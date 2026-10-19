import "server-only";

import type { Localized } from "@/types/common";
import type {
  AttentionWash,
  DashboardAlert,
  DashboardFunnel,
  DashboardKpi,
  DashboardPeriod,
  DashboardSummary,
  KpiKey,
  RevenuePoint,
  TopWash,
} from "@/types/dashboard";

import { daysAgo, now, round2 } from "../../db";
import { ok } from "../../http";
import { defaultCommissionPct } from "../platform";
import { route } from "../router";
import { type Q, db } from "../sql";

/**
 * Super Admin dashboard on Postgres. Same shape and alert rules as the mock
 * (`../../handlers/dashboard.ts`), with one deliberate difference: the mock
 * adds a fixed "whole platform" baseline (and synthetic trend curves) to the
 * headline figures because its seed is a sample. Here every figure, spark and
 * curve is the real number from the database.
 */
const PERIOD_DAYS: Record<DashboardPeriod, number> = { today: 1, "7d": 7, "30d": 30 };

/** Local calendar days of the last `days` days (oldest → newest) as [start, end) ISO bounds. */
function dayRanges(days: number) {
  const list = Array.from({ length: days }, (_, i) => daysAgo(days - 1 - i));
  const ends = list.map((d) => {
    const e = new Date(d);
    e.setDate(e.getDate() + 1);
    return e.toISOString();
  });
  return { list, starts: list.map((d) => d.toISOString()), ends };
}

function deltaOf(series: number[]): number | null {
  if (series.length < 2) return null;
  const prev = series[series.length - 2];
  const cur = series[series.length - 1];
  if (!prev) return null;
  return round2(((cur - prev) / prev) * 100);
}

interface DayTotals {
  created: number;
  completed: number;
  cancelled: number;
  gmv: number;
  commission: number;
}

/**
 * Per-bucket order totals for [start, end) ranges: bookings, completed,
 * cancelled, paid GMV and platform commission (each wash's current rate).
 */
function orderTotals(q: Q, starts: string[], ends: string[], pct: number) {
  return q<DayTotals[]>`
    select count(o.id)::int as created,
           (count(o.id) filter (where o.status = 'completed'))::int as completed,
           (count(o.id) filter (where o.status = 'cancelled'))::int as cancelled,
           coalesce(sum(o.total) filter (where o.status = 'completed' and o.payment_status = 'paid'), 0) as gmv,
           coalesce(sum(o.total * coalesce(b.commission_rate, ${pct}::numeric) / 100)
                    filter (where o.status = 'completed' and o.payment_status = 'paid'), 0) as commission
    from unnest(${starts}::timestamptz[], ${ends}::timestamptz[]) with ordinality as d(s, e, i)
    left join (public.orders o join public.businesses b on b.id = o.business_id)
      on o.scheduled_at >= d.s and o.scheduled_at < d.e
    group by d.i order by d.i`;
}

interface Counts {
  customers: number;
  activeCustomers: number;
  totalWashes: number;
  activeWashes: number;
  totalBranches: number;
  activeBranches: number;
  pendingApplications: number;
}

/**
 * Platform counts as of each end instant (growth sparks). Customers, washes
 * and branches by creation date; applications still pending at that time.
 */
function countsAt(q: Q, ends: string[]) {
  return q<Counts[]>`
    select (select count(*)::int from public.customers cu where cu.created_at < d.e) as customers,
           (select count(*)::int from public.customers cu where cu.created_at < d.e and cu.status = 'active') as "activeCustomers",
           (select count(*)::int from public.businesses b where b.created_at < d.e and b.status <> 'rejected') as "totalWashes",
           (select count(*)::int from public.businesses b where b.created_at < d.e and b.status = 'active') as "activeWashes",
           (select count(*)::int from public.branches br where br.created_at < d.e) as "totalBranches",
           (select count(*)::int from public.branches br where br.created_at < d.e and br.active) as "activeBranches",
           (select count(*)::int from public.wash_applications ap
             where ap.submitted_at < d.e and (ap.status = 'pending' or ap.reviewed_at >= d.e)) as "pendingApplications"
    from unnest(${ends}::timestamptz[]) with ordinality as d(e, i)
    order by d.i`;
}

