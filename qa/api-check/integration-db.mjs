// Booking-flow scenarios across the customer app, the partner portal and the Super Admin, run against
// the Supabase database inside ONE transaction that is always rolled back (nothing is kept, no push
// is sent: pg_net requests queued inside the transaction are discarded with it).
//
// The customer app is simulated exactly as PostgREST runs it: `set local role authenticated` with the
// customer's JWT claims, then the same RPCs / table writes. Wash and admin actions are the SQL the
// panels run. Optionally applies the pending migrations first, to test them before they go live.
//
// Usage:  node qa/api-check/integration-db.mjs [--with-migrations]
// Needs DATABASE_URL in .env (session pooler). Picks the first two customers that have an app login
// and a car, and the first branch with a primary service and an add-on.
import { readFileSync } from "node:fs";
import postgres from "postgres";

const env = Object.fromEntries(
  readFileSync(new URL("../../.env", import.meta.url), "utf8")
    .split(/\r?\n/)
    .map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2].replace(/^"(.*)"$/, "$1")]),
);
const WITH_MIGRATIONS = process.argv.includes("--with-migrations");
const MIGRATIONS = [
  "20261021090000_customer_data_api_hardening.sql",
  "20261021091000_app_orders_commission_ledger.sql",
  "20261021092000_foreign_key_indexes.sql",
  "20261025090000_booking_flow_fixes.sql",
  "20261021100000_panel_notifications.sql",
];

