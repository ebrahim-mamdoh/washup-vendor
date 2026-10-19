import "server-only";

import type { Localized } from "@/types/common";
import type { Order, PaymentMethod } from "@/types/orders";
import type { VendorPeriod } from "@/types/vendor/dashboard";
import type {
  CustomerSegment,
  VendorAuditItem,
  VendorCustomer,
  VendorCustomerDetails,
  VendorFinance,
  VendorReport,
  VendorReportType,
  VendorReview,
  VendorSearchResult,
} from "@/types/vendor/insights";

import { daysAgo, isSameDay, now, round2 } from "../../db";
import { MockApiError, ok, requireText } from "../../http";
import { dayKey, hasManualDiscount } from "../../vendor/engine";
import {
  PHONE,
  REVIEW_COLS,
  customersWhere,
  ordersWhere,
  payoutsWhere,
  reviewsWhere,
  vehiclesWhere,
  vendorNotificationsWhere,
} from "../entities";
import { countsOf, orderBy, paged, searchPattern } from "../list";
import { branchNames, staffNames, toVendorItems } from "../lookups";
import { defaultCommissionPct, logAudit, pushAdminNotification } from "../platform";
import { vroute } from "../router";
import { type Q, db, tx } from "../sql";
import { scopeBranches } from "./scope";

const LOST_AFTER_DAYS = 60;
/** Pseudo actor id: every Carzen admin is shown to washes as one "إدارة كارزن" actor (admin names stay internal). */
const CARZEN_ACTOR = "carzen";
const PERIOD_DAYS: Record<VendorPeriod, number> = { today: 1, "7d": 7, "30d": 30 };
const EMPTY_SQL = `'{"ar":"—","en":"—"}'::jsonb`;
/** Primary service name of order `o` (first primary item, else the first item) — SQL for `serviceName(o)`. */
const PRIMARY_ITEM = (alias: string) =>
  `(select i.name from public.order_items i where i.order_id = ${alias}.id order by (i.type <> 'primary'), i.position limit 1)`;

// ── Pure helpers (same math as ../../vendor/insights.ts) ──────────────────────

/**
 * Segment from a customer's orders (newest first). Equivalent to the mock's
 * `segmentOf`: lost when the last completed visit is older than 60 days,
 * otherwise returning with 2+ completed visits, else new.
 */
function segmentOf(visits: Order[]): CustomerSegment {
  const completed = visits.filter((o) => o.status === "completed");
  const last = completed[0]?.scheduledAt;
  if (last && (now().getTime() - new Date(last).getTime()) / 86400000 > LOST_AFTER_DAYS) return "lost";
  return completed.length >= 2 ? "returning" : "new";
}

function favorite(orders: Order[]): { name: Localized; count: number }[] {
  const m = new Map<string, { name: Localized; count: number }>();
  orders
    .filter((o) => o.status === "completed")
    .forEach((o) => {
      const p = o.items.find((i) => i.type === "primary") ?? o.items[0];
      const cur = m.get(p.name.ar) ?? { name: p.name, count: 0 };
      cur.count += 1;
      m.set(p.name.ar, cur);
    });
  return [...m.values()].sort((a, b) => b.count - a.count);
}

function money(n: number) {
  return Math.round(n);
}

// ── Customers (alias w over the per-customer aggregate) ──────────────────────

/**
 * Customers with at least one order in `branchIds`, shaped as `VendorCustomer`
 * (visits, spend and segment over those branches only — same as `customersOf`).
 */
function customersBase(q: Q, branchIds: string[], search: string | null) {
  const lostBefore = new Date(now().getTime() - LOST_AFTER_DAYS * 86400000).toISOString();
  return q`
    select cu.id, cu.name, ${q.unsafe(PHONE("cu.phone"))} as phone,
      coalesce((select json_agg(v.plate order by v.created_at, v.id) from public.vehicles v where v.customer_id = cu.id), '[]') as plates,
      sc.visits, sc."lastVisitAt", sc."firstVisitAt", sc."totalSpent",
      case when sc."lastVisitAt" < ${lostBefore} then 'lost' when sc.visits >= 2 then 'returning' else 'new' end as segment,
      (select f.name from (
         select (array_agg(pi.name order by o2.scheduled_at desc))[1] as name, count(*) as n, max(o2.scheduled_at) as last
         from public.orders o2 cross join lateral ${q.unsafe(PRIMARY_ITEM("o2"))} as pi(name)
         where o2.customer_id = cu.id and o2.branch_id = any(${branchIds}) and o2.status = 'completed'
         group by pi.name ->> 'ar'
       ) f order by f.n desc, f.last desc limit 1) as "favoriteService"
    from (
      select o.customer_id as id,
             (count(*) filter (where o.status = 'completed'))::int as visits,
             max(o.scheduled_at) filter (where o.status = 'completed') as "lastVisitAt",
             min(o.scheduled_at) filter (where o.status = 'completed') as "firstVisitAt",
             coalesce(sum(o.total) filter (where o.status = 'completed' and o.payment_status = 'paid'), 0) as "totalSpent"
      from public.orders o
      where o.customer_id is not null and o.branch_id = any(${branchIds})
      group by o.customer_id
    ) sc
    join public.customers cu on cu.id = sc.id
    where true
      ${
        search
          ? q`and (cu.name ilike ${search} or ${q.unsafe(PHONE("cu.phone"))} ilike ${search}
                 or replace(${q.unsafe(PHONE("cu.phone"))}, ' ', '') ilike ${search}
                 or exists (select 1 from public.vehicles v where v.customer_id = cu.id and v.plate ilike ${search}))`
          : q``
      }`;
}

