import "server-only";

import type { Localized } from "@/types/common";
import type { Customer, Vehicle } from "@/types/customers";
import type { Order, OrderItem, OrderStatus, PaymentMethod } from "@/types/orders";
import type {
  AvailabilitySlot,
  CreateOrderPayload,
  CustomerRecognition,
  OrderAction,
  OrderActionPayload,
  PricePreview,
} from "@/types/vendor/operations";
import type { Branch } from "@/types/washes";
import type postgres from "postgres";

import { isSameDay, now, round2 } from "../../db";
import { MockApiError } from "../../http";
import type { VendorActor } from "../../router";
import {
  OCCUPYING,
  bookingHorizon,
  clockToMin,
  discountAfterItemsChange,
  hoursFor,
  normalizePhone,
  normalizePlate,
  offerAmount,
  primaryPrice,
  recognitionForWash,
  withManualDiscount,
} from "../../vendor/engine";
import { branchById, customersWhere, e164, offersWhere, orderById, servicesWhere, vehiclesWhere } from "../entities";
import { staffNames } from "../lookups";
import { defaultCommissionPct, logAudit } from "../platform";
import type { Q } from "../sql";
import { assertNotSuspended } from "./scope";

/**
 * Order engine on Postgres — the db-dependent half of `../../vendor/engine.ts`
 * (pricing, availability, allowed actions, the state machine with its money
 * bookkeeping, recognition and creation). Same rules, messages and audit
 * entries as the mock; the pure helpers (`nextActionFor`, `overdueMinutes`,
 * `hoursFor`, `normalizePlate`…) are imported from the mock engine.
 *
 * Mutating functions take an open transaction (`t`) and never call `db()`.
 */
type Tx = postgres.TransactionSql;

/** SQL predicate for `OCCUPYING` statuses (alias o). */
export const OCCUPYING_SQL = `o.status in (${OCCUPYING.map((s) => `'${s}'`).join(", ")})`;

function atMinutes(date: Date, minutes: number): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setMinutes(minutes);
  return d;
}

// ── Pricing (spec A8.1: price always computed, never typed) ──

/** Best live offer for the branch; `base` is the primary service's price (the part offers discount). */
async function bestOffer(q: Q, branchId: string, category: string, base: number) {
  const at = now().toISOString();
  const offers = await offersWhere(
    q,
    q`of.status not in ('draft', 'disabled') and of.starts_at <= ${at} and of.ends_at >= ${at}
      and exists (select 1 from public.offer_branches ob where ob.offer_id = of.id and ob.branch_id = ${branchId})
      and (not exists (select 1 from public.offer_categories oc where oc.offer_id = of.id)
           or exists (select 1 from public.offer_categories oc where oc.offer_id = of.id and oc.category_id = ${category}))`,
    // Newest first, like the mock list (new offers are unshifted).
    q`order by of.created_at desc, of.id`,
  );
  let best: { id: string; amount: number; title: Localized } | null = null;
  for (const o of offers) {
    const amount = offerAmount(o, base);
    if (!best || amount > best.amount) best = { id: o.id, amount, title: o.title };
  }
  return best;
}