/** Current platform counts (no date cut-off: the headline values). */
function currentCounts(q: Q) {
  return q<Counts[]>`
    select (select count(*)::int from public.customers) as customers,
           (select count(*)::int from public.customers where status = 'active') as "activeCustomers",
           (select count(*)::int from public.businesses where status <> 'rejected') as "totalWashes",
           (select count(*)::int from public.businesses where status = 'active') as "activeWashes",
           (select count(*)::int from public.branches) as "totalBranches",
           (select count(*)::int from public.branches where active) as "activeBranches",
           (select count(*)::int from public.wash_applications where status = 'pending') as "pendingApplications"`;
}

function buildKpis(week: DayTotals[], history: Counts[], current: Counts): DashboardKpi[] {
  // The last spark point is the headline value itself.
  const growth = (k: keyof Counts) => [...history.slice(0, -1).map((h) => h[k]), current[k]];
  const daily = (k: keyof DayTotals) => week.map((d) => (k === "commission" ? round2(d[k]) : d[k]));
  const make = (key: KpiKey, spark: number[], delta?: number | null): DashboardKpi => ({
    key,
    value: spark[spark.length - 1],
    spark,
    delta: delta === undefined ? deltaOf(spark) : delta,
  });

  return [
    make("customers", growth("customers")),
    make("activeCustomers", growth("activeCustomers")),
    make("totalWashes", growth("totalWashes")),
    make("activeWashes", growth("activeWashes")),
    make("pendingApplications", growth("pendingApplications"), null),
    make("totalBranches", growth("totalBranches")),
    make("bookingsToday", daily("created")),
    make("completedToday", daily("completed")),
    make("cancelledToday", daily("cancelled")),
    make("gmvToday", daily("gmv")),
    make("platformRevenueToday", daily("commission")),
  ];
}

async function buildFunnel(q: Q, from: string, end: string): Promise<DashboardFunnel> {
  const [f] = await q<{ created: number; confirmed: number; waiting: number; inService: number; completed: number; cancelled: number; noShow: number }[]>`
    select count(*)::int as created,
           (count(*) filter (where status in ('confirmed', 'waiting', 'in_service', 'completed')))::int as confirmed,
           (count(*) filter (where status in ('waiting', 'in_service', 'completed')))::int as waiting,
           (count(*) filter (where status in ('in_service', 'completed')))::int as "inService",
           (count(*) filter (where status = 'completed'))::int as completed,
           (count(*) filter (where status = 'cancelled'))::int as cancelled,
           (count(*) filter (where status = 'no_show'))::int as "noShow"
    from public.orders where scheduled_at >= ${from} and scheduled_at < ${end}`;
  return {
    steps: [
      { key: "created", value: f.created },
      { key: "confirmed", value: f.confirmed },
      { key: "waiting", value: f.waiting },
      { key: "in_service", value: f.inService },
      { key: "completed", value: f.completed },
    ],
    cancelled: f.cancelled,
    noShow: f.noShow,
  };
}

/**
 * Revenue curve: hourly for today (8 ص → current hour; earlier/later orders
 * fold into the first/last hour so the total matches the KPI card), daily
 * otherwise.
 */
async function buildRevenue(q: Q, period: DashboardPeriod, week: DayTotals[], pct: number): Promise<RevenuePoint[]> {
  if (period === "today") {
    const today = daysAgo(0);
    const hours = Array.from({ length: Math.max(1, now().getHours() - 7) }, (_, i) => 8 + i);
    const at = (h: number) => {
      const d = new Date(today);
      d.setHours(h, 0, 0, 0);
      return d.toISOString();
    };
    const starts = hours.map((h, i) => (i === 0 ? at(0) : at(h)));
    const ends = hours.map((h, i) => (i === hours.length - 1 ? at(24) : at(h + 1)));
    const rows = await orderTotals(q, starts, ends, pct);
    return hours.map((h, i) => ({
      label: `${h % 12 || 12}${h >= 12 ? "م" : "ص"}`,
      gmv: rows[i].gmv,
      commission: round2(rows[i].commission),
    }));
  }

  const days = PERIOD_DAYS[period];
  const { list, starts, ends } = dayRanges(days);
  const rows = days === week.length ? week : await orderTotals(q, starts, ends, pct);
  return list.map((day, i) => ({
    label: `${day.getDate()}/${day.getMonth() + 1}`,
    gmv: rows[i].gmv,
    commission: round2(rows[i].commission),
  }));
}

