import "server-only";

import type { Localized } from "@/types/common";
import type { Complaint, ComplaintDetails, ComplaintListItem, ComplaintStatus } from "@/types/complaints";

import { MockApiError, ok } from "../../http";
import { adminsWhere, auditWhere, branchById, businessById, complaintsWhere, customerById, ordersWhere } from "../entities";
import { countsOf, orderBy, paged, searchPattern } from "../list";
import { actorNames, branchNames, businessNames, customerNames } from "../lookups";
import { logAudit } from "../platform";
import { route } from "../router";
import { type Q, db, tx } from "../sql";

const STATUSES: ComplaintStatus[] = ["open", "in_review", "waiting", "resolved", "closed"];
const EMPTY: Localized = { ar: "—", en: "—" };

/** Allowed forward moves; reopening a closed ticket is not part of the MVP flow. */
const TRANSITIONS: Record<ComplaintStatus, ComplaintStatus[]> = {
  open: ["in_review", "waiting", "resolved"],
  in_review: ["waiting", "resolved", "open"],
  waiting: ["in_review", "resolved"],
  resolved: ["closed", "in_review"],
  closed: [],
};

async function complaintById(q: Q, id: string): Promise<Complaint> {
  const [complaint] = await complaintsWhere(q, q`c.id = ${id}`);
  if (!complaint) throw new MockApiError("الشكوى غير موجود", 404);
  return complaint;
}

/** Complaints (already in page order) → list items with customer, wash, branch, order and assignee names. */
async function toComplaintListItems(q: Q, ids: string[]): Promise<ComplaintListItem[]> {
  if (!ids.length) return [];
  const rows = await complaintsWhere(q, q`c.id = any(${ids})`);
  const byId = new Map(rows.map((c) => [c.id, c]));
  const complaints = ids.map((id) => byId.get(id)).filter((c): c is Complaint => Boolean(c));
  const orderIds = complaints.map((c) => c.orderId).filter((x): x is string => Boolean(x));

  const [customers, businesses, branches, admins, orders] = await Promise.all([
    customerNames(q, complaints.map((c) => c.customerId)),
    businessNames(q, complaints.map((c) => c.businessId)),
    branchNames(q, complaints.map((c) => c.branchId)),
    actorNames(q, complaints.map((c) => c.assignedAdminId)),
    orderIds.length ? q<{ id: string; number: string }[]>`select id, number from public.orders where id = any(${orderIds})` : Promise.resolve([]),
  ]);
  const numbers = new Map(orders.map((o) => [o.id, o.number]));
  return complaints.map((c) => ({
    ...c,
    customerName: customers.get(c.customerId) ?? "—",
    businessName: businesses.get(c.businessId) ?? EMPTY,
    branchName: branches.get(c.branchId) ?? EMPTY,
    orderNumber: (c.orderId && numbers.get(c.orderId)) || null,
    assigneeName: (c.assignedAdminId && admins.get(c.assignedAdminId)) || null,
  }));
}

