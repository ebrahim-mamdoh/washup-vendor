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
  PrimaryAction,
  VendorOrderListItem,
} from "@/types/vendor/operations";
import type { Branch, Staff, WorkingDay } from "@/types/washes";
import { isSameDay, logAudit, nid, now, round2 } from "../db";
import { MockApiError } from "../http";
import { effectiveCommissionRate, toOrderListItem } from "../lookups";
import type { VendorActor } from "../router";
import type { MockDatabase } from "../schema";
import { assertNotSuspended } from "./scope";

/** Orders that occupy a bay or a slot. */
export const OCCUPYING: OrderStatus[] = ["pending", "confirmed", "waiting", "in_service"];

// ── Time helpers ─────────────────────────────────────────────

export function dayKey(d: Date | string): string {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
}

/** "HH:MM" → minutes from midnight; a close time of 00:00 means midnight (1440). */
export function clockToMin(hhmm: string, isClose = false): number {
  const [h, m] = hhmm.split(":").map(Number);
  const v = h * 60 + m;
  return isClose && v === 0 ? 1440 : v;
}

export function minutesOfDay(d: Date): number {
  return d.getHours() * 60 + d.getMinutes();
}

export function hoursFor(branch: Branch, date: Date): WorkingDay {
  return branch.workingHours[date.getDay()] ?? { open: "09:00", close: "21:00", closed: false };
}

export function isOpenAt(branch: Branch, at: Date = now()): boolean {
  if (!branch.active) return false;
  const h = hoursFor(branch, at);
  if (h.closed) return false;
  const m = minutesOfDay(at);
  return m >= clockToMin(h.open) && m < clockToMin(h.close, true);
}

function atMinutes(date: Date, minutes: number): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setMinutes(minutes);
  return d;
}

// ── People ──────────────────────────────────────────────────

/** Employees/managers of a branch whose scheduled shift covers `at` (spec MG-04: on-shift staff). */
export function onShiftAt(db: MockDatabase, branchId: string, at: Date = now()): Staff[] {
  const m = minutesOfDay(at);
  return db.staff.filter(
    (s) =>
      s.branchId === branchId &&
      s.status === "active" &&
      s.role !== "owner" &&
      s.scheduledShifts.some((p) => p.days.includes(at.getDay()) && m >= clockToMin(p.start) && m < clockToMin(p.end, true)),
  );
}

export function staffName(db: MockDatabase, id: string | null): string | null {
  if (!id) return null;
  return db.staff.find((s) => s.id === id)?.name ?? null;
}

// ── Pricing (spec A8.1: price always computed, never typed) ──

export function priceServices(db: MockDatabase, branchId: string, serviceIds: string[]): PricePreview {
  if (!serviceIds.length) throw new MockApiError("اختر خدمة واحدة على الأقل", 422);
  const services = serviceIds.map((id) => {
    const s = db.services.find((x) => x.id === id && x.branchId === branchId);
    if (!s) throw new MockApiError("خدمة غير موجودة في هذا الفرع", 422);
    if (!s.active) throw new MockApiError(`الخدمة «${s.name.ar}» غير مفعلة`, 422);
    return s;
  });
  const primaries = services.filter((s) => s.type === "primary");
  if (primaries.length !== 1) throw new MockApiError("اختر خدمة أساسية واحدة (والإضافات اختيارية)", 422);

  const items: OrderItem[] = services.map((s) => ({ serviceId: s.id, name: s.name, type: s.type, price: s.price, durationMin: s.durationMin }));
  const subtotal = items.reduce((sum, it) => sum + it.price, 0);
  // Offers apply to the primary service only — the same rule as the customer app's create_order.
  const offer = bestOffer(db, branchId, primaries[0].category, primaries[0].price);

  return {
    items,
    subtotal,
    offerDiscount: offer?.amount ?? 0,
    offerTitle: offer?.title ?? null,
    total: subtotal - (offer?.amount ?? 0),
    durationMin: items.reduce((sum, it) => sum + it.durationMin, 0),
  };
}