async function buildAlerts(q: Q): Promise<DashboardAlert[]> {
  const [[c], spikes, [shift]] = await Promise.all([
    q<{ pendingApps: number; disc: number; reported: number }[]>`
      select (select count(*)::int from public.wash_applications where status = 'pending') as "pendingApps",
             (select count(*)::int from public.transactions where flag = 'discrepancy') as disc,
             (select count(*)::int from public.reviews where reported_by_wash and status = 'visible') as reported`,
    q<{ id: string; name: Localized | null; count: number }[]>`
      select c.business_id as id, (select b.name from public.businesses b where b.id = c.business_id) as name, count(*)::int as count
      from public.complaints c where c.status not in ('closed', 'resolved')
      group by c.business_id having count(*) >= 3
      order by min(c.created_at), c.business_id`,
    q<{ difference: number; staffName: string | null; businessId: string; businessName: Localized; areaName: Localized }[]>`
      select sh.difference, st.name as "staffName", br.business_id as "businessId", bz.name as "businessName", ar.name as "areaName"
      from public.staff_shifts sh
      join public.branches br on br.id = sh.branch_id
      join public.businesses bz on bz.id = br.business_id
      join public.areas ar on ar.id = br.area_id
      left join public.staff st on st.id = sh.staff_id
      where sh.difference < 0 and sh.review_status = 'submitted'
      order by sh.scheduled_start desc, sh.id
      limit 1`,
  ]);

  const alerts: DashboardAlert[] = [];
  if (c.pendingApps > 0) {
    alerts.push({
      id: "alert_apps",
      type: "applications",
      severity: "warning",
      title: `${c.pendingApps} طلبات انضمام بانتظار المراجعة`,
      description: "أقدم طلب ينتظر منذ أكثر من يومين.",
      href: "/applications",
      count: c.pendingApps,
    });
  }
  for (const s of spikes) {
    alerts.push({
      id: `alert_comp_${s.id}`,
      type: "complaint_spike",
      severity: "danger",
      title: `معدل شكاوى مرتفع: ${s.name?.ar ?? s.id}`,
      description: `${s.count} شكاوى مفتوحة — راجع المغسلة واتخذ إجراء.`,
      href: `/washes/${s.id}`,
      count: s.count,
    });
  }
  if (c.disc > 0) {
    alerts.push({
      id: "alert_disc",
      type: "discrepancy",
      severity: "warning",
      title: `${c.disc} معاملة بها فرق في التحصيل`,
      description: "المبلغ المحصل لا يطابق إجمالي الطلب.",
      href: "/finance/transactions?filter=discrepancy",
      count: c.disc,
    });
  }
  if (shift) {
    alerts.push({
      id: "alert_shift",
      type: "shift_difference",
      severity: "info",
      title: `عجز ${Math.abs(shift.difference)} ج.م في وردية`,
      // The mock hard-codes the seeded shift's wash; here it is the shift's own wash and area.
      description: `${shift.staffName ?? ""} — ${shift.businessName.ar} ${shift.areaName.ar}`,
      href: `/washes/${shift.businessId}`,
      count: 1,
    });
  }
  if (c.reported > 0) {
    alerts.push({
      id: "alert_reviews",
      type: "reported_review",
      severity: "info",
      title: `${c.reported} تقييم أبلغت عنه المغاسل`,
      description: "راجع التقييمات المبلغ عنها وقرر إخفاءها أو إبقاءها.",
      href: "/reviews?filter=reported",
      count: c.reported,
    });
  }
  return alerts;
}

/**
 * Top 5 active washes by completed GMV over the period (at least 7 days).
 * Area = the wash's first branch (oldest; ties in area catalogue order), like the mock.
 */
