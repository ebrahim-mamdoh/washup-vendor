import "server-only";

import type { CustomerDetails, CustomerListItem } from "@/types/customers";

import { daysAgo, round2 } from "../../db";
import { MockApiError, ok, requireText } from "../../http";
import {
  CUSTOMER_COLS,
  PHONE,
  auditWhere,
  complaintsWhere,
  customerById,
  ordersWhere,
  reviewsWhere,
  vehiclesWhere,
} from "../entities";
import { orderBy, paged, searchPattern } from "../list";
import { toOrderListItems } from "../lookups";
import { logAudit } from "../platform";
import { route } from "../router";
import { db, tx } from "../sql";

const HIGH_ACTIVITY_MIN_ORDERS = 6;

export const customerRoutes = [
  route("GET", "/admin/customers", async ({ query }) => {
    const sql = db();
    const filter = query.get("filter") ?? "all";
    const weekAgo = daysAgo(7).toISOString();
    const search = searchPattern(query);

    // Search matches the name, the phone with or without spaces (E.164 = display format
    // without spaces) and any of the customer's plates.
    const base = sql`
      select ${sql.unsafe(CUSTOMER_COLS)}, vs."vehiclesCount", vs.plates, os."ordersCount", os."completedCount", os."totalSpent"
      from public.customers cu
      cross join lateral (
        select count(*)::int as "vehiclesCount", coalesce(json_agg(v.plate order by v.created_at, v.id), '[]') as plates
        from public.vehicles v where v.customer_id = cu.id) vs
      cross join lateral (
        select count(*)::int as "ordersCount",
               (count(*) filter (where o.status = 'completed'))::int as "completedCount",
               coalesce(sum(o.total) filter (where o.status = 'completed'), 0) as "totalSpent"
        from public.orders o where o.customer_id = cu.id) os
      where true
        ${search ? sql`and (cu.name ilike ${search} or cu.phone ilike ${search} or ${sql.unsafe(PHONE("cu.phone"))} ilike ${search}
                         or exists (select 1 from public.vehicles v where v.customer_id = cu.id and v.plate ilike ${search}))` : sql``}`;

    const where =
      filter === "active" || filter === "suspended"
        ? sql`where w.status = ${filter}`
        : filter === "new"
          ? sql`where w."createdAt" >= ${weekAgo}`
          : filter === "high_activity"
            ? sql`where w."ordersCount" >= ${HIGH_ACTIVITY_MIN_ORDERS}`
            : sql``;

    const [[counts], [{ total }]] = await Promise.all([
      sql<{ all: number; active: number; suspended: number; new: number; high_activity: number }[]>`
        with w as (${base})
        select count(*)::int as all,
               (count(*) filter (where w.status = 'active'))::int as active,
               (count(*) filter (where w.status = 'suspended'))::int as suspended,
               (count(*) filter (where w."createdAt" >= ${weekAgo}))::int as new,
               (count(*) filter (where w."ordersCount" >= ${HIGH_ACTIVITY_MIN_ORDERS}))::int as high_activity
        from w`,
      sql<{ total: number }[]>`with w as (${base}) select count(*)::int as total from w ${where}`,
    ]);
    const sort = orderBy(
      sql,
      query,
      {
        name: `w.name collate "C"`,
        ordersCount: `w."ordersCount"`,
        completedCount: `w."completedCount"`,
        totalSpent: `w."totalSpent"`,
        lastActiveAt: `w."lastActiveAt"`,
        createdAt: `w."createdAt"`,
      },
      { key: filter === "high_activity" ? "ordersCount" : "lastActiveAt", order: "desc" },
      "w.id",
    );
    const { items, pagination } = await paged(query, total, 12, (limit, offset) =>
      sql<CustomerListItem[]>`with w as (${base}) select * from w ${where} ${sort} limit ${limit} offset ${offset}`,
    );
    return ok(items, "OK", { pagination, meta: { counts } });
  }),

  route("GET", "/admin/customers/:id", async ({ params }) => {
    const sql = db();
    const customer = await customerById(sql, params.id);

    const [vehicles, orderRows, reviews, complaints, auditLogs] = await Promise.all([
      vehiclesWhere(sql, sql`v.customer_id = ${customer.id}`, sql`order by v.created_at, v.id`),
      ordersWhere(sql, sql`o.customer_id = ${customer.id}`, sql`order by o.scheduled_at desc, o.id`),
      reviewsWhere(sql, sql`r.customer_id = ${customer.id}`, sql`order by r.created_at desc, r.id`),
      complaintsWhere(sql, sql`c.customer_id = ${customer.id}`, sql`order by c.created_at, c.id`),
      auditWhere(sql, sql`al.entity_id = ${customer.id}`, sql`order by al.at desc`),
    ]);
    const orders = await toOrderListItems(sql, orderRows);
    const completed = orders.filter((o) => o.status === "completed");

    const details: CustomerDetails = {
      customer,
      vehicles,
      orders,
      reviews,
      complaints,
      auditLogs,
      stats: {
        ordersCount: orders.length,
        completedCount: completed.length,
        cancelledCount: orders.filter((o) => o.status === "cancelled").length,
        noShowCount: orders.filter((o) => o.status === "no_show").length,
        totalSpent: completed.reduce((s, o) => s + o.total, 0),
        avgRating: reviews.length ? round2(reviews.reduce((s, r) => s + r.stars, 0) / reviews.length) : null,
      },
    };
    return ok(details);
  }),

  route("POST", "/admin/customers/:id/status", async ({ params, body, admin }) => {
    const customer = await tx(async (t) => {
      const current = await customerById(t, params.id);
      const suspended = Boolean(body.suspended);
      if ((current.status === "suspended") === suspended) {
        throw new MockApiError(suspended ? "الحساب موقوف بالفعل" : "الحساب نشط بالفعل", 409);
      }
      const reason = requireText(body.reason, "reason", "السبب", 5);
      const status = suspended ? "suspended" : "active";

      // Status guard: a concurrent toggle can't apply twice.
      const updated = await t`
        update public.customers set status = ${status}, status_reason = ${suspended ? reason : null}
        where id = ${current.id} and status = ${current.status} returning id`;
      if (!updated.length) throw new MockApiError(suspended ? "الحساب موقوف بالفعل" : "الحساب نشط بالفعل", 409);

      await logAudit(t, {
        actorId: admin.id,
        action: suspended ? "suspend_customer" : "reactivate_customer",
        entity: "customers",
        entityId: current.id,
        oldValue: current.status,
        newValue: status,
        reason,
      });
      return customerById(t, current.id);
    });
    return ok(
      customer,
      customer.status === "suspended" ? `تم إيقاف حساب ${customer.name}` : `تمت إعادة تفعيل حساب ${customer.name}`,
    );
  }),
];
