import "server-only";

import type { WashApplication } from "@/types/applications";
import type { AuditLog } from "@/types/audit";
import type { AdminUser } from "@/types/auth";
import type { Complaint } from "@/types/complaints";
import type { Customer, Vehicle } from "@/types/customers";
import type { Payment, Payout, Transaction } from "@/types/finance";
import type { AdminNotification } from "@/types/notifications";
import type { Offer } from "@/types/offers";
import type { Order } from "@/types/orders";
import type { Review } from "@/types/reviews";
import type { VendorNotification } from "@/types/vendor/insights";
import type { DayClosing } from "@/types/vendor/team";
import type { Branch, Business, Staff, WashService } from "@/types/washes";
import type postgres from "postgres";

import { MockApiError } from "../http";
import { nationalPhone, prettyPhone } from "../vendor/engine";
import type { Shift } from "../schema";
import { ISO, type Q } from "./sql";

/**
 * Row → contract mapping for every Carzen entity, in one place.
 *
 * Each `xWhere(q, cond, tail?)` selects rows already shaped like the API
 * contract (`@/types`), so handlers never see snake_case. `cond` is a
 * postgres.js fragment written against the entity's fixed table alias (listed
 * on each function); `tail` is an optional `order by … limit …` fragment.
 *
 * Differences between storage and contract handled here:
 * - phones are E.164 in the database (`+201…`) and `+20 1XX XXX XXXX` in the API;
 * - nullable FKs the contract types as `string` come back as "" (staff.branch_id
 *   for owners, review.service_id, payment.collected_by, note authors);
 * - nested lists (order items/timeline/notes, branch hours/amenities/blocked
 *   slots, staff shift patterns, offer branches/categories, complaint notes) are
 *   aggregated with json, timestamps inside them formatted by `ISO()`.
 */
type Frag = postgres.Fragment;

/** E.164 → the API display format (`+20 120 000 0007`, `+20 2 2555 0142`; same as the mock `prettyPhone`). */
export const apiPhone = (p: string | null): string => (p ? prettyPhone(p) : "");
/** Any Egyptian number (mobile or landline, with or without +20 / 0) → E.164. */
export const e164 = (p: string): string => `+20${nationalPhone(p)}`;

/** SQL for `apiPhone(col)`: the national number (see `nationalPhone`) in `prettyPhone`'s groups. */
export const PHONE = (col: string) =>
  `(select case when d = '' then ''
                when length(d) = 10 and left(d, 1) = '1' then '+20 ' || substr(d, 1, 3) || ' ' || substr(d, 4, 3) || ' ' || substr(d, 7)
                when length(d) = 9 and left(d, 1) in ('2', '3') then '+20 ' || substr(d, 1, 1) || ' ' || substr(d, 2, 4) || ' ' || substr(d, 6)
                when length(d) >= 8 then '+20 ' || substr(d, 1, 2) || ' ' || substr(d, 3, 3) || ' ' || substr(d, 6)
                else '+20 ' || d end
    from (select ltrim(case when r like '0020%' then substr(r, 5) when r like '20%' and length(r) > 10 then substr(r, 3) else r end, '0') as d
          from (select regexp_replace(coalesce(${col}, ''), '[^0-9]', '', 'g') as r) y) x)`;

function select<T>(q: Q, cols: string, from: string, cond: Frag, tail?: Frag): Promise<T[]> {
  return q`select ${q.unsafe(cols)} from ${q.unsafe(from)} where ${cond} ${tail ?? q``}` as unknown as Promise<T[]>;
}

async function one<T>(rows: Promise<T[]>, label: string | null): Promise<T> {
  const [row] = await rows;
  if (!row) throw new MockApiError(`${label ?? "العنصر"} غير موجود`, 404);
  return row;
}

// ── Businesses (alias b) ─────────────────────────────────────────────────────