function buildTopWashes(q: Q, from: string, end: string) {
  return q<TopWash[]>`
    select b.id, b.name,
           coalesce((select br.area_id from public.branches br join public.areas ar on ar.id = br.area_id where br.business_id = b.id
                     order by br.created_at, ar.sort_order, br.id limit 1), '') as area,
           b.rating, coalesce(os.completed, 0) as completed, coalesce(os.gmv, 0) as gmv
    from public.businesses b
    left join lateral (
      select count(*)::int as completed, sum(o.total) as gmv from public.orders o
      where o.business_id = b.id and o.status = 'completed' and o.scheduled_at >= ${from} and o.scheduled_at < ${end}) os on true
    where b.status = 'active'
    order by coalesce(os.gmv, 0) desc, b.created_at, b.id
    limit 5`;
}

/** Active washes with open complaints (≥2), a low rating (<4.2) or a high 30-day cancellation rate (≥15%). */
async function buildAttention(q: Q, from30: string, end: string): Promise<AttentionWash[]> {
  const rows = await q<{ id: string; name: Localized; rating: number; openComplaints: number; orders: number; cancelled: number }[]>`
    select b.id, b.name, b.rating,
           (select count(*)::int from public.complaints c where c.business_id = b.id and c.status not in ('resolved', 'closed')) as "openComplaints",
           os.orders, os.cancelled
    from public.businesses b
    cross join lateral (
      select count(*)::int as orders, (count(*) filter (where o.status = 'cancelled'))::int as cancelled
      from public.orders o where o.business_id = b.id and o.scheduled_at >= ${from30} and o.scheduled_at < ${end}) os
    where b.status = 'active'
    order by b.created_at, b.id`;

  const out: AttentionWash[] = [];
  for (const b of rows) {
    if (b.openComplaints >= 2) out.push({ id: b.id, name: b.name, issue: "complaints", value: b.openComplaints });
    else if (b.rating > 0 && b.rating < 4.2) out.push({ id: b.id, name: b.name, issue: "rating", value: b.rating });
    else {
      const rate = b.orders >= 8 ? (b.cancelled / b.orders) * 100 : 0;
      if (rate >= 15) out.push({ id: b.id, name: b.name, issue: "cancellations", value: round2(rate) });
    }
  }
  return out.slice(0, 5);
}

export const dashboardRoutes = [
  route("GET", "/admin/dashboard", async ({ query }) => {
    const sql = db();
    const raw = query.get("period");
    const period: DashboardPeriod = raw === "7d" || raw === "30d" ? raw : "today";

    // Day windows from the server clock (never current_date in SQL).
    const week = dayRanges(7);
    const end = week.ends[week.ends.length - 1];
    const periodFrom = daysAgo(PERIOD_DAYS[period] - 1).toISOString();
    const topFrom = daysAgo(Math.max(PERIOD_DAYS[period], 7) - 1).toISOString();
    const from30 = daysAgo(29).toISOString();
    const pct = await defaultCommissionPct(sql);

    const [weekTotals, history, [current], funnel, alerts, topWashes, needsAttention] = await Promise.all([
      orderTotals(sql, week.starts, week.ends, pct),
      countsAt(sql, week.ends),
      currentCounts(sql),
      buildFunnel(sql, periodFrom, end),
      buildAlerts(sql),
      buildTopWashes(sql, topFrom, end),
      buildAttention(sql, from30, end),
    ]);
    const revenue = await buildRevenue(sql, period, weekTotals, pct);
    const kpis = buildKpis(weekTotals, history, current);
    const kpi = (k: KpiKey) => kpis.find((x) => x.key === k)?.value ?? 0;

    const summary: DashboardSummary = {
      period,
      generatedAt: now().toISOString(),
      kpis,
      funnel,
      revenue,
      revenueTotals: {
        gmv: revenue.reduce((s, p) => s + p.gmv, 0),
        commission: round2(revenue.reduce((s, p) => s + p.commission, 0)),
      },
      alerts,
      topWashes,
      needsAttention,
      health: {
        activeUsers: kpi("activeCustomers"),
        activeWashes: kpi("activeWashes"),
        activeBranches: current.activeBranches,
        bookingsToday: kpi("bookingsToday"),
      },
    };
    return ok(summary);
  }),
];
