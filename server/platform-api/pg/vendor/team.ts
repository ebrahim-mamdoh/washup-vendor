import "server-only";

import type { Order, PaymentMethod } from "@/types/orders";
import type { DayClosingSummary, MethodTotals, ShiftClosing, StaffPerformance, VendorStaffMember } from "@/types/vendor/team";
import type { ShiftPattern, Staff, StaffPermissions, StaffRole } from "@/types/washes";

import { daysAgo, now, round2 } from "../../db";
import { MockApiError, ok, requireText, sortBy } from "../../http";
import type { VendorActor } from "../../router";
import type { Shift } from "../../schema";
import { defaultPermissions } from "../../seed";
import { clockToMin, dayKey, hasManualDiscount, normalizePhone } from "../../vendor/engine";
import { isLocalAuth } from "../auth";
import { PHONE, auditWhere, dayClosingsWhere, e164, shiftsWhere, staffById, staffWhere } from "../entities";
import { dayBounds, paged, searchPattern } from "../list";
import { branchNames, onShiftAt, staffNames } from "../lookups";
import { logAudit } from "../platform";
import { vroute } from "../router";
import { type Q, db, tx } from "../sql";
import { assertBranch, assertOwner, scopeBranches, singleBranch } from "./scope";

/**
 * Vendor team on Postgres: staff (D10 / OW-11 / OW-17), shift closings
 * (D11 / MG-07 / OW-15) and end-of-day reconciliation (MG-08). Same routes,
 * rules, messages and audit entries as `../../vendor/team.ts`.
 */

const PERIOD_DAYS = { today: 1, "7d": 7, "30d": 30 } as const;
const PERMISSION_KEYS: (keyof StaffPermissions)[] = ["confirmBooking", "cancelOrder", "closeShift", "editServices", "refund", "collectPayment", "runService", "manageStaff"];
const METHODS: PaymentMethod[] = ["cash", "card", "online"];
const HHMM = /^(([01]\d|2[0-3]):[0-5]\d|24:00)$/;
const EMPTY_NAME = { ar: "—", en: "—" };

function audit(q: Q, actor: VendorActor, action: string, entity: string, entityId: string, branchId: string | null, oldValue: unknown, newValue: unknown, reason?: string | null) {
  return logAudit(q, { actorType: "staff", actorId: actor.staff.id, action, entity, entityId, branchId, oldValue, newValue, reason: reason ?? null });
}

function parsePermissions(raw: unknown, role: StaffRole): StaffPermissions {
  const base = defaultPermissions(role);
  if (!raw || typeof raw !== "object") return base;
  const out = { ...base };
  for (const k of PERMISSION_KEYS) if (k in (raw as object)) out[k] = Boolean((raw as Record<string, unknown>)[k]);
  return out;
}

/** Interfaces have no index signature; postgres.js json() wants one. */
const asJson = (p: StaffPermissions): Record<string, boolean> => ({ ...p });

function methodTotals(values: Partial<Record<PaymentMethod, number>>): MethodTotals {
  const t = { cash: values.cash ?? 0, card: values.card ?? 0, online: values.online ?? 0 };
  return { ...t, total: t.cash + t.card + t.online };
}

/**
 * Shift patterns have no position column and the shared staff mapper lists
 * them by id, so replaced patterns get ordered ids (`pat_<staff>_<nn>`, the
 * seed's scheme) instead of random ones — keeps the saved order.
 */
const patternId = (staffId: string, i: number) => `pat_${staffId}_${String(i).padStart(2, "0")}`;

/** Replaces a staff member's weekly patterns (delete + insert, inside the caller's transaction). */
async function replacePatterns(t: Q, staffId: string, patterns: ShiftPattern[]) {
  await t`delete from public.staff_shift_patterns where staff_id = ${staffId}`;
  if (!patterns.length) return;
  await t`
    insert into public.staff_shift_patterns ${t(
      patterns.map((p, i) => ({ id: patternId(staffId, i), staff_id: staffId, starts_at: p.start, ends_at: p.end, days: `{${p.days.join(",")}}` })),
      "id", "staff_id", "starts_at", "ends_at", "days",
    )}`;
}