/** Services → price preview plus the applied offer id (used by order creation). */
async function priceWithOffer(q: Q, branchId: string, serviceIds: string[]): Promise<{ preview: PricePreview; offerId: string | null }> {
  if (!serviceIds.length) throw new MockApiError("اختر خدمة واحدة على الأقل", 422);
  const rows = await servicesWhere(q, q`sv.branch_id = ${branchId} and sv.id = any(${[...new Set(serviceIds)]})`);
  const byId = new Map(rows.map((s) => [s.id, s]));
  const services = serviceIds.map((id) => {
    const s = byId.get(id);
    if (!s) throw new MockApiError("خدمة غير موجودة في هذا الفرع", 422);
    if (!s.active) throw new MockApiError(`الخدمة «${s.name.ar}» غير مفعلة`, 422);
    return s;
  });
  const primaries = services.filter((s) => s.type === "primary");
  if (primaries.length !== 1) throw new MockApiError("اختر خدمة أساسية واحدة (والإضافات اختيارية)", 422);

  const items: OrderItem[] = services.map((s) => ({ serviceId: s.id, name: s.name, type: s.type, price: s.price, durationMin: s.durationMin }));
  const subtotal = items.reduce((sum, it) => sum + it.price, 0);
  // Offers apply to the primary service only — the same rule as the customer app's create_order.
  const offer = await bestOffer(q, branchId, primaries[0].category, primaries[0].price);
  return {
    preview: {
      items,
      subtotal,
      offerDiscount: offer?.amount ?? 0,
      offerTitle: offer?.title ?? null,
      total: subtotal - (offer?.amount ?? 0),
      durationMin: items.reduce((sum, it) => sum + it.durationMin, 0),
    },
    offerId: offer?.amount ? offer.id : null,
  };
}

export async function priceServices(q: Q, branchId: string, serviceIds: string[]): Promise<PricePreview> {
  return (await priceWithOffer(q, branchId, serviceIds)).preview;
}

// ── Availability (spec A8.2) ────────────────────────────────

type Occupancy = Pick<Order, "id" | "scheduledAt" | "durationMin">;

/** Occupying orders of a branch that overlap [from, to) — light rows for slot math. */
export function occupancyBetween(q: Q, branchId: string, from: Date, to: Date): Promise<Occupancy[]> {
  return q<Occupancy[]>`
    select o.id, o.scheduled_at as "scheduledAt", o.duration_min as "durationMin" from public.orders o
    where o.branch_id = ${branchId} and ${q.unsafe(OCCUPYING_SQL)}
      and o.scheduled_at < ${to.toISOString()} and o.scheduled_at + o.duration_min * interval '1 minute' > ${from.toISOString()}
    order by o.scheduled_at, o.id`;
}

/** Same overlap rule as the mock `occupiedAt`, over rows already loaded. */
export function overlapping<T extends Occupancy>(rows: T[], start: Date, end: Date): T[] {
  return rows.filter((o) => {
    const s = new Date(o.scheduledAt).getTime();
    const e = s + o.durationMin * 60000;
    return s < end.getTime() && e > start.getTime();
  });
}

export async function availability(q: Q, branch: Branch, date: Date, durationMin: number): Promise<AvailabilitySlot[]> {
  const h = hoursFor(branch, date);
  if (h.closed || !branch.active || atMinutes(date, 0) > bookingHorizon(branch)) return [];
  const step = branch.settings.slotIntervalMin || 30;
  const open = clockToMin(h.open);
  const close = clockToMin(h.close, true);
  const earliest = now().getTime() + branch.settings.leadTimeMin * 60000;
  const occupancy = await occupancyBetween(q, branch.id, atMinutes(date, open), atMinutes(date, close));
  const slots: AvailabilitySlot[] = [];
  for (let m = open; m + durationMin <= close; m += step) {
    const start = atMinutes(date, m);
    const end = new Date(start.getTime() + durationMin * 60000);
    const occupied = overlapping(occupancy, start, end).length;
    const blocked = branch.blockedSlots.some((b) => new Date(b.start) < end && new Date(b.end) > start);
    slots.push({
      start: start.toISOString(),
      free: Math.max(0, branch.capacity - occupied),
      capacity: branch.capacity,
      blocked,
      past: start.getTime() < earliest,
    });
  }
  return slots;
}

/** Orders in service right now at a branch (bays busy). */
export async function busyBays(q: Q, branchId: string): Promise<number> {
  const [{ n }] = await q<{ n: number }[]>`select count(*)::int as n from public.orders where branch_id = ${branchId} and status = 'in_service'`;
  return n;
}

// ── Permissions per action ──────────────────────────────────