const sql = postgres(env.DATABASE_URL, { prepare: false, max: 1, onnotice: () => {} });
const out = [];
const check = (ok, name, detail = "") => out.push(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
class Rollback extends Error {}

/** Runs `fn` as the customer app would (PostgREST role + JWT), in a savepoint; returns { value } or { error }. */
async function asApp(t, uid, fn) {
  try {
    const value = await t.savepoint(async (sp) => {
      await sp`select set_config('request.jwt.claims', ${JSON.stringify(uid ? { sub: uid, role: "authenticated" } : { role: "anon" })}, true)`;
      await sp.unsafe(`set local role ${uid ? "authenticated" : "anon"}`);
      const r = await fn(sp);
      await sp.unsafe("reset role");
      return r;
    });
    return { value };
  } catch (e) {
    return { error: e.message };
  }
}

const custNotifs = async (t, orderId) =>
  t`select type, title->>'ar' as title, body->>'ar' as body from public.customer_notifications where order_id = ${orderId} order by created_at, id`;
const show = (rows) => rows.map((n) => `${n.type}: ${n.body}`).join(" | ") || "none";
const washNotifs = async (t, businessId, since) =>
  t`select type, title->>'ar' as title, body->>'ar' as body from public.vendor_notifications where business_id = ${businessId} and created_at >= ${since} order by created_at`;
const hasTable = async (t, name) => (await t`select to_regclass(${"public." + name}) as r`)[0].r !== null;

try {
  await sql.begin(async (t) => {
    if (WITH_MIGRATIONS) {
      for (const f of MIGRATIONS) await t.unsafe(readFileSync(new URL(`../../supabase/migrations/${f}`, import.meta.url), "utf8"));
      check(true, `applied ${MIGRATIONS.length} migrations inside the transaction`);
    }
    const started = (await t`select now() as n`)[0].n;

    // ── Fixtures ──
    const custs = await t`
      select c.id, c.user_id, (select v.id from public.vehicles v where v.customer_id = c.id order by v.is_default desc, v.created_at limit 1) as vehicle
      from public.customers c where c.user_id is not null and c.status = 'active' and exists (select 1 from public.vehicles v where v.customer_id = c.id)
      order by c.created_at limit 2`;
    if (custs.length < 2) throw new Error("need 2 customers with an app login and a car");
    const [c1, c2] = custs;
    const [br] = await t`
      select b.id, b.business_id from public.branches b join public.businesses z on z.id = b.business_id
      where b.active and z.status = 'active'
        and exists (select 1 from public.services s where s.branch_id = b.id and s.type = 'primary' and s.active)
        and exists (select 1 from public.services s where s.branch_id = b.id and s.type = 'addon' and s.active)
      order by b.id limit 1`;
    const [primary] = await t`select id, price, category_id from public.services where branch_id = ${br.id} and type = 'primary' and active order by price limit 1`;
    const [addon] = await t`select id, price from public.services where branch_id = ${br.id} and type = 'addon' and active order by price limit 1`;
    // Isolate the scenario from the branch's real setup: manual confirmation, open every day, no blocks, free capacity.
    await t`update public.branches set auto_confirm = false, lead_time_min = 15, max_advance_days = 7, slot_interval_min = 30, capacity = 10 where id = ${br.id}`;
    await t`update public.branch_working_hours set opens_at = '09:00', closes_at = '23:00', closed = false where branch_id = ${br.id}`;
    await t`delete from public.branch_blocked_slots where branch_id = ${br.id}`;
    await t`delete from public.offer_branches where branch_id = ${br.id}`;
    const slot = async (dayOffset, hour) =>
      (await t`select ((now() at time zone 'Africa/Cairo')::date + ${dayOffset}::int + make_time(${hour}::int, 0, 0)) at time zone 'Africa/Cairo' as ts`)[0].ts;
    const book = (c, at, addons = [addon.id]) =>
      asApp(t, c.user_id, (sp) => sp`select public.create_order(${br.id}, ${c.vehicle}, ${primary.id}, ${at}, ${addons}) as o`.then((r) => r[0].o));

    // ── 1. Booking at a wash with manual confirmation ──
    const b1 = await book(c1, await slot(1, 12));
    check(!b1.error, "app books (create_order)", b1.error ?? "");
    const o1 = b1.value;
    check(o1?.status === "pending", "manual confirmation → booking is pending", o1?.status);
    const n1 = o1 ? await custNotifs(t, o1.id) : [];
    check(n1.length === 1 && /بانتظار/.test(n1[0].body), "customer told it waits for the wash", show(n1));
    const w1 = await washNotifs(t, br.business_id, started);
    check(w1.some((n) => n.type === "new_booking"), "wash notified of the new app booking", `${w1.length} notification(s)`);
    const [tx1] = o1 ? await t`select status, gross from public.transactions where order_id = ${o1.id}` : [];
    check(Boolean(tx1), "commission ledger row created for the app order", tx1 ? `${tx1.status} ${tx1.gross}` : "missing");

    // ── 2. The wash confirms ──
    await t`update public.orders set status = 'confirmed' where id = ${o1.id}`;
    const n2 = await custNotifs(t, o1.id);
    check(n2.some((n) => n.type === "confirmed"), "customer notified: confirmed", show(n2));

    // ── 3. The customer moves a confirmed booking ──
    const newTime = await slot(1, 15);
    const r3 = await asApp(t, c1.user_id, (sp) => sp`select public.reschedule_order(${o1.id}, ${newTime}) as o`.then((r) => r[0].o));
    check(!r3.error, "app reschedules", r3.error ?? "");
    check(r3.value?.status === "pending", "new time needs the wash again (back to pending)", r3.value?.status);
    const w3 = await washNotifs(t, br.business_id, started);
    check(w3.some((n) => /غيّر موعد/.test(n.title)), "wash notified of the new time", w3.map((n) => n.title).join(" | "));
    const n3 = await custNotifs(t, o1.id);
    check(n3.some((n) => /تغيير موعد/.test(n.title) && /بانتظار/.test(n.body)), "customer told the new time awaits confirmation", show(n3));

    // ── 4. The customer cancels ──
    const r4 = await asApp(t, c1.user_id, (sp) => sp`select public.cancel_order(${o1.id}, 'تغيرت ظروفي') as o`.then((r) => r[0].o));
    check(!r4.error && r4.value?.status === "cancelled", "app cancels", r4.error ?? r4.value?.status);
    const w4 = await washNotifs(t, br.business_id, started);
    check(w4.some((n) => n.type === "booking_cancelled"), "wash notified of the cancellation");
    check((await t`select 1 from public.transactions where order_id = ${o1.id} and status = 'pending'`).length === 0, "pending commission dropped on cancel");

    // ── 5. Auto-confirm on ──
    await t`update public.branches set auto_confirm = true where id = ${br.id}`;
    const b5 = await book(c2, await slot(1, 13));
    check(b5.value?.status === "confirmed", "auto-confirm → confirmed at once", b5.error ?? b5.value?.status);
    const n5 = b5.value && (await t`select type, body->>'ar' as body from public.customer_notifications where order_id = ${b5.value.id}`);
    check(n5?.length === 1 && n5[0].type === "confirmed", "customer gets one 'confirmed' notification (not 'under review')", n5?.map((n) => `${n.type}: ${n.body}`).join(" | "));
    const w5 = await washNotifs(t, br.business_id, started);
    check(w5.some((n) => n.type === "new_booking" && /تلقائ/.test(n.body)), "wash told it was auto-confirmed", w5.at(-1)?.body);
    await t`update public.branches set auto_confirm = false where id = ${br.id}`;

    // ── 6. Offers: a live offer stored as "scheduled", primary-only discount ──
    const [offer] = await t`
      insert into public.offers (scope, business_id, title, description, discount_type, discount_value, starts_at, ends_at, status, featured)
      values ('wash', ${br.business_id}, ${t.json({ ar: "خصم اختبار", en: "Test" })}, ${t.json({ ar: "", en: "" })}, 'percent', 20,
              now() - interval '1 hour', now() + interval '2 days', 'scheduled', false) returning id`;
    await t`insert into public.offer_branches (offer_id, branch_id) values (${offer.id}, ${br.id})`;
    if (await t`select 1 from pg_proc where proname = 'refresh_offer_statuses'`.then((r) => r.length)) await t`select public.refresh_offer_statuses()`;
    const [{ status: offerStatus }] = await t`select status from public.offers where id = ${offer.id}`;
    check(offerStatus === "active", "offer whose start passed becomes active", offerStatus);
    const b6 = await book(c1, await slot(2, 12));
    const expected = Math.round((primary.price * 20) / 100);
    check(Number(b6.value?.discount?.amount ?? b6.value?.discount_amount ?? -1) === expected || Number(b6.value?.total) === Number(primary.price) + Number(addon.price) - expected,
      `app applies the offer to the primary service only (${expected} off)`, b6.error ?? `total ${b6.value?.total}`);

    // ── 7. Pending booking nobody confirmed → auto-cancel (cron) ──
    const [stale] = await t`
      insert into public.orders (number, source, customer_id, vehicle_id, plate, business_id, branch_id, subtotal, total, duration_min, scheduled_at, status, payment_status)
      select public.next_order_number('app'), 'app', ${c2.id}, ${c2.vehicle}, v.plate, ${br.business_id}, ${br.id}, 100, 100, 30, now() - interval '2 hours', 'pending', 'pending'
      from public.vehicles v where v.id = ${c2.vehicle} returning id`;
    await t`select public.close_stale_orders()`;
    const [s7] = await t`select status, cancel_reason from public.orders where id = ${stale.id}`;
    check(s7.status === "cancelled" && s7.cancel_reason === "expired_unconfirmed", "unconfirmed booking auto-cancelled after its time", `${s7.status} ${s7.cancel_reason}`);
    const n7 = await custNotifs(t, stale.id);
    check(n7.some((n) => /لم تؤكد/.test(n.body)), "customer told the wash did not confirm in time", show(n7));
    const w7 = await washNotifs(t, br.business_id, started);
    check(w7.some((n) => /انتهى وقت تأكيد/.test(n.title)), "wash told the booking expired unconfirmed");

    // ── 8. Confirmed but never came → no-show (cron) ──
    const [ns] = await t`
      insert into public.orders (number, source, customer_id, vehicle_id, plate, business_id, branch_id, subtotal, total, duration_min, scheduled_at, status, payment_status)
      select public.next_order_number('app'), 'app', ${c2.id}, ${c2.vehicle}, v.plate, ${br.business_id}, ${br.id}, 100, 100, 30, now() - interval '5 hours', 'confirmed', 'pending'
      from public.vehicles v where v.id = ${c2.vehicle} returning id`;
    await t`select public.close_stale_orders()`;
    const n8 = await custNotifs(t, ns.id);
    check(n8.some((n) => /لم تحضر|عدم الحضور/.test(n.body + n.title)), "customer told the booking closed as no-show", show(n8));
    check((await t`select 1 from public.transactions where order_id = ${ns.id} and status = 'pending'`).length === 0, "no-show drops the pending commission");

    // ── 9. The wash cancels / the admin cancels: the customer hears who and why ──
    const b9 = await book(c2, await slot(2, 16));
    await t`update public.orders set status = 'cancelled', cancel_reason = 'عطل في المعدات', cancelled_by_type = 'staff', cancelled_at = now() where id = ${b9.value.id}`;
    const n9 = await custNotifs(t, b9.value.id);
    check(n9.some((n) => /المغسلة/.test(n.body) && /عطل في المعدات/.test(n.body)), "customer told the wash cancelled, with the reason", show(n9));

    // ── 10. What the app may NOT do directly ──
    const b10 = await book(c2, await slot(3, 12));
    const u10 = await asApp(t, c2.user_id, (sp) => sp`update public.orders set status = 'completed', total = 0, payment_status = 'paid' where id = ${b10.value.id} returning status`);
    check(Boolean(u10.error) || u10.value.length === 0, "customer cannot complete/price/pay an order directly", u10.error ?? `${u10.value.length} row(s) changed`);
    const i10 = await asApp(t, c2.user_id, (sp) => sp`insert into public.order_events (order_id, status, actor_type, actor_id) values (${b10.value.id}, 'completed', 'customer', ${c2.id})`);
    check(Boolean(i10.error), "customer cannot write order history", i10.error ?? "inserted");
    const notifId = (await t`select id from public.customer_notifications where order_id = ${b10.value.id} limit 1`)[0]?.id;
    const m10 = await asApp(t, c2.user_id, (sp) => sp`update public.customer_notifications set read = true, title = ${t.json({ ar: "x" })} where id = ${notifId} returning read, title->>'ar' as title`);
    check(!m10.error && m10.value[0]?.read === true && m10.value[0]?.title !== "x", "mark as read works, other fields stay", m10.error ?? JSON.stringify(m10.value[0]));
    const rv = await asApp(t, c2.user_id, (sp) => sp`insert into public.reviews (order_id, customer_id, business_id, branch_id, stars, comment, status) values (${b10.value.id}, ${c2.id}, ${br.business_id}, ${br.id}, 5, ${sp.json({ ar: "تمام", en: "" })}, 'visible') returning id`);
    check(Boolean(rv.error), "no review before the service is completed", rv.error ?? "inserted");
    await t`update public.orders set status = 'completed' where id = ${b10.value.id}`;
    const rv2 = await asApp(t, c2.user_id, (sp) => sp`insert into public.reviews (order_id, customer_id, business_id, branch_id, stars, comment, status) values (${b10.value.id}, ${c2.id}, ${br.business_id}, ${br.id}, 4, ${sp.json({ ar: "كويس", en: "" })}, 'hidden') returning id, status`);
    check(!rv2.error && rv2.value[0].status === "visible", "review on a completed order is accepted (as visible)", rv2.error ?? rv2.value[0].status);
    if (!rv2.error) {
      await t`update public.reviews set status = 'hidden', hidden_reason = 'مسيء' where id = ${rv2.value[0].id}`;
      await asApp(t, c2.user_id, (sp) => sp`update public.reviews set status = 'visible', comment = ${sp.json({ ar: "تعديل", en: "" })} where id = ${rv2.value[0].id}`);
      const [after] = await t`select status, comment from public.reviews where id = ${rv2.value[0].id}`;
      check(after.status === "hidden", "a review hidden by the admin stays hidden", `${after.status} / ${after.comment}`);
    }

    // ── 11. Washes that are not live ──
    await t`update public.businesses set status = 'approved' where id = ${br.business_id}`;
    const b11 = await book(c1, await slot(3, 15));
    check(b11.error?.includes("branch_unavailable"), "onboarding (approved, not active) wash takes no bookings", b11.error ?? b11.value?.status);
    const l11 = await asApp(t, null, (sp) => sp`select id from public.branches where id = ${br.id}`);
    check(!l11.error && l11.value.length === 0, "and is not listed in the app", l11.error ?? `${l11.value.length} row(s)`);
    await t`update public.businesses set status = 'active' where id = ${br.business_id}`;

    // ── 12. Ledger completeness ──
    const [{ missing }] = await t`select count(*)::int as missing from public.orders o where o.source = 'app' and o.status not in ('cancelled', 'no_show') and not exists (select 1 from public.transactions x where x.order_id = o.id)`;
    check(missing === 0, "every live app order has a ledger row", `${missing} missing`);
    if (await hasTable(t, "legacy_areas")) {
      const [{ n }] = await t`select count(*)::int as n from pg_policies where schemaname = 'public' and tablename like 'legacy_%' and cmd in ('ALL', 'UPDATE', 'DELETE')`;
      check(n === 0, "no public write policies on legacy tables", `${n} left`);
    }

    throw new Rollback();
  });
} catch (e) {
  if (!(e instanceof Rollback)) {
    out.push(`ERROR ${e.message}`);
    process.exitCode = 1;
  }
} finally {
  await sql.end();
}

console.log(`${WITH_MIGRATIONS ? "WITH pending migrations" : "CURRENT database"} (rolled back)\n`);
console.log(out.join("\n"));
const pass = out.filter((l) => l.startsWith("PASS")).length;
console.log(`\n${pass}/${out.filter((l) => /^(PASS|FAIL)/.test(l)).length} passed`);