/** "YYYY-MM-DD" (the mock's `dayKey`) → [start, end) of that server-local day, or a 422. */
function dateBounds(date: string): [string, string] {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
  if (!d || Number.isNaN(+d) || dayKey(d) !== date) throw new MockApiError("تاريخ غير صالح", 422, { date: ["تاريخ غير صالح"] });
  return dayBounds(d);
}

type PerfOrder = {
  id: string;
  staffId: string;
  total: number;
  durationMin: number;
  discount: Order["discount"];
  startedAt: string | null;
  completedAt: string | null;
  stars: number[];
};

/** Same math as the mock's `performance()`, over completed orders loaded for the whole list. */
function performance(orders: PerfOrder[], discountLogs: number): StaffPerformance {
  const durations = orders
    .map((o) => (o.startedAt && o.completedAt ? (new Date(o.completedAt).getTime() - new Date(o.startedAt).getTime()) / 60000 : null))
    .filter((d): d is number => d !== null);
  const stars = orders.flatMap((o) => o.stars);
  const discounted = orders.filter((o) => hasManualDiscount(o as unknown as Order));
  return {
    completed: orders.length,
    serviceValue: orders.reduce((s, o) => s + o.total, 0),
    avgDurationMin: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null,
    expectedDurationMin: orders.length ? Math.round(orders.reduce((s, o) => s + o.durationMin, 0) / orders.length) : null,
    rating: stars.length ? round2(stars.reduce((s, r) => s + r, 0) / stars.length) : null,
    discountsCount: Math.max(discountLogs, discounted.length),
    discountsAmount: discounted.reduce((s, o) => s + (o.discount?.amount ?? 0), 0),
  };
}

/** Shift rows → closings (staff, branch and reviewer names in one query each). */
async function toClosings(q: Q, shifts: Shift[]): Promise<ShiftClosing[]> {
  const [names, branches] = await Promise.all([
    staffNames(q, shifts.flatMap((s) => [s.staffId, s.reviewedBy])),
    branchNames(q, shifts.map((s) => s.branchId)),
  ]);
  return shifts.map((s) => ({
    id: s.id,
    staffId: s.staffId,
    staffName: names.get(s.staffId) ?? "—",
    branchId: s.branchId,
    branchName: branches.get(s.branchId) ?? EMPTY_NAME,
    scheduledStart: s.scheduledStart,
    scheduledEnd: s.scheduledEnd,
    actualStart: s.actualStart,
    actualEnd: s.actualEnd,
    ordersCompleted: s.ordersCompleted,
    cashPayments: s.cashPayments,
    cardPayments: s.cardPayments,
    expectedCash: s.expectedCash,
    actualCash: s.actualCash,
    difference: s.difference,
    reason: s.reason?.ar ?? null,
    status: s.reviewStatus,
    reviewNote: s.reviewNote,
    reviewedBy: (s.reviewedBy && names.get(s.reviewedBy)) || null,
  }));
}

/** A staff member of the actor's business, or undefined. */
async function businessStaff(q: Q, actor: VendorActor, id: string): Promise<Staff | undefined> {
  const [member] = await staffWhere(q, q`st.id = ${id} and st.business_id = ${actor.business.id}`);
  return member;
}