export const BUSINESS_COLS = `b.id, b.name, coalesce(b.owner_staff_id, '') as "ownerId", coalesce(ow.name, '') as "ownerName",
  b.status, b.status_reason as "statusReason", b.commission_rate as "commissionRate", b.rating, b.created_at as "createdAt"`;
export const BUSINESS_FROM = `public.businesses b left join public.staff ow on ow.id = b.owner_staff_id`;

export const businessesWhere = (q: Q, cond: Frag, tail?: Frag) => select<Business>(q, BUSINESS_COLS, BUSINESS_FROM, cond, tail);
export const businessById = (q: Q, id: string, label: string | null = "المغسلة") => one(businessesWhere(q, q`b.id = ${id}`), label);

// ── Branches (alias br) ──────────────────────────────────────────────────────

export const BRANCH_COLS = `br.id, br.business_id as "businessId", br.name, br.area_id as area, br.address, br.lat, br.lng,
  ${PHONE("br.phone")} as phone,
  coalesce((select json_agg(ba.amenity_id order by ba.amenity_id) from public.branch_amenities ba where ba.branch_id = br.id), '[]') as amenities,
  br.capacity, br.active, br.featured,
  coalesce((select json_agg(json_build_object('open', to_char(h.opens_at, 'HH24:MI'), 'close', to_char(h.closes_at, 'HH24:MI'), 'closed', h.closed) order by h.weekday)
            from public.branch_working_hours h where h.branch_id = br.id), '[]') as "workingHours",
  json_build_object('autoConfirm', br.auto_confirm, 'slotIntervalMin', br.slot_interval_min, 'leadTimeMin', br.lead_time_min,
    'maxAdvanceDays', br.max_advance_days, 'freeCancelMin', br.free_cancel_min, 'noShowGraceMin', br.no_show_grace_min,
    'reminderMin', br.reminder_min) as settings,
  br.rating, br.review_count as "reviewCount",
  coalesce((select json_agg(json_build_object('id', s.id, 'start', ${ISO("s.starts_at")}, 'end', ${ISO("s.ends_at")}, 'reason', s.reason,
            'createdBy', coalesce(s.created_by, '')) order by s.starts_at) from public.branch_blocked_slots s where s.branch_id = br.id), '[]') as "blockedSlots"`;

export const branchesWhere = (q: Q, cond: Frag, tail?: Frag) => select<Branch>(q, BRANCH_COLS, "public.branches br", cond, tail);
export const branchById = (q: Q, id: string, label: string | null = "الفرع") => one(branchesWhere(q, q`br.id = ${id}`), label);

// ── Services (alias sv) ──────────────────────────────────────────────────────

export const SERVICE_COLS = `sv.id, sv.branch_id as "branchId", sv.type, sv.category_id as category, sv.name, sv.price,
  sv.duration_min as "durationMin", sv.active`;
export const servicesWhere = (q: Q, cond: Frag, tail?: Frag) => select<WashService>(q, SERVICE_COLS, "public.services sv", cond, tail);

// ── Staff (alias st) ─────────────────────────────────────────────────────────

export const STAFF_COLS = `st.id, st.business_id as "businessId", coalesce(st.branch_id, '') as "branchId", st.name, ${PHONE("st.phone")} as phone,
  st.role, st.status, st.max_discount_pct as "maxDiscountPct", st.permissions,
  coalesce((select json_agg(json_build_object('start', to_char(p.starts_at, 'HH24:MI'), 'end', to_char(p.ends_at, 'HH24:MI'), 'days', p.days) order by p.id)
            from public.staff_shift_patterns p where p.staff_id = st.id), '[]') as "scheduledShifts",
  st.joined_at as "joinedAt"`;
export const staffWhere = (q: Q, cond: Frag, tail?: Frag) => select<Staff>(q, STAFF_COLS, "public.staff st", cond, tail);
export const staffById = (q: Q, id: string, label: string | null = "الموظف") => one(staffWhere(q, q`st.id = ${id}`), label);