/** Same matrix as the mock `allowedActions`; `graceMin` is the branch no-show grace. */
export function allowedActions(actor: VendorActor, o: Order, graceMin: number): OrderAction[] {
  if (o.closedInDayId) return ["note"];
  const p = actor.staff.permissions;
  const out: OrderAction[] = ["note"];
  const add = (cond: boolean, ...a: OrderAction[]) => cond && out.push(...a);
  const unpaid = o.paymentStatus === "pending";
  const graceOver = new Date(o.scheduledAt).getTime() + graceMin * 60000 < now().getTime();

  switch (o.status) {
    case "pending":
      add(p.confirmBooking, "confirm");
      add(p.cancelOrder, "cancel");
      add(true, "assign", "discount");
      break;
    case "confirmed":
      add(isSameDay(o.scheduledAt, now()), "check_in");
      add(graceOver, "no_show");
      add(p.cancelOrder, "cancel");
      add(true, "assign", "discount");
      break;
    case "waiting":
      add(p.runService, "start");
      add(p.cancelOrder, "cancel");
      add(true, "assign", "add_service", "discount");
      break;
    case "in_service":
      add(p.runService, "complete");
      add(true, "assign", "add_service", "discount");
      break;
    case "completed":
      add(unpaid && p.collectPayment, "collect_payment");
      add(unpaid, "discount");
      add(o.paymentStatus === "paid" && p.refund, "refund");
      break;
    default:
      break;
  }
  return out;
}

export async function branchGraceMin(q: Q, branchId: string): Promise<number> {
  const [row] = await q<{ grace: number }[]>`select no_show_grace_min as grace from public.branches where id = ${branchId}`;
  return row?.grace ?? 15;
}

// ── Bookkeeping ─────────────────────────────────────────────

const CONFLICT = "هذا الإجراء غير متاح لحالة الطلب الحالية أو لصلاحياتك";

async function pushTimeline(t: Tx, o: Order, status: OrderStatus, actor: VendorActor) {
  await t`insert into public.order_events (order_id, status, actor_type, actor_id) values (${o.id}, ${status}, 'staff', ${actor.staff.id})`;
}

function audit(t: Tx, actor: VendorActor, o: Order, action: string, oldValue: unknown, newValue: unknown, reason?: string | null) {
  return logAudit(t, {
    actorType: "staff",
    actorId: actor.staff.id,
    action,
    entity: "orders",
    entityId: o.id,
    branchId: o.branchId,
    oldValue,
    newValue,
    reason: reason ?? null,
  });
}

/** Moves the order to `to`, guarded on its current status (0 rows → someone else moved it first). */
async function moveStatus(t: Tx, o: Order, to: OrderStatus, extra?: postgres.Fragment) {
  const rows = await t`
    update public.orders set status = ${to} ${extra ?? t``}
    where id = ${o.id} and status = ${o.status} and closed_in_day_id is null returning id`;
  if (!rows.length) throw new MockApiError(CONFLICT, 409);
}

async function dropPendingTransaction(t: Tx, o: Order) {
  await t`delete from public.transactions where order_id = ${o.id} and status = 'pending'`;
}

/** Recomputes subtotal/duration/discount/total like the mock `recomputeTotals` and writes them (plus a pending transaction). */
async function writeTotals(t: Tx, o: Order, items: OrderItem[], discount: Order["discount"]) {
  const subtotal = items.reduce((s, it) => s + it.price, 0);
  const durationMin = items.reduce((s, it) => s + it.durationMin, 0);
  const d = discount ? { ...discount } : null;
  if (d) d.amount = discountAfterItemsChange(d, items, subtotal);
  const total = Math.max(0, subtotal - (d?.amount ?? 0));
  const rows = await t`
    update public.orders set subtotal = ${subtotal}, duration_min = ${durationMin}, discount_amount = ${d?.amount ?? null},
      discount_pct = ${d ? d.pct : null}, discount_reason = ${d?.reason ?? null}, total = ${total}
    where id = ${o.id} and status = ${o.status} and closed_in_day_id is null returning id`;
  if (!rows.length) throw new MockApiError(CONFLICT, 409);
  const [txn] = await t<{ id: string; rate: number }[]>`
    select id, commission_rate as rate from public.transactions where order_id = ${o.id} and status = 'pending'`;
  if (txn) {
    const commission = round2((total * txn.rate) / 100);
    await t`update public.transactions set gross = ${total}, commission = ${commission}, net_to_wash = ${round2(total - commission)} where id = ${txn.id}`;
  }
  return total;
}

