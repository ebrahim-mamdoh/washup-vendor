import "server-only";

import type { Localized } from "@/types/common";
import type { Order } from "@/types/orders";
import type {
  CarInside,
  LiveBranchCard,
  SetupChecklist,
  VendorAlert,
  VendorDashboard,
  VendorKpi,
  VendorKpiKey,
  VendorPeriod,
} from "@/types/vendor/dashboard";
import type { Branch, Staff } from "@/types/washes";

import { daysAgo, now, round2 } from "../../db";
import { ok } from "../../http";
import { serviceName } from "../../lookups";
import type { VendorActor } from "../../router";
import { dayKey, hoursFor, isOpenAt, overdueMinutes } from "../../vendor/engine";
import { branchesWhere, ordersWhere, shiftsWhere } from "../entities";
import { onShiftAt, staffNames } from "../lookups";
import { vroute } from "../router";
import { type Q, db } from "../sql";
import { scopeBranches } from "./scope";

/**
 * Vendor dashboard on Postgres. The KPI/chart math is the mock's, run over a
 * bounded, scoped set: the actor's branches, from the start of the previous
 * comparison period (≥ 7 days for the alerts) to the end of today, plus every
 * order still inside the wash or unpaid (live cards, cars inside, late payments).
 */
const DAYS: Record<VendorPeriod, number> = { today: 1, "7d": 7, "30d": 30 };
const EMPTY: Localized = { ar: "—", en: "—" };

const paidRevenue = (os: Order[]) => os.filter((o) => o.paymentStatus === "paid").reduce((s, o) => s + o.total, 0);

/**
 * Each order's schedule time and local day, parsed once per request. The KPI,
 * chart and card math walks the same ~1,000 orders dozens of times; re-parsing
 * dates (and converting them to the local time zone) on every pass made the
 * 30-day dashboard take seconds of CPU.
 */
const stamps = new WeakMap<Order, { t: number; day: string }>();
function stamp(o: Order) {
  let s = stamps.get(o);
  if (!s) {
    const d = new Date(o.scheduledAt);
    s = { t: d.getTime(), day: dayKey(d) };
    stamps.set(o, s);
  }
  return s;
}
const onDay = (o: Order, day: string) => stamp(o).day === day;

function inRange(orders: Order[], from: Date, to: Date) {
  const a = from.getTime();
  const b = to.getTime();
  return orders.filter((o) => {
    const t = stamp(o).t;
    return t >= a && t <= b;
  });
}

function endOfDay(d: Date) {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
}

function kpiValues(os: Order[]): Record<VendorKpiKey, number> {
  const bookings = os.filter((o) => o.source !== "walk_in");
  return {
    totalOrders: os.filter((o) => o.status !== "cancelled").length,
    confirmedBookings: bookings.filter((o) => !["pending", "cancelled", "no_show"].includes(o.status)).length,
    walkIns: os.filter((o) => o.source === "walk_in").length,
    completed: os.filter((o) => o.status === "completed").length,
    cancelled: os.filter((o) => o.status === "cancelled").length,
    noShows: os.filter((o) => o.status === "no_show").length,
    revenue: paidRevenue(os),
    pendingPayments: os.filter((o) => o.status === "completed" && o.paymentStatus === "pending").length,
  };
}

/** End of a past day, clipped to the current time-of-day — for "vs. same time yesterday". */
function sameTimeOn(day: Date) {
  const t = now();
  const d = new Date(day);
  d.setHours(t.getHours(), t.getMinutes(), 59, 999);
  return d;
}

function buildKpis(scoped: Order[], period: VendorPeriod): VendorKpi[] {
  const n = DAYS[period];
  const today = now();
  // "Today" is a partial day, so it is compared with the same hours of each earlier day.
  const until = (day: Date) => (period === "today" ? sameTimeOn(day) : endOfDay(day));
  const cur = inRange(scoped, daysAgo(n - 1), endOfDay(today));
  const prev = inRange(scoped, daysAgo(2 * n - 1), until(daysAgo(n)));
  const curV = kpiValues(cur);
  const prevV = kpiValues(prev);
  // Sparklines: 7 buckets of the period length (days for today/7d, ~4-day buckets for 30d).
  const bucket = period === "30d" ? 4 : 1;
  const sparks = Array.from({ length: 7 }, (_, i) => {
    const endOffset = (6 - i) * bucket;
    const from = daysAgo(endOffset + bucket - 1);
    return kpiValues(inRange(scoped, from, endOffset === 0 ? endOfDay(today) : until(daysAgo(endOffset))));
  });
  return (Object.keys(curV) as VendorKpiKey[]).map((key) => ({
    key,
    value: curV[key],
    delta: prevV[key] ? round2(((curV[key] - prevV[key]) / prevV[key]) * 100) : null,
    spark: sparks.map((s) => s[key]),
  }));
}

