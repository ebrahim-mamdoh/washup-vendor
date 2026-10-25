// End-to-end booking across the three apps, on the DEPLOYED panels and the live database (writes real
// rows: one app booking, cancelled at the end, and one test offer, disabled at the end).
//
//   wash  (partner portal API) publishes a 20% offer, previews the price
//   app   (customer, same role/RLS/RPC path as PostgREST) books primary + add-on → must cost the same
//   wash  is notified (row + browser push via the DB hook), sees it pending, confirms it
//   app   customer gets "created" then "confirmed"; reschedules → back to pending, wash notified
//   admin (Super Admin API) sees the order and its commission ledger row
//   app   cancels → wash notified, pending commission dropped
//
// Usage: VENDOR_PHONE=… VENDOR_PASSWORD=… ADMIN_EMAIL=… ADMIN_PASSWORD=… node qa/api-check/e2e-booking.mjs [vendorBase] [adminBase]
import { readFileSync } from "node:fs";
import postgres from "postgres";

const env = Object.fromEntries(
  readFileSync(new URL("../../.env", import.meta.url), "utf8")
    .split(/\r?\n/)
    .map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2].replace(/^"(.*)"$/, "$1")]),
);
const VENDOR = process.argv[2] ?? "https://washup-vendor.vercel.app";
const ADMIN = process.argv[3] ?? "https://washup-superadmin.vercel.app";
const sql = postgres(env.DATABASE_URL, { prepare: false, max: 1, onnotice: () => {} });
const out = [];
const check = (ok, name, detail = "") => out.push(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(base, method, path, token, body) {
  const res = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, data: json?.data, msg: json?.message };
}

/** Runs `fn` as the customer app (PostgREST: role authenticated + the customer's JWT claims), committed. */
async function asApp(uid, fn) {
  try {
    return {
      value: await sql.begin(async (t) => {
        await t`select set_config('request.jwt.claims', ${JSON.stringify({ sub: uid, role: "authenticated" })}, true)`;
        await t.unsafe("set local role authenticated");
        return fn(t);
      }),
    };
  } catch (e) {
    return { error: e.message };
  }
}