function requireReason(value: unknown, label = "السبب"): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (text.length < 3) throw new MockApiError(`${label} مطلوب`, 422, { reason: [`${label} مطلوب`] });
  return text;
}

async function assertAssignable(q: Q, branchId: string, staffId: string) {
  const rows = await q`
    select 1 from public.staff where id = ${staffId} and branch_id = ${branchId} and status = 'active' and role <> 'owner'`;
  if (!rows.length) throw new MockApiError("الموظف غير متاح في هذا الفرع", 422);
}

async function staffName(q: Q, id: string | null): Promise<string | null> {
  if (!id) return null;
  return (await staffNames(q, [id])).get(id) ?? null;
}

/**
 * Locks an order row for the rest of the transaction and loads it, or 404 when
 * it is outside the actor's branches (same message as the mock `findInScope`).
 */
export async function lockOrderInScope(t: Tx, actor: VendorActor, id: string): Promise<Order | null> {
  const [row] = await t<{ id: string; branch_id: string }[]>`select id, branch_id from public.orders where id = ${id} for update`;
  if (!row || !actor.branchIds.includes(row.branch_id)) return null;
  return orderById(t, row.id);
}

// ── State machine ───────────────────────────────────────────

const PAYMENT_LABEL: Record<PaymentMethod, string> = { cash: "نقدي", card: "بطاقة", online: "أونلاين" };