// ── Customers (alias cu) & vehicles (alias v) ────────────────────────────────

export const CUSTOMER_COLS = `cu.id, cu.name, ${PHONE("cu.phone")} as phone, cu.status, cu.status_reason as "statusReason",
  cu.created_at as "createdAt", cu.last_active_at as "lastActiveAt"`;
export const customersWhere = (q: Q, cond: Frag, tail?: Frag) => select<Customer>(q, CUSTOMER_COLS, "public.customers cu", cond, tail);
export const customerById = (q: Q, id: string, label: string | null = "العميل") => one(customersWhere(q, q`cu.id = ${id}`), label);

export const VEHICLE_COLS = `v.id, v.customer_id as "customerId", v.make, v.model, v.year, v.color, v.plate,
  v.plate_normalized as "plateNormalized", v.is_default as "isDefault"`;
export const vehiclesWhere = (q: Q, cond: Frag, tail?: Frag) => select<Vehicle>(q, VEHICLE_COLS, "public.vehicles v", cond, tail);

// ── Orders (alias o) ─────────────────────────────────────────────────────────

export const ORDER_COLS = `o.id, o.number, o.code, o.source, o.customer_id as "customerId", o.vehicle_id as "vehicleId", o.plate,
  o.business_id as "businessId", o.branch_id as "branchId",
  coalesce((select json_agg(json_build_object('serviceId', coalesce(i.service_id, ''), 'name', i.name, 'type', i.type, 'price', i.price,
            'durationMin', i.duration_min) order by i.position) from public.order_items i where i.order_id = o.id), '[]') as items,
  o.subtotal,
  case when o.discount_amount is null then null
       else json_build_object('amount', o.discount_amount, 'pct', coalesce(o.discount_pct, 0), 'reason', coalesce(o.discount_reason, '')) end as discount,
  o.offer_id as "offerId", o.total, o.duration_min as "durationMin", o.scheduled_at as "scheduledAt", o.status,
  o.payment_status as "paymentStatus", o.payment_method as "paymentMethod", o.assigned_staff_id as "assignedStaffId",
  coalesce((select json_agg(json_build_object('status', e.status, 'at', ${ISO("e.at")}, 'byType', e.actor_type, 'byId', e.actor_id) order by e.at, e.id)
            from public.order_events e where e.order_id = o.id), '[]') as timeline,
  coalesce((select json_agg(json_build_object('text', n.text, 'at', ${ISO("n.created_at")}, 'authorId', coalesce(n.author_staff_id, '')) order by n.created_at, n.id)
            from public.order_notes n where n.order_id = o.id), '[]') as notes,
  case when o.cancelled_at is null then null
       else json_build_object('reason', o.cancel_reason, 'byType', o.cancelled_by_type, 'byId', coalesce(o.cancelled_by_id, ''), 'at', ${ISO("o.cancelled_at")}) end as cancel,
  o.flag, o.created_at as "createdAt", o.closed_in_day_id as "closedInDayId"`;
export const ordersWhere = (q: Q, cond: Frag, tail?: Frag) => select<Order>(q, ORDER_COLS, "public.orders o", cond, tail);
export const orderById = (q: Q, id: string, label: string | null = "الطلب") => one(ordersWhere(q, q`o.id = ${id}`), label);

// ── Money (payments p, transactions t, payouts po) ───────────────────────────

export const PAYMENT_COLS = `p.id, p.order_id as "orderId", p.amount, p.method, coalesce(p.collected_by, '') as "collectedBy",
  p.collected_at as "collectedAt", p.status`;
export const paymentsWhere = (q: Q, cond: Frag, tail?: Frag) => select<Payment>(q, PAYMENT_COLS, "public.payments p", cond, tail);