export const complaintRoutes = [
  route("GET", "/admin/complaints", async ({ query }) => {
    const sql = db();
    const status = query.get("status");
    const category = query.get("category");
    const assignee = query.get("assignee");
    const search = searchPattern(query);

    const base = sql`
      select c.id, c.status::text as status, c.ticket, c.created_at
      from public.complaints c
      left join public.customers cu on cu.id = c.customer_id
      left join public.businesses bz on bz.id = c.business_id
      left join public.orders o on o.id = c.order_id
      where true
        ${category && category !== "all" ? sql`and c.category::text = ${category}` : sql``}
        ${assignee === "unassigned" ? sql`and c.assigned_admin_id is null` : sql``}
        ${assignee && assignee !== "all" && assignee !== "unassigned" ? sql`and c.assigned_admin_id = ${assignee}` : sql``}
        ${search ? sql`and (c.ticket ilike ${search} or coalesce(cu.name, '—') ilike ${search} or coalesce(bz.name ->> 'ar', '—') ilike ${search}
                         or o.number ilike ${search} or c.description ilike ${search})` : sql``}`;

    const filter = status && status !== "all" ? sql`where w.status = ${status}` : sql``;
    const [countRows, [{ total }]] = await Promise.all([
      sql<{ k: string; n: number }[]>`with w as (${base}) select w.status as k, count(*)::int as n from w group by w.status`,
      sql<{ total: number }[]>`with w as (${base}) select count(*)::int as total from w ${filter}`,
    ]);
    const sort = orderBy(
      sql,
      query,
      { createdAt: "w.created_at", ticket: `w.ticket collate "C"`, status: `w.status collate "C"` },
      { key: "createdAt", order: "asc" },
      "w.id",
    );
    const { items, pagination } = await paged(query, total, 12, async (limit, offset) => {
      const ids = await sql<{ id: string }[]>`with w as (${base}) select w.id from w ${filter} ${sort} limit ${limit} offset ${offset}`;
      return toComplaintListItems(sql, ids.map((r) => r.id));
    });
    return ok(items, "OK", { pagination, meta: { counts: countsOf(countRows, STATUSES) } });
  }),

  route("GET", "/admin/complaints/:id", async ({ params }) => {
    const sql = db();
    const complaint = await complaintById(sql, params.id);

    const [customer, business, branch, [order], [assignee], [washStats], authors, auditLogs] = await Promise.all([
      customerById(sql, complaint.customerId),
      businessById(sql, complaint.businessId),
      branchById(sql, complaint.branchId),
      complaint.orderId ? ordersWhere(sql, sql`o.id = ${complaint.orderId}`) : Promise.resolve([]),
      complaint.assignedAdminId ? adminsWhere(sql, sql`a.id = ${complaint.assignedAdminId}`) : Promise.resolve([]),
      sql<{ count: number; open: number }[]>`
        select count(*)::int as count, (count(*) filter (where status not in ('resolved', 'closed')))::int as open
        from public.complaints where business_id = ${complaint.businessId}`,
      actorNames(sql, complaint.notes.map((n) => n.authorId)),
      auditWhere(sql, sql`al.entity_id = ${complaint.id}`, sql`order by al.at desc`),
    ]);

    const details: ComplaintDetails = {
      complaint,
      customer,
      business,
      branch,
      order: order ?? null,
      assignee: assignee ?? null,
      washComplaintCount: washStats.count,
      washOpenComplaints: washStats.open,
      noteAuthors: Object.fromEntries(complaint.notes.map((n) => [n.authorId, authors.get(n.authorId) ?? n.authorId])),
      auditLogs,
    };
    return ok(details);
  }),

  route("PATCH", "/admin/complaints/:id", async ({ params, body, admin }) => {
    const { complaint, changes } = await tx(async (t) => {
      const current = await complaintById(t, params.id);
      const changes: string[] = [];
      let assignedAdminId = current.assignedAdminId;
      let status = current.status;
      let resolution = current.resolution;

      if (body.assignedAdminId !== undefined) {
        const next = body.assignedAdminId === null ? null : String(body.assignedAdminId);
        if (next) {
          const [available] = await t`select 1 from public.admin_users where id = ${next} and status = 'active'`;
          if (!available) throw new MockApiError("المسؤول المختار غير متاح", 422);
        }
        if (next !== assignedAdminId) {
          const names = await actorNames(t, [assignedAdminId, next]);
          await logAudit(t, {
            actorId: admin.id,
            action: "assign_complaint",
            entity: "complaints",
            entityId: current.id,
            oldValue: (assignedAdminId && names.get(assignedAdminId)) || null,
            newValue: (next && names.get(next)) || null,
          });
          assignedAdminId = next;
          changes.push("assign");
        }
      }

      if (typeof body.note === "string" && body.note.trim()) {
        const note = body.note.trim();
        await t`insert into public.complaint_notes (complaint_id, author_admin_id, text) values (${current.id}, ${admin.id}, ${note})`;
        await logAudit(t, { actorId: admin.id, action: "add_complaint_note", entity: "complaints", entityId: current.id, reason: note });
        changes.push("note");
      }

      if (body.status !== undefined) {
        const next = String(body.status) as ComplaintStatus;
        if (!STATUSES.includes(next)) throw new MockApiError("حالة غير صالحة", 422);
        if (next !== status) {
          if (!TRANSITIONS[status].includes(next)) {
            throw new MockApiError("لا يمكن الانتقال لهذه الحالة من الحالة الحالية", 409);
          }
          if (next === "resolved") {
            const text = typeof body.resolution === "string" ? body.resolution.trim() : "";
            if (text.length < 5) {
              throw new MockApiError("اكتب قرار الحل قبل إغلاق الشكوى كمحلولة", 422, { resolution: ["قرار الحل مطلوب"] });
            }
            resolution = text;
          }
          if (next !== "open" && !assignedAdminId) assignedAdminId = admin.id;
          await logAudit(t, {
            actorId: admin.id,
            action: "update_complaint_status",
            entity: "complaints",
            entityId: current.id,
            oldValue: status,
            newValue: next,
            reason: next === "resolved" ? resolution : null,
          });
          status = next;
          changes.push("status");
        }
      }

      if (!changes.length) throw new MockApiError("لا توجد تغييرات للحفظ", 422);
      // One write for every field; the status guard rejects a ticket that moved on meanwhile.
      const updated = await t`
        update public.complaints
        set assigned_admin_id = ${assignedAdminId}, status = ${status}, resolution = ${resolution}, updated_at = now()
        where id = ${current.id} and status = ${current.status} returning id`;
      if (!updated.length) throw new MockApiError("لا يمكن الانتقال لهذه الحالة من الحالة الحالية", 409);
      return { complaint: await complaintById(t, current.id), changes };
    });

    const message = changes.includes("status")
      ? complaint.status === "resolved"
        ? "تم حل الشكوى وإبلاغ العميل"
        : "تم تحديث حالة الشكوى"
      : changes.includes("assign")
        ? "تم تعيين المسؤول"
        : "تمت إضافة الملاحظة";
    return ok(complaint, message);
  }),
];
