import "server-only";

import type {
  CommissionSettings,
  DiscrepancyDetails,
  FinanceOverview,
  FinancePeriod,
  Payout,
  PayoutListItem,
  Transaction,
  TransactionListItem,
  TransactionStatus,
} from "@/types/finance";

import { daysAgo, now, round2 } from "../../db";
import { MockApiError, ok, requireText } from "../../http";
import { PAYOUT_COLS, TRANSACTION_COLS, auditWhere, businessesWhere, payoutsWhere, transactionsWhere } from "../entities";
import { countsOf, orderBy, paged, searchPattern } from "../list";
import { actorNames } from "../lookups";
import { defaultCommissionPct, logAudit, pushVendorNotification } from "../platform";
import { route } from "../router";
import { type Q, db, tx } from "../sql";

const TXN_STATUSES: TransactionStatus[] = ["pending", "paid", "refunded", "settled"];
const PERIOD_DAYS: Record<FinancePeriod, number> = { today: 1, "7d": 7, "30d": 30 };

/**
 * Transaction list item columns (alias t + bz, o, p): business name, order
 * number, payment method and the first collected payment, like the mock `toTxnItem`.
 */
const TXN_ITEM = (q: Q) => q`
  select ${q.unsafe(TRANSACTION_COLS)}, coalesce(bz.name, '{"ar":"—","en":"—"}'::jsonb) as "businessName",
         coalesce(o.number, '—') as "orderNumber", o.payment_method as "paymentMethod", p.amount as "collectedAmount"
  from public.transactions t
  left join public.businesses bz on bz.id = t.business_id
  left join public.orders o on o.id = t.order_id
  left join lateral (
    select p.amount from public.payments p where p.order_id = t.order_id order by p.collected_at, p.id limit 1) p on true`;

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

/**
 * End of a payout period: the mock settles transactions dated up to the
 * period end instant; the database keeps only the date, so this is the end of
 * that calendar day (local), the same instant for the seeded periods.
 */
function periodEndBoundary(periodEnd: string): string {
  const [y, m, d] = periodEnd.slice(0, 10).split("-").map(Number);
  return new Date(y, m - 1, d + 1).toISOString();
}