export const TRANSACTION_COLS = `t.id, t.order_id as "orderId", t.business_id as "businessId", t.gross, t.commission_rate as "commissionRate",
  t.commission, t.net_to_wash as "netToWash", t.date, t.status, t.flag, t.review_note as "reviewNote"`;
export const transactionsWhere = (q: Q, cond: Frag, tail?: Frag) => select<Transaction>(q, TRANSACTION_COLS, "public.transactions t", cond, tail);

export const PAYOUT_COLS = `po.id, po.business_id as "businessId", po.period_start::text || 'T00:00:00.000Z' as "periodStart",
  po.period_end::text || 'T00:00:00.000Z' as "periodEnd", po.amount_due as "amountDue", po.amount_paid as "amountPaid", po.status,
  po.reference, po.paid_at as "paidAt"`;
export const payoutsWhere = (q: Q, cond: Frag, tail?: Frag) => select<Payout>(q, PAYOUT_COLS, "public.payouts po", cond, tail);

// ── Engagement (reviews r, offers of, complaints c, applications ap) ─────────

export const REVIEW_COLS = `r.id, r.order_id as "orderId", r.customer_id as "customerId", r.business_id as "businessId", r.branch_id as "branchId",
  coalesce(r.service_id, '') as "serviceId", r.stars, r.comment, to_json(r.tags) as tags, r.reply, r.reply_at as "replyAt",
  r.report_reason as "reportReason", r.status, r.hidden_reason as "hiddenReason", r.reported_by_wash as "reportedByWash",
  r.created_at as "createdAt"`;
export const reviewsWhere = (q: Q, cond: Frag, tail?: Frag) => select<Review>(q, REVIEW_COLS, "public.reviews r", cond, tail);

export const OFFER_COLS = `of.id, of.scope, of.business_id as "businessId",
  coalesce((select json_agg(ob.branch_id order by ob.branch_id) from public.offer_branches ob where ob.offer_id = of.id), '[]') as "branchIds",
  coalesce((select json_agg(oc.category_id order by oc.category_id) from public.offer_categories oc where oc.offer_id = of.id), '[]') as "serviceCategories",
  of.title, of.description, of.discount_type as "discountType", of.discount_value as "discountValue",
  of.starts_at as "startAt", of.ends_at as "endAt", of.status, of.featured`;
export const offersWhere = (q: Q, cond: Frag, tail?: Frag) => select<Offer>(q, OFFER_COLS, "public.offers of", cond, tail);

export const COMPLAINT_COLS = `c.id, c.ticket, c.customer_id as "customerId", c.business_id as "businessId", c.branch_id as "branchId",
  c.order_id as "orderId", c.category, c.description, c.status, c.assigned_admin_id as "assignedAdminId",
  coalesce((select json_agg(json_build_object('authorId', coalesce(n.author_admin_id, ''), 'text', n.text, 'at', ${ISO("n.created_at")}) order by n.created_at, n.id)
            from public.complaint_notes n where n.complaint_id = c.id), '[]') as notes,
  c.resolution, c.created_at as "createdAt", c.updated_at as "updatedAt"`;
export const complaintsWhere = (q: Q, cond: Frag, tail?: Frag) => select<Complaint>(q, COMPLAINT_COLS, "public.complaints c", cond, tail);

export const APPLICATION_COLS = `ap.id, ap.business_name as "businessName", ap.owner_name as "ownerName", ${PHONE("ap.phone")} as phone, ap.email,
  ap.area_id as area, ap.address, ap.lat, ap.lng, ap.services, ap.working_hours as "workingHours", ap.capacity,
  coalesce((select json_agg(regexp_replace(d, '^[^/]+/', '')) from unnest(ap.documents) d), '[]') as documents,
  ap.status, ap.review_note as "reviewNote", ap.submitted_at as "submittedAt", ap.reviewed_at as "reviewedAt", ap.business_id as "businessId"`;