export const vendorTeamRoutes = [
  // ── Employees (D10 / OW-11 / OW-17) ──────────────────────
  vroute("GET", "/vendor/staff", async ({ query, actor }) => {
    const sql = db();
    const branchIds = scopeBranches(actor, query.get("branchId"));
    const role = query.get("role");
    const period = (query.get("period") as keyof typeof PERIOD_DAYS) ?? "30d";
    const from = daysAgo((PERIOD_DAYS[period] ?? 30) - 1).toISOString();
    const search = searchPattern(query);

    const [staff, onShiftLists] = await Promise.all([
      staffWhere(
        sql,
        sql`st.business_id = ${actor.business.id} and (st.branch_id = any(${branchIds}) or st.role = 'owner')
          ${actor.role === "owner" ? sql`` : sql`and st.role <> 'owner'`}
          ${role && role !== "all" ? sql`and st.role::text = ${role}` : sql``}
          ${search ? sql`and (st.name ilike ${search} or ${sql.unsafe(PHONE("st.phone"))} ilike ${search}
                             or replace(${sql.unsafe(PHONE("st.phone"))}, ' ', '') ilike ${search})` : sql``}`,
        sql`order by st.id`,
      ),
      Promise.all(branchIds.map((id) => onShiftAt(sql, id))),
    ]);
    const onShift = new Set(onShiftLists.flat().map((s) => s.id));
    const ids = staff.map((s) => s.id);

    // Performance inputs for the period, loaded once for the whole list (same math as the mock).
    const [orders, discountLogs, branches] = await Promise.all([
      ids.length
        ? sql<PerfOrder[]>`
            select o.id, o.assigned_staff_id as "staffId", o.total, o.duration_min as "durationMin",
              case when o.discount_amount is null then null
                   else json_build_object('amount', o.discount_amount, 'pct', coalesce(o.discount_pct, 0), 'reason', coalesce(o.discount_reason, '')) end as discount,
              (select min(e.at) from public.order_events e where e.order_id = o.id and e.status = 'in_service') as "startedAt",
              (select min(e.at) from public.order_events e where e.order_id = o.id and e.status = 'completed') as "completedAt",
              coalesce((select json_agg(r.stars) from public.reviews r where r.order_id = o.id and r.status = 'visible'), '[]') as stars
            from public.orders o
            where o.assigned_staff_id = any(${ids}) and o.status = 'completed' and o.scheduled_at >= ${from}`
        : Promise.resolve([] as PerfOrder[]),
      ids.length
        ? sql<{ staffId: string; n: number }[]>`
            select actor_id as "staffId", count(*)::int as n from public.audit_logs
            where action = 'order.discount' and actor_id = any(${ids}) and at >= ${from}
            group by actor_id`
        : Promise.resolve([]),
      branchNames(sql, staff.map((s) => s.branchId)),
    ]);
    const logs = new Map(discountLogs.map((r) => [r.staffId, r.n]));

    const list: VendorStaffMember[] = staff.map((s) => ({
      ...s,
      branchName: branches.get(s.branchId) ?? EMPTY_NAME,
      onShiftNow: onShift.has(s.id),
      performance: performance(orders.filter((o) => o.staffId === s.id), logs.get(s.id) ?? 0),
    }));
    // Sorting by computed performance stays in JS (the list is the scoped team, not paged).
    const sorted = sortBy(
      list,
      query,
      {
        name: (s) => s.name,
        completed: (s) => s.performance.completed,
        serviceValue: (s) => s.performance.serviceValue,
        rating: (s) => s.performance.rating,
        avgDuration: (s) => s.performance.avgDurationMin,
        discounts: (s) => s.performance.discountsAmount,
      },
      { key: "completed", order: "desc" },
    );
    const counts = {
      all: list.length,
      owner: list.filter((s) => s.role === "owner").length,
      manager: list.filter((s) => s.role === "manager").length,
      employee: list.filter((s) => s.role === "employee").length,
    };
    return ok(sorted, "OK", { meta: { counts, onShift: onShift.size } });
  }),

  vroute("POST", "/vendor/staff", async ({ body, actor }) => {
    if (!actor.staff.permissions.manageStaff) throw new MockApiError("ليس لديك صلاحية إدارة الموظفين", 403);
    const member = await tx(async (t) => {
      const branchId = String(body.branchId ?? "");
      assertBranch(actor, branchId);
      const role: StaffRole = body.role === "manager" ? "manager" : "employee";
      if (role === "manager") assertOwner(actor, "إضافة مدير فرع");
      const name = requireText(body.name, "name", "الاسم", 3);
      const phone = normalizePhone(String(body.phone ?? ""));
      if (phone.length !== 10) throw new MockApiError("رقم موبايل غير صحيح", 422, { phone: ["رقم غير صحيح"] });
      const [taken] = await t`select 1 from public.staff where phone = ${e164(phone)}`;
      if (taken) throw new MockApiError("هذا الرقم مسجل لحساب آخر", 409, { phone: ["مسجل بالفعل"] });
      const cap = Math.min(Number(body.maxDiscountPct ?? 10), actor.role === "owner" ? 50 : actor.staff.maxDiscountPct);
      const maxDiscountPct = Number.isNaN(cap) ? 10 : Math.round(cap);

      // Profile only: the Supabase Auth account is created separately (user_id stays null).
      const [{ id }] = await t<{ id: string }[]>`
        insert into public.staff (business_id, branch_id, name, phone, role, status, max_discount_pct, permissions)
        values (${actor.business.id}, ${branchId}, ${name}, ${e164(phone)}, ${role}, 'active', ${maxDiscountPct},
                ${t.json(asJson(parsePermissions(body.permissions, role)))})
        returning id`;
      await replacePatterns(t, id, [{ start: "09:00", end: "17:00", days: [0, 1, 2, 3, 4, 5, 6] }]);
      await audit(t, actor, "staff.create", "staff", id, branchId, null, `${name} · ${role}`);
      return staffById(t, id);
    });
    // Local auth accepts the demo password for every profile; with Supabase Auth the login is set up separately.
    return ok(member, isLocalAuth() ? `تمت إضافة ${member.name} — كلمة المرور المؤقتة demo1234` : `تمت إضافة ${member.name}`);
  }),

  vroute("PATCH", "/vendor/staff/:id", async ({ params, body, actor }) => {
    const member = await tx(async (t) => {
      const current = await businessStaff(t, actor, params.id);
      if (!current || (!actor.branchIds.includes(current.branchId) && current.role !== "owner")) throw new MockApiError("الموظف غير موجود", 404);
      if (current.role === "owner") throw new MockApiError("لا يمكن تعديل حساب المالك من هنا", 403);
      // MG-09: managers can't change roles, discount limits or move staff to other branches.
      assertOwner(actor, "تعديل الدور وحد الخصم والصلاحيات");
      const reason = requireText(body.reason, "reason", "سبب التعديل", 3);
      const before = { role: current.role, branchId: current.branchId, maxDiscountPct: current.maxDiscountPct, permissions: current.permissions };
      const next = { name: current.name, role: current.role, branchId: current.branchId, maxDiscountPct: current.maxDiscountPct, permissions: current.permissions };
      if (body.name) next.name = requireText(body.name, "name", "الاسم", 3);
      if (body.role === "manager" || body.role === "employee") next.role = body.role;
      if (body.branchId) {
        assertBranch(actor, String(body.branchId));
        next.branchId = String(body.branchId);
      }
      if (body.maxDiscountPct !== undefined) {
        const pct = Number(body.maxDiscountPct);
        if (Number.isNaN(pct) || pct < 0 || pct > 50) throw new MockApiError("حد الخصم بين 0 و 50٪", 422, { maxDiscountPct: ["قيمة غير صالحة"] });
        next.maxDiscountPct = Math.round(pct);
      }
      if (body.permissions) next.permissions = parsePermissions(body.permissions, next.role);
      await t`
        update public.staff set name = ${next.name}, role = ${next.role}, branch_id = ${next.branchId},
               max_discount_pct = ${next.maxDiscountPct}, permissions = ${t.json(asJson(next.permissions))}
        where id = ${current.id}`;
      await audit(
        t, actor, "staff.update", "staff", current.id, next.branchId, before,
        { role: next.role, branchId: next.branchId, maxDiscountPct: next.maxDiscountPct, permissions: next.permissions }, reason,
      );
      return staffById(t, current.id);
    });
    return ok(member, `تم تحديث بيانات ${member.name}`);
  }),

  vroute("POST", "/vendor/staff/:id/status", async ({ params, body, actor }) => {
    if (!actor.staff.permissions.manageStaff) throw new MockApiError("ليس لديك صلاحية إدارة الموظفين", 403);
    const active = Boolean(body.active);
    const member = await tx(async (t) => {
      const current = await businessStaff(t, actor, params.id);
      if (!current || !actor.branchIds.includes(current.branchId) || current.role === "owner") throw new MockApiError("الموظف غير موجود", 404);
      if (current.id === actor.staff.id) throw new MockApiError("لا يمكنك إيقاف حسابك", 409);
      if (current.role === "manager") assertOwner(actor, "إيقاف مدير فرع");
      const reason = requireText(body.reason, "reason", "السبب", 3);
      const status = active ? "active" : "suspended";
      // A suspended account fails actor resolution on its next request, which ends its sessions.
      await t`update public.staff set status = ${status} where id = ${current.id}`;
      await audit(t, actor, "staff.status", "staff", current.id, current.branchId, current.status, status, reason);
      return { ...current, status } as Staff;
    });
    return ok(member, active ? `تم تفعيل حساب ${member.name}` : `تم إيقاف ${member.name} — لن يستطيع تسجيل الدخول`);
  }),

  vroute("PUT", "/vendor/staff/:id/schedule", async ({ params, body, actor }) => {
    if (!actor.staff.permissions.manageStaff) throw new MockApiError("ليس لديك صلاحية إدارة الورديات", 403);
    const member = await tx(async (t) => {
      const current = await businessStaff(t, actor, params.id);
      if (!current || !actor.branchIds.includes(current.branchId) || current.role === "owner") throw new MockApiError("الموظف غير موجود", 404);
      const shifts = Array.isArray(body.shifts) ? (body.shifts as ShiftPattern[]) : [];
      for (const p of shifts) {
        if (!HHMM.test(String(p.start)) || !HHMM.test(String(p.end))) throw new MockApiError("صيغة الوقت غير صحيحة", 422);
        if (clockToMin(p.end, true) <= clockToMin(p.start)) throw new MockApiError("نهاية الوردية يجب أن تكون بعد بدايتها", 422);
        // The database requires 1–7 whole weekdays per pattern.
        if (!Array.isArray(p.days) || !p.days.length || !p.days.every((d) => Number.isInteger(Number(d)) && d >= 0 && d <= 6)) {
          throw new MockApiError("أيام غير صالحة", 422);
        }
      }
      const patterns = shifts.map((p) => ({ start: p.start, end: p.end, days: [...new Set(p.days.map(Number))].sort() }));
      await replacePatterns(t, current.id, patterns);
      await audit(t, actor, "staff.schedule", "staff", current.id, current.branchId, current.scheduledShifts, patterns);
      return staffById(t, current.id);
    });
    return ok(member, `تم تحديث جدول ${member.name}`);
  }),

  // ── Shift closings (D11 / MG-07 / OW-15) ─────────────────
  vroute("GET", "/vendor/shifts", async ({ query, actor }) => {
    const sql = db();
    const branchIds = scopeBranches(actor, query.get("branchId"));
    const filter = query.get("filter") ?? "all";
    const cond =
      filter === "all"
        ? sql``
        : filter === "difference"
          ? sql`and coalesce(sh.difference, 0) <> 0`
          : sql`and sh.review_status::text = ${filter}`;

    const [[counts], [totals]] = await Promise.all([
      sql<{ all: number; difference: number; open: number; submitted: number; reviewed: number; flagged: number }[]>`
        select count(*)::int as all,
               (count(*) filter (where coalesce(sh.difference, 0) <> 0))::int as difference,
               (count(*) filter (where sh.review_status = 'open'))::int as open,
               (count(*) filter (where sh.review_status = 'submitted'))::int as submitted,
               (count(*) filter (where sh.review_status = 'reviewed'))::int as reviewed,
               (count(*) filter (where sh.review_status = 'flagged'))::int as flagged
        from public.staff_shifts sh where sh.branch_id = any(${branchIds})`,
      sql<{ total: number; expected: number; difference: number }[]>`
        select count(*)::int as total, coalesce(sum(sh.expected_cash), 0) as expected, coalesce(sum(sh.difference), 0) as difference
        from public.staff_shifts sh where sh.branch_id = any(${branchIds}) ${cond}`,
    ]);
    // Awaiting review first, then newest.
    const { items, pagination } = await paged(query, totals.total, 15, async (limit, offset) =>
      toClosings(
        sql,
        await shiftsWhere(
          sql,
          sql`sh.branch_id = any(${branchIds}) ${cond}`,
          sql`order by (sh.review_status = 'submitted') desc, sh.scheduled_start desc, sh.id limit ${limit} offset ${offset}`,
        ),
      ),
    );
    return ok(items, "OK", {
      pagination,
      meta: { counts, totals: { expected: totals.expected, difference: totals.difference } },
    });
  }),

  vroute("GET", "/vendor/shifts/:id", async ({ params, actor }) => {
    const sql = db();
    const [row] = await shiftsWhere(sql, sql`sh.id = ${params.id}`);
    if (!row || !actor.branchIds.includes(row.branchId)) throw new MockApiError("الوردية غير موجودة", 404);
    const start = new Date(new Date(row.actualStart ?? row.scheduledStart).getTime() - 3600000).toISOString();
    const end = new Date(row.actualEnd ?? now()).toISOString();
    const [[shift], orders, auditLogs] = await Promise.all([
      toClosings(sql, [row]),
      sql<{ id: string; number: string; plate: string; total: number; method: PaymentMethod | null; paid: boolean; at: string }[]>`
        select o.id, o.number, o.plate, o.total, o.payment_method as method, (o.payment_status = 'paid') as paid, o.scheduled_at as at
        from public.orders o
        where o.assigned_staff_id = ${row.staffId} and o.status = 'completed' and o.scheduled_at >= ${start} and o.scheduled_at <= ${end}
        order by o.scheduled_at, o.id`,
      auditWhere(sql, sql`al.entity_id = ${row.id}`, sql`order by al.at desc, al.id`),
    ]);
    return ok({ shift, orders, auditLogs });
  }),

  vroute("POST", "/vendor/shifts/:id/review", async ({ params, body, actor }) => {
    if (!actor.staff.permissions.closeShift) throw new MockApiError("ليس لديك صلاحية مراجعة الورديات", 403);
    const { closing, status } = await tx(async (t) => {
      const [current] = await shiftsWhere(t, t`sh.id = ${params.id}`);
      if (!current || !actor.branchIds.includes(current.branchId)) throw new MockApiError("الوردية غير موجودة", 404);
      if (current.reviewStatus === "open") throw new MockApiError("الوردية ما زالت مفتوحة — لا يمكن مراجعتها قبل الإغلاق", 409);
      const status = body.status === "flagged" ? "flagged" : "reviewed";
      const note = requireText(body.note, "note", "ملاحظة المراجعة", 3);
      // Guard in the WHERE clause: a shift reopened meanwhile can't be reviewed.
      const updated = await t`
        update public.staff_shifts set review_status = ${status}, review_note = ${note}, reviewed_by = ${actor.staff.id}
        where id = ${current.id} and review_status <> 'open' returning id`;
      if (!updated.length) throw new MockApiError("الوردية ما زالت مفتوحة — لا يمكن مراجعتها قبل الإغلاق", 409);
      await logAudit(t, {
        actorType: "staff",
        actorId: actor.staff.id,
        action: status === "flagged" ? "shift.flag" : "shift.review",
        entity: "shifts",
        entityId: current.id,
        branchId: current.branchId,
        oldValue: current.reviewStatus,
        newValue: status,
        reason: note,
      });
      const [row] = await shiftsWhere(t, t`sh.id = ${current.id}`);
      const [closing] = await toClosings(t, [row]);
      return { closing, status };
    });
    return ok(closing, status === "flagged" ? "تم تمييز الوردية للمتابعة" : "تمت مراجعة الوردية");
  }),

  // ── End-of-day reconciliation (MG-08) ────────────────────
  vroute("GET", "/vendor/day-closing", async ({ query, actor }) => {
    const sql = db();
    const branchId = singleBranch(actor, query.get("branchId"));
    const date = query.get("date") ?? dayKey(now());
    const [start, end] = dateBounds(date);
    const inDay = () => sql`o.branch_id = ${branchId} and o.scheduled_at >= ${start} and o.scheduled_at < ${end}`;

    const [orders, [stats], [closing], history, names] = await Promise.all([
      sql<DayClosingSummary["orders"]>`
        select o.id, o.number, o.plate, o.total, o.payment_method as method, (o.payment_status = 'paid') as paid
        from public.orders o where ${inDay()} and o.status = 'completed'
        order by o.scheduled_at, o.id`,
      sql<{ cash: number; card: number; online: number; inService: number; unpaid: number }[]>`
        select coalesce(sum(o.total) filter (where o.status = 'completed' and o.payment_status = 'paid' and o.payment_method = 'cash'), 0) as cash,
               coalesce(sum(o.total) filter (where o.status = 'completed' and o.payment_status = 'paid' and o.payment_method = 'card'), 0) as card,
               coalesce(sum(o.total) filter (where o.status = 'completed' and o.payment_status = 'paid' and o.payment_method = 'online'), 0) as online,
               (count(*) filter (where o.status in ('in_service', 'waiting')))::int as "inService",
               (count(*) filter (where o.status = 'completed' and o.payment_status = 'pending'))::int as unpaid
        from public.orders o where ${inDay()}`,
      dayClosingsWhere(sql, sql`dc.branch_id = ${branchId} and dc.date = ${date}`),
      dayClosingsWhere(sql, sql`dc.branch_id = ${branchId}`, sql`order by dc.date desc limit 10`),
      branchNames(sql, [branchId]),
    ]);
    const summary: DayClosingSummary = {
      branchId,
      branchName: names.get(branchId) ?? EMPTY_NAME,
      date,
      closing: closing ?? null,
      completedOrders: orders.length,
      expected: methodTotals({ cash: stats.cash, card: stats.card, online: stats.online }),
      inServiceOrders: stats.inService,
      unpaidOrders: stats.unpaid,
      orders,
      history,
    };
    return ok(summary);
  }),

  vroute("POST", "/vendor/day-closing", async ({ body, actor }) => {
    if (!actor.staff.permissions.closeShift) throw new MockApiError("ليس لديك صلاحية إغلاق اليوم", 403);
    const branchId = String(body.branchId ?? "");
    assertBranch(actor, branchId);
    const date = String(body.date ?? dayKey(now()));
    const [start, end] = dateBounds(date);

    const closing = await tx(async (t) => {
      const [done] = await t`select 1 from public.day_closings where branch_id = ${branchId} and date = ${date}`;
      if (done) throw new MockApiError("تم إغلاق هذا اليوم مسبقًا", 409);
      const inDay = () => t`o.branch_id = ${branchId} and o.scheduled_at >= ${start} and o.scheduled_at < ${end}`;
      const blocking = await t<{ number: string }[]>`
        select o.number from public.orders o
        where ${inDay()} and (o.status in ('in_service', 'waiting') or (o.status = 'completed' and o.payment_status = 'pending'))
        order by o.scheduled_at, o.id`;
      if (blocking.length) {
        throw new MockApiError(`لا يمكن الإغلاق: ${blocking.length} طلب ما زال قيد التنفيذ أو بدون دفع (${blocking.map((o) => o.number).slice(0, 4).join("، ")})`, 409);
      }
      const paid = await t<{ id: string; total: number; method: PaymentMethod | null }[]>`
        select o.id, o.total, o.payment_method as method from public.orders o
        where ${inDay()} and o.status = 'completed' and o.payment_status = 'paid'`;
      const expected = methodTotals(Object.fromEntries(METHODS.map((m) => [m, paid.filter((o) => o.method === m).reduce((s, o) => s + o.total, 0)])));
      const rawActual = (body.actual ?? {}) as Record<string, unknown>;
      // Stored as numeric(10,2): round each amount so the difference matches what is saved.
      const actual = methodTotals(Object.fromEntries(METHODS.map((m) => [m, round2(Math.max(0, Number(rawActual[m] ?? 0) || 0))])));
      const difference = round2(actual.total - expected.total);
      const reason = typeof body.reason === "string" ? body.reason.trim() : "";
      if (difference !== 0 && reason.length < 3) throw new MockApiError("يوجد فرق — اكتب سبب الفرق قبل الإغلاق", 422, { reason: ["مطلوب عند وجود فرق"] });

      // `difference` is generated by the database; once per branch/day enforced by the unique key.
      const [row] = await t<{ id: string }[]>`
        insert into public.day_closings (branch_id, date, expected_cash, expected_card, expected_online,
                                         actual_cash, actual_card, actual_online, reason, orders_locked, closed_by)
        values (${branchId}, ${date}, ${expected.cash}, ${expected.card}, ${expected.online},
                ${actual.cash}, ${actual.card}, ${actual.online}, ${reason || null}, ${paid.length}, ${actor.staff.id})
        on conflict (branch_id, date) do nothing
        returning id`;
      if (!row) throw new MockApiError("تم إغلاق هذا اليوم مسبقًا", 409);
      if (paid.length) {
        await t`update public.orders set closed_in_day_id = ${row.id} where id = any(${paid.map((o) => o.id)})`;
      }
      await logAudit(t, {
        actorType: "staff",
        actorId: actor.staff.id,
        action: "day.close",
        entity: "branches",
        entityId: branchId,
        branchId,
        oldValue: expected.total,
        newValue: actual.total,
        reason: reason || null,
      });
      const [saved] = await dayClosingsWhere(t, t`dc.id = ${row.id}`);
      return saved;
    });
    return ok(
      closing,
      closing.difference ? `تم إغلاق اليوم بفرق ${closing.difference} ج.م — تم قفل ${closing.ordersLocked} طلب` : `تم إغلاق اليوم وقفل ${closing.ordersLocked} طلب`,
    );
  }),
];