export const financeRoutes = [
  route("GET", "/admin/finance/overview", async ({ query }) => {
    const sql = db();
    const raw = query.get("period");
    const period: FinancePeriod = raw === "today" || raw === "7d" ? raw : "30d";
    const { list, starts, ends } = dayRanges(PERIOD_DAYS[period]);
    const from = starts[0];
    const end = ends[ends.length - 1];
    const pct = await defaultCommissionPct(sql);
    // Commission uses each wash's current rate (override or platform default), like the mock.
    const rate = sql`coalesce(b.commission_rate, ${pct}::numeric) / 100`;

    const [daily, [range], topWashes] = await Promise.all([
      sql<{ gmv: number; commission: number; orders: number }[]>`
        select coalesce(sum(o.total), 0) as gmv, coalesce(sum(o.total * ${rate}), 0) as commission, count(o.id)::int as orders
        from unnest(${starts}::timestamptz[], ${ends}::timestamptz[]) with ordinality as d(s, e, i)
        left join (public.orders o join public.businesses b on b.id = o.business_id)
          on o.scheduled_at >= d.s and o.scheduled_at < d.e and o.status = 'completed' and o.payment_status = 'paid'
        group by d.i order by d.i`,
      sql<{ refunds: number; pendingPayouts: number; discrepancies: number }[]>`
        select coalesce((select sum(total) from public.orders
                         where scheduled_at >= ${from} and scheduled_at < ${end} and payment_status = 'refunded'), 0) as refunds,
               coalesce((select sum(amount_due - amount_paid) from public.payouts where status = 'due'), 0) as "pendingPayouts",
               (select count(*)::int from public.transactions where flag = 'discrepancy') as discrepancies`,
      sql<{ id: string; name: FinanceOverview["topWashes"][number]["name"]; gmv: number; commission: number; orders: number }[]>`
        select b.id, b.name, sum(o.total) as gmv, sum(o.total) * ${rate} as commission, count(*)::int as orders
        from public.orders o join public.businesses b on b.id = o.business_id
        where o.scheduled_at >= ${from} and o.scheduled_at < ${end} and o.status = 'completed' and o.payment_status = 'paid'
        group by b.id
        having sum(o.total) > 0
        order by gmv desc, b.id
        limit 6`,
    ]);

    const gmv = daily.reduce((s, d) => s + d.gmv, 0);
    const commission = round2(daily.reduce((s, d) => s + d.commission, 0));
    const paidOrders = daily.reduce((s, d) => s + d.orders, 0);

    const overview: FinanceOverview = {
      period,
      gmv,
      commission,
      netToWashes: round2(gmv - commission),
      refunds: range.refunds,
      paidOrders,
      averageOrderValue: paidOrders ? Math.round(gmv / paidOrders) : 0,
      pendingPayouts: range.pendingPayouts,
      discrepancies: range.discrepancies,
      series: list.map((day, i) => ({
        label: `${day.getDate()}/${day.getMonth() + 1}`,
        date: day.toISOString(),
        gmv: daily[i].gmv,
        commission: round2(daily[i].commission),
      })),
      topWashes: topWashes.map((w) => ({ ...w, commission: round2(w.commission) })),
    };
    return ok(overview);
  }),

  route("GET", "/admin/finance/transactions", async ({ query }) => {
    const sql = db();
    const filter = query.get("filter");
    const washId = query.get("washId");
    const search = searchPattern(query);

    const base = sql`
      ${TXN_ITEM(sql)}
      where true
        ${washId && washId !== "all" ? sql`and t.business_id = ${washId}` : sql``}
        ${search ? sql`and (o.number ilike ${search} or bz.name ->> 'ar' ilike ${search} or bz.name ->> 'en' ilike ${search} or t.id ilike ${search})` : sql``}`;
    const where =
      filter === "discrepancy"
        ? sql`where w.flag = 'discrepancy'`
        : filter && filter !== "all"
          ? sql`where w.status = ${filter}`
          : sql``;

    const [countRows, [{ discrepancy }], [totals]] = await Promise.all([
      sql<{ k: string; n: number }[]>`with w as (${base}) select w.status::text as k, count(*)::int as n from w group by w.status`,
      sql<{ discrepancy: number }[]>`with w as (${base}) select count(*)::int as discrepancy from w where w.flag = 'discrepancy'`,
      sql<{ total: number; gross: number; commission: number; netToWash: number }[]>`
        with w as (${base})
        select count(*)::int as total, coalesce(sum(w.gross), 0) as gross, coalesce(sum(w.commission), 0) as commission,
               coalesce(sum(w."netToWash"), 0) as "netToWash"
        from w ${where}`,
    ]);
    const sort = orderBy(
      sql,
      query,
      { date: "w.date", gross: "w.gross", commission: "w.commission", net: `w."netToWash"` },
      { key: "date", order: "desc" },
      "w.id",
    );
    const { items, pagination } = await paged(query, totals.total, 15, (limit, offset) =>
      sql<TransactionListItem[]>`with w as (${base}) select * from w ${where} ${sort} limit ${limit} offset ${offset}`,
    );
    return ok(items, "OK", {
      pagination,
      meta: {
        counts: { ...countsOf(countRows, TXN_STATUSES), discrepancy },
        totals: { gross: totals.gross, commission: round2(totals.commission), netToWash: round2(totals.netToWash) },
      },
    });
  }),

  route("GET", "/admin/finance/transactions/:id", async ({ params }) => {
    const sql = db();
    const [transaction] = await sql<TransactionListItem[]>`${TXN_ITEM(sql)} where t.id = ${params.id}`;
    if (!transaction) throw new MockApiError("المعاملة غير موجود", 404);

    const [[order], [payment], auditLogs] = await Promise.all([
      sql<{ total: number }[]>`select total from public.orders where id = ${transaction.orderId}`,
      sql<{ amount: number; collectedBy: string | null; collectedAt: string }[]>`
        select amount, collected_by as "collectedBy", collected_at as "collectedAt"
        from public.payments where order_id = ${transaction.orderId} order by collected_at, id limit 1`,
      auditWhere(sql, sql`al.entity_id in (${transaction.id}, ${transaction.orderId})`, sql`order by al.at desc`),
    ]);
    const cashier = payment?.collectedBy ? ((await actorNames(sql, [payment.collectedBy])).get(payment.collectedBy) ?? null) : null;

    const details: DiscrepancyDetails = {
      transaction,
      orderTotal: order?.total ?? transaction.gross,
      collected: payment?.amount ?? 0,
      difference: round2((payment?.amount ?? 0) - (order?.total ?? transaction.gross)),
      cashier,
      collectedAt: payment?.collectedAt ?? null,
      auditLogs,
    };
    return ok(details);
  }),

  route("POST", "/admin/finance/transactions/:id/resolve", async ({ params, body, admin }) => {
    const txn = await tx(async (t) => {
      const [current] = await transactionsWhere(t, t`t.id = ${params.id}`);
      if (!current) throw new MockApiError("المعاملة غير موجود", 404);
      if (current.flag !== "discrepancy") throw new MockApiError("هذه المعاملة لا تحتوي على فرق مفتوح", 409);
      const note = requireText(body.note, "note", "ملاحظة المراجعة", 5);

      // Flag guard in the WHERE clause: a concurrent resolve can't apply twice.
      const updated = await t`
        update public.transactions set flag = null, review_note = ${note}
        where id = ${current.id} and flag = 'discrepancy' returning id`;
      if (!updated.length) throw new MockApiError("هذه المعاملة لا تحتوي على فرق مفتوح", 409);
      await logAudit(t, {
        actorId: admin.id,
        action: "resolve_discrepancy",
        entity: "transactions",
        entityId: current.id,
        oldValue: "discrepancy",
        newValue: "reviewed",
        reason: note,
      });
      const [after] = await transactionsWhere(t, t`t.id = ${current.id}`);
      return after as Transaction;
    });
    return ok(txn, "تم تعليم الفرق كمُراجَع");
  }),

  route("GET", "/admin/finance/commission", async () => {
    const sql = db();
    const from = daysAgo(29).toISOString();
    const [defaultPct, washes] = await Promise.all([
      defaultCommissionPct(sql),
      sql<{ id: string; name: CommissionSettings["washes"][number]["name"]; commissionRate: number | null; gmv30d: number }[]>`
        select b.id, b.name, b.commission_rate as "commissionRate",
               coalesce((select sum(o.total) from public.orders o
                         where o.business_id = b.id and o.status = 'completed' and o.payment_status = 'paid' and o.scheduled_at >= ${from}), 0) as "gmv30d"
        from public.businesses b
        where b.status <> 'rejected'
        order by b.created_at, b.id`,
    ]);
    const settings: CommissionSettings = {
      defaultCommissionPct: defaultPct,
      washes: washes.map((b) => ({
        id: b.id,
        name: b.name,
        rate: b.commissionRate ?? defaultPct,
        isOverride: b.commissionRate !== null && b.commissionRate !== defaultPct,
        gmv30d: b.gmv30d,
      })),
    };
    return ok(settings);
  }),

  route("PUT", "/admin/finance/commission", async ({ body, admin }) => {
    await tx(async (t) => {
      const reason = requireText(body.reason, "reason", "سبب التعديل", 5);
      const nextDefault = Number(body.defaultCommissionPct);
      if (Number.isNaN(nextDefault) || nextDefault < 0 || nextDefault > 30) {
        throw new MockApiError("العمولة الافتراضية يجب أن تكون بين 0 و 30٪", 422);
      }
      const overrides = (body.overrides ?? {}) as Record<string, number | null>;
      const currentDefault = await defaultCommissionPct(t);
      const changes: string[] = [];

      if (nextDefault !== currentDefault) {
        await logAudit(t, {
          actorId: admin.id,
          action: "update_default_commission",
          entity: "settings",
          entityId: "commission",
          oldValue: `${currentDefault}%`,
          newValue: `${nextDefault}%`,
          reason,
        });
        await t`
          insert into public.platform_settings (key, value, updated_by, updated_at)
          values ('commission', ${t.json({ defaultPct: nextDefault })}, ${admin.id}, now())
          on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`;
        changes.push("default");
      }

      const ids = Object.keys(overrides);
      const businesses = ids.length ? await businessesWhere(t, t`b.id = any(${ids})`) : [];
      const byId = new Map(businesses.map((b) => [b.id, b]));
      for (const [bizId, raw] of Object.entries(overrides)) {
        const biz = byId.get(bizId);
        if (!biz) continue;
        const next = raw === null ? null : Number(raw);
        if (next !== null && (Number.isNaN(next) || next < 0 || next > 30)) {
          throw new MockApiError(`نسبة غير صالحة لـ ${biz.name.ar}`, 422);
        }
        if (next === biz.commissionRate) continue;
        await logAudit(t, {
          actorId: admin.id,
          action: "update_commission_override",
          entity: "businesses",
          entityId: biz.id,
          oldValue: biz.commissionRate === null ? "default" : `${biz.commissionRate}%`,
          newValue: next === null ? "default" : `${next}%`,
          reason,
        });
        await pushVendorNotification(
          t,
          biz.id,
          null,
          "platform",
          "تحديث نسبة العمولة",
          `نسبة عمولة كارزن على مغسلتك أصبحت ${next ?? nextDefault}٪ للمعاملات الجديدة.`,
          "/finance",
        );
        await t`update public.businesses set commission_rate = ${next} where id = ${biz.id}`;
        changes.push(bizId);
      }
      // Throwing rolls back the transaction, so nothing above is kept.
      if (!changes.length) throw new MockApiError("لا توجد تغييرات للحفظ", 422);
    });
    return ok(null, "تم حفظ العمولة — تُطبق على المعاملات الجديدة فقط");
  }),

  route("GET", "/admin/finance/payouts", async ({ query }) => {
    const sql = db();
    const status = query.get("status");
    const search = searchPattern(query);

    const base = sql`
      select ${sql.unsafe(PAYOUT_COLS)}, coalesce(bz.name, '{"ar":"—","en":"—"}'::jsonb) as "businessName"
      from public.payouts po left join public.businesses bz on bz.id = po.business_id
      where true
        ${search ? sql`and (bz.name ->> 'ar' ilike ${search} or bz.name ->> 'en' ilike ${search} or po.reference ilike ${search})` : sql``}`;
    const filter = status && status !== "all" ? sql`where w.status = ${status}` : sql``;

    const [countRows, [totals], [{ total }]] = await Promise.all([
      sql<{ k: string; n: number }[]>`with w as (${base}) select w.status::text as k, count(*)::int as n from w group by w.status`,
      sql<{ due: number; paid: number }[]>`
        with w as (${base})
        select coalesce(sum(w."amountDue" - w."amountPaid") filter (where w.status = 'due'), 0) as due,
               coalesce(sum(w."amountPaid"), 0) as paid
        from w`,
      sql<{ total: number }[]>`with w as (${base}) select count(*)::int as total from w ${filter}`,
    ]);
    const sort = orderBy(sql, query, { periodEnd: `w."periodEnd"`, amountDue: `w."amountDue"` }, { key: "periodEnd", order: "desc" }, "w.id");
    const { items, pagination } = await paged(query, total, 15, (limit, offset) =>
      sql<PayoutListItem[]>`with w as (${base}) select * from w ${filter} ${sort} limit ${limit} offset ${offset}`,
    );
    return ok(items, "OK", { pagination, meta: { counts: countsOf(countRows, ["due", "paid"] as const), totals } });
  }),

  route("POST", "/admin/finance/payouts/:id/pay", async ({ params, body, admin }) => {
    const payout = await tx(async (t) => {
      const [current] = await payoutsWhere(t, t`po.id = ${params.id}`);
      if (!current) throw new MockApiError("الدفعة غير موجود", 404);
      if (current.status === "paid") throw new MockApiError("تم سداد هذه الدفعة مسبقًا", 409);
      const amount = Number(body.amountPaid);
      if (Number.isNaN(amount) || amount <= 0) throw new MockApiError("أدخل مبلغًا صحيحًا", 422);
      if (amount > current.amountDue) throw new MockApiError("المبلغ أكبر من المستحق", 422);
      const reference = requireText(body.reference, "reference", "المرجع", 4);
      const date = typeof body.date === "string" && body.date ? new Date(body.date).toISOString() : now().toISOString();
      const status: Payout["status"] = amount >= current.amountDue ? "paid" : "due";

      // Status guard in the WHERE clause: a payout can't be paid twice concurrently.
      const updated = await t`
        update public.payouts set amount_paid = ${amount}, reference = ${reference}, paid_at = ${date}, status = ${status}
        where id = ${current.id} and status = 'due' returning id`;
      if (!updated.length) throw new MockApiError("تم سداد هذه الدفعة مسبقًا", 409);

      let settled = 0;
      if (status === "paid") {
        const rows = await t`
          update public.transactions set status = 'settled'
          where business_id = ${current.businessId} and status = 'paid' and date < ${periodEndBoundary(current.periodEnd)}
          returning id`;
        settled = rows.length;
      }
      await logAudit(t, {
        actorId: admin.id,
        action: "mark_payout_paid",
        entity: "payouts",
        entityId: current.id,
        oldValue: "due",
        newValue: status,
        reason: `Reference: ${reference} — ${amount} EGP${settled ? ` (تسوية ${settled} معاملة)` : ""}`,
      });
      await pushVendorNotification(
        t,
        current.businessId,
        null,
        "payout",
        status === "paid" ? "تم تحويل مستحقاتك" : "تم تحويل دفعة جزئية",
        `حولت كارزن ${amount.toLocaleString("en-US")} ج.م — المرجع ${reference}.`,
        "/finance",
      );
      const [after] = await payoutsWhere(t, t`po.id = ${current.id}`);
      return after;
    });
    return ok(payout, payout.status === "paid" ? "تم تسجيل الدفعة وتسوية المعاملات" : "تم تسجيل دفعة جزئية");
  }),
];