function liveBranch(b: Branch, scoped: Order[], onShift: Staff[], at: Date, todayKey: string): LiveBranchCard {
  const mine = scoped.filter((o) => o.branchId === b.id);
  const today = mine.filter((o) => onDay(o, todayKey));
  const h = hoursFor(b, at);
  return {
    id: b.id,
    name: b.name,
    area: b.area,
    isOpen: isOpenAt(b, at),
    opensAt: h.closed ? null : h.open,
    closesAt: h.closed ? null : h.close,
    activeOrders: today.filter((o) => ["pending", "confirmed", "waiting", "in_service"].includes(o.status)).length,
    waiting: today.filter((o) => o.status === "waiting").length,
    inService: today.filter((o) => o.status === "in_service").length,
    paymentPending: today.filter((o) => o.status === "completed" && o.paymentStatus === "pending").length,
    baysBusy: mine.filter((o) => o.status === "in_service").length,
    capacity: b.capacity,
    staffOnShift: onShift.map((s) => ({ id: s.id, name: s.name })),
    revenueToday: paidRevenue(today),
  };
}

function carsInside(scoped: Order[], branches: Map<string, Branch>, staff: Map<string, string>, at: Date, todayKey: string): CarInside[] {
  return scoped
    .filter(
      (o) =>
        o.status === "waiting" || o.status === "in_service" || (o.status === "completed" && o.paymentStatus === "pending" && onDay(o, todayKey)),
    )
    .map((o) => {
      const since = [...o.timeline].reverse().find((e) => e.status === o.status)?.at ?? o.scheduledAt;
      return {
        orderId: o.id,
        number: o.number,
        plate: o.plate,
        status: o.status,
        paymentPending: o.status === "completed",
        serviceName: serviceName(o),
        branchName: branches.get(o.branchId)?.name ?? EMPTY,
        staffName: (o.assignedStaffId && staff.get(o.assignedStaffId)) || null,
        since,
        overdueMin: overdueMinutes(o, at),
      };
    })
    .sort((a, b) => ["in_service", "waiting", "completed"].indexOf(a.status) - ["in_service", "waiting", "completed"].indexOf(b.status));
}