// ── Reports ──────────────────────────────────────────────────────────────────

type ReportOrder = Pick<Order, "id" | "status" | "paymentStatus" | "source" | "assignedStaffId" | "total" | "scheduledAt"> & {
  items: { name: Localized; type: string; price: number }[];
};

interface ReportInput {
  orders: ReportOrder[];
  rate: number;
  staff: { id: string; name: string; branchId: string }[];
  reviews: { orderId: string; stars: number }[];
  branchName: (id: string) => Localized;
}

/** Same report math as the mock `buildReport`, over rows loaded for one bounded period. */
function buildReport({ orders, rate, staff, reviews, branchName }: ReportInput, type: VendorReportType, from: Date, to: Date): VendorReport {
  const days = Math.max(1, Math.round((to.getTime() - from.getTime()) / 86400000));
  const dayList = Array.from({ length: days }, (_, i) => {
    const d = new Date(from);
    d.setDate(d.getDate() + i);
    return d;
  });
  const paid = orders.filter((o) => o.paymentStatus === "paid");
  const base = { type, from: from.toISOString(), to: to.toISOString() };

  switch (type) {
    case "orders": {
      const rows = dayList.map((d) => {
        const day = orders.filter((o) => isSameDay(o.scheduledAt, d));
        return {
          date: `${d.getDate()}/${d.getMonth() + 1}`,
          total: day.length,
          completed: day.filter((o) => o.status === "completed").length,
          cancelled: day.filter((o) => o.status === "cancelled").length,
          noShow: day.filter((o) => o.status === "no_show").length,
          rate: day.length ? round2((day.filter((o) => o.status === "completed").length / day.length) * 100) : 0,
        };
      });
      return {
        ...base,
        chart: rows.map((r) => ({ label: r.date, value: r.total })),
        chartKind: "bar",
        valueFormat: "number",
        columns: [
          { key: "date", label: "اليوم", format: "text" },
          { key: "total", label: "الطلبات", align: "end", format: "number" },
          { key: "completed", label: "مكتملة", align: "end", format: "number" },
          { key: "cancelled", label: "ملغاة", align: "end", format: "number" },
          { key: "noShow", label: "لم يحضر", align: "end", format: "number" },
          { key: "rate", label: "معدل الإكمال", align: "end", format: "percent" },
        ],
        rows,
        summary: [
          { label: "إجمالي الطلبات", value: orders.length, format: "number" },
          { label: "مكتملة", value: orders.filter((o) => o.status === "completed").length, format: "number" },
          {
            label: "معدل الإكمال",
            value: orders.length ? round2((orders.filter((o) => o.status === "completed").length / orders.length) * 100) : 0,
            format: "percent",
          },
          { label: "ملغاة + لم يحضر", value: orders.filter((o) => o.status === "cancelled" || o.status === "no_show").length, format: "number" },
        ],
      };
    }
    case "revenue": {
      const rows = dayList.map((d) => {
        const day = paid.filter((o) => isSameDay(o.scheduledAt, d));
        const gross = day.reduce((s, o) => s + o.total, 0);
        const commission = day.reduce((s, o) => s + (o.total * rate) / 100, 0);
        return { date: `${d.getDate()}/${d.getMonth() + 1}`, orders: day.length, gross, commission: money(commission), net: money(gross - commission) };
      });
      const gross = rows.reduce((s, r) => s + r.gross, 0);
      const commission = rows.reduce((s, r) => s + r.commission, 0);
      return {
        ...base,
        chart: rows.map((r) => ({ label: r.date, value: r.gross })),
        chartKind: "line",
        valueFormat: "money",
        columns: [
          { key: "date", label: "اليوم", format: "text" },
          { key: "orders", label: "طلبات مدفوعة", align: "end", format: "number" },
          { key: "gross", label: "الإيراد", align: "end", format: "money" },
          { key: "commission", label: "عمولة كارزن", align: "end", format: "money" },
          { key: "net", label: "الصافي", align: "end", format: "money" },
        ],
        rows,
        summary: [
          { label: "الإيراد", value: gross, format: "money" },
          { label: "عمولة كارزن", value: commission, format: "money" },
          { label: "صافي المغسلة", value: gross - commission, format: "money" },
          { label: "متوسط التذكرة", value: paid.length ? money(gross / paid.length) : 0, format: "money" },
        ],
      };
    }
    case "services": {
      const m = new Map<string, { name: string; count: number; revenue: number }>();
      orders
        .filter((o) => o.status !== "cancelled")
        .forEach((o) =>
          o.items.forEach((it) => {
            const cur = m.get(it.name.ar) ?? { name: it.name.ar, count: 0, revenue: 0 };
            cur.count += 1;
            cur.revenue += o.paymentStatus === "paid" ? it.price : 0;
            m.set(it.name.ar, cur);
          }),
        );
      const rows = [...m.values()].sort((a, b) => b.count - a.count);
      const total = rows.reduce((s, r) => s + r.count, 0) || 1;
      return {
        ...base,
        chart: rows.slice(0, 8).map((r) => ({ label: r.name, value: r.count })),
        chartKind: "bar",
        valueFormat: "number",
        columns: [
          { key: "name", label: "الخدمة", format: "text" },
          { key: "count", label: "مرات الطلب", align: "end", format: "number" },
          { key: "share", label: "النسبة", align: "end", format: "percent" },
          { key: "revenue", label: "الإيراد", align: "end", format: "money" },
        ],
        rows: rows.map((r) => ({ ...r, share: round2((r.count / total) * 100) })),
        summary: [
          { label: "الأكثر طلبًا", value: rows[0]?.count ?? 0, format: "number" },
          { label: "عدد الخدمات المطلوبة", value: rows.length, format: "number" },
          { label: "إيراد الخدمات", value: rows.reduce((s, r) => s + r.revenue, 0), format: "money" },
        ],
      };
    }
    case "source": {
      const labels = { app: "التطبيق", walk_in: "حضور مباشر", phone: "هاتفي" } as const;
      const rows = (["app", "walk_in", "phone"] as const).map((src) => {
        const list = orders.filter((o) => o.source === src);
        return {
          source: labels[src],
          orders: list.length,
          completed: list.filter((o) => o.status === "completed").length,
          revenue: list.filter((o) => o.paymentStatus === "paid").reduce((s, o) => s + o.total, 0),
          share: orders.length ? round2((list.length / orders.length) * 100) : 0,
        };
      });
      return {
        ...base,
        chart: rows.map((r) => ({ label: r.source, value: r.orders })),
        chartKind: "donut",
        valueFormat: "number",
        columns: [
          { key: "source", label: "المصدر", format: "text" },
          { key: "orders", label: "الطلبات", align: "end", format: "number" },
          { key: "share", label: "النسبة", align: "end", format: "percent" },
          { key: "completed", label: "مكتملة", align: "end", format: "number" },
          { key: "revenue", label: "الإيراد", align: "end", format: "money" },
        ],
        rows,
        summary: rows.map((r) => ({ label: r.source, value: r.share, format: "percent" as const })),
      };
    }
    case "employees": {
      const rows = staff
        .map((s) => {
          const done = orders.filter((o) => o.assignedStaffId === s.id && o.status === "completed");
          const doneIds = new Set(done.map((o) => o.id));
          const rated = reviews.filter((r) => doneIds.has(r.orderId));
          return {
            name: s.name,
            branch: branchName(s.branchId).ar,
            completed: done.length,
            value: done.reduce((sum, o) => sum + o.total, 0),
            rating: rated.length ? round2(rated.reduce((sum, r) => sum + r.stars, 0) / rated.length) : 0,
          };
        })
        .sort((a, b) => b.completed - a.completed);
      return {
        ...base,
        chart: rows.map((r) => ({ label: r.name, value: r.completed })),
        chartKind: "bar",
        valueFormat: "number",
        columns: [
          { key: "name", label: "الموظف", format: "text" },
          { key: "branch", label: "الفرع", format: "text" },
          { key: "completed", label: "طلبات مكتملة", align: "end", format: "number" },
          { key: "value", label: "قيمة الخدمات", align: "end", format: "money" },
          { key: "rating", label: "متوسط التقييم", align: "end", format: "number" },
        ],
        rows,
        summary: [
          { label: "عدد الموظفين", value: rows.length, format: "number" },
          { label: "إجمالي المكتمل", value: rows.reduce((s, r) => s + r.completed, 0), format: "number" },
        ],
      };
    }
  }
}