/** Applies one action to a locked order (see `lockOrderInScope`) and returns the success message. */
export async function performAction(t: Tx, actor: VendorActor, o: Order, payload: OrderActionPayload): Promise<string> {
  const [branch] = await t<{ capacity: number; grace: number }[]>`
    select capacity, no_show_grace_min as grace from public.branches where id = ${o.branchId}`;
  const allowed = allowedActions(actor, o, branch?.grace ?? 15);
  if (!allowed.includes(payload.action)) {
    if (o.closedInDayId) throw new MockApiError("الطلب مقفل بإغلاق اليوم — لا يمكن تعديله", 423);
    throw new MockApiError(CONFLICT, 409);
  }

  const from = o.status;
  switch (payload.action) {
    case "confirm": {
      await moveStatus(t, o, "confirmed");
      await pushTimeline(t, o, "confirmed", actor);
      await audit(t, actor, o, "order.confirm", from, "confirmed");
      return `تم تأكيد الحجز ${o.number} وإبلاغ العميل`;
    }
    case "check_in": {
      await moveStatus(t, o, "waiting");
      await pushTimeline(t, o, "waiting", actor);
      await audit(t, actor, o, "order.check_in", from, "waiting");
      return `تم تسجيل وصول ${o.plate || o.number}`;
    }
    case "start": {
      const staffId = payload.staffId ?? o.assignedStaffId;
      if (!staffId) throw new MockApiError("اختر الموظف المسؤول عن الخدمة", 422, { staffId: ["مطلوب"] });
      await assertAssignable(t, o.branchId, staffId);
      const busy = await busyBays(t, o.branchId);
      if (busy >= branch.capacity) throw new MockApiError(`كل الأماكن مشغولة (${busy}/${branch.capacity}) — انتظر حتى يفرغ مكان`, 409);
      await moveStatus(t, o, "in_service", t`, assigned_staff_id = ${staffId}`);
      await pushTimeline(t, o, "in_service", actor);
      const name = await staffName(t, staffId);
      await audit(t, actor, o, "order.start", from, `in_service · ${name}`);
      return `بدأت الخدمة — ${name}`;
    }
    case "complete": {
      await moveStatus(t, o, "completed");
      await pushTimeline(t, o, "completed", actor);
      await audit(t, actor, o, "order.complete", from, "completed");
      return `اكتملت الخدمة — بانتظار الدفع ${o.total} ج.م`;
    }
    case "collect_payment": {
      const method = payload.method;
      if (method !== "cash" && method !== "card") throw new MockApiError("اختر طريقة الدفع", 422);
      if (method === "cash") {
        const received = Number(payload.amountReceived ?? o.total);
        if (Number.isNaN(received) || received < o.total) throw new MockApiError(`المبلغ المستلم أقل من الإجمالي (${o.total} ج.م)`, 422);
      }
      const rows = await t`
        update public.orders set payment_status = 'paid', payment_method = ${method}
        where id = ${o.id} and status = 'completed' and payment_status = 'pending' and closed_in_day_id is null returning id`;
      if (!rows.length) throw new MockApiError(CONFLICT, 409);
      await t`
        insert into public.payments (order_id, amount, method, collected_by, status)
        values (${o.id}, ${o.total}, ${method}, ${actor.staff.id}, 'paid')`;
      await t`update public.transactions set status = 'paid' where order_id = ${o.id}`;
      await audit(t, actor, o, "order.payment", "pending", `paid · ${PAYMENT_LABEL[method]} · ${o.total}`);
      const change = method === "cash" ? Number(payload.amountReceived ?? o.total) - o.total : 0;
      return change > 0 ? `تم التحصيل — الباقي للعميل ${change} ج.م` : "تم تحصيل المبلغ بنجاح";
    }
    case "cancel": {
      const reason = requireReason(payload.reason, "سبب الإلغاء");
      await moveStatus(
        t,
        o,
        "cancelled",
        t`, cancel_reason = ${reason}, cancelled_by_type = 'staff', cancelled_by_id = ${actor.staff.id}, cancelled_at = now()`,
      );
      await pushTimeline(t, o, "cancelled", actor);
      await dropPendingTransaction(t, o);
      await audit(t, actor, o, "order.cancel", from, "cancelled", reason);
      return `تم إلغاء الطلب ${o.number} وإبلاغ العميل`;
    }
    case "no_show": {
      await moveStatus(t, o, "no_show");
      await pushTimeline(t, o, "no_show", actor);
      await dropPendingTransaction(t, o);
      await audit(t, actor, o, "order.no_show", from, "no_show");
      return "تم تسجيل عدم الحضور وتحرير الموعد";
    }
    case "assign": {
      const staffId = payload.staffId ?? "";
      await assertAssignable(t, o.branchId, staffId);
      const names = await staffNames(t, [o.assignedStaffId, staffId]);
      const old = (o.assignedStaffId && names.get(o.assignedStaffId)) || null;
      const rows = await t`
        update public.orders set assigned_staff_id = ${staffId}
        where id = ${o.id} and status = ${o.status} and closed_in_day_id is null returning id`;
      if (!rows.length) throw new MockApiError(CONFLICT, 409);
      const name = names.get(staffId) ?? null;
      await audit(t, actor, o, "order.assign", old, name);
      return `تم تعيين ${name}`;
    }
    case "add_service": {
      const [svc] = await servicesWhere(
        t,
        t`sv.id = ${payload.serviceId ?? null} and sv.branch_id = ${o.branchId} and sv.type = 'addon' and sv.active`,
      );
      if (!svc) throw new MockApiError("الإضافة غير متاحة في هذا الفرع", 422);
      if (o.items.some((it) => it.serviceId === svc.id)) throw new MockApiError("الإضافة موجودة بالفعل على الطلب", 409);
      const oldTotal = o.total;
      const item: OrderItem = { serviceId: svc.id, name: svc.name, type: "addon", price: svc.price, durationMin: svc.durationMin };
      await t`
        insert into public.order_items (order_id, service_id, name, type, price, duration_min, position)
        values (${o.id}, ${svc.id}, ${t.json(svc.name)}, 'addon', ${svc.price}, ${svc.durationMin},
                (select coalesce(max(position) + 1, 0) from public.order_items where order_id = ${o.id}))`;
      const total = await writeTotals(t, o, [...o.items, item], o.discount);
      await audit(t, actor, o, "order.add_service", oldTotal, `${total} (+${svc.name.ar})`);
      return `تمت إضافة ${svc.name.ar} — الإجمالي ${total} ج.م`;
    }
    case "discount": {
      const reason = requireReason(payload.reason, "سبب الخصم");
      const value = Number(payload.discountValue);
      if (Number.isNaN(value) || value <= 0) throw new MockApiError("قيمة الخصم غير صالحة", 422);
      const pct = payload.discountType === "fixed" ? (value / o.subtotal) * 100 : value;
      if (pct > actor.staff.maxDiscountPct) {
        throw new MockApiError(`الحد الأقصى لخصمك ${actor.staff.maxDiscountPct}٪ — هذا الخصم ${Math.round(pct)}٪`, 403);
      }
      const old = o.total;
      const manual = payload.discountType === "fixed" ? Math.min(value, o.subtotal) : Math.round((o.subtotal * value) / 100);
      const [offer] = o.offerId ? await offersWhere(t, t`of.id = ${o.offerId}`) : [];
      const discount = withManualDiscount(o, offer ? offerAmount(offer, primaryPrice(o.items)) : null, manual, payload.discountType === "fixed" ? 0 : value, reason);
      const total = await writeTotals(t, o, o.items, discount);
      await audit(t, actor, o, "order.discount", old, total, reason);
      return `تم تطبيق الخصم — الإجمالي الآن ${total} ج.م`;
    }
    case "note": {
      const text = typeof payload.text === "string" ? payload.text.trim() : "";
      if (text.length < 2) throw new MockApiError("اكتب الملاحظة", 422);
      await t`insert into public.order_notes (order_id, author_staff_id, text) values (${o.id}, ${actor.staff.id}, ${text})`;
      await audit(t, actor, o, "order.note", null, text);
      return "تمت إضافة الملاحظة";
    }
    case "refund": {
      const reason = requireReason(payload.reason, "سبب الاسترداد");
      const rows = await t`
        update public.orders set payment_status = 'refunded'
        where id = ${o.id} and status = 'completed' and payment_status = 'paid' and closed_in_day_id is null returning id`;
      if (!rows.length) throw new MockApiError(CONFLICT, 409);
      await t`
        update public.payments set status = 'refunded'
        where id = (select id from public.payments where order_id = ${o.id} and status = 'paid' order by collected_at, id limit 1)`;
      await t`update public.transactions set status = 'refunded' where order_id = ${o.id}`;
      await audit(t, actor, o, "order.refund", "paid", "refunded", reason);
      return `تم استرداد ${o.total} ج.م للعميل`;
    }
    default:
      throw new MockApiError(CONFLICT, 409);
  }
}

