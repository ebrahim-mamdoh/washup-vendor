import "server-only";

import type { Localized } from "@/types/common";
import type {
  BranchListItem,
  BusinessStatus,
  StaffListItem,
  SuspendReason,
  WashDetails,
  WashListItem,
  WashOrderSummary,
} from "@/types/washes";

import { now, round2 } from "../../db";
import { MockApiError, ok, requireText } from "../../http";
import {
  BRANCH_COLS,
  BUSINESS_COLS,
  BUSINESS_FROM,
  PHONE,
  STAFF_COLS,
  auditWhere,
  branchById,
  businessById,
  businessesWhere,
  complaintsWhere,
  reviewsWhere,
  servicesWhere,
  staffById,
  staffWhere,
  transactionsWhere,
} from "../entities";
import { countsOf, dayBounds, orderBy, paged, searchPattern } from "../list";
import { defaultCommissionPct, logAudit, pushAdminNotification, pushVendorNotification } from "../platform";
import { route } from "../router";
import { type Q, db, tx } from "../sql";

const BUSINESS_STATUSES: BusinessStatus[] = ["pending", "approved", "active", "suspended", "rejected"];

const SUSPEND_REASON_LABELS: Record<SuspendReason, string> = {
  repeated_complaints: "شكاوى متكررة",
  incorrect_information: "بيانات غير صحيحة",
  operational_issue: "مشكلة تشغيلية",
  policy_violation: "مخالفة السياسات",
  owner_request: "بطلب من المالك",
};

/** Order summary columns (alias o): branch name + primary service name. */
const ORDER_SUMMARY_COLS = (q: Q) => q`
  o.id, o.number, (select br.name from public.branches br where br.id = o.branch_id) as "branchName",
  coalesce((select i.name from public.order_items i where i.order_id = o.id order by (i.type <> 'primary'), i.position limit 1),
           '{"ar":"—","en":"—"}'::jsonb) as "serviceName",
  o.scheduled_at as "scheduledAt", o.status, o.total`;

function upcomingOrders(q: Q, businessId: string) {
  return q<WashOrderSummary[]>`
    select ${ORDER_SUMMARY_COLS(q)} from public.orders o
    where o.business_id = ${businessId} and o.status in ('pending', 'confirmed') and o.scheduled_at > ${now().toISOString()}
    order by o.scheduled_at`;
}