export const applicationsWhere = (q: Q, cond: Frag, tail?: Frag) => select<WashApplication>(q, APPLICATION_COLS, "public.wash_applications ap", cond, tail);

// ── Team (shifts sh, day closings dc) ────────────────────────────────────────

export const SHIFT_COLS = `sh.id, sh.staff_id as "staffId", sh.branch_id as "branchId", sh.scheduled_start as "scheduledStart",
  sh.scheduled_end as "scheduledEnd", sh.actual_start as "actualStart", sh.actual_end as "actualEnd",
  sh.orders_completed as "ordersCompleted", sh.cash_payments as "cashPayments", sh.card_payments as "cardPayments",
  sh.expected_cash as "expectedCash", sh.actual_cash as "actualCash", sh.difference, sh.difference_reason as reason,
  sh.review_status as "reviewStatus", sh.review_note as "reviewNote", sh.reviewed_by as "reviewedBy"`;
export const shiftsWhere = (q: Q, cond: Frag, tail?: Frag) => select<Shift>(q, SHIFT_COLS, "public.staff_shifts sh", cond, tail);

export const DAY_CLOSING_COLS = `dc.id, dc.branch_id as "branchId", dc.date,
  json_build_object('cash', dc.expected_cash, 'card', dc.expected_card, 'online', dc.expected_online,
    'total', dc.expected_cash + dc.expected_card + dc.expected_online) as expected,
  json_build_object('cash', dc.actual_cash, 'card', dc.actual_card, 'online', dc.actual_online,
    'total', dc.actual_cash + dc.actual_card + dc.actual_online) as actual,
  dc.difference, dc.reason, dc.orders_locked as "ordersLocked", dc.closed_by as "closedBy",
  coalesce((select s.name from public.staff s where s.id = dc.closed_by), '') as "closedByName", dc.closed_at as "closedAt"`;
export const dayClosingsWhere = (q: Q, cond: Frag, tail?: Frag) => select<DayClosing>(q, DAY_CLOSING_COLS, "public.day_closings dc", cond, tail);

// ── Platform people & activity (admins a, audit al, notifications an / vn) ──

export const ADMIN_COLS = `a.id, a.name, a.email, a.role, a.status, a.last_login_at as "lastLoginAt", a.created_at as "createdAt"`;
export const adminsWhere = (q: Q, cond: Frag, tail?: Frag) => select<AdminUser>(q, ADMIN_COLS, "public.admin_users a", cond, tail);

export const AUDIT_COLS = `al.id, al.actor_type as "actorType", al.actor_id as "actorId", al.action, al.entity, al.entity_id as "entityId",
  al.branch_id as "branchId", al.old_value as "oldValue", al.new_value as "newValue", al.reason, al.at,
  coalesce(al.actor_name, (select a.name from public.admin_users a where a.id = al.actor_id),
           (select s.name from public.staff s where s.id = al.actor_id)) as "actorName"`;
export const auditWhere = (q: Q, cond: Frag, tail?: Frag) => select<AuditLog>(q, AUDIT_COLS, "public.audit_logs al", cond, tail);

export const ADMIN_NOTIFICATION_COLS = `an.id, an.type, an.title, an.body, an.href, an.read, an.created_at as "createdAt"`;
export const adminNotificationsWhere = (q: Q, cond: Frag, tail?: Frag) =>
  select<AdminNotification>(q, ADMIN_NOTIFICATION_COLS, "public.admin_notifications an", cond, tail);

export const VENDOR_NOTIFICATION_COLS = `vn.id, vn.business_id as "businessId", vn.branch_id as "branchId", vn.type, vn.title, vn.body, vn.href,
  vn.read, vn.created_at as "createdAt"`;
export const vendorNotificationsWhere = (q: Q, cond: Frag, tail?: Frag) =>
  select<VendorNotification>(q, VENDOR_NOTIFICATION_COLS, "public.vendor_notifications vn", cond, tail);