async function alerts(
  q: Q,
  actor: VendorActor,
  branchIds: string[],
  scoped: Order[],
  branches: Map<string, Branch>,
  onShift: Map<string, Staff[]>,
  at: Date,
  todayKey: string,
): Promise<VendorAlert[]> {
  const [shifts, [{ lowUnreplied }]] = await Promise.all([
    shiftsWhere(q, q`sh.branch_id = any(${branchIds}) and sh.review_status = 'submitted' and coalesce(sh.difference, 0) <> 0`, q`order by sh.scheduled_start, sh.id`),
    q<{ lowUnreplied: number }[]>`
      select count(*)::int as "lowUnreplied" from public.reviews
      where branch_id = any(${branchIds}) and status = 'visible' and stars <= 2 and coalesce(reply, '') = ''`,
  ]);
  const shiftStaff = await staffNames(q, shifts.map((s) => s.staffId));

  const out: VendorAlert[] = [];
  if (actor.business.status === "suspended") {
    out.push({
      id: "suspended",
      type: "suspended",
      severity: "danger",
      title: "المغسلة معلّقة من إدارة كارزن",
      description: actor.business.statusReason ?? "لا تظهر للعملاء حاليًا ولا تستقبل حجوزات جديدة.",
      href: "/notifications",
    });
  }
  for (const s of shifts) {
    out.push({
      id: `cash_${s.id}`,
      type: "cash_difference",
      severity: "danger",
      title: `فرق نقدية ${s.difference! > 0 ? "+" : ""}${s.difference} ج.م`,
      description: `وردية ${shiftStaff.get(s.staffId) ?? null} — ${(branches.get(s.branchId)?.name ?? EMPTY).ar}`,
      href: `/shifts?filter=difference`,
    });
  }
  const late = scoped.filter((o) => o.status === "completed" && o.paymentStatus === "pending" && overdueMinutes(o, at) > 30);
  if (late.length) {
    out.push({
      id: "pay_pending",
      type: "payment_pending",
      severity: "warning",
      title: `${late.length} طلب مكتمل بدون دفع لأكثر من 30 دقيقة`,
      description: late.map((o) => o.number).slice(0, 3).join("، "),
      href: "/orders?tab=payment_pending",
    });
  }
  for (const id of branchIds) {
    const b = branches.get(id)!;
    if (isOpenAt(b, at) && (onShift.get(id) ?? []).length === 0) {
      out.push({
        id: `noshift_${id}`,
        type: "no_shift",
        severity: "warning",
        title: `لا يوجد موظف في وردية — ${b.name.ar}`,
        description: "الفرع مفتوح الآن بدون أي موظف مسجل في وردية.",
        href: "/staff",
      });
    }
  }
  const last7 = inRange(scoped, daysAgo(6), endOfDay(at));
  const cancelRate = last7.length >= 10 ? last7.filter((o) => o.status === "cancelled").length / last7.length : 0;
  if (cancelRate >= 0.15) {
    out.push({
      id: "cancel_rate",
      type: "high_cancellation",
      severity: "warning",
      title: `نسبة إلغاء مرتفعة ${Math.round(cancelRate * 100)}٪`,
      description: "خلال آخر 7 أيام — راجع أسباب الإلغاء في الحجوزات.",
      href: "/bookings?tab=cancelled",
    });
  }
  const noShows = scoped.filter((o) => o.status === "no_show" && onDay(o, todayKey)).length;
  if (noShows) {
    out.push({ id: "noshow", type: "no_show", severity: "info", title: `${noShows} عدم حضور اليوم`, description: "تم تحرير مواعيدهم.", href: "/bookings?tab=no_show" });
  }
  if (lowUnreplied) {
    out.push({ id: "reviews", type: "review", severity: "info", title: `${lowUnreplied} تقييم منخفض بدون رد`, description: "الرد السريع يحسن صورة المغسلة.", href: "/reviews?replied=no" });
  }
  return out;
}

async function setupChecklist(q: Q, actor: VendorActor): Promise<SetupChecklist | null> {
  const ageDays = (now().getTime() - new Date(actor.business.createdAt).getTime()) / 86400000;
  if (actor.business.status !== "approved" && ageDays > 30) return null;
  const [s] = await q<{ branchOk: boolean; anyActive: boolean; services: number; hours: boolean; staff: boolean }[]>`
    select
      coalesce(bool_and(coalesce(br.phone, '') <> '' and coalesce(br.address ->> 'ar', '') <> ''), true) as "branchOk",
      coalesce(bool_or(br.active), false) as "anyActive",
      (select count(*)::int from public.services sv join public.branches b2 on b2.id = sv.branch_id
        where b2.business_id = ${actor.business.id} and sv.active) as services,
      exists (select 1 from public.audit_logs al join public.branches b3 on b3.id = al.branch_id
        where al.action = 'branch.update' and b3.business_id = ${actor.business.id}) as hours,
      exists (select 1 from public.staff st where st.business_id = ${actor.business.id} and st.role <> 'owner') as staff
    from public.branches br where br.business_id = ${actor.business.id}`;
  const steps = [
    { key: "branch" as const, label: "راجع بيانات الفرع والعنوان", done: s.branchOk, href: "/branches" },
    { key: "services" as const, label: "راجع الخدمات والأسعار", done: s.services >= 2, href: "/services" },
    { key: "hours" as const, label: "اضبط ساعات العمل والسعة", done: s.hours, href: "/branches" },
    { key: "staff" as const, label: "أضف أول موظف", done: s.staff, href: "/staff" },
    { key: "live" as const, label: "فعّل المغسلة للعملاء", done: actor.business.status === "active" && s.anyActive, href: "/settings" },
  ];
  const done = steps.filter((x) => x.done).length;
  if (done === steps.length && ageDays > 7) return null;
  return { steps, done, total: steps.length };
}