let offerId = null;
let vToken = null;
try {
  // ── Logins on the deployed panels ──
  const vl = await api(VENDOR, "POST", "/vendor/auth/login", null, { phone: process.env.VENDOR_PHONE, password: process.env.VENDOR_PASSWORD });
  vToken = vl.data?.access_token;
  check(Boolean(vToken), "wash owner signs in to the partner portal", vl.msg);
  const al = await api(ADMIN, "POST", "/admin/auth/login", null, { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD });
  const aToken = al.data?.access_token;
  check(Boolean(aToken), "admin signs in to the Super Admin", al.msg);
  if (!vToken || !aToken) throw new Error("login failed");

  // ── Fixtures: the owner's branch, a primary + an add-on, an app customer with a car ──
  const [st] = await sql`select business_id, branch_id from public.staff where phone = ${"+2" + process.env.VENDOR_PHONE.replace(/^\+?2?/, "")} and role = 'owner'`;
  const [primary] = await sql`select id, price, category_id from public.services where branch_id = ${st.branch_id} and type = 'primary' and active order by price limit 1`;
  const [addon] = await sql`select id, price from public.services where branch_id = ${st.branch_id} and type = 'addon' and active order by price limit 1`;
  const [cust] = await sql`
    select c.id, c.user_id, (select v.id from public.vehicles v where v.customer_id = c.id order by v.is_default desc limit 1) as vehicle
    from public.customers c where c.user_id is not null and c.status = 'active' and exists (select 1 from public.vehicles v where v.customer_id = c.id)
    order by c.created_at limit 1`;
  const [{ auto }] = await sql`select auto_confirm as auto from public.branches where id = ${st.branch_id}`;
  check(auto === false, "branch confirms bookings manually", String(auto));

  // ── 1. The wash publishes an offer from the portal ──
  const of = await api(VENDOR, "POST", "/vendor/offers", vToken, {
    title: { ar: "اختبار تكامل — خصم 20%", en: "Integration test 20%" },
    discountType: "percent",
    discountValue: 20,
    startAt: new Date(Date.now() - 60_000).toISOString(),
    endAt: new Date(Date.now() + 3_600_000).toISOString(),
    branchIds: [st.branch_id],
    serviceCategories: [],
    publish: true,
  });
  offerId = of.data?.id ?? null;
  check(of.status === 200 && of.data?.status === "active", "wash publishes a live offer", `${of.status} ${of.data?.status ?? of.msg}`);

  // ── 2. Same order, same price in the portal and in the app ──
  const pv = await api(VENDOR, "GET", `/vendor/price-preview?branchId=${st.branch_id}&serviceIds=${primary.id},${addon.id}`, vToken);
  const expectedOff = Math.round((Number(primary.price) * 20) / 100);
  check(pv.data?.offerDiscount === expectedOff, `portal: offer takes ${expectedOff} off the primary service only`, `discount ${pv.data?.offerDiscount}, total ${pv.data?.total}`);

  let booking;
  for (const hour of [12, 13, 14, 15, 16, 17]) {
    const [{ ts }] = await sql`select ((now() at time zone 'Africa/Cairo')::date + 1 + make_time(${hour}::int, 0, 0)) at time zone 'Africa/Cairo' as ts`;
    booking = await asApp(cust.user_id, (t) => t`select public.create_order(${st.branch_id}, ${cust.vehicle}, ${primary.id}, ${ts}, ${[addon.id]}) as o`.then((r) => r[0].o));
    if (!booking.error || !/slot_|vehicle_busy/.test(booking.error)) break;
  }
  const order = booking.value;
  check(Boolean(order), "app books primary + add-on", booking.error ?? `${order.number}`);
  if (!order) throw new Error("booking failed");
  check(Number(order.total) === Number(pv.data?.total), "app charges exactly what the portal shows", `app ${order.total} / portal ${pv.data?.total}`);
  check(order.status === "pending", "booking waits for the wash", order.status);

  // ── 3. The wash hears about it (row + browser push through the DB hook) ──
  await sleep(4000);
  const wn = await sql`select id, type, title->>'ar' as title from public.vendor_notifications where href = ${"/orders/" + order.id} order by created_at`;
  check(wn.some((n) => n.type === "new_booking"), "wash gets a 'new booking' notification", wn.map((n) => n.title).join(" | "));
  const [push] = await sql`select status_code, content from net._http_response order by created desc limit 1`;
  check(push?.status_code === 200, "DB pushed it to the partner portal on Vercel", `${push?.status_code} ${String(push?.content ?? "").slice(0, 90)}`);
  const vlist = await api(VENDOR, "GET", "/vendor/notifications", vToken);
  check((vlist.data ?? []).some((n) => n.href === `/orders/${order.id}`), "the notification shows in the portal's list");

  // ── 4. The wash opens and confirms it ──
  const vo = await api(VENDOR, "GET", `/vendor/orders/${order.id}`, vToken);
  const vOrder = vo.data?.order ?? vo.data;
  check(vOrder?.status === "pending" && Number(vOrder?.total) === Number(order.total), "portal shows the booking pending, same total", `${vOrder?.status} ${vOrder?.total}`);
  check((vo.data?.allowedActions ?? []).includes("confirm"), "portal offers 'confirm'", (vo.data?.allowedActions ?? []).join(","));
  const cf = await api(VENDOR, "POST", `/vendor/orders/${order.id}/actions`, vToken, { action: "confirm" });
  check(cf.status === 200, "wash confirms", cf.msg);
  const cn = await sql`select type, body->>'ar' as body from public.customer_notifications where order_id = ${order.id} order by created_at`;
  check(cn.map((n) => n.type).join(",") === "created,confirmed", "customer hears 'sent' then 'confirmed'", cn.map((n) => `${n.type}: ${n.body}`).join(" | "));

  // ── 5. The admin sees the order and its commission ──
  const ao = await api(ADMIN, "GET", `/admin/orders/${order.id}`, aToken);
  const aOrder = ao.data?.order ?? ao.data;
  check(ao.status === 200 && aOrder?.status === "confirmed", "Super Admin sees the confirmed booking", `${ao.status} ${aOrder?.status}`);
  const [tx] = await sql`select status, gross, commission from public.transactions where order_id = ${order.id}`;
  check(Boolean(tx) && Number(tx.gross) === Number(order.total) && Number(tx.commission) >= Number(order.total) * 0.01, "commission ledger row for the app order (rate in %)", tx ? `${tx.status} gross ${tx.gross} commission ${tx.commission}` : "missing");

  // ── 6. The customer moves it: needs the wash again ──
  const [{ ts: later }] = await sql`select ${order.scheduled_at ?? order.scheduledAt}::timestamptz + interval '2 hours' as ts`;
  const rs = await asApp(cust.user_id, (t) => t`select public.reschedule_order(${order.id}, ${later}) as o`.then((r) => r[0].o));
  check(rs.value?.status === "pending", "rescheduled booking goes back to pending", rs.error ?? rs.value?.status);
  await sleep(2500);
  const wn2 = await sql`select title->>'ar' as title from public.vendor_notifications where href = ${"/orders/" + order.id} order by created_at`;
  check(wn2.some((n) => /غيّر موعد/.test(n.title)), "wash told the customer moved it", wn2.map((n) => n.title).join(" | "));

  // ── 7. The customer cancels ──
  const cc = await asApp(cust.user_id, (t) => t`select public.cancel_order(${order.id}, 'اختبار تكامل') as o`.then((r) => r[0].o));
  check(cc.value?.status === "cancelled", "customer cancels", cc.error ?? cc.value?.status);
  await sleep(2500);
  const wn3 = await sql`select type, title->>'ar' as title from public.vendor_notifications where href = ${"/orders/" + order.id} order by created_at`;
  check(wn3.some((n) => n.type === "booking_cancelled"), "wash told the customer cancelled", wn3.map((n) => n.title).join(" | "));
  check((await sql`select 1 from public.transactions where order_id = ${order.id} and status = 'pending'`).length === 0, "pending commission dropped");
  const vo2 = await api(VENDOR, "GET", `/vendor/orders/${order.id}`, vToken);
  check((vo2.data?.order ?? vo2.data)?.status === "cancelled", "portal shows it cancelled", (vo2.data?.order ?? vo2.data)?.status);
} catch (e) {
  out.push(`ERROR ${e.message}`);
  process.exitCode = 1;
} finally {
  if (offerId && vToken) {
    const off = await api(VENDOR, "POST", `/vendor/offers/${offerId}/status`, vToken, { enabled: false });
    out.push(`cleanup: test offer ${off.data?.status ?? off.msg}`);
  }
  await sql.end();
}

console.log(`E2E on ${VENDOR} + ${ADMIN}\n`);
console.log(out.join("\n"));
console.log(`\n${out.filter((l) => l.startsWith("PASS")).length}/${out.filter((l) => /^(PASS|FAIL)/.test(l)).length} passed`);