export const washRoutes = [
  route("GET", "/admin/washes", async ({ query }) => {
    const sql = db();
    const status = query.get("status");
    const area = query.get("area");
    const search = searchPattern(query);

    const base = sql`
      select ${sql.unsafe(BUSINESS_COLS)}, brs."branchesCount", brs.areas, os."ordersCount", os."completedCount", os."activeOrders",
             cs."complaintsCount", cs."openComplaints", os.gmv, os."lastActivityAt"
      from ${sql.unsafe(BUSINESS_FROM)}
      cross join lateral (
        select count(*)::int as "branchesCount", coalesce(json_agg(distinct br.area_id), '[]') as areas
        from public.branches br where br.business_id = b.id) brs
      cross join lateral (
        select count(*)::int as "ordersCount",
               (count(*) filter (where o.status = 'completed'))::int as "completedCount",
               (count(*) filter (where o.status in ('pending', 'confirmed', 'waiting', 'in_service')))::int as "activeOrders",
               coalesce(sum(o.total) filter (where o.status = 'completed' and o.payment_status = 'paid'), 0) as gmv,
               max(o.scheduled_at) filter (where o.scheduled_at <= ${now().toISOString()}) as "lastActivityAt"
        from public.orders o where o.business_id = b.id) os
      cross join lateral (
        select count(*)::int as "complaintsCount",
               (count(*) filter (where c.status not in ('resolved', 'closed')))::int as "openComplaints"
        from public.complaints c where c.business_id = b.id) cs
      where true
        ${search ? sql`and (b.name ->> 'ar' ilike ${search} or b.name ->> 'en' ilike ${search} or ow.name ilike ${search})` : sql``}
        ${area && area !== "all" ? sql`and exists (select 1 from public.branches br where br.business_id = b.id and br.area_id = ${area})` : sql``}`;

    const filter = status && status !== "all" ? sql`where w.status = ${status}` : sql``;
    const [countRows, [{ total }]] = await Promise.all([
      sql<{ k: string; n: number }[]>`with w as (${base}) select w.status::text as k, count(*)::int as n from w group by w.status`,
      sql<{ total: number }[]>`with w as (${base}) select count(*)::int as total from w ${filter}`,
    ]);
    const sort = orderBy(
      sql,
      query,
      {
        name: `w.name ->> 'ar'`,
        createdAt: `w."createdAt"`,
        rating: "w.rating",
        ordersCount: `w."ordersCount"`,
        branchesCount: `w."branchesCount"`,
        gmv: "w.gmv",
        complaintsCount: `w."openComplaints"`,
        lastActivityAt: `w."lastActivityAt"`,
      },
      { key: "gmv", order: "desc" },
      "w.id",
    );
    const { items, pagination } = await paged(query, total, 10, (limit, offset) =>
      sql<WashListItem[]>`with w as (${base}) select * from w ${filter} ${sort} limit ${limit} offset ${offset}`,
    );
    return ok(items, "OK", { pagination, meta: { counts: countsOf(countRows, BUSINESS_STATUSES) } });
  }),

  route("GET", "/admin/washes/:id", async ({ params }) => {
    const sql = db();
    const business = await businessById(sql, params.id);
    const [todayStart, todayEnd] = dayBounds(now());

    const [branches, services, staff, [stats], upcoming, recentOrders, reviews, complaints, transactions, [money], defaultRate, auditLogs] =
      await Promise.all([
        sql<WashDetails["branches"]>`
          select ${sql.unsafe(BRANCH_COLS)},
            (select count(*)::int from public.orders o where o.branch_id = br.id and o.scheduled_at >= ${todayStart} and o.scheduled_at < ${todayEnd}) as "todayOrders",
            (select count(*)::int from public.services s where s.branch_id = br.id) as "servicesCount"
          from public.branches br where br.business_id = ${business.id} order by br.id`,
        servicesWhere(sql, sql`sv.branch_id in (select id from public.branches where business_id = ${business.id})`, sql`order by sv.branch_id, sv.id`),
        staffWhere(sql, sql`st.business_id = ${business.id}`, sql`order by st.id`),
        sql<{ total: number; completed: number; cancelled: number; noShow: number }[]>`
          select count(*)::int as total,
                 (count(*) filter (where status = 'completed'))::int as completed,
                 (count(*) filter (where status = 'cancelled'))::int as cancelled,
                 (count(*) filter (where status = 'no_show'))::int as "noShow"
          from public.orders where business_id = ${business.id}`,
        upcomingOrders(sql, business.id),
        sql<WashOrderSummary[]>`
          select ${ORDER_SUMMARY_COLS(sql)} from public.orders o where o.business_id = ${business.id}
          order by o.scheduled_at desc limit 12`,
        reviewsWhere(sql, sql`r.business_id = ${business.id}`, sql`order by r.created_at desc limit 12`),
        complaintsWhere(sql, sql`c.business_id = ${business.id}`, sql`order by c.created_at desc`),
        transactionsWhere(sql, sql`t.business_id = ${business.id}`, sql`order by t.date desc limit 15`),
        sql<{ gross: number; commission: number; pendingPayout: number }[]>`
          select coalesce((select sum(gross) from public.transactions where business_id = ${business.id}), 0) as gross,
                 coalesce((select sum(commission) from public.transactions where business_id = ${business.id}), 0) as commission,
                 coalesce((select sum(amount_due - amount_paid) from public.payouts where business_id = ${business.id} and status = 'due'), 0) as "pendingPayout"`,
        defaultCommissionPct(sql),
        auditWhere(
          sql,
          sql`(al.entity_id = ${business.id} or al.branch_id in (select id from public.branches where business_id = ${business.id}))`,
          sql`order by al.at desc limit 30`,
        ),
      ]);

    const details: WashDetails = {
      business,
      branches,
      services,
      staff,
      bookingStats: { ...stats, upcoming: upcoming.length },
      recentOrders,
      reviews,
      complaints,
      transactions,
      financials: {
        gross: money.gross,
        commission: round2(money.commission),
        netToWash: round2(money.gross - money.commission),
        pendingPayout: money.pendingPayout,
        effectiveRate: business.commissionRate ?? defaultRate,
      },
      auditLogs,
    };
    return ok(details);
  }),

  route("GET", "/admin/washes/:id/impact", async ({ params }) => {
    const sql = db();
    const business = await businessById(sql, params.id);
    const [upcoming, [{ n }]] = await Promise.all([
      upcomingOrders(sql, business.id),
      sql<{ n: number }[]>`select count(*)::int as n from public.branches where business_id = ${business.id} and active`,
    ]);
    return ok({ upcomingOrders: upcoming, activeBranches: n });
  }),

  route("POST", "/admin/washes/:id/suspend", async ({ params, body, admin }) => {
    const reason = String(body.reason ?? "") as SuspendReason;
    const cancelUpcoming = Boolean(body.cancelUpcoming);

    const { business, cancelled } = await tx(async (t) => {
      const current = await businessById(t, params.id);
      if (current.status !== "active") throw new MockApiError("يمكن تعليق المغاسل النشطة فقط", 409);
      if (!SUSPEND_REASON_LABELS[reason]) throw new MockApiError("اختر سبب التعليق", 422);
      const note = requireText(body.note, "note", "ملاحظة التعليق");
      const statusReason = `${SUSPEND_REASON_LABELS[reason]} — ${note}`;

      // Status guard in the WHERE clause: a concurrent suspend can't apply twice.
      const updated = await t`
        update public.businesses set status = 'suspended', status_reason = ${statusReason}
        where id = ${current.id} and status = 'active' returning id`;
      if (!updated.length) throw new MockApiError("يمكن تعليق المغاسل النشطة فقط", 409);

      let cancelledCount = 0;
      if (cancelUpcoming) {
        const rows = await t<{ id: string }[]>`
          update public.orders set status = 'cancelled', cancel_reason = 'تعليق المغسلة من إدارة المنصة',
                 cancelled_by_type = 'admin', cancelled_by_id = ${admin.id}, cancelled_at = now()
          where business_id = ${current.id} and status in ('pending', 'confirmed') and scheduled_at > ${now().toISOString()}
          returning id`;
        if (rows.length) {
          await t`
            insert into public.order_events (order_id, status, actor_type, actor_id)
            select id, 'cancelled', 'admin', ${admin.id} from unnest(${rows.map((r) => r.id)}::text[]) as id`;
        }
        cancelledCount = rows.length;
      }

      await logAudit(t, {
        actorId: admin.id,
        action: "suspend_wash",
        entity: "businesses",
        entityId: current.id,
        oldValue: current.status,
        newValue: "suspended",
        reason: `${SUSPEND_REASON_LABELS[reason]}: ${note}${cancelledCount ? ` (ألغي ${cancelledCount} حجز قادم)` : ""}`,
      });
      await pushVendorNotification(
        t,
        current.id,
        null,
        "platform",
        "تم تعليق مغسلتك مؤقتًا",
        `قررت إدارة كارزن تعليق المغسلة: ${statusReason}. لن تظهر للعملاء ولن تستقبل حجوزات جديدة حتى إعادة التفعيل.`,
        "/settings",
      );
      return { business: await businessById(t, current.id), cancelled: cancelledCount };
    });
    return ok(business, `تم تعليق ${business.name.ar}${cancelled ? ` وإلغاء ${cancelled} حجز` : ""}`);
  }),

  route("POST", "/admin/washes/:id/reactivate", async ({ params, body, admin }) => {
    const business = await tx(async (t) => {
      const current = await businessById(t, params.id);
      if (current.status !== "suspended") throw new MockApiError("المغسلة ليست معلّقة", 409);
      const note = requireText(body.note, "note", "ملاحظة إعادة التفعيل");
      const updated = await t`
        update public.businesses set status = 'active', status_reason = null
        where id = ${current.id} and status = 'suspended' returning id`;
      if (!updated.length) throw new MockApiError("المغسلة ليست معلّقة", 409);
      await logAudit(t, {
        actorId: admin.id,
        action: "reactivate_wash",
        entity: "businesses",
        entityId: current.id,
        oldValue: current.status,
        newValue: "active",
        reason: note,
      });
      await pushVendorNotification(
        t,
        current.id,
        null,
        "platform",
        "تمت إعادة تفعيل مغسلتك",
        `عادت المغسلة للظهور للعملاء واستقبال الحجوزات. ملاحظة الإدارة: ${note}`,
        "/dashboard",
      );
      return businessById(t, current.id);
    });
    return ok(business, `تمت إعادة تفعيل ${business.name.ar}`);
  }),

  route("PATCH", "/admin/washes/:id", async ({ params, body, admin }) => {
    const business = await tx(async (t) => {
      const current = await businessById(t, params.id);
      const reason = requireText(body.reason, "reason", "سبب التعديل", 5);
      const patch = (body.patch ?? {}) as { name?: Localized; ownerName?: string; commissionRate?: number | null };
      const before = { name: current.name, ownerName: current.ownerName, commissionRate: current.commissionRate };

      if (patch.commissionRate !== undefined) {
        const rate = patch.commissionRate === null ? null : Number(patch.commissionRate);
        if (rate !== null && (Number.isNaN(rate) || rate < 0 || rate > 30)) {
          throw new MockApiError("نسبة العمولة يجب أن تكون بين 0 و 30٪", 422);
        }
        await t`update public.businesses set commission_rate = ${rate} where id = ${current.id}`;
      }
      if (patch.name) {
        const name = { ar: String(patch.name.ar).trim(), en: String(patch.name.en).trim() };
        await t`update public.businesses set name = ${t.json(name)} where id = ${current.id}`;
      }
      // The owner's name lives on their staff profile.
      if (patch.ownerName && current.ownerId) {
        await t`update public.staff set name = ${String(patch.ownerName).trim()} where id = ${current.ownerId}`;
      }

      const after = await businessById(t, current.id);
      await logAudit(t, {
        actorId: admin.id,
        action: "edit_business_data",
        entity: "businesses",
        entityId: current.id,
        oldValue: before,
        newValue: { name: after.name, ownerName: after.ownerName, commissionRate: after.commissionRate },
        reason,
      });
      return after;
    });
    return ok(business, "تم حفظ التعديلات وتسجيلها في سجل التدقيق");
  }),

  route("GET", "/admin/branches", async ({ query }) => {
    const sql = db();
    const area = query.get("area");
    const status = query.get("status");
    const search = searchPattern(query);
    const [todayStart, todayEnd] = dayBounds(now());

    const base = sql`
      select ${sql.unsafe(BRANCH_COLS)}, bz.name as "businessName", bz.status as "businessStatus",
        (select count(*)::int from public.orders o where o.branch_id = br.id and o.scheduled_at >= ${todayStart} and o.scheduled_at < ${todayEnd}) as "todayOrders"
      from public.branches br join public.businesses bz on bz.id = br.business_id`;
    const where = sql`
      where true
        ${search ? sql`and (w.name ->> 'ar' ilike ${search} or w.name ->> 'en' ilike ${search} or w."businessName" ->> 'ar' ilike ${search})` : sql``}
        ${area && area !== "all" ? sql`and w.area = ${area}` : sql``}
        ${status === "active" ? sql`and w.active` : status === "inactive" ? sql`and not w.active` : sql``}`;

    const [[counts], [{ total }]] = await Promise.all([
      sql<{ all: number; active: number; inactive: number }[]>`
        select count(*)::int as all, (count(*) filter (where active))::int as active, (count(*) filter (where not active))::int as inactive
        from public.branches`,
      sql<{ total: number }[]>`with w as (${base}) select count(*)::int as total from w ${where}`,
    ]);
    const sort = orderBy(
      sql,
      query,
      { name: `w.name ->> 'ar'`, capacity: "w.capacity", rating: "w.rating", todayOrders: `w."todayOrders"` },
      { key: "todayOrders", order: "desc" },
      "w.id",
    );
    const { items, pagination } = await paged(query, total, 20, (limit, offset) =>
      sql<BranchListItem[]>`with w as (${base}) select * from w ${where} ${sort} limit ${limit} offset ${offset}`,
    );
    return ok(items, "OK", { pagination, meta: { counts } });
  }),

  route("POST", "/admin/branches/:id/toggle", async ({ params, body, admin }) => {
    const branch = await tx(async (t) => {
      const current = await branchById(t, params.id);
      const active = Boolean(body.active);
      const reason = requireText(body.reason, "reason", "السبب");
      await t`update public.branches set active = ${active} where id = ${current.id}`;
      await logAudit(t, {
        actorId: admin.id,
        action: active ? "activate_branch" : "deactivate_branch",
        entity: "branches",
        entityId: current.id,
        branchId: current.id,
        oldValue: current.active ? "active" : "inactive",
        newValue: active ? "active" : "inactive",
        reason,
      });
      return { ...current, active };
    });
    return ok(branch, branch.active ? "تم تفعيل الفرع" : "تم إيقاف الفرع");
  }),

  route("GET", "/admin/staff", async ({ query }) => {
    const sql = db();
    const role = query.get("role");
    const search = searchPattern(query);

    const base = sql`
      select ${sql.unsafe(STAFF_COLS)}, bz.name as "businessName",
        (select br.name from public.branches br where br.id = st.branch_id) as "branchName", bz.status as "businessStatus"
      from public.staff st join public.businesses bz on bz.id = st.business_id
      where true
        ${search ? sql`and (st.name ilike ${search} or ${sql.unsafe(PHONE("st.phone"))} ilike ${search}
                         or bz.name ->> 'ar' ilike ${search} or bz.name ->> 'en' ilike ${search})` : sql``}`;
    const filter = role && role !== "all" ? sql`where w.role = ${role}` : sql``;

    const [countRows, [{ total }]] = await Promise.all([
      sql<{ k: string; n: number }[]>`with w as (${base}) select w.role::text as k, count(*)::int as n from w group by w.role`,
      sql<{ total: number }[]>`with w as (${base}) select count(*)::int as total from w ${filter}`,
    ]);
    const sort = orderBy(
      sql,
      query,
      { name: "w.name", role: "w.role", business: `w."businessName" ->> 'ar'` },
      { key: "business", order: "asc" },
      "w.id",
    );
    const { items, pagination } = await paged(query, total, 15, (limit, offset) =>
      sql<StaffListItem[]>`with w as (${base}) select * from w ${filter} ${sort} limit ${limit} offset ${offset}`,
    );
    return ok(items, "OK", { pagination, meta: { counts: countsOf(countRows, ["owner", "manager", "employee"] as const) } });
  }),

  route("POST", "/admin/staff/:id/status", async ({ params, body, admin }) => {
    const member = await tx(async (t) => {
      const current = await staffById(t, params.id);
      const suspended = Boolean(body.suspended);
      const reason = requireText(body.reason, "reason", "السبب");
      const status = suspended ? "suspended" : "active";
      await t`update public.staff set status = ${status} where id = ${current.id}`;
      await logAudit(t, {
        actorId: admin.id,
        action: suspended ? "suspend_staff" : "reactivate_staff",
        entity: "staff",
        entityId: current.id,
        oldValue: current.status,
        newValue: status,
        reason,
      });
      if (suspended && current.role === "owner") {
        const [business] = await businessesWhere(t, t`b.id = ${current.businessId}`);
        await pushAdminNotification(
          t,
          "unusual_activity",
          { ar: "تم إيقاف حساب مالك", en: "Owner account suspended" },
          { ar: `${current.name} — ${business?.name.ar ?? "—"}`, en: current.name },
          `/washes/${current.businessId}`,
        );
      }
      return { ...current, status } as typeof current;
    });
    return ok(member, member.status === "suspended" ? "تم إيقاف الحساب" : "تمت إعادة تفعيل الحساب");
  }),
];