export const vendorDashboardRoutes = [
  vroute("GET", "/vendor/dashboard", async ({ query, actor }) => {
    const sql = db();
    const raw = query.get("period");
    const period: VendorPeriod = raw === "7d" || raw === "30d" ? raw : "today";
    const branchIds = scopeBranches(actor, query.get("branchId"));
    const n = DAYS[period];
    const at = now();
    // Oldest day any figure reads: the previous comparison period, and 7 days for sparklines/alerts.
    const windowStart = daysAgo(Math.max(2 * n - 1, 6));

    const [scoped, branchRows, shiftLists] = await Promise.all([
      ordersWhere(
        sql,
        sql`o.branch_id = any(${branchIds}) and ((o.scheduled_at >= ${windowStart.toISOString()} and o.scheduled_at <= ${endOfDay(at).toISOString()})
            or o.status in ('waiting', 'in_service') or (o.status = 'completed' and o.payment_status = 'pending'))`,
        sql`order by o.created_at, o.id`,
      ),
      branchesWhere(sql, sql`br.id = any(${branchIds})`),
      Promise.all(branchIds.map((id) => onShiftAt(sql, id, at))),
    ]);
    const branches = new Map(branchRows.map((b) => [b.id, b]));
    const onShift = new Map(branchIds.map((id, i) => [id, shiftLists[i]]));
    const inside = scoped.filter((o) => o.status === "waiting" || o.status === "in_service" || o.status === "completed");
    const todayKey = dayKey(at);
    const [staff, alertList] = await Promise.all([
      staffNames(sql, inside.map((o) => o.assignedStaffId)),
      alerts(sql, actor, branchIds, scoped, branches, onShift, at, todayKey),
    ]);

    const periodOrders = inRange(scoped, daysAgo(n - 1), endOfDay(at));
    const today = scoped.filter((o) => onDay(o, todayKey));

    let revenueChart: { label: string; value: number }[];
    if (period === "today") {
      const hours = Array.from({ length: Math.max(1, at.getHours() - 7) }, (_, i) => 8 + i);
      revenueChart = hours.map((h) => ({
        label: `${h % 12 || 12}${h >= 12 ? "م" : "ص"}`,
        value: paidRevenue(today.filter((o) => new Date(o.scheduledAt).getHours() === h)),
      }));
    } else {
      revenueChart = Array.from({ length: n }, (_, i) => {
        const d = daysAgo(n - 1 - i);
        const key = dayKey(d);
        return { label: `${d.getDate()}/${d.getMonth() + 1}`, value: paidRevenue(scoped.filter((o) => onDay(o, key))) };
      });
    }

    const svcCount = new Map<string, { name: Order["items"][number]["name"]; count: number; revenue: number }>();
    periodOrders
      .filter((o) => o.status !== "cancelled")
      .forEach((o) => {
        const p = o.items.find((i) => i.type === "primary") ?? o.items[0];
        const key = p.name.ar;
        const cur = svcCount.get(key) ?? { name: p.name, count: 0, revenue: 0 };
        cur.count += 1;
        cur.revenue += o.paymentStatus === "paid" ? o.total : 0;
        svcCount.set(key, cur);
      });
    const topServices = [...svcCount.values()].sort((a, b) => b.count - a.count).slice(0, 5);

    const data: VendorDashboard = {
      period,
      branchId: query.get("branchId") ?? "all",
      generatedAt: at.toISOString(),
      kpis: buildKpis(scoped, period),
      liveBranches: branchIds.map((id) => liveBranch(branches.get(id)!, scoped, onShift.get(id) ?? [], at, todayKey)),
      carsInside: carsInside(scoped, branches, staff, at, todayKey),
      alerts: alertList,
      charts: {
        revenueByHour: revenueChart,
        bySource: (["app", "walk_in", "phone"] as const).map((source) => ({ source, value: periodOrders.filter((o) => o.source === source).length })),
        topServices,
        byStatus: (["pending", "confirmed", "waiting", "in_service", "completed", "cancelled", "no_show"] as const)
          .map((status) => ({ status, value: periodOrders.filter((o) => o.status === status).length }))
          .filter((x) => x.value > 0),
      },
      dailySummary: {
        orders: today.filter((o) => o.status !== "cancelled").length,
        revenue: paidRevenue(today),
        topService: topServices[0]?.name ?? null,
        issues: alertList.length,
      },
    };
    return ok(data);
  }),
  // Guided setup, read by the sidebar card on every page (kept out of the dashboard payload).
  vroute("GET", "/vendor/setup", async ({ actor }) => ok(await setupChecklist(db(), actor))),
];
