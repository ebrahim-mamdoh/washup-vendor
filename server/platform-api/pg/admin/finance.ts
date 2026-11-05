import "server-only";

import type {
  CommissionSettings,
  CommissionWash,
  CurrencyOverview,
  DiscrepancyDetails,
  FinanceOverview,
  FinancePeriod,
  Payout,
  PayoutListItem,
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
 * number, payment method and the first collected payment, with currency info.
 */
const TXN_ITEM = (q: Q) => q`
  select ${q.unsafe(TRANSACTION_COLS)}, coalesce(bz.name, '{"ar":"—","en":"—"}'::jsonb) as "businessName",
         coalesce(o.number, '—') as "orderNumber", o.payment_method as "paymentMethod", p.amount as "collectedAmount",
         coalesce(c.currency_symbol ->> 'ar', 'ج.م') as "currencySymbol",
         coalesce(c.currency_decimals, 2)::int as "currencyDecimals"
  from public.transactions t
  left join public.businesses bz on bz.id = t.business_id
  left join public.orders o on o.id = t.order_id
  left join public.branches br on br.id = o.branch_id
  left join public.areas ar on ar.id = br.area_id
  left join public.countries c on c.code = ar.country_code
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
  // ── Overview ──────────────────────────────────────────────
  route("GET", "/admin/finance/overview", async ({ query }) => {
    const sql = db();
    const raw = query.get("period");
    const period: FinancePeriod = raw === "today" || raw === "7d" ? raw : "30d";
    const { list, starts, ends } = dayRanges(PERIOD_DAYS[period]);
    const from = starts[0];
    const end = ends[ends.length - 1];
    const pct = await defaultCommissionPct(sql);
    const country = query.get("country")?.trim().toUpperCase() || "";
    const countryOnOrder =
      country && country !== "ALL"
        ? sql`exists (select 1 from public.branches br join public.areas ar on ar.id = br.area_id where br.id = o.branch_id and upper(ar.country_code) = ${country})`
        : sql`true`;
    const countryOnPayout =
      country && country !== "ALL"
        ? sql`exists (select 1 from public.branches br join public.areas ar on ar.id = br.area_id where br.business_id = po.business_id and upper(ar.country_code) = ${country})`
        : sql`true`;
    const countryOnTxn =
      country && country !== "ALL"
        ? sql`exists (select 1 from public.orders o join public.branches br on br.id = o.branch_id join public.areas ar on ar.id = br.area_id where o.id = t.order_id and upper(ar.country_code) = ${country})`
        : sql`true`;

    // Commission uses each wash's current rate (override or platform default), like the mock.
    const rate = sql`coalesce(b.commission_rate, ${pct}::numeric) / 100`;

    const [daily, [range], topWashes, byCurrencyRows] = await Promise.all([
      sql<{ gmv: number; commission: number; orders: number }[]>`
        select coalesce(sum(o.total), 0) as gmv, coalesce(sum(o.total * ${rate}), 0) as commission, count(o.id)::int as orders
        from unnest(${starts}::timestamptz[], ${ends}::timestamptz[]) with ordinality as d(s, e, i)
        left join (public.orders o join public.businesses b on b.id = o.business_id)
          on o.scheduled_at >= d.s and o.scheduled_at < d.e and o.status = 'completed' and o.payment_status = 'paid' and ${countryOnOrder}
        group by d.i order by d.i`,
      sql<{ refunds: number; pendingPayouts: number; discrepancies: number }[]>`
        select coalesce((select sum(o.total) from public.orders o
                         where o.scheduled_at >= ${from} and o.scheduled_at < ${end} and o.payment_status = 'refunded' and ${countryOnOrder}), 0) as refunds,
               coalesce((select sum(po.amount_due - po.amount_paid) from public.payouts po where po.status = 'due' and ${countryOnPayout}), 0) as "pendingPayouts",
               (select count(*)::int from public.transactions t where t.flag = 'discrepancy' and ${countryOnTxn}) as discrepancies`,
      sql<{ id: string; name: FinanceOverview["topWashes"][number]["name"]; gmv: number; commission: number; orders: number }[]>`
        select b.id, b.name, sum(o.total) as gmv, sum(o.total) * ${rate} as commission, count(*)::int as orders
        from public.orders o join public.businesses b on b.id = o.business_id
        where o.scheduled_at >= ${from} and o.scheduled_at < ${end} and o.status = 'completed' and o.payment_status = 'paid' and ${countryOnOrder}
        group by b.id
        having sum(o.total) > 0
        order by gmv desc, b.id
        limit 6`,
      sql<{
        currency: string;
        symbol: string;
        decimals: number;
        gmv: number;
        commission: number;
        orders: number;
        refunds: number;
        pendingPayouts: number;
      }[]>`
        with order_stats as (
          select coalesce(c.currency, 'EGP') as currency,
                 coalesce(c.currency_symbol ->> 'ar', 'ج.م') as symbol,
                 coalesce(c.currency_decimals, 2)::int as decimals,
                 coalesce(sum(o.total) filter (where o.status = 'completed' and o.payment_status = 'paid'), 0) as gmv,
                 coalesce(sum(o.total * ${rate}) filter (where o.status = 'completed' and o.payment_status = 'paid'), 0) as commission,
                 coalesce(count(o.id) filter (where o.status = 'completed' and o.payment_status = 'paid'), 0)::int as orders,
                 coalesce(sum(o.total) filter (where o.payment_status = 'refunded'), 0) as refunds
          from public.orders o
          join public.businesses b on b.id = o.business_id
          left join public.branches br on br.id = o.branch_id
          left join public.areas ar on ar.id = br.area_id
          left join public.countries c on c.code = ar.country_code
          where o.scheduled_at >= ${from} and o.scheduled_at < ${end} and ${countryOnOrder}
          group by c.currency, c.currency_symbol, c.currency_decimals
        ),
        payout_stats as (
          select coalesce(loc.currency, 'EGP') as currency,
                 coalesce(loc.symbol, 'ج.م') as symbol,
                 coalesce(loc.decimals, 2)::int as decimals,
                 coalesce(sum(po.amount_due - po.amount_paid), 0) as pending
          from public.payouts po
          left join lateral (
            select c.currency, c.currency_symbol ->> 'ar' as symbol, c.currency_decimals as decimals, ar.country_code
            from public.branches br
            join public.areas ar on ar.id = br.area_id
            join public.countries c on c.code = ar.country_code
            where br.business_id = po.business_id
            order by br.id
            limit 1
          ) loc on true
          where po.status = 'due'
            ${country && country !== "ALL" ? sql`and upper(loc.country_code) = ${country}` : sql``}
          group by loc.currency, loc.symbol, loc.decimals
        ),
        all_currencies as (
          select currency, symbol, decimals from order_stats
          union
          select currency, symbol, decimals from payout_stats
        )
        select ac.currency, ac.symbol, ac.decimals,
               coalesce(os.gmv, 0) as gmv,
               coalesce(os.commission, 0) as commission,
               coalesce(os.orders, 0)::int as orders,
               coalesce(os.refunds, 0) as refunds,
               coalesce(ps.pending, 0) as "pendingPayouts"
        from all_currencies ac
        left join order_stats os on os.currency = ac.currency
        left join payout_stats ps on ps.currency = ac.currency
        order by ac.currency`,
    ]);

    const byCurrency: Record<string, CurrencyOverview> = {};
    for (const r of byCurrencyRows) {
      byCurrency[r.currency] = {
        gmv: r.gmv,
        commission: round2(r.commission),
        netToWashes: round2(r.gmv - r.commission),
        refunds: r.refunds,
        pendingPayouts: r.pendingPayouts,
        paidOrders: r.orders,
        currencySymbol: r.symbol,
        currencyDecimals: r.decimals,
      };
    }

    // W6: When filtering by a single country, aggregate fields are filled.
    // When "ALL" or omitted, zero-out single numbers to avoid mixing currencies.
    const isSingleCountry = Boolean(country && country !== "ALL");
    const gmv = isSingleCountry ? daily.reduce((s, d) => s + d.gmv, 0) : 0;
    const commission = isSingleCountry ? round2(daily.reduce((s, d) => s + d.commission, 0)) : 0;
    const paidOrders = isSingleCountry ? daily.reduce((s, d) => s + d.orders, 0) : 0;
    const refunds = isSingleCountry ? range.refunds : 0;
    const pendingPayouts = isSingleCountry ? range.pendingPayouts : 0;

    const overview: FinanceOverview = {
      period,
      gmv,
      commission,
      netToWashes: round2(gmv - commission),
      refunds,
      paidOrders,
      averageOrderValue: paidOrders ? Math.round(gmv / paidOrders) : 0,
      pendingPayouts,
      discrepancies: range.discrepancies,
      series: list.map((day, i) => ({
        label: `${day.getDate()}/${day.getMonth() + 1}`,
        date: day.toISOString(),
        gmv: daily[i].gmv,
        commission: round2(daily[i].commission),
      })),
      topWashes: topWashes.map((w) => ({ ...w, commission: round2(w.commission) })),
      byCurrency,
    };
    return ok(overview);
  }),

  // ── Transactions ──────────────────────────────────────────
  route("GET", "/admin/finance/transactions", async ({ query }) => {
    const sql = db();
    const filter = query.get("filter");
    const washId = query.get("washId");
    const country = query.get("country")?.trim().toUpperCase();
    const search = searchPattern(query);

    const base = sql`
      ${TXN_ITEM(sql)}
      where true
        ${country && country !== "ALL" ? sql`and upper(c.code) = ${country}` : sql``}
        ${washId && washId !== "all" ? sql`and t.business_id = ${washId}` : sql``}
        ${search ? sql`and (o.number ilike ${search} or bz.name ->> 'ar' ilike ${search} or bz.name ->> 'en' ilike ${search} or t.id ilike ${search})` : sql``}`;
    const where =
      filter === "discrepancy"
        ? sql`where w.flag = 'discrepancy'`
        : filter && filter !== "all"
          ? sql`where w.status = ${filter}`
          : sql``;

    const [countRows, [{ discrepancy }], [totals], totalsByCurrency] = await Promise.all([
      sql<{ k: string; n: number }[]>`with w as (${base}) select w.status::text as k, count(*)::int as n from w group by w.status`,
      sql<{ discrepancy: number }[]>`with w as (${base}) select count(*)::int as discrepancy from w where w.flag = 'discrepancy'`,
      sql<{ total: number; gross: number; commission: number; netToWash: number }[]>`
        with w as (${base})
        select count(*)::int as total, coalesce(sum(w.gross), 0) as gross, coalesce(sum(w.commission), 0) as commission,
               coalesce(sum(w."netToWash"), 0) as "netToWash"
        from w ${where}`,
      sql<{ symbol: string; decimals: number; gross: number; commission: number; netToWash: number }[]>`
        with w as (${base})
        select w."currencySymbol" as symbol, w."currencyDecimals"::int as decimals,
               coalesce(sum(w.gross), 0) as gross, coalesce(sum(w.commission), 0) as commission,
               coalesce(sum(w."netToWash"), 0) as "netToWash"
        from w ${where}
        group by w."currencySymbol", w."currencyDecimals"
        order by w."currencySymbol"`,
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
        totals,
        totalsByCurrency,
      },
    });
  }),

  route("GET", "/admin/finance/transactions/:id", async ({ params }) => {
    const sql = db();
    const [txn] = await sql<TransactionListItem[]>`${TXN_ITEM(sql)} where t.id = ${params.id}`;
    if (!txn) throw new MockApiError("المعاملة غير موجود", 404);

    const [order, [payment], auditLogs] = await Promise.all([
      sql<{ total: number }[]>`select total from public.orders where id = ${txn.orderId}`,
      sql<{ amount: number; collectedBy: string | null; collectedAt: string | null }[]>`
        select amount, collected_by as "collectedBy", collected_at as "collectedAt"
        from public.payments where order_id = ${txn.orderId} and status = 'paid'
        order by collected_at desc, id desc limit 1`,
      auditWhere(sql, sql`al.entity_id = ${txn.id} and al.entity = 'transactions'`, sql`order by al.at desc limit 20`),
    ]);
    const names = await actorNames(sql, payment?.collectedBy ? [payment.collectedBy] : []);
    const details: DiscrepancyDetails = {
      transaction: txn,
      orderTotal: order[0]?.total ?? txn.gross,
      collected: payment?.amount ?? txn.collectedAmount ?? 0,
      difference: round2((payment?.amount ?? txn.collectedAmount ?? 0) - (order[0]?.total ?? txn.gross)),
      cashier: payment?.collectedBy ? names.get(payment.collectedBy) ?? payment.collectedBy : null,
      collectedAt: payment?.collectedAt ?? null,
      auditLogs,
    };
    return ok(details);
  }),

  route("POST", "/admin/finance/transactions/:id/resolve", async ({ params, body, admin }) => {
    const note = requireText(body.note, "note", "ملاحظة التسوية", 5);
    const txn = await tx(async (t) => {
      const [current] = await transactionsWhere(t, t`t.id = ${params.id}`);
      if (!current) throw new MockApiError("المعاملة غير موجود", 404);
      if (!current.flag) throw new MockApiError("المعاملة لا تحتاج تسوية (لا توجد فروقات)", 409);

      // Status guard in the WHERE clause: flag must still be non-null.
      const updated = await t`
        update public.transactions set flag = null, review_note = ${note}
        where id = ${current.id} and flag is not null returning id`;
      if (!updated.length) throw new MockApiError("تمت تسوية هذه المعاملة مسبقًا", 409);

      await logAudit(t, {
        actorId: admin.id,
        action: "resolve_discrepancy",
        entity: "transactions",
        entityId: current.id,
        oldValue: current.flag,
        newValue: null,
        reason: note,
      });
      const [after] = await transactionsWhere(t, t`t.id = ${current.id}`);
      return after;
    });
    return ok(txn, "تمت تسوية الفرق وإغلاق المعاملة");
  }),

  // ── Commission ────────────────────────────────────────────
  route("GET", "/admin/finance/commission", async ({ query }) => {
    const sql = db();
    const country = query.get("country")?.trim().toUpperCase();
    const defaultPct = await defaultCommissionPct(sql);
    const from = daysAgo(30).toISOString();
    const countryFilter =
      country && country !== "ALL"
        ? sql`exists (select 1 from public.branches br join public.areas ar on ar.id = br.area_id where br.business_id = b.id and upper(ar.country_code) = ${country})`
        : sql`true`;

    const washes = await sql<CommissionWash[]>`
      select b.id, b.name,
             coalesce(b.commission_rate, ${defaultPct}::numeric) as rate,
             b.commission_rate is not null as "isOverride",
             coalesce((select sum(o.total) from public.orders o
                       where o.business_id = b.id and o.scheduled_at >= ${from} and o.status = 'completed' and o.payment_status = 'paid'), 0) as "gmv30d",
             coalesce(loc.symbol, 'ج.م') as "currencySymbol",
             coalesce(loc.decimals, 2)::int as "currencyDecimals"
      from public.businesses b
      left join lateral (
        select c.currency_symbol ->> 'ar' as symbol, c.currency_decimals as decimals
        from public.branches br
        join public.areas ar on ar.id = br.area_id
        join public.countries c on c.code = ar.country_code
        where br.business_id = b.id
        order by br.id
        limit 1
      ) loc on true
      where b.status <> 'rejected' and ${countryFilter}
      order by b.name ->> 'ar', b.id`;
    const settings: CommissionSettings = { defaultCommissionPct: defaultPct, washes };
    return ok(settings);
  }),

  route("PUT", "/admin/finance/commission", async ({ body, admin }) => {
    const reason = requireText(body.reason, "reason", "السبب", 5);
    await tx(async (t) => {
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
          `نسبة عمولة Wash Up على مغسلتك أصبحت ${next ?? nextDefault}٪ للمعاملات الجديدة.`,
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

  // ── Payouts ───────────────────────────────────────────────
  route("GET", "/admin/finance/payouts", async ({ query }) => {
    const sql = db();
    const status = query.get("status");
    const country = query.get("country")?.trim().toUpperCase();
    const search = searchPattern(query);

    const base = sql`
      select ${sql.unsafe(PAYOUT_COLS)}, coalesce(bz.name, '{"ar":"—","en":"—"}'::jsonb) as "businessName",
             coalesce(loc.symbol, 'ج.م') as "currencySymbol",
             coalesce(loc.decimals, 2)::int as "currencyDecimals"
      from public.payouts po
      left join public.businesses bz on bz.id = po.business_id
      left join lateral (
        select c.currency_symbol ->> 'ar' as symbol, c.currency_decimals as decimals, ar.country_code
        from public.branches br
        join public.areas ar on ar.id = br.area_id
        join public.countries c on c.code = ar.country_code
        where br.business_id = po.business_id
        order by br.id
        limit 1
      ) loc on true
      where true
        ${country && country !== "ALL" ? sql`and upper(loc.country_code) = ${country}` : sql``}
        ${search ? sql`and (bz.name ->> 'ar' ilike ${search} or bz.name ->> 'en' ilike ${search} or po.reference ilike ${search})` : sql``}`;
    const filter = status && status !== "all" ? sql`where w.status = ${status}` : sql``;

    const [countRows, [totals], [{ total }], totalsByCurrency] = await Promise.all([
      sql<{ k: string; n: number }[]>`with w as (${base}) select w.status::text as k, count(*)::int as n from w group by w.status`,
      sql<{ due: number; paid: number }[]>`
        with w as (${base})
        select coalesce(sum(w."amountDue" - w."amountPaid") filter (where w.status = 'due'), 0) as due,
               coalesce(sum(w."amountPaid"), 0) as paid
        from w`,
      sql<{ total: number }[]>`with w as (${base}) select count(*)::int as total from w ${filter}`,
      sql<{ symbol: string; decimals: number; due: number; paid: number }[]>`
        with w as (${base})
        select w."currencySymbol" as symbol, w."currencyDecimals"::int as decimals,
               coalesce(sum(w."amountDue" - w."amountPaid") filter (where w.status = 'due'), 0) as due,
               coalesce(sum(w."amountPaid"), 0) as paid
        from w
        group by w."currencySymbol", w."currencyDecimals"
        order by w."currencySymbol"`,
    ]);
    const sort = orderBy(sql, query, { periodEnd: `w."periodEnd"`, amountDue: `w."amountDue"` }, { key: "periodEnd", order: "desc" }, "w.id");
    const { items, pagination } = await paged(query, total, 15, (limit, offset) =>
      sql<PayoutListItem[]>`with w as (${base}) select * from w ${filter} ${sort} limit ${limit} offset ${offset}`,
    );
    return ok(items, "OK", { pagination, meta: { counts: countsOf(countRows, ["due", "paid"] as const), totals, totalsByCurrency } });
  }),

  route("POST", "/admin/finance/payouts/:id/pay", async ({ params, body, admin }) => {
    const payout = await tx(async (t) => {
      const [current] = await payoutsWhere(t, t`po.id = ${params.id}`);
      if (!current) throw new MockApiError("الدفعة غير موجود", 404);
      if (current.status === "paid") throw new MockApiError("تم سداد هذه الدفعة مسبقًا", 409);
      const amount = Number(body.amountPaid);
      if (Number.isNaN(amount) || amount <= 0) throw new MockApiError("أدخل مبلغًا صحيحًا", 422);

      // W5: Cumulative partial payout logic
      const currentPaid = current.amountPaid ?? 0;
      const remaining = Math.max(0, current.amountDue - currentPaid);
      if (amount > remaining) throw new MockApiError("المبلغ أكبر من المتبقي المستحق", 422);

      const reference = requireText(body.reference, "reference", "المرجع", 4);
      const date = typeof body.date === "string" && body.date ? new Date(body.date).toISOString() : now().toISOString();
      const newPaid = currentPaid + amount;
      const status: Payout["status"] = newPaid >= current.amountDue ? "paid" : "due";

      // Status guard in the WHERE clause: a payout can't be paid twice concurrently.
      const updated = await t`
        update public.payouts set amount_paid = ${newPaid}, reference = ${reference}, paid_at = ${date}, status = ${status}
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

      const [bizLoc] = await t<{ symbol: string }[]>`
        select coalesce(c.currency_symbol ->> 'ar', 'ج.م') as symbol
        from public.branches br
        join public.areas ar on ar.id = br.area_id
        join public.countries c on c.code = ar.country_code
        where br.business_id = ${current.businessId}
        order by br.id
        limit 1`;
      const currencySymbol = bizLoc?.symbol ?? "ج.م";

      await logAudit(t, {
        actorId: admin.id,
        action: "mark_payout_paid",
        entity: "payouts",
        entityId: current.id,
        oldValue: "due",
        newValue: status,
        reason: `Reference: ${reference} — ${amount} ${currencySymbol}${settled ? ` (تسوية ${settled} معاملة)` : ""}`,
      });
      await pushVendorNotification(
        t,
        current.businessId,
        null,
        "payout",
        status === "paid" ? "تم تحويل مستحقاتك" : "تم تحويل دفعة جزئية",
        `حولت Wash Up ${amount.toLocaleString("en-US")} ${currencySymbol} — المرجع ${reference}.`,
        "/finance",
      );
      const [after] = await payoutsWhere(t, t`po.id = ${current.id}`);
      return after;
    });
    return ok(payout, payout.status === "paid" ? "تم تسجيل الدفعة وتسوية المعاملات" : "تم تسجيل دفعة جزئية");
  }),
];
