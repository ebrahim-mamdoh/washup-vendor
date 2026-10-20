import "server-only";

import type { Order } from "@/types/orders";
import type {
  LiveBoard,
  OrderActionPayload,
  ScheduleDay,
  VendorOrderDetails,
  VendorOrderListItem,
} from "@/types/vendor/operations";
import type postgres from "postgres";

import { isSameDay, now } from "../../db";
import { MockApiError, ok, requireText } from "../../http";
import { serviceName } from "../../lookups";
import { cleanOrderPayload, clockToMin, dayKey, hoursFor, nextActionFor, parseDay } from "../../vendor/engine";
import {
  PHONE,
  auditWhere,
  branchById,
  branchesWhere,
  customersWhere,
  orderById,
  ordersWhere,
  paymentsWhere,
  reviewsWhere,
  servicesWhere,
  staffWhere,
  vehiclesWhere,
} from "../entities";
import { dayBounds, orderBy, paged, searchPattern } from "../list";
import { onShiftAt, staffNames, toVendorItems } from "../lookups";
import { logAudit } from "../platform";
import { vroute } from "../router";
import { type Q, db, tx } from "../sql";
import {
  OCCUPYING_SQL,
  allowedActions,
  availability,
  busyBays,
  createOrder,
  lockOrderInScope,
  occupancyBetween,
  overlapping,
  performAction,
  priceServices,
  recognizeForWash,
} from "./engine";
import { assertBranch, scopeBranches, singleBranch } from "./scope";

type Frag = postgres.Fragment;

const BOOKING_TABS = ["today", "upcoming", "completed", "cancelled", "no_show"];
const ORDER_TABS = ["active", "waiting", "in_service", "payment_pending", "paid", "all"];

/** Tab predicates for the two list views (spec D4 bookings / D5 orders), as SQL over alias o. */
function tabWhere(q: Q, tab: string): Frag {
  const [todayStart, todayEnd] = dayBounds(now());
  const endOfToday = new Date(new Date(todayEnd).getTime() - 1).toISOString();
  switch (tab) {
    // bookings view (app + phone)
    case "today":
      return q`(o.scheduled_at >= ${todayStart} and o.scheduled_at < ${todayEnd})`;
    case "upcoming":
      return q`(o.scheduled_at > ${endOfToday} and o.status in ('pending', 'confirmed'))`;
    case "completed":
      return q`o.status = 'completed'`;
    case "cancelled":
      return q`o.status = 'cancelled'`;
    case "no_show":
      return q`o.status = 'no_show'`;
    // orders view (all sources)
    case "active":
      return q`(o.status in ('waiting', 'in_service') or (o.status = 'completed' and o.payment_status = 'pending'))`;
    case "waiting":
      return q`o.status = 'waiting'`;
    case "in_service":
      return q`o.status = 'in_service'`;
    case "payment_pending":
      return q`(o.status = 'completed' and o.payment_status = 'pending')`;
    case "paid":
      return q`(o.status = 'completed' and o.payment_status <> 'pending')`;
    default:
      return q`true`;
  }
}

/** `?date=YYYY-MM-DD` → the server-local day, as an `o.scheduled_at` range (an invalid date matches nothing, like the mock). */
function dateWhere(q: Q, date: string | null): Frag {
  if (!date) return q``;
  const start = new Date(`${date}T00:00:00`);
  if (Number.isNaN(start.getTime()) || dayKey(start) !== date) return q`and false`;
  const [from, to] = dayBounds(start);
  return q`and o.scheduled_at >= ${from} and o.scheduled_at < ${to}`;
}

/** `?date=` of the schedule/availability screens (noon avoids DST edges), today by default. */
const dayParam = (raw: string | null) => (raw ? parseDay(raw) : now());

