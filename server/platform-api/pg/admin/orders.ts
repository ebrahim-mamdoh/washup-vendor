import "server-only";

import type { Order, OrderDetails, OrderStatus } from "@/types/orders";

import { MockApiError, ok, requireText } from "../../http";
import { UPCOMING_STATUSES } from "../../lookups";
import {
  auditWhere,
  branchById,
  businessById,
  complaintsWhere,
  customersWhere,
  orderById,
  ordersWhere,
  paymentsWhere,
  reviewsWhere,
  staffWhere,
  transactionsWhere,
  vehiclesWhere,
} from "../entities";
import { countsOf, orderBy, paged, searchPattern } from "../list";
import { toOrderListItems } from "../lookups";
import { logAudit, pushAdminNotification, pushVendorNotification } from "../platform";
import { route } from "../router";
import { type Q, db, tx } from "../sql";

const STATUSES: OrderStatus[] = ["pending", "confirmed", "waiting", "in_service", "completed", "cancelled", "no_show"];

/** Full orders for a page of ids, in the order of `ids` (the page was sorted in SQL). */
async function ordersInOrder(q: Q, ids: string[]): Promise<Order[]> {
  if (!ids.length) return [];
  const rows = await ordersWhere(q, q`o.id = any(${ids})`);
  const byId = new Map(rows.map((o) => [o.id, o]));
  return ids.map((id) => byId.get(id)).filter((o): o is Order => Boolean(o));
}