// ── Audit (alias w over vendor-facing audit rows) ────────────────────────────

/** Audit rows the actor may see, with the actor shown the way washes see it (admins → "إدارة كارزن"). */
function auditBase(q: Q, branchIds: string[], businessId: string, isOwner: boolean) {
  return q`
    select al.id, al.actor_type as "actorType", al.actor_id as "rawActorId",
      case when al.actor_type = 'admin' then ${CARZEN_ACTOR} else al.actor_id end as "actorId",
      case when al.actor_type = 'admin' then 'إدارة كارزن'
           when al.actor_type = 'system' then 'النظام'
           else coalesce(al.actor_name, (select s.name from public.staff s where s.id = al.actor_id), al.actor_id) end as "actorName",
      al.action, al.entity, al.entity_id as "entityId", al.branch_id as "branchId", al.old_value as "oldValue",
      al.new_value as "newValue", al.reason, al.at,
      (select br.name from public.branches br where br.id = al.branch_id) as "branchName"
    from public.audit_logs al
    where (al.branch_id = any(${branchIds})
        or al.entity_id in (select o.id from public.orders o where o.branch_id = any(${branchIds}))
        or al.entity_id = ${businessId}
        ${
          isOwner
            ? q`or (al.actor_type = 'staff' and al.actor_id in (select s.id from public.staff s where s.business_id = ${businessId}))`
            : q``
        })`;
}