// ── Creation & recognition ──────────────────────────────────

export async function recognize(q: Q, businessId: string, plate?: string | null, phone?: string | null): Promise<CustomerRecognition> {
  let vehicle: Vehicle | null = null;
  let customer: Customer | null = null;
  if (plate && normalizePlate(plate).length >= 3) {
    [vehicle = null] = await vehiclesWhere(q, q`v.plate_normalized = ${normalizePlate(plate)}`, q`order by v.created_at, v.id limit 1`);
    if (vehicle) [customer = null] = await customersWhere(q, q`cu.id = ${vehicle.customerId}`);
  }
  if (!customer && phone && normalizePhone(phone).length >= 10) {
    [customer = null] = await customersWhere(q, q`cu.phone = ${e164(normalizePhone(phone))}`);
    if (customer && !vehicle) {
      [vehicle = null] = await vehiclesWhere(q, q`v.customer_id = ${customer.id} and v.is_default`, q`order by v.created_at, v.id limit 1`);
    }
  }
  if (!customer) return { customer: null, vehicle, visits: 0, lastVisitAt: null, usualServiceId: null, usualServiceName: null };

  // Completed visits at this wash; the usual service is the most frequent primary (ties → most recent).
  const [[stats], usual] = await Promise.all([
    q<{ visits: number; last: string | null }[]>`
      select count(*)::int as visits, max(scheduled_at) as last from public.orders
      where customer_id = ${customer.id} and business_id = ${businessId} and status = 'completed'`,
    q<{ id: string; name: Localized | null }[]>`
      select p.service_id as id, (select s.name from public.services s where s.id = p.service_id) as name
      from public.orders o
      cross join lateral (select coalesce(i.service_id, '') as service_id from public.order_items i
                          where i.order_id = o.id and i.type = 'primary' order by i.position limit 1) p
      where o.customer_id = ${customer.id} and o.business_id = ${businessId} and o.status = 'completed'
      group by p.service_id order by count(*) desc, max(o.scheduled_at) desc limit 1`,
  ]);
  return {
    customer,
    vehicle,
    visits: stats.visits,
    lastVisitAt: stats.last,
    usualServiceId: usual[0]?.id ?? null,
    usualServiceName: usual[0]?.name ?? null,
  };
}