export const vendorOperationRoutes = [
  vroute("GET", "/vendor/orders", async ({ query, actor }) => {
    const sql = db();
    const branchIds = scopeBranches(actor, query.get("branchId"));
    const view = query.get("view") === "bookings" ? "bookings" : "orders";
    const tabs = view === "bookings" ? BOOKING_TABS : ORDER_TABS;
    const tab = tabs.includes(query.get("tab") ?? "") ? query.get("tab")! : tabs[0];
    const source = query.get("source");
    const staffId = query.get("staffId");
    const search = searchPattern(query);

    const base = sql`
      o.branch_id = any(${branchIds})
      ${view === "bookings" ? sql`and o.source <> 'walk_in'` : sql``}
      ${source && source !== "all" ? sql`and o.source::text = ${source}` : sql``}
      ${staffId && staffId !== "all" ? sql`and o.assigned_staff_id = ${staffId}` : sql``}
      ${dateWhere(sql, query.get("date"))}
      ${
        search
          ? sql`and (o.number ilike ${search} or o.code ilike ${search} or o.plate ilike ${search}
              or exists (select 1 from public.customers cu where cu.id = o.customer_id and (cu.name ilike ${search}
                or ${sql.unsafe(PHONE("cu.phone"))} ilike ${search} or replace(${sql.unsafe(PHONE("cu.phone"))}, ' ', '') ilike ${search})))`
          : sql``
      }`;
    const filter = sql`${base} and ${tabWhere(sql, tab)}`;

    const [[counts], [{ total, amount }]] = await Promise.all([
      sql<Record<string, number>[]>`
        select count(*)::int as "__all" ${tabs.map((t) => sql`, (count(*) filter (where ${tabWhere(sql, t)}))::int as ${sql(t)}`)}
        from public.orders o where ${base}`,
      sql<{ total: number; amount: number }[]>`
        select count(*)::int as total, coalesce(sum(o.total), 0) as amount from public.orders o where ${filter}`,
    ]);
    const chronological = tab === "today" || tab === "upcoming" || tab === "waiting" || tab === "active";
    const sort = orderBy(
      sql,
      query,
      { scheduledAt: "o.scheduled_at", total: "o.total", number: "o.number", status: "o.status::text" },
      { key: "scheduledAt", order: chronological ? "asc" : "desc" },
      "o.id",
    );
    const { items, pagination } = await paged(query, total, 15, async (limit, offset) =>
      toVendorItems(sql, await ordersWhere(sql, filter, sql`${sort} limit ${limit} offset ${offset}`)),
    );
    return ok(items, "OK", {
      pagination,
      meta: { counts: Object.fromEntries(tabs.map((t) => [t, counts[t] ?? 0])), totalAmount: amount },
    });
  }),

  vroute("GET", "/vendor/orders/:id", async ({ params, actor }) => {
    const sql = db();
    const [order] = await ordersWhere(sql, sql`(o.id = ${params.id} or o.number = ${params.id})`, sql`order by (o.id = ${params.id}) desc limit 1`);
    if (!order || !actor.branchIds.includes(order.branchId)) throw new MockApiError("الطلب غير موجود", 404);
    const authorIds = order.notes.map((n) => n.authorId).filter((x): x is string => Boolean(x));
    const itemIds = order.items.map((i) => i.serviceId).filter(Boolean);

    const [branch, [customer], [vehicle], staff, [payment], [review], auditLogs, authors, availableAddons, assignable] = await Promise.all([
      branchById(sql, order.branchId),
      order.customerId ? customersWhere(sql, sql`cu.id = ${order.customerId}`) : Promise.resolve([]),
      order.vehicleId ? vehiclesWhere(sql, sql`v.id = ${order.vehicleId}`) : Promise.resolve([]),
      staffNames(sql, [order.assignedStaffId]),
      paymentsWhere(sql, sql`p.order_id = ${order.id}`, sql`order by p.collected_at, p.id limit 1`),
      reviewsWhere(sql, sql`r.order_id = ${order.id}`, sql`order by r.created_at, r.id limit 1`),
      auditWhere(sql, sql`al.entity_id = ${order.id}`, sql`order by al.at desc, al.id desc`),
      staffNames(sql, authorIds),
      servicesWhere(
        sql,
        sql`sv.branch_id = ${order.branchId} and sv.type = 'addon' and sv.active and not (sv.id = any(${itemIds}))`,
        sql`order by sv.id`,
      ),
      staffWhere(sql, sql`st.branch_id = ${order.branchId} and st.status = 'active' and st.role <> 'owner'`, sql`order by st.id`),
    ]);
    const staffName = order.assignedStaffId ? staff.get(order.assignedStaffId) : undefined;

    const details: VendorOrderDetails = {
      order,
      customer: customer ?? null,
      vehicle: vehicle ?? null,
      branch,
      staff: order.assignedStaffId && staffName ? { id: order.assignedStaffId, name: staffName } : null,
      payment: payment ?? null,
      review: review ?? null,
      auditLogs,
      noteAuthors: Object.fromEntries(authorIds.map((id) => [id, authors.get(id) ?? "—"])),
      availableAddons,
      assignableStaff: assignable.map((s) => ({ id: s.id, name: s.name })),
      allowedActions: allowedActions(actor, order, branch.settings.noShowGraceMin ?? 15),
      nextAction: nextActionFor(order),
      maxDiscountPct: actor.staff.maxDiscountPct,
      locked: Boolean(order.closedInDayId),
    };
    return ok(details);
  }),

  vroute("POST", "/vendor/orders", async ({ body, actor }) => {
    const payload = cleanOrderPayload(body);
    if (payload.source !== "phone" && payload.source !== "walk_in") throw new MockApiError("نوع الطلب غير صالح", 422);
    assertBranch(actor, payload.branchId);
    const { item, wait } = await tx(async (t) => {
      const id = await createOrder(t, actor, payload);
      const order = await orderById(t, id);
      const [busy, [{ capacity }]] = await Promise.all([
        busyBays(t, order.branchId),
        t<{ capacity: number }[]>`select capacity from public.branches where id = ${order.branchId}`,
      ]);
      const [vendorItem] = await toVendorItems(t, [order]);
      return { item: vendorItem, wait: order.source === "walk_in" && busy >= capacity };
    });
    return ok(item, `تم إنشاء الطلب ${item.number}${wait ? " — كل الأماكن مشغولة، الانتظار المتوقع ~20 دقيقة" : ""}`);
  }),

  vroute("POST", "/vendor/orders/:id/actions", async ({ params, body, actor }) => {
    const { item, message } = await tx(async (t) => {
      const order = await lockOrderInScope(t, actor, params.id);
      if (!order) throw new MockApiError("الطلب غير موجود", 404);
      const msg = await performAction(t, actor, order, body as unknown as OrderActionPayload);
      const [vendorItem] = await toVendorItems(t, [await orderById(t, order.id)]);
      return { item: vendorItem, message: msg };
    });
    return ok(item, message);
  }),

  vroute("POST", "/vendor/orders/bulk-confirm", async ({ body, actor }) => {
    const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
    if (!ids.length) throw new MockApiError("اختر حجزًا واحدًا على الأقل", 422);
    const confirmed = await tx(async (t) => {
      let n = 0;
      for (const id of ids) {
        const order = await lockOrderInScope(t, actor, id);
        if (!order || order.status !== "pending") continue;
        await performAction(t, actor, order, { action: "confirm" });
        n += 1;
      }
      if (!n) throw new MockApiError("لا توجد حجوزات بانتظار التأكيد ضمن الاختيار", 409);
      return n;
    });
    return ok({ confirmed }, `تم تأكيد ${confirmed} حجز`);
  }),

  vroute("GET", "/vendor/price-preview", async ({ query, actor }) => {
    const branchId = singleBranch(actor, query.get("branchId"));
    const ids = (query.get("serviceIds") ?? "").split(",").filter(Boolean);
    return ok(await priceServices(db(), branchId, ids));
  }),

  vroute("GET", "/vendor/recognize", async ({ query, actor }) =>
    ok(await recognizeForWash(db(), actor.business.id, query.get("plate"), query.get("phone"))),
  ),

  vroute("GET", "/vendor/availability", async ({ query, actor }) => {
    const sql = db();
    const branchId = singleBranch(actor, query.get("branchId"));
    const ids = (query.get("serviceIds") ?? "").split(",").filter(Boolean);
    const [branch, duration] = await Promise.all([
      branchById(sql, branchId),
      ids.length ? priceServices(sql, branchId, ids).then((p) => p.durationMin) : Promise.resolve(30),
    ]);
    return ok(await availability(sql, branch, dayParam(query.get("date")), duration));
  }),

  vroute("GET", "/vendor/live", async ({ query, actor }) => {
    const sql = db();
    const branchIds = scopeBranches(actor, query.get("branchId"));
    const at = now();
    const [todayStart, todayEnd] = dayBounds(at);
    // Only what the board shows: today's orders plus every car still inside or unpaid.
    const [orders, branches, shifts] = await Promise.all([
      ordersWhere(
        sql,
        sql`o.branch_id = any(${branchIds}) and ((o.scheduled_at >= ${todayStart} and o.scheduled_at < ${todayEnd})
            or o.status in ('waiting', 'in_service') or (o.status = 'completed' and o.payment_status = 'pending'))`,
        sql`order by o.created_at, o.id`,
      ),
      branchesWhere(sql, sql`br.id = any(${branchIds})`),
      Promise.all(branchIds.map((id) => onShiftAt(sql, id, at))),
    ]);
    const today = orders.filter((o) => isSameDay(o.scheduledAt, at));
    const byTime = (a: Order, b: Order) => a.scheduledAt.localeCompare(b.scheduledAt);
    const columns = {
      upcoming: today.filter((o) => o.status === "pending" || o.status === "confirmed").sort(byTime),
      waiting: orders.filter((o) => o.status === "waiting").sort(byTime),
      in_service: orders.filter((o) => o.status === "in_service"),
      payment_pending: orders.filter((o) => o.status === "completed" && o.paymentStatus === "pending"),
      done: today
        .filter((o) => o.status === "completed" && o.paymentStatus !== "pending")
        .sort((a, b) => b.scheduledAt.localeCompare(a.scheduledAt))
        .slice(0, 12),
    };
    const items = new Map((await toVendorItems(sql, Object.values(columns).flat(), at)).map((i) => [i.id, i]));
    const map = (list: Order[]): VendorOrderListItem[] => list.map((o) => items.get(o.id)!);
    const board: LiveBoard = {
      branchId: query.get("branchId") ?? "all",
      generatedAt: at.toISOString(),
      columns: {
        upcoming: map(columns.upcoming),
        waiting: map(columns.waiting),
        in_service: map(columns.in_service),
        payment_pending: map(columns.payment_pending),
        done: map(columns.done),
      },
      bays: {
        busy: columns.in_service.length,
        capacity: branches.reduce((s, b) => s + b.capacity, 0),
      },
      staffOnShift: shifts.flat().map((s) => ({ id: s.id, name: s.name })),
    };
    return ok(board);
  }),

  vroute("GET", "/vendor/schedule", async ({ query, actor }) => {
    const sql = db();
    const branchId = singleBranch(actor, query.get("branchId"));
    const branch = await branchById(sql, branchId);
    const date = dayParam(query.get("date"));
    const hours = hoursFor(branch, date);
    const step = branch.settings.slotIntervalMin || 30;
    const slots: ScheduleDay["slots"] = [];
    if (!hours.closed) {
      const slotStart = (m: number) => {
        const start = new Date(date);
        start.setHours(0, 0, 0, 0);
        start.setMinutes(m);
        return start;
      };
      const open = clockToMin(hours.open);
      const close = clockToMin(hours.close, true);
      // One query for the day's occupying orders, then the same per-slot overlap as the mock.
      const orders = await ordersWhere(
        sql,
        sql`o.branch_id = ${branchId} and ${sql.unsafe(OCCUPYING_SQL)} and o.scheduled_at < ${slotStart(close + step).toISOString()}
            and o.scheduled_at + o.duration_min * interval '1 minute' > ${slotStart(open).toISOString()}`,
        sql`order by o.created_at, o.id`,
      );
      const at = now().getTime();
      for (let m = open; m < close; m += step) {
        const start = slotStart(m);
        const end = new Date(start.getTime() + step * 60000);
        const inSlot = overlapping(orders, start, end);
        slots.push({
          start: start.toISOString(),
          occupied: inSlot.length,
          capacity: branch.capacity,
          blocked: branch.blockedSlots.find((b) => new Date(b.start) < end && new Date(b.end) > start) ?? null,
          past: end.getTime() <= at,
          orders: inSlot.map((o) => ({ id: o.id, number: o.number, plate: o.plate, status: o.status, serviceName: serviceName(o) })),
        });
      }
    }
    const day: ScheduleDay = {
      branchId,
      date: dayKey(date),
      capacity: branch.capacity,
      slotIntervalMin: step,
      hours,
      slots,
      blocks: branch.blockedSlots.filter((b) => dayKey(b.start) === dayKey(date)),
    };
    return ok(day);
  }),

  vroute("POST", "/vendor/schedule/blocks", async ({ body, actor }) => {
    const branchId = String(body.branchId ?? "");
    assertBranch(actor, branchId);
    const { block, affected } = await tx(async (t) => {
      const reason = requireText(body.reason, "reason", "سبب الحجب");
      const start = new Date(String(body.start));
      const end = new Date(String(body.end));
      if (Number.isNaN(+start) || Number.isNaN(+end) || end <= start) throw new MockApiError("نهاية الفترة يجب أن تكون بعد بدايتها", 422);
      const occupied = (await occupancyBetween(t, branchId, start, end)).length;
      const [row] = await t<{ id: string }[]>`
        insert into public.branch_blocked_slots (branch_id, starts_at, ends_at, reason, created_by)
        values (${branchId}, ${start.toISOString()}, ${end.toISOString()}, ${reason}, ${actor.staff.id}) returning id`;
      const created = { id: row.id, start: start.toISOString(), end: end.toISOString(), reason, createdBy: actor.staff.id };
      await logAudit(t, {
        actorType: "staff",
        actorId: actor.staff.id,
        action: "slot.block",
        entity: "branches",
        entityId: branchId,
        branchId,
        newValue: `${created.start} → ${created.end}`,
        reason,
      });
      return { block: created, affected: occupied };
    });
    return ok(block, affected ? `تم حجب الفترة — يوجد ${affected} حجز قائم فيها لم يتأثر` : "تم حجب الفترة واختفت من تطبيق العميل");
  }),

  vroute("DELETE", "/vendor/schedule/blocks/:id", async ({ params, actor }) => {
    await tx(async (t) => {
      const [block] = await t<{ id: string; branchId: string; start: string; end: string }[]>`
        delete from public.branch_blocked_slots where id = ${params.id} and branch_id = any(${actor.branchIds})
        returning id, branch_id as "branchId", starts_at as start, ends_at as "end"`;
      if (!block) throw new MockApiError("الفترة المحجوبة غير موجودة", 404);
      await logAudit(t, {
        actorType: "staff",
        actorId: actor.staff.id,
        action: "slot.unblock",
        entity: "branches",
        entityId: block.branchId,
        branchId: block.branchId,
        oldValue: `${block.start} → ${block.end}`,
      });
    });
    return ok(null, "تم إلغاء الحجب وعادت الفترة متاحة للحجز");
  }),
];