/** Best live offer for the branch; `base` is the primary service's price (the part offers discount). */
function bestOffer(db: MockDatabase, branchId: string, category: string, base: number) {
  const t = now().getTime();
  let best: { id: string; amount: number; title: Localized } | null = null;
  for (const o of db.offers) {
    if (o.status === "draft" || o.status === "disabled") continue;
    if (new Date(o.startAt).getTime() > t || new Date(o.endAt).getTime() < t) continue;
    if (!o.branchIds.includes(branchId)) continue;
    if (o.serviceCategories.length && !o.serviceCategories.includes(category)) continue;
    const amount = offerAmount(o, base);
    if (!best || amount > best.amount) best = { id: o.id, amount, title: o.title };
  }
  return best;
}

// ── Availability (spec A8.2) ────────────────────────────────

export function occupiedAt(db: MockDatabase, branchId: string, start: Date, end: Date, excludeId?: string): Order[] {
  return db.orders.filter((o) => {
    if (o.branchId !== branchId || o.id === excludeId || !OCCUPYING.includes(o.status)) return false;
    const s = new Date(o.scheduledAt).getTime();
    const e = s + o.durationMin * 60000;
    return s < end.getTime() && e > start.getTime();
  });
}

export function availability(db: MockDatabase, branch: Branch, date: Date, durationMin: number): AvailabilitySlot[] {
  const h = hoursFor(branch, date);
  if (h.closed || !branch.active || atMinutes(date, 0) > bookingHorizon(branch)) return [];
  const step = branch.settings.slotIntervalMin || 30;
  const open = clockToMin(h.open);
  const close = clockToMin(h.close, true);
  const earliest = now().getTime() + branch.settings.leadTimeMin * 60000;
  const slots: AvailabilitySlot[] = [];
  for (let m = open; m + durationMin <= close; m += step) {
    const start = atMinutes(date, m);
    const end = new Date(start.getTime() + durationMin * 60000);
    const occupied = occupiedAt(db, branch.id, start, end).length;
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

// ── List mapping ────────────────────────────────────────────

export function nextActionFor(o: Order): PrimaryAction | null {
  switch (o.status) {
    case "pending":
      return "confirm";
    case "confirmed":
      return "check_in";
    case "waiting":
      return "start";
    case "in_service":
      return "complete";
    case "completed":
      return o.paymentStatus === "pending" ? "collect_payment" : null;
    default:
      return null;
  }
}

/** Minutes an order is running late for its current step (0 when on time). */
export function overdueMinutes(o: Order, at: Date = now()): number {
  const t = at.getTime();
  if (o.status === "in_service") {
    const started = [...o.timeline].reverse().find((e) => e.status === "in_service");
    const startedAt = started ? new Date(started.at).getTime() : new Date(o.scheduledAt).getTime();
    return Math.max(0, Math.round((t - startedAt) / 60000 - o.durationMin));
  }
  if (o.status === "confirmed" || o.status === "pending") {
    return Math.max(0, Math.round((t - new Date(o.scheduledAt).getTime()) / 60000));
  }
  if (o.status === "completed" && o.paymentStatus === "pending") {
    const done = [...o.timeline].reverse().find((e) => e.status === "completed");
    return done ? Math.max(0, Math.round((t - new Date(done.at).getTime()) / 60000)) : 0;
  }
  return 0;
}

export function toVendorItem(db: MockDatabase, o: Order): VendorOrderListItem {
  const vehicle = o.vehicleId ? db.vehicles.find((v) => v.id === o.vehicleId) : null;
  return {
    ...toOrderListItem(db, o),
    staffName: staffName(db, o.assignedStaffId),
    vehicleLabel: vehicle ? `${vehicle.make} ${vehicle.model}` : null,
    nextAction: nextActionFor(o),
    overdueMin: overdueMinutes(o),
    locked: Boolean(o.closedInDayId),
  };
}

// ── Permissions per action ──────────────────────────────────

export function allowedActions(db: MockDatabase, actor: VendorActor, o: Order): OrderAction[] {
  if (o.closedInDayId) return ["note"];
  const p = actor.staff.permissions;
  const out: OrderAction[] = ["note"];
  const add = (cond: boolean, ...a: OrderAction[]) => cond && out.push(...a);
  const unpaid = o.paymentStatus === "pending";
  const grace = db.branches.find((b) => b.id === o.branchId)?.settings.noShowGraceMin ?? 15;
  const graceOver = new Date(o.scheduledAt).getTime() + grace * 60000 < now().getTime();

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

// ── Money bookkeeping ───────────────────────────────────────

function recomputeTotals(db: MockDatabase, o: Order) {
  o.subtotal = o.items.reduce((s, it) => s + it.price, 0);
  o.durationMin = o.items.reduce((s, it) => s + it.durationMin, 0);
  if (o.discount) o.discount.amount = discountAfterItemsChange(o.discount, o.items, o.subtotal);
  o.total = Math.max(0, o.subtotal - (o.discount?.amount ?? 0));
  const txn = db.transactions.find((t) => t.orderId === o.id);
  if (txn && txn.status === "pending") {
    txn.gross = o.total;
    txn.commission = round2((o.total * txn.commissionRate) / 100);
    txn.netToWash = round2(o.total - txn.commission);
  }
}

function addTransaction(db: MockDatabase, o: Order) {
  const rate = effectiveCommissionRate(db, o.businessId);
  const commission = round2((o.total * rate) / 100);
  db.transactions.push({
    id: `txn_${o.id}`,
    orderId: o.id,
    businessId: o.businessId,
    gross: o.total,
    commissionRate: rate,
    commission,
    netToWash: round2(o.total - commission),
    date: o.scheduledAt,
    status: "pending",
    flag: null,
    reviewNote: null,
  });
}

function dropPendingTransaction(db: MockDatabase, o: Order) {
  const i = db.transactions.findIndex((t) => t.orderId === o.id && t.status === "pending");
  if (i >= 0) db.transactions.splice(i, 1);
}

function pushTimeline(o: Order, status: OrderStatus, actor: VendorActor) {
  o.timeline.push({ status, at: now().toISOString(), byType: "staff", byId: actor.staff.id });
}

function audit(db: MockDatabase, actor: VendorActor, o: Order, action: string, oldValue: unknown, newValue: unknown, reason?: string | null) {
  logAudit(db, {
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

function requireReason(value: unknown, label = "السبب"): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (text.length < 3) throw new MockApiError(`${label} مطلوب`, 422, { reason: [`${label} مطلوب`] });
  return text;
}

// ── State machine ───────────────────────────────────────────

const PAYMENT_LABEL: Record<PaymentMethod, string> = { cash: "نقدي", card: "بطاقة", online: "أونلاين" };

export function performAction(db: MockDatabase, actor: VendorActor, o: Order, payload: OrderActionPayload): string {
  const branch = db.branches.find((b) => b.id === o.branchId)!;
  const allowed = allowedActions(db, actor, o);
  if (!allowed.includes(payload.action)) {
    if (o.closedInDayId) throw new MockApiError("الطلب مقفل بإغلاق اليوم — لا يمكن تعديله", 423);
    throw new MockApiError("هذا الإجراء غير متاح لحالة الطلب الحالية أو لصلاحياتك", 409);
  }

  const from = o.status;
  switch (payload.action) {
    case "confirm": {
      o.status = "confirmed";
      pushTimeline(o, "confirmed", actor);
      audit(db, actor, o, "order.confirm", from, "confirmed");
      return `تم تأكيد الحجز ${o.number} وإبلاغ العميل`;
    }
    case "check_in": {
      o.status = "waiting";
      pushTimeline(o, "waiting", actor);
      audit(db, actor, o, "order.check_in", from, "waiting");
      return `تم تسجيل وصول ${o.plate || o.number}`;
    }
    case "start": {
      const staffId = payload.staffId ?? o.assignedStaffId;
      if (!staffId) throw new MockApiError("اختر الموظف المسؤول عن الخدمة", 422, { staffId: ["مطلوب"] });
      assertAssignable(db, o.branchId, staffId);
      const busy = db.orders.filter((x) => x.branchId === o.branchId && x.status === "in_service").length;
      if (busy >= branch.capacity) throw new MockApiError(`كل الأماكن مشغولة (${busy}/${branch.capacity}) — انتظر حتى يفرغ مكان`, 409);
      o.assignedStaffId = staffId;
      o.status = "in_service";
      pushTimeline(o, "in_service", actor);
      audit(db, actor, o, "order.start", from, `in_service · ${staffName(db, staffId)}`);
      return `بدأت الخدمة — ${staffName(db, staffId)}`;
    }
    case "complete": {
      o.status = "completed";
      pushTimeline(o, "completed", actor);
      audit(db, actor, o, "order.complete", from, "completed");
      return `اكتملت الخدمة — بانتظار الدفع ${o.total} ج.م`;
    }
    case "collect_payment": {
      const method = payload.method;
      if (method !== "cash" && method !== "card") throw new MockApiError("اختر طريقة الدفع", 422);
      if (method === "cash") {
        const received = Number(payload.amountReceived ?? o.total);
        if (Number.isNaN(received) || received < o.total) throw new MockApiError(`المبلغ المستلم أقل من الإجمالي (${o.total} ج.م)`, 422);
      }
      o.paymentStatus = "paid";
      o.paymentMethod = method;
      db.payments.push({
        id: nid("pay"),
        orderId: o.id,
        amount: o.total,
        method,
        collectedBy: actor.staff.id,
        collectedAt: now().toISOString(),
        status: "paid",
      });
      const txn = db.transactions.find((t) => t.orderId === o.id);
      if (txn) txn.status = "paid";
      audit(db, actor, o, "order.payment", "pending", `paid · ${PAYMENT_LABEL[method]} · ${o.total}`);
      const change = method === "cash" ? Number(payload.amountReceived ?? o.total) - o.total : 0;
      return change > 0 ? `تم التحصيل — الباقي للعميل ${change} ج.م` : "تم تحصيل المبلغ بنجاح";
    }
    case "cancel": {
      const reason = requireReason(payload.reason, "سبب الإلغاء");
      o.status = "cancelled";
      o.cancel = { reason, byType: "staff", byId: actor.staff.id, at: now().toISOString() };
      pushTimeline(o, "cancelled", actor);
      dropPendingTransaction(db, o);
      audit(db, actor, o, "order.cancel", from, "cancelled", reason);
      return `تم إلغاء الطلب ${o.number} وإبلاغ العميل`;
    }
    case "no_show": {
      o.status = "no_show";
      pushTimeline(o, "no_show", actor);
      dropPendingTransaction(db, o);
      audit(db, actor, o, "order.no_show", from, "no_show");
      return "تم تسجيل عدم الحضور وتحرير الموعد";
    }
    case "assign": {
      const staffId = payload.staffId ?? "";
      assertAssignable(db, o.branchId, staffId);
      const old = staffName(db, o.assignedStaffId);
      o.assignedStaffId = staffId;
      audit(db, actor, o, "order.assign", old, staffName(db, staffId));
      return `تم تعيين ${staffName(db, staffId)}`;
    }
    case "add_service": {
      const svc = db.services.find((s) => s.id === payload.serviceId && s.branchId === o.branchId && s.type === "addon" && s.active);
      if (!svc) throw new MockApiError("الإضافة غير متاحة في هذا الفرع", 422);
      if (o.items.some((it) => it.serviceId === svc.id)) throw new MockApiError("الإضافة موجودة بالفعل على الطلب", 409);
      const oldTotal = o.total;
      o.items.push({ serviceId: svc.id, name: svc.name, type: "addon", price: svc.price, durationMin: svc.durationMin });
      recomputeTotals(db, o);
      audit(db, actor, o, "order.add_service", oldTotal, `${o.total} (+${svc.name.ar})`);
      return `تمت إضافة ${svc.name.ar} — الإجمالي ${o.total} ج.م`;
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
      const offer = o.offerId ? db.offers.find((x) => x.id === o.offerId) : undefined;
      o.discount = withManualDiscount(o, offer ? offerAmount(offer, primaryPrice(o.items)) : null, manual, payload.discountType === "fixed" ? 0 : value, reason);
      recomputeTotals(db, o);
      audit(db, actor, o, "order.discount", old, o.total, reason);
      return `تم تطبيق الخصم — الإجمالي الآن ${o.total} ج.م`;
    }
    case "note": {
      const text = typeof payload.text === "string" ? payload.text.trim() : "";
      if (text.length < 2) throw new MockApiError("اكتب الملاحظة", 422);
      o.notes.push({ text, at: now().toISOString(), authorId: actor.staff.id });
      audit(db, actor, o, "order.note", null, text);
      return "تمت إضافة الملاحظة";
    }
    case "refund": {
      const reason = requireReason(payload.reason, "سبب الاسترداد");
      o.paymentStatus = "refunded";
      const pay = db.payments.find((p) => p.orderId === o.id && p.status === "paid");
      if (pay) pay.status = "refunded";
      const txn = db.transactions.find((t) => t.orderId === o.id);
      if (txn) txn.status = "refunded";
      audit(db, actor, o, "order.refund", "paid", "refunded", reason);
      return `تم استرداد ${o.total} ج.م للعميل`;
    }
  }
}

function assertAssignable(db: MockDatabase, branchId: string, staffId: string) {
  const s = db.staff.find((x) => x.id === staffId);
  if (!s || s.branchId !== branchId || s.status !== "active" || s.role === "owner") {
    throw new MockApiError("الموظف غير متاح في هذا الفرع", 422);
  }
}

// ── Creation & recognition ──────────────────────────────────

const ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function nextNumber(db: MockDatabase, source: Order["source"]): string {
  const base = source === "app" ? 10000 : source === "walk_in" ? 20000 : 30000;
  // Only this source's numbers: seeded history of another source may sit in this range.
  const max = db.orders
    .filter((o) => o.source === source)
    .map((o) => Number(o.number.replace("CZ-", "")))
    .filter((n) => n >= base && n < base + 10000)
    .reduce((a, b) => Math.max(a, b), base);
  return `CZ-${String(max + 1).padStart(5, "0")}`;
}

function nextCode(db: MockDatabase): string {
  const used = new Set(db.orders.map((o) => o.code));
  let c = "";
  do {
    c = Array.from({ length: 5 }, () => ALPHA[Math.floor(Math.random() * ALPHA.length)]).join("");
  } while (used.has(c));
  return c;
}

export function normalizePlate(p: string): string {
  return p.replace(/[\s-]/g, "").toUpperCase();
}

export function normalizePhone(p: string): string {
  const digits = p.replace(/\D/g, "");
  return digits.slice(-10);
}

/**
 * Egyptian national number (no country code, no trunk 0): mobiles are 10 digits ("1XXXXXXXXX"),
 * Cairo/Alexandria landlines 9 ("2XXXXXXXX"), other landlines 8–9.
 */
export function nationalPhone(p: string): string {
  let d = p.replace(/\D/g, "");
  if (d.startsWith("0020")) d = d.slice(4);
  else if (d.startsWith("20") && d.length > 10) d = d.slice(2);
  return d.replace(/^0+/, "");
}

/** Display format: mobiles `+20 1XX XXX XXXX`, Cairo/Alex landlines `+20 2 XXXX XXXX`, others `+20 XX XXX XXXX`. */
export function prettyPhone(p: string): string {
  const d = nationalPhone(p);
  if (d.length === 10 && d.startsWith("1")) return `+20 ${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6)}`;
  if (d.length === 9 && (d.startsWith("2") || d.startsWith("3"))) return `+20 ${d[0]} ${d.slice(1, 5)} ${d.slice(5)}`;
  if (d.length >= 8) return `+20 ${d.slice(0, 2)} ${d.slice(2, 5)} ${d.slice(5)}`;
  return d ? `+20 ${d}` : "";
}

export function recognize(db: MockDatabase, businessId: string, plate?: string | null, phone?: string | null): CustomerRecognition {
  let vehicle: Vehicle | null = null;
  let customer: Customer | null = null;
  if (plate && normalizePlate(plate).length >= 3) {
    vehicle = db.vehicles.find((v) => v.plateNormalized === normalizePlate(plate)) ?? null;
    if (vehicle) customer = db.customers.find((c) => c.id === vehicle!.customerId) ?? null;
  }
  if (!customer && phone && normalizePhone(phone).length >= 10) {
    customer = db.customers.find((c) => normalizePhone(c.phone) === normalizePhone(phone)) ?? null;
    if (customer && !vehicle) vehicle = db.vehicles.find((v) => v.customerId === customer!.id && v.isDefault) ?? null;
  }
  if (!customer) return { customer: null, vehicle, visits: 0, lastVisitAt: null, usualServiceId: null, usualServiceName: null };

  const visits = db.orders
    .filter((o) => o.customerId === customer!.id && o.businessId === businessId && o.status === "completed")
    .sort((a, b) => +new Date(b.scheduledAt) - +new Date(a.scheduledAt));
  const freq = new Map<string, number>();
  visits.forEach((o) => {
    const p = o.items.find((i) => i.type === "primary");
    if (p) freq.set(p.serviceId, (freq.get(p.serviceId) ?? 0) + 1);
  });
  const usual = [...freq.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const usualSvc = usual ? db.services.find((s) => s.id === usual) : null;
  return {
    customer,
    vehicle,
    visits: visits.length,
    lastVisitAt: visits[0]?.scheduledAt ?? null,
    usualServiceId: usual,
    usualServiceName: usualSvc?.name ?? null,
  };
}

export function createOrder(db: MockDatabase, actor: VendorActor, payload: CreateOrderPayload): Order {
  assertNotSuspended(actor);
  const branch = db.branches.find((b) => b.id === payload.branchId)!;
  if (!branch.active) throw new MockApiError("الفرع متوقف — فعّله أولًا لاستقبال الطلبات", 409);
  const plate = normalizePlate(payload.plate ?? "");
  if (plate.length < 3) throw new MockApiError("رقم اللوحة مطلوب", 422, { plate: ["مطلوب"] });

  const price = priceServices(db, branch.id, payload.serviceIds);
  const isPhone = payload.source === "phone";
  let scheduledAt = now();
  if (isPhone) {
    if (!payload.scheduledAt) throw new MockApiError("اختر موعد الحجز", 422, { scheduledAt: ["مطلوب"] });
    scheduledAt = new Date(payload.scheduledAt);
    const slot = availability(db, branch, scheduledAt, price.durationMin).find((s) => s.start === scheduledAt.toISOString());
    if (!slot || slot.past || slot.blocked || slot.free <= 0) throw new MockApiError("هذا الموعد لم يعد متاحًا — اختر موعدًا آخر", 409);
  }

  // Customer & vehicle: reuse when recognized, create otherwise (phone is optional for walk-ins).
  const rec = recognize(db, actor.business.id, plate, payload.customerPhone);
  let customer = rec.customer;
  if (!customer && payload.customerPhone && normalizePhone(payload.customerPhone).length === 10) {
    customer = {
      id: nid("cu"),
      name: payload.customerName?.trim() || "عميل جديد",
      phone: prettyPhone(payload.customerPhone),
      status: "active",
      statusReason: null,
      createdAt: now().toISOString(),
      lastActiveAt: now().toISOString(),
    };
    db.customers.push(customer);
  }
  if (isPhone && !customer) throw new MockApiError("رقم موبايل العميل مطلوب للحجز الهاتفي", 422, { customerPhone: ["مطلوب"] });
  let vehicle = rec.vehicle;
  if (!vehicle && customer) {
    vehicle = {
      id: nid("ve"),
      customerId: customer.id,
      make: payload.vehicleMake?.trim() || "—",
      model: payload.vehicleModel?.trim() || "",
      year: null,
      color: payload.vehicleColor || "silver",
      plate,
      plateNormalized: plate,
      isDefault: !db.vehicles.some((v) => v.customerId === customer!.id),
    };
    db.vehicles.push(vehicle);
  }

  const status: OrderStatus = isPhone ? "confirmed" : "waiting";
  const offerId = price.offerDiscount ? db.offers.find((o) => o.title.ar === price.offerTitle?.ar)?.id ?? null : null;
  const order: Order = {
    id: nid("ord"),
    number: nextNumber(db, payload.source),
    code: nextCode(db),
    source: payload.source,
    customerId: customer?.id ?? null,
    vehicleId: vehicle?.id ?? null,
    plate,
    businessId: actor.business.id,
    branchId: branch.id,
    items: price.items,
    subtotal: price.subtotal,
    discount: price.offerDiscount ? { amount: price.offerDiscount, pct: 0, reason: `عرض: ${price.offerTitle?.ar ?? ""}` } : null,
    offerId,
    total: price.total,
    durationMin: price.durationMin,
    scheduledAt: scheduledAt.toISOString(),
    status,
    paymentStatus: "pending",
    paymentMethod: null,
    assignedStaffId: null,
    timeline: [{ status, at: now().toISOString(), byType: "staff", byId: actor.staff.id }],
    notes: payload.notes?.trim() ? [{ text: payload.notes.trim(), at: now().toISOString(), authorId: actor.staff.id }] : [],
    cancel: null,
    flag: null,
    createdAt: now().toISOString(),
    closedInDayId: null,
  };
  db.orders.push(order);
  addTransaction(db, order);
  if (customer) customer.lastActiveAt = now().toISOString();
  logAudit(db, {
    actorType: "staff",
    actorId: actor.staff.id,
    action: "order.create",
    entity: "orders",
    entityId: order.id,
    branchId: branch.id,
    newValue: `${order.number} · ${isPhone ? "حجز هاتفي" : "حضور مباشر"} · ${order.total} ج.م`,
  });
  return order;
}

export const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  pending: "بانتظار التأكيد",
  confirmed: "مؤكد",
  waiting: "في الانتظار",
  in_service: "جارٍ التنفيذ",
  completed: "مكتمل",
  cancelled: "ملغي",
  no_show: "لم يحضر",
};

// ── Shared rules (mock + Postgres) ──────────────────────────

/**
 * Amount an offer takes off `base` — the primary service's price, never the add-ons (the same rule
 * as the customer app's create_order, so an order costs the same through every channel).
 */
export function offerAmount(offer: { discountType: "percent" | "fixed"; discountValue: number }, base: number): number {
  return Math.min(base, offer.discountType === "percent" ? Math.round((base * offer.discountValue) / 100) : offer.discountValue);
}

/** Price of the order's primary service (what offers discount). */
export function primaryPrice(items: Pick<OrderItem, "type" | "price">[]): number {
  return items.find((it) => it.type === "primary")?.price ?? 0;
}

/**
 * The discount once the items change (an add-on was added). A percent discount from an offer stays
 * a percent of the primary service; a manual percent discount follows the new subtotal; fixed
 * amounts (and offer + manual stacks, stored as an amount) stay as they are.
 */
export function discountAfterItemsChange(d: NonNullable<Order["discount"]>, items: Pick<OrderItem, "type" | "price">[], subtotal: number): number {
  if (!(d.pct > 0)) return d.amount;
  const offerOnly = isOfferReason(d.reason) && !d.reason.includes(" + ");
  return Math.round(((offerOnly ? primaryPrice(items) : subtotal) * d.pct) / 100);
}

/**
 * The order discount after a manual discount of `manual` EGP. It stacks on the
 * applied offer only: a newer manual discount replaces the older one instead of
 * piling up (so offer + manual never passes offer + maxDiscountPct).
 * `offerPart` is the offer's own amount (null when the offer row is gone: the
 * current discount is then taken as the offer part).
 */
export function withManualDiscount(o: Order, offerPart: number | null, manual: number, pct: number, reason: string): NonNullable<Order["discount"]> {
  if (!o.discount || !isOfferReason(o.discount.reason)) return { amount: manual, pct, reason };
  const offerReason = o.discount.reason.split(" + ")[0];
  return { amount: Math.min(o.subtotal, (offerPart ?? o.discount.amount) + manual), pct: 0, reason: `${offerReason} + ${reason}` };
}

/**
 * Recognition as the wash may see it: only customers who already have an order
 * at this wash, and never the platform's moderation data (status, reason).
 */
export function recognitionForWash(rec: CustomerRecognition, knownHere: boolean): CustomerRecognition {
  if (!rec.customer || !knownHere) {
    return { customer: null, vehicle: null, visits: 0, lastVisitAt: null, usualServiceId: null, usualServiceName: null };
  }
  return { ...rec, customer: { ...rec.customer, status: "active", statusReason: null } };
}

/** Last day a booking may be made for: today + `maxAdvanceDays` (end of that day). */
export function bookingHorizon(branch: Branch, at: Date = now()): Date {
  const d = new Date(at);
  d.setDate(d.getDate() + (branch.settings.maxAdvanceDays || 7));
  d.setHours(23, 59, 59, 999);
  return d;
}

/** Validates the free-text fields of a new order (wrong types → 422, never a crash). */
export function cleanOrderPayload(body: Record<string, unknown>): CreateOrderPayload {
  const text = (key: string, max = 200): string | undefined => {
    const v = body[key];
    if (v === undefined || v === null || v === "") return undefined;
    if (typeof v !== "string") throw new MockApiError("بيانات الطلب غير صالحة", 422, { [key]: ["قيمة غير صالحة"] });
    return v.slice(0, max);
  };
  return {
    source: body.source as CreateOrderPayload["source"],
    branchId: String(body.branchId ?? ""),
    serviceIds: Array.isArray(body.serviceIds) ? body.serviceIds.map(String) : [],
    plate: text("plate", 20) ?? "",
    customerPhone: text("customerPhone", 30),
    customerName: text("customerName", 80),
    vehicleMake: text("vehicleMake", 40),
    vehicleModel: text("vehicleModel", 40),
    vehicleColor: text("vehicleColor", 20),
    scheduledAt: text("scheduledAt", 40),
    notes: text("notes", 500),
  } as CreateOrderPayload;
}

/** "HH:MM" working hours for 7 days, each open before close unless closed; else a 422. */
export function cleanWorkingHours(raw: unknown): WorkingDay[] {
  const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (!Array.isArray(raw) || raw.length !== 7) throw new MockApiError("ساعات العمل يجب أن تغطي 7 أيام", 422);
  return raw.map((d) => {
    const day = (d && typeof d === "object" ? d : {}) as Partial<WorkingDay>;
    const open = String(day.open ?? "");
    const close = String(day.close ?? "");
    if (!HHMM.test(open) || !HHMM.test(close)) throw new MockApiError("صيغة الوقت غير صحيحة", 422);
    const closed = Boolean(day.closed);
    if (!closed && clockToMin(close, true) <= clockToMin(open)) throw new MockApiError("وقت الإغلاق يجب أن يكون بعد وقت الفتح", 422);
    return { open, close, closed };
  });
}

/** Weekly shift patterns from a request body; anything malformed is a 422. */
export function cleanShiftPatterns(raw: unknown): { start: string; end: string; days: number[] }[] {
  const HHMM = /^(([01]\d|2[0-3]):[0-5]\d|24:00)$/;
  if (!Array.isArray(raw)) throw new MockApiError("جدول الورديات غير صالح", 422);
  return raw.map((p) => {
    const item = (p && typeof p === "object" ? p : {}) as { start?: unknown; end?: unknown; days?: unknown };
    const start = String(item.start ?? "");
    const end = String(item.end ?? "");
    if (!HHMM.test(start) || !HHMM.test(end)) throw new MockApiError("صيغة الوقت غير صحيحة", 422);
    if (clockToMin(end, true) <= clockToMin(start)) throw new MockApiError("نهاية الوردية يجب أن تكون بعد بدايتها", 422);
    const days = Array.isArray(item.days) ? item.days.map(Number) : [];
    if (!days.length || !days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) throw new MockApiError("أيام غير صالحة", 422);
    return { start, end, days: [...new Set(days)].sort() };
  });
}

/** "YYYY-MM-DD" → that calendar day (noon, server time), or a 422. */
export function parseDay(raw: string, field = "date"): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12) : null;
  if (!d || Number.isNaN(+d) || dayKey(d) !== raw) throw new MockApiError("تاريخ غير صالح", 422, { [field]: ["تاريخ غير صالح"] });
  return d;
}

/** A service duration (minutes) worth averaging: events out of order or days apart are bad data. */
export function isPlausibleDuration(d: number | null): d is number {
  return d !== null && d >= 0 && d <= 12 * 60;
}

/** A day that may be closed: a valid "YYYY-MM-DD" that is today or earlier. */
export function assertClosableDay(date: string): void {
  parseDay(date);
  if (date > dayKey(now())) throw new MockApiError("لا يمكن إغلاق يوم لم يأتِ بعد", 422, { date: ["تاريخ في المستقبل"] });
}

/**
 * True when a discount reason starts with an offer: "عرض: …" (portal and seed) or "offer"
 * (the customer app's create_order), optionally followed by " + <manual reason>".
 */
export function isOfferReason(reason: string): boolean {
  return reason.startsWith("عرض") || reason === "offer" || reason.startsWith("offer + ");
}

/** True when staff applied a manual discount (alone or stacked on an offer). */
export function hasManualDiscount(o: Order): boolean {
  if (!o.discount) return false;
  return !isOfferReason(o.discount.reason) || o.discount.reason.includes(" + ");
}