/** `recognize` as returned to the portal (see `recognitionForWash`). */
export async function recognizeForWash(q: Q, businessId: string, plate?: string | null, phone?: string | null): Promise<CustomerRecognition> {
  const rec = await recognize(q, businessId, plate, phone);
  const known = rec.customer
    ? (await q`select 1 from public.orders where customer_id = ${rec.customer.id} and business_id = ${businessId} limit 1`).length > 0
    : false;
  return recognitionForWash(rec, known);
}

/** Creates a walk-in or phone order (customer/vehicle reused or created) and returns its id. */
export async function createOrder(t: Tx, actor: VendorActor, payload: CreateOrderPayload): Promise<string> {
  assertNotSuspended(actor);
  const branch = await branchById(t, payload.branchId);
  if (!branch.active) throw new MockApiError("الفرع متوقف — فعّله أولًا لاستقبال الطلبات", 409);
  const plate = normalizePlate(payload.plate ?? "");
  if (plate.length < 3) throw new MockApiError("رقم اللوحة مطلوب", 422, { plate: ["مطلوب"] });

  const { preview: price, offerId } = await priceWithOffer(t, branch.id, payload.serviceIds);
  const isPhone = payload.source === "phone";
  let scheduledAt = now();
  if (isPhone) {
    if (!payload.scheduledAt) throw new MockApiError("اختر موعد الحجز", 422, { scheduledAt: ["مطلوب"] });
    scheduledAt = new Date(payload.scheduledAt);
    const slots = Number.isNaN(scheduledAt.getTime()) ? [] : await availability(t, branch, scheduledAt, price.durationMin);
    const slot = slots.find((s) => s.start === scheduledAt.toISOString());
    if (!slot || slot.past || slot.blocked || slot.free <= 0) throw new MockApiError("هذا الموعد لم يعد متاحًا — اختر موعدًا آخر", 409);
  }

  // Customer & vehicle: reuse when recognized, create otherwise (phone is optional for walk-ins).
  const rec = await recognize(t, actor.business.id, plate, payload.customerPhone);
  let customerId = rec.customer?.id ?? null;
  if (!customerId && payload.customerPhone && normalizePhone(payload.customerPhone).length === 10) {
    const [row] = await t<{ id: string }[]>`
      insert into public.customers (name, phone, status)
      values (${payload.customerName?.trim() || "عميل جديد"}, ${e164(normalizePhone(payload.customerPhone))}, 'active') returning id`;
    customerId = row.id;
  }
  if (isPhone && !customerId) throw new MockApiError("رقم موبايل العميل مطلوب للحجز الهاتفي", 422, { customerPhone: ["مطلوب"] });
  let vehicleId = rec.vehicle?.id ?? null;
  if (!vehicleId && customerId) {
    const [row] = await t<{ id: string }[]>`
      insert into public.vehicles (customer_id, make, model, year, color, plate, is_default)
      values (${customerId}, ${payload.vehicleMake?.trim() || "—"}, ${payload.vehicleModel?.trim() || ""}, null,
              ${payload.vehicleColor || "silver"}, ${plate},
              not exists (select 1 from public.vehicles where customer_id = ${customerId}))
      returning id`;
    vehicleId = row.id;
  }

  const status: OrderStatus = isPhone ? "confirmed" : "waiting";
  const discount = price.offerDiscount ? { amount: price.offerDiscount, reason: `عرض: ${price.offerTitle?.ar ?? ""}` } : null;
  const [order] = await t<{ id: string; number: string }[]>`
    insert into public.orders (number, source, customer_id, vehicle_id, plate, business_id, branch_id, offer_id, subtotal,
      discount_amount, discount_pct, discount_reason, total, duration_min, scheduled_at, status, payment_status)
    values (public.next_order_number(${payload.source}::public.order_source), ${payload.source}, ${customerId}, ${vehicleId}, ${plate},
      ${actor.business.id}, ${branch.id}, ${offerId}, ${price.subtotal}, ${discount?.amount ?? null}, ${discount ? 0 : null},
      ${discount?.reason ?? null}, ${price.total}, ${price.durationMin}, ${scheduledAt.toISOString()}, ${status}, 'pending')
    returning id, number`;
  for (const [i, it] of price.items.entries()) {
    await t`
      insert into public.order_items (order_id, service_id, name, type, price, duration_min, position)
      values (${order.id}, ${it.serviceId}, ${t.json(it.name)}, ${it.type}, ${it.price}, ${it.durationMin}, ${i})`;
  }
  await t`insert into public.order_events (order_id, status, actor_type, actor_id) values (${order.id}, ${status}, 'staff', ${actor.staff.id})`;
  if (payload.notes?.trim()) {
    await t`insert into public.order_notes (order_id, author_staff_id, text) values (${order.id}, ${actor.staff.id}, ${payload.notes.trim()})`;
  }

  // Commission ledger row (pending until paid), same id scheme as the mock.
  const [biz] = await t<{ rate: number | null }[]>`select commission_rate as rate from public.businesses where id = ${actor.business.id}`;
  const rate = biz?.rate ?? (await defaultCommissionPct(t));
  const commission = round2((price.total * rate) / 100);
  await t`
    insert into public.transactions (id, order_id, business_id, gross, commission_rate, commission, net_to_wash, date, status)
    values (${`txn_${order.id}`}, ${order.id}, ${actor.business.id}, ${price.total}, ${rate}, ${commission},
            ${round2(price.total - commission)}, ${scheduledAt.toISOString()}, 'pending')`;
  if (customerId) await t`update public.customers set last_active_at = now() where id = ${customerId}`;
  await logAudit(t, {
    actorType: "staff",
    actorId: actor.staff.id,
    action: "order.create",
    entity: "orders",
    entityId: order.id,
    branchId: branch.id,
    newValue: `${order.number} · ${isPhone ? "حجز هاتفي" : "حضور مباشر"} · ${price.total} ج.م`,
  });
  return order.id;
}