export const orderRoutes = [
  route("GET", "/admin/orders", async ({ query }) => {
    const sql = db();
    const status = query.get("status");
    const source = query.get("source");
    const payment = query.get("payment");
    const washId = query.get("washId");
    const customerId = query.get("customerId");
    const dateFrom = query.get("dateFrom");
    const dateTo = query.get("dateTo");
    const search = searchPattern(query);
    // Day bounds in server-local time, exactly like the mock (`T00:00:00` / `T23:59:59` local).
    const from = dateFrom ? new Date(`${dateFrom}T00:00:00`).toISOString() : null;
    const to = dateTo ? new Date(`${dateTo}T23:59:59`).toISOString() : null;

    // Light rows for filtering/sorting/counting; the page is loaded in full afterwards.
    const base = sql`
      select o.id, o.status::text as status, o.number, o.total, o.scheduled_at, cu.name as customer_name
      from public.orders o
      left join public.customers cu on cu.id = o.customer_id
      join public.businesses bz on bz.id = o.business_id
      join public.branches br on br.id = o.branch_id
      where true
        ${source && source !== "all" ? sql`and o.source::text = ${source}` : sql``}
        ${payment && payment !== "all" ? sql`and o.payment_status::text = ${payment}` : sql``}
        ${washId && washId !== "all" ? sql`and o.business_id = ${washId}` : sql``}
        ${customerId ? sql`and o.customer_id = ${customerId}` : sql``}
        ${from ? sql`and o.scheduled_at >= ${from}` : sql``}
        ${to ? sql`and o.scheduled_at <= ${to}` : sql``}
        ${search ? sql`and (o.number ilike ${search} or o.code ilike ${search} or o.plate ilike ${search} or cu.name ilike ${search}
                         or bz.name ->> 'ar' ilike ${search} or br.name ->> 'ar' ilike ${search})` : sql``}`;

    const filter = status && status !== "all" ? sql`where w.status = ${status}` : sql``;
    const [countRows, [{ total, totalAmount }]] = await Promise.all([
      sql<{ k: string; n: number }[]>`with w as (${base}) select w.status as k, count(*)::int as n from w group by w.status`,
      sql<{ total: number; totalAmount: number }[]>`
        with w as (${base}) select count(*)::int as total, coalesce(sum(w.total), 0) as "totalAmount" from w ${filter}`,
    ]);
    // Text sorts use the C collation: same code-point order as the mock's JS comparisons.
    const sort = orderBy(
      sql,
      query,
      {
        scheduledAt: "w.scheduled_at",
        number: `w.number collate "C"`,
        total: "w.total",
        status: `w.status collate "C"`,
        customer: `w.customer_name collate "C"`,
      },
      { key: "scheduledAt", order: "desc" },
      "w.id",
    );
    const { items, pagination } = await paged(query, total, 12, async (limit, offset) => {
      const ids = await sql<{ id: string }[]>`with w as (${base}) select w.id from w ${filter} ${sort} limit ${limit} offset ${offset}`;
      return toOrderListItems(sql, await ordersInOrder(sql, ids.map((r) => r.id)));
    });
    return ok(items, "OK", { pagination, meta: { counts: countsOf(countRows, STATUSES), totalAmount } });
  }),

  route("GET", "/admin/orders/:id", async ({ params }) => {
    const sql = db();
    // Accepts the order id or its public number (CZ-xxxxx).
    const [order] = await ordersWhere(sql, sql`(o.id = ${params.id} or o.number = ${params.id})`, sql`order by o.id limit 1`);
    if (!order) throw new MockApiError("الحجز غير موجود", 404);

    const [[customer], [vehicle], business, branch, [staff], [payment], [transaction], [review], [complaint], auditLogs] =
      await Promise.all([
        order.customerId ? customersWhere(sql, sql`cu.id = ${order.customerId}`) : Promise.resolve([]),
        order.vehicleId ? vehiclesWhere(sql, sql`v.id = ${order.vehicleId}`) : Promise.resolve([]),
        businessById(sql, order.businessId),
        branchById(sql, order.branchId),
        order.assignedStaffId ? staffWhere(sql, sql`st.id = ${order.assignedStaffId}`) : Promise.resolve([]),
        paymentsWhere(sql, sql`p.order_id = ${order.id}`, sql`order by p.collected_at, p.id limit 1`),
        transactionsWhere(sql, sql`t.order_id = ${order.id}`),
        reviewsWhere(sql, sql`r.order_id = ${order.id}`),
        complaintsWhere(sql, sql`c.order_id = ${order.id}`, sql`order by c.created_at, c.id limit 1`),
        auditWhere(sql, sql`al.entity_id = ${order.id}`, sql`order by al.at desc`),
      ]);

    const details: OrderDetails = {
      order,
      customer: customer ?? null,
      vehicle: vehicle ?? null,
      business,
      branch,
      staff: staff ?? null,
      payment: payment ?? null,
      transaction: transaction ?? null,
      review: review ?? null,
      complaint: complaint ?? null,
      auditLogs,
    };
    return ok(details);
  }),

  route("POST", "/admin/orders/:id/cancel", async ({ params, body, admin }) => {
    const order = await tx(async (t) => {
      const current = await orderById(t, params.id, "الحجز");
      if (!(UPCOMING_STATUSES as readonly string[]).includes(current.status)) {
        throw new MockApiError("يمكن إلغاء الحجوزات قيد المراجعة أو المؤكدة فقط", 409);
      }
      const reason = requireText(body.reason, "reason", "سبب الإلغاء", 5);

      // Status guard in the WHERE clause: an order that moved on meanwhile can't be cancelled.
      const updated = await t`
        update public.orders set status = 'cancelled', cancel_reason = ${reason},
               cancelled_by_type = 'admin', cancelled_by_id = ${admin.id}, cancelled_at = now()
        where id = ${current.id} and status in ('pending', 'confirmed') returning id`;
      if (!updated.length) throw new MockApiError("يمكن إلغاء الحجوزات قيد المراجعة أو المؤكدة فقط", 409);
      await t`insert into public.order_events (order_id, status, actor_type, actor_id) values (${current.id}, 'cancelled', 'admin', ${admin.id})`;
      // A commission entry that was never settled disappears with the order.
      await t`delete from public.transactions where order_id = ${current.id} and status = 'pending'`;

      await logAudit(t, {
        actorId: admin.id,
        action: "cancel_order",
        entity: "orders",
        entityId: current.id,
        branchId: current.branchId,
        oldValue: current.status,
        newValue: "cancelled",
        reason,
      });
      await pushVendorNotification(
        t,
        current.businessId,
        current.branchId,
        "booking_cancelled",
        `ألغت إدارة كارزن الحجز ${current.number}`,
        `السبب: ${reason}`,
        `/orders/${current.id}`,
      );
      return orderById(t, current.id, "الحجز");
    });
    return ok(order, `تم إلغاء الحجز ${order.number} وإبلاغ العميل والمغسلة`);
  }),

  route("POST", "/admin/orders/:id/flag", async ({ params, body, admin }) => {
    const order = await tx(async (t) => {
      const current = await orderById(t, params.id, "الحجز");
      if (current.flag === "finance_review") {
        throw new MockApiError("الحجز محوّل بالفعل للمراجعة المالية", 409);
      }
      const reason = requireText(body.reason, "reason", "سبب المراجعة", 5);

      const updated = await t`
        update public.orders set flag = 'finance_review'
        where id = ${current.id} and flag is distinct from 'finance_review' returning id`;
      if (!updated.length) throw new MockApiError("الحجز محوّل بالفعل للمراجعة المالية", 409);
      // order_notes.author_staff_id references staff: an admin author is stored as null
      // (same mapping as the seed), so the note's authorId reads "" on this data source.
      // The text is capped at the column's 500-character limit.
      await t`
        insert into public.order_notes (order_id, author_staff_id, text)
        values (${current.id}, (select id from public.staff where id = ${admin.id}), ${`تحويل للمراجعة المالية: ${reason}`.slice(0, 500)})`;

      await pushAdminNotification(
        t,
        "finance_flag",
        { ar: `مراجعة مالية للحجز ${current.number}`, en: `Finance review for ${current.number}` },
        { ar: reason, en: reason },
        `/orders/${current.id}`,
      );
      await logAudit(t, {
        actorId: admin.id,
        action: "flag_order_finance",
        entity: "orders",
        entityId: current.id,
        branchId: current.branchId,
        newValue: "finance_review",
        reason,
      });
      return orderById(t, current.id, "الحجز");
    });
    return ok(order, "تم تحويل الحجز لفريق المالية");
  }),
];