const AUDIT_ITEM_COLS = `w.id, w."actorType", w."actorId", w."actorName", w.action, w.entity, w."entityId", w."branchId",
  w."oldValue", w."newValue", w.reason, w.at, w."branchName"`;

export const vendorInsightRoutes = [
  // ── Customers / CRM (D12 / OW-19) ────────────────────────
  vroute("GET", "/vendor/customers", async ({ query, actor }) => {
    const sql = db();
    const branchIds = scopeBranches(actor, query.get("branchId"));
    const segment = query.get("segment");
    const base = customersBase(sql, branchIds, searchPattern(query));
    const filter = segment && segment !== "all" ? sql`where w.segment = ${segment}` : sql``;

    const [countRows, [{ total }]] = await Promise.all([
      sql<{ k: string; n: number }[]>`with w as (${base}) select w.segment as k, count(*)::int as n from w group by w.segment`,
      sql<{ total: number }[]>`with w as (${base}) select count(*)::int as total from w ${filter}`,
    ]);
    const sort = orderBy(
      sql,
      query,
      { name: `w.name collate "C"`, visits: "w.visits", totalSpent: `w."totalSpent"`, lastVisitAt: `w."lastVisitAt"` },
      { key: "lastVisitAt", order: "desc" },
      "w.id",
    );
    const { items, pagination } = await paged(query, total, 15, (limit, offset) =>
      sql<VendorCustomer[]>`with w as (${base}) select * from w ${filter} ${sort} limit ${limit} offset ${offset}`,
    );
    return ok(items, "OK", { pagination, meta: { counts: countsOf(countRows, ["new", "returning", "lost"] as const) } });
  }),

  vroute("GET", "/vendor/customers/:id", async ({ params, actor }) => {
    const sql = db();
    const [orders, [customer], vehicles, reviews] = await Promise.all([
      ordersWhere(sql, sql`o.customer_id = ${params.id} and o.branch_id = any(${actor.branchIds})`, sql`order by o.scheduled_at desc, o.id`),
      customersWhere(sql, sql`cu.id = ${params.id}`),
      vehiclesWhere(sql, sql`v.customer_id = ${params.id}`, sql`order by v.created_at, v.id`),
      reviewsWhere(sql, sql`r.customer_id = ${params.id} and r.branch_id = any(${actor.branchIds})`, sql`order by r.created_at desc, r.id`),
    ]);
    if (!customer || !orders.length) throw new MockApiError("العميل غير موجود ضمن عملاء مغسلتك", 404);
    const completed = orders.filter((o) => o.status === "completed");
    const spent = completed.filter((o) => o.paymentStatus === "paid").reduce((s, o) => s + o.total, 0);
    const details: VendorCustomerDetails = {
      customer,
      vehicles,
      orders: await toVendorItems(sql, orders),
      favoriteServices: favorite(orders),
      reviews,
      stats: {
        visits: completed.length,
        totalSpent: spent,
        avgTicket: completed.length ? Math.round(spent / completed.length) : 0,
        noShows: orders.filter((o) => o.status === "no_show").length,
        cancellations: orders.filter((o) => o.status === "cancelled").length,
        segment: segmentOf(orders),
      },
    };
    return ok(details);
  }),

  // ── Reviews (D13 / OW-20) ────────────────────────────────
  vroute("GET", "/vendor/reviews", async ({ query, actor }) => {
    const sql = db();
    const branchIds = scopeBranches(actor, query.get("branchId"));
    const stars = query.get("stars");
    const replied = query.get("replied");
    const search = searchPattern(query);
    const starsN = Number(stars);

    const base = sql`
      select ${sql.unsafe(REVIEW_COLS)}, coalesce(cu.name, '—') as "customerName",
        coalesce(br.name, ${sql.unsafe(EMPTY_SQL)}) as "branchName", coalesce(sv.name, ${sql.unsafe(EMPTY_SQL)}) as "serviceName",
        od.number as "orderNumber"
      from public.reviews r
      left join public.customers cu on cu.id = r.customer_id
      left join public.branches br on br.id = r.branch_id
      left join public.services sv on sv.id = r.service_id
      left join public.orders od on od.id = r.order_id
      where r.branch_id = any(${branchIds}) and r.status = 'visible'`;
    const where = sql`
      where true
        ${!stars || stars === "all" ? sql`` : Number.isInteger(starsN) ? sql`and w.stars = ${starsN}` : sql`and false`}
        ${replied === "yes" ? sql`and coalesce(w.reply, '') <> ''` : replied && replied !== "all" ? sql`and coalesce(w.reply, '') = ''` : sql``}
        ${search ? sql`and (w.comment ->> 'ar' ilike ${search} or w."customerName" ilike ${search} or w."orderNumber" ilike ${search})` : sql``}`;

    const [[stats], [{ total }]] = await Promise.all([
      sql<{ count: number; sum: number; s1: number; s2: number; s3: number; s4: number; s5: number; unreplied: number; reported: number }[]>`
        select count(*)::int as count, coalesce(sum(stars), 0)::int as sum,
               (count(*) filter (where stars = 1))::int as s1, (count(*) filter (where stars = 2))::int as s2,
               (count(*) filter (where stars = 3))::int as s3, (count(*) filter (where stars = 4))::int as s4,
               (count(*) filter (where stars = 5))::int as s5,
               (count(*) filter (where coalesce(reply, '') = ''))::int as unreplied,
               (count(*) filter (where reported_by_wash))::int as reported
        from public.reviews where branch_id = any(${branchIds}) and status = 'visible'`,
      sql<{ total: number }[]>`with w as (${base}) select count(*)::int as total from w ${where}`,
    ]);
    const sort = orderBy(sql, query, { createdAt: `w."createdAt"`, stars: "w.stars" }, { key: "createdAt", order: "desc" }, `w."createdAt" desc, w.id`);
    const { items, pagination } = await paged(query, total, 10, (limit, offset) =>
      sql<VendorReview[]>`with w as (${base}) select * from w ${where} ${sort} limit ${limit} offset ${offset}`,
    );
    return ok(items, "OK", {
      pagination,
      meta: {
        average: stats.count ? round2(stats.sum / stats.count) : 0,
        count: stats.count,
        distribution: { "1": stats.s1, "2": stats.s2, "3": stats.s3, "4": stats.s4, "5": stats.s5 },
        unreplied: stats.unreplied,
        reported: stats.reported,
      },
    });
  }),

  vroute("POST", "/vendor/reviews/:id/reply", async ({ params, body, actor }) => {
    const review = await tx(async (t) => {
      const [current] = await reviewsWhere(t, t`r.id = ${params.id} and r.branch_id = any(${actor.branchIds}) and r.status = 'visible'`);
      if (!current) throw new MockApiError("التقييم غير موجود", 404);
      if (current.reply) throw new MockApiError("تم الرد على هذا التقييم مسبقًا (رد واحد لكل تقييم)", 409);
      const text = requireText(body.text, "text", "نص الرد", 5);
      if (text.length > 400) throw new MockApiError("الرد طويل جدًا (400 حرف كحد أقصى)", 422);
      // Guard in the WHERE clause: one reply per review even under concurrent requests.
      const updated = await t`
        update public.reviews set reply = ${text}, reply_at = now()
        where id = ${current.id} and reply is null and status = 'visible' returning id`;
      if (!updated.length) throw new MockApiError("تم الرد على هذا التقييم مسبقًا (رد واحد لكل تقييم)", 409);
      await logAudit(t, {
        actorType: "staff",
        actorId: actor.staff.id,
        action: "review.reply",
        entity: "reviews",
        entityId: current.id,
        branchId: current.branchId,
        newValue: text,
      });
      const [after] = await reviewsWhere(t, t`r.id = ${current.id}`);
      return after;
    });
    return ok(review, "تم نشر الرد — يظهر للعملاء في التطبيق");
  }),

  vroute("POST", "/vendor/reviews/:id/report", async ({ params, body, actor }) => {
    const review = await tx(async (t) => {
      const [current] = await reviewsWhere(t, t`r.id = ${params.id} and r.branch_id = any(${actor.branchIds}) and r.status = 'visible'`);
      if (!current) throw new MockApiError("التقييم غير موجود", 404);
      if (current.reportedByWash) throw new MockApiError("تم إبلاغ كارزن عن هذا التقييم مسبقًا", 409);
      const reason = requireText(body.reason, "reason", "سبب الإبلاغ", 5);
      const updated = await t`
        update public.reviews set reported_by_wash = true, report_reason = ${reason}
        where id = ${current.id} and not reported_by_wash and status = 'visible' returning id`;
      if (!updated.length) throw new MockApiError("تم إبلاغ كارزن عن هذا التقييم مسبقًا", 409);
      await logAudit(t, {
        actorType: "staff",
        actorId: actor.staff.id,
        action: "review.report",
        entity: "reviews",
        entityId: current.id,
        branchId: current.branchId,
        newValue: "reported",
        reason,
      });
      // Lands in the super admin's moderation queue (Reviews → "أبلغت عنه المغسلة").
      await pushAdminNotification(
        t,
        "critical_review",
        { ar: `${actor.business.name.ar} أبلغت عن تقييم`, en: `${actor.business.name.en} reported a review` },
        { ar: `تقييم ${current.stars} نجوم — السبب: ${reason}`, en: `${current.stars}-star review — ${reason}` },
        "/reviews?filter=reported",
      );
      const [after] = await reviewsWhere(t, t`r.id = ${current.id}`);
      return after;
    });
    return ok(review, "تم إبلاغ فريق كارزن للمراجعة");
  }),

  // ── Reports (D14 / OW-18) ────────────────────────────────
  vroute("GET", "/vendor/reports", async ({ query, actor }) => {
    const sql = db();
    const branchIds = scopeBranches(actor, query.get("branchId"));
    const type = (["orders", "revenue", "services", "source", "employees"] as const).find((t) => t === query.get("type")) ?? "orders";
    const to = query.get("to")
      ? new Date(`${query.get("to")}T23:59:59`)
      : (() => {
          const d = new Date(now());
          d.setHours(23, 59, 59, 999);
          return d;
        })();
    const from = query.get("from") ? new Date(`${query.get("from")}T00:00:00`) : daysAgo(13);
    if (to <= from) throw new MockApiError("تاريخ النهاية يجب أن يكون بعد البداية", 422);
    if ((to.getTime() - from.getTime()) / 86400000 > 92) throw new MockApiError("أقصى مدى للتقرير 3 شهور", 422);

    const isEmployees = type === "employees";
    const [orders, rate, staff, names] = await Promise.all([
      sql<ReportOrder[]>`
        select o.id, o.status, o.payment_status as "paymentStatus", o.source, o.assigned_staff_id as "assignedStaffId", o.total,
          o.scheduled_at as "scheduledAt",
          coalesce((select json_agg(json_build_object('name', i.name, 'type', i.type, 'price', i.price) order by i.position)
                    from public.order_items i where i.order_id = o.id), '[]') as items
        from public.orders o
        where o.branch_id = any(${branchIds}) and o.scheduled_at >= ${from.toISOString()} and o.scheduled_at <= ${to.toISOString()}
        order by o.scheduled_at, o.id`,
      actor.business.commissionRate ?? defaultCommissionPct(sql),
      isEmployees
        ? sql<{ id: string; name: string; branchId: string }[]>`
            select id, name, branch_id as "branchId" from public.staff
            where branch_id = any(${branchIds}) and role <> 'owner' order by joined_at, id`
        : Promise.resolve([]),
      branchNames(sql, branchIds),
    ]);
    const doneIds = isEmployees ? orders.filter((o) => o.status === "completed" && o.assignedStaffId).map((o) => o.id) : [];
    const reviews = doneIds.length
      ? await sql<{ orderId: string; stars: number }[]>`
          select order_id as "orderId", stars from public.reviews where status = 'visible' and order_id = any(${doneIds})`
      : [];
    const branchName = (id: string) => names.get(id) ?? { ar: "—", en: "—" };
    return ok(buildReport({ orders, rate, staff, reviews, branchName }, type, from, to));
  }),

  // ── Financials (D15 / OW-14) ─────────────────────────────
  vroute("GET", "/vendor/finance", async ({ query, actor }) => {
    const sql = db();
    const branchIds = scopeBranches(actor, query.get("branchId"));
    const raw = query.get("period");
    const period: VendorPeriod = raw === "today" || raw === "7d" ? raw : "30d";
    const n = PERIOD_DAYS[period];
    const from = daysAgo(n - 1);
    const until = new Date(now().getTime() + 86400000);

    type FinanceOrder = Pick<Order, "id" | "branchId" | "status" | "paymentStatus" | "paymentMethod" | "total" | "scheduledAt" | "discount" | "assignedStaffId">;
    const [inRange, pending, payouts, names, rate] = await Promise.all([
      sql<FinanceOrder[]>`
        select o.id, o.branch_id as "branchId", o.status, o.payment_status as "paymentStatus", o.payment_method as "paymentMethod",
          o.total, o.scheduled_at as "scheduledAt", o.assigned_staff_id as "assignedStaffId",
          case when o.discount_amount is null then null
               else json_build_object('amount', o.discount_amount, 'pct', coalesce(o.discount_pct, 0), 'reason', coalesce(o.discount_reason, '')) end as discount
        from public.orders o
        where o.branch_id = any(${branchIds}) and o.scheduled_at >= ${from.toISOString()} and o.scheduled_at <= ${until.toISOString()}
        order by o.scheduled_at, o.id`,
      ordersWhere(
        sql,
        sql`o.branch_id = any(${branchIds}) and o.status = 'completed' and o.payment_status = 'pending'`,
        sql`order by o.scheduled_at desc, o.id`,
      ),
      payoutsWhere(sql, sql`po.business_id = ${actor.business.id}`, sql`order by po.period_end desc, po.id`),
      branchNames(sql, branchIds),
      actor.business.commissionRate ?? defaultCommissionPct(sql),
    ]);

    const paid = inRange.filter((o) => o.paymentStatus === "paid");
    const revenue = paid.reduce((s, o) => s + o.total, 0);
    const commission = round2((revenue * rate) / 100);
    const discounted = inRange.filter((o) => hasManualDiscount(o as Order) && o.status !== "cancelled");

    // Who gave each manual discount: the latest `order.discount` audit entry, else the assigned employee.
    const logs = discounted.length
      ? await sql<{ entityId: string; actorId: string }[]>`
          select distinct on (entity_id) entity_id as "entityId", actor_id as "actorId" from public.audit_logs
          where action = 'order.discount' and entity_id = any(${discounted.map((o) => o.id)})
          order by entity_id, at desc, id desc`
      : [];
    const discountBy = new Map(logs.map((l) => [l.entityId, l.actorId]));
    const giverIds = discounted.map((o) => discountBy.get(o.id) ?? o.assignedStaffId ?? "unknown");
    const [givers, pendingItems] = await Promise.all([staffNames(sql, giverIds), toVendorItems(sql, pending)]);
    const byStaff = new Map<string, { staffId: string; name: string; count: number; amount: number }>();
    discounted.forEach((o, i) => {
      const id = giverIds[i];
      const cur = byStaff.get(id) ?? { staffId: id, name: givers.get(id) ?? "—", count: 0, amount: 0 };
      cur.count += 1;
      cur.amount += o.discount!.amount;
      byStaff.set(id, cur);
    });

    const finance: VendorFinance = {
      period,
      revenue,
      commissionRate: rate,
      commission,
      net: round2(revenue - commission),
      refunds: inRange.filter((o) => o.paymentStatus === "refunded").reduce((s, o) => s + o.total, 0),
      discounts: discounted.reduce((s, o) => s + (o.discount?.amount ?? 0), 0),
      paidOrders: paid.length,
      pendingPayments: { count: pending.length, amount: pending.reduce((s, o) => s + o.total, 0), orders: pendingItems },
      byDay: Array.from({ length: n }, (_, i) => {
        const d = daysAgo(n - 1 - i);
        return {
          label: `${d.getDate()}/${d.getMonth() + 1}`,
          date: dayKey(d),
          revenue: paid.filter((o) => isSameDay(o.scheduledAt, d)).reduce((s, o) => s + o.total, 0),
        };
      }),
      byMethod: (["cash", "card", "online"] as PaymentMethod[]).map((method) => {
        const list = paid.filter((o) => o.paymentMethod === method);
        return { method, amount: list.reduce((s, o) => s + o.total, 0), count: list.length };
      }),
      byBranch: branchIds.map((id) => {
        const list = paid.filter((o) => o.branchId === id);
        return { branchId: id, name: names.get(id) ?? { ar: "—", en: "—" }, revenue: list.reduce((s, o) => s + o.total, 0), orders: list.length };
      }),
      discountsByStaff: [...byStaff.values()].sort((a, b) => b.amount - a.amount),
      payouts,
    };
    return ok(finance);
  }),

  // ── Audit log (D17 / OW-16) ──────────────────────────────
  vroute("GET", "/vendor/audit", async ({ query, actor }) => {
    const sql = db();
    const branchIds = scopeBranches(actor, query.get("branchId"));
    const actorId = query.get("actorId");
    const action = query.get("action");
    const from = query.get("from");
    const to = query.get("to");
    const search = searchPattern(query);
    const base = auditBase(sql, branchIds, actor.business.id, actor.role === "owner");
    const where = sql`
      where true
        ${!actorId || actorId === "all" ? sql`` : actorId === CARZEN_ACTOR ? sql`and w."actorType" = 'admin'` : sql`and w."rawActorId" = ${actorId}`}
        ${!action || action === "all" ? sql`` : sql`and w.action = ${action}`}
        ${from ? sql`and w.at >= ${new Date(`${from}T00:00:00`).toISOString()}` : sql``}
        ${to ? sql`and w.at <= ${new Date(`${to}T23:59:59`).toISOString()}` : sql``}
        ${search ? sql`and (w."entityId" ilike ${search} or w.reason ilike ${search} or w."actorName" ilike ${search} or w."newValue" ilike ${search})` : sql``}`;

    const [[{ total }], actionRows, actors] = await Promise.all([
      sql<{ total: number }[]>`with w as (${base}) select count(*)::int as total from w ${where}`,
      sql<{ action: string }[]>`with w as (${base}) select distinct w.action from w`,
      sql<{ id: string; name: string }[]>`
        with w as (${base})
        select w."actorId" as id, (array_agg(w."actorName" order by w.at, w.id))[1] as name
        from w group by w."actorId" order by max(w.at) desc, w."actorId"`,
    ]);
    const { items, pagination } = await paged(query, total, 20, (limit, offset) =>
      sql<VendorAuditItem[]>`
        with w as (${base}) select ${sql.unsafe(AUDIT_ITEM_COLS)} from w ${where}
        order by w.at desc, w.id desc limit ${limit} offset ${offset}`,
    );
    return ok(items, "OK", {
      pagination,
      meta: { actions: actionRows.map((r) => r.action).sort(), actors },
    });
  }),

  // ── Notifications (D18 / OW-21) ──────────────────────────
  vroute("GET", "/vendor/notifications", async ({ query, actor }) => {
    const sql = db();
    const filter = query.get("filter");
    const mine = sql`vn.business_id = ${actor.business.id}
      and (vn.branch_id is null or vn.branch_id = any(${actor.branchIds}))
      and (vn.staff_id is null or vn.staff_id = ${actor.staff.id})`;
    const cond =
      filter === "unread" ? sql`${mine} and not vn.read` : filter && filter !== "all" ? sql`${mine} and vn.type::text = ${filter}` : mine;
    const [{ total, unread }] = await sql<{ total: number; unread: number }[]>`
      select (count(*) filter (where ${cond}))::int as total, (count(*) filter (where not vn.read))::int as unread
      from public.vendor_notifications vn where ${mine}`;
    const { items, pagination } = await paged(query, total, 20, (limit, offset) =>
      vendorNotificationsWhere(sql, cond, sql`order by vn.created_at desc, vn.id limit ${limit} offset ${offset}`),
    );
    return ok(items, "OK", { pagination, meta: { unread } });
  }),

  vroute("POST", "/vendor/notifications/:id/read", async ({ params, actor }) => {
    const notification = await tx(async (t) => {
      const updated = await t`
        update public.vendor_notifications set read = true
        where id = ${params.id} and business_id = ${actor.business.id} returning id`;
      if (!updated.length) throw new MockApiError("الإشعار غير موجود", 404);
      const [row] = await vendorNotificationsWhere(t, t`vn.id = ${params.id}`);
      return row;
    });
    return ok(notification);
  }),

  vroute("POST", "/vendor/notifications/read-all", async ({ actor }) => {
    await tx(
      (t) => t`
        update public.vendor_notifications set read = true
        where business_id = ${actor.business.id} and not read
          and (branch_id is null or branch_id = any(${actor.branchIds}))
          and (staff_id is null or staff_id = ${actor.staff.id})`,
    );
    return ok(null, "تم تعليم كل الإشعارات كمقروءة");
  }),

  // ── Global search (plate / phone / order number) ─────────
  vroute("GET", "/vendor/search", async ({ query, actor }) => {
    const q = query.get("q")?.trim() ?? "";
    if (q.length < 2) return ok({ query: q, results: [] as VendorSearchResult[] });
    const sql = db();
    const term = searchPattern(new URLSearchParams({ search: q }))!;
    const plateQ = q.replace(/[\s-]/g, "").toUpperCase();

    const [orders, plates, customers] = await Promise.all([
      sql<{ id: string; number: string; plate: string | null; service: string }[]>`
        select o.id, o.number, o.plate, coalesce(${sql.unsafe(PRIMARY_ITEM("o"))} ->> 'ar', '—') as service
        from public.orders o
        where o.branch_id = any(${actor.branchIds}) and (o.number ilike ${term} or o.code ilike ${term})
        order by o.scheduled_at desc, o.id limit 5`,
      // One row per plate: its latest order ("آخر طلب").
      sql<{ id: string; number: string; plate: string; customerId: string | null }[]>`
        select p.id, p.number, p.plate, p."customerId" from (
          select distinct on (o.plate) o.id, o.number, o.plate, o.customer_id as "customerId", o.scheduled_at
          from public.orders o
          where o.branch_id = any(${actor.branchIds}) and coalesce(o.plate, '') <> '' and strpos(o.plate, ${plateQ}) > 0
          order by o.plate, o.scheduled_at desc, o.id
        ) p order by p.scheduled_at desc, p.id limit 5`,
      sql<{ id: string; name: string; phone: string }[]>`
        select cu.id, cu.name, ${sql.unsafe(PHONE("cu.phone"))} as phone
        from public.customers cu
        join (select o.customer_id, max(o.scheduled_at) as last from public.orders o
              where o.customer_id is not null and o.branch_id = any(${actor.branchIds}) group by o.customer_id) c on c.customer_id = cu.id
        where cu.name ilike ${term} or ${sql.unsafe(PHONE("cu.phone"))} ilike ${term} or replace(${sql.unsafe(PHONE("cu.phone"))}, ' ', '') ilike ${term}
        order by c.last desc, cu.id limit 5`,
    ]);

    const results: VendorSearchResult[] = [
      ...orders.map((o) => ({ id: o.id, group: "orders" as const, title: o.number, subtitle: `${o.plate} · ${o.service}`, href: `/orders/${o.id}` })),
      ...plates.map((o) => ({
        id: o.id,
        group: "plates" as const,
        title: o.plate,
        subtitle: `آخر طلب ${o.number}`,
        href: o.customerId ? `/customers/${o.customerId}` : `/orders/${o.id}`,
      })),
      ...customers.map((c) => ({ id: c.id, group: "customers" as const, title: c.name, subtitle: c.phone, href: `/customers/${c.id}` })),
    ];
    return ok({ query: q, results });
  }),
];
