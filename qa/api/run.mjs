#!/usr/bin/env node
/**
 * Carzen Partners (vendor portal) — functional + security API suite.
 *
 *   node qa/api/run.mjs --base http://localhost:3300            # mock data source
 *   node qa/api/run.mjs --base http://localhost:3301            # supabase data source
 *   node qa/api/run.mjs --base http://localhost:3301 --only auth,authz --verbose
 *   node qa/api/compare.mjs                                     # mode-difference report (after both runs)
 *
 * Options: --base <url> (default http://localhost:3301), --mode <label> (default: mock for :3300,
 * supabase for :3301), --only <area prefixes, comma separated>, --verbose, --no-bruteforce.
 * Writes qa/api/results-<mode>.json. Exit code 1 when any case fails.
 *
 * Dependency-free (Node >= 20). State changes are restored where the API allows it; what cannot be
 * undone through the API (new orders, a QA service/offer/staff, one review reply, a past-date day
 * closing) is created with unique "QA…" names/plates and left in a terminal/inactive state.
 * It never closes *today* and always reactivates the wash after the suspension checks.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createHarness, skip } from "./lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const BASE = arg("base", "http://localhost:3301").replace(/\/$/, "");
const MODE = arg("mode", BASE.endsWith(":3300") ? "mock" : BASE.endsWith(":3301") ? "supabase" : `port-${new URL(BASE).port || "80"}`);
const ONLY = arg("only", null)?.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean) ?? null;
const VERBOSE = argv.includes("--verbose");
const BRUTEFORCE = !argv.includes("--no-bruteforce");
const API = `${BASE}/api/v1`;

const PASSWORD = "demo1234";
const PHONES = { owner: "01200000000", adel: "01005550102", tamer: "01005550201", employee: "01005550101" };
const ADMIN = { email: "sara@carzen.demo", password: PASSWORD };
const OTHER = { order: "ord_py_1", branch: "br_nile_maadi", service: "svc_br_nile_maadi_ext", offer: "of_nile", ownerStaff: "st_owner_biz_nile", employee: "st_emp_br_nile_maadi" };

const H = createHarness({ api: API, only: ONLY, verbose: VERBOSE });
const { call, t, check, expectStatus, expectError, expectOk, describe } = H;
const get = (p, token, o) => call("GET", p, { token, ...o });
const post = (p, token, body, o) => call("POST", p, { token, body, ...o });
const patch = (p, token, body, o) => call("PATCH", p, { token, body, ...o });
const put = (p, token, body, o) => call("PUT", p, { token, body, ...o });
const del = (p, token, o) => call("DELETE", p, { token, ...o });
const enc = encodeURIComponent;

// ── Unique test data ─────────────────────────────────────────
const RUN = Date.now().toString(36).slice(-6).toUpperCase();
let seq = 0;
const plate = () => `QA${RUN}${(++seq).toString(36).toUpperCase()}`;
/** Unique 11-digit Egyptian-looking mobile number (prefix + digits). */
const phone = (prefix = "015") => {
  seq += 1;
  const n = (Date.now() * 7 + seq * 104729) % 10 ** (11 - prefix.length);
  return prefix + String(n).padStart(11 - prefix.length, "0");
};
const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const addDays = (n, h = 12, m = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  d.setHours(h, m, 0, 0);
  return d;
};
const TODAY = dayKey(new Date());
const TOMORROW = dayKey(addDays(1));

const ctx = { createdOrders: [], tokens: {} };
const svcId = (branch, key) => {
  const id = `svc_${branch}_${key}`;
  const s = ctx.services?.find((x) => x.id === id);
  if (!s) skip(`service ${id} not found`);
  return s.id;
};
const price = (branch, key) => ctx.services.find((x) => x.id === `svc_${branch}_${key}`).price;

async function login(phoneNo, password = PASSWORD) {
  return post("/vendor/auth/login", undefined, { phone: phoneNo, password });
}
async function adminToken() {
  if (ctx.tokens.admin) return ctx.tokens.admin;
  const r = await post("/admin/auth/login", undefined, ADMIN);
  if (r.status !== 200) skip(`admin login failed: ${describe(r)}`);
  ctx.tokens.admin = r.data.access_token;
  return ctx.tokens.admin;
}
async function walkIn(token, branchId, serviceIds, extra = {}) {
  const r = await post("/vendor/orders", token, { source: "walk_in", branchId, plate: plate(), serviceIds, customerPhone: phone(), customerName: "QA عميل", ...extra });
  if (r.status === 200 && r.data?.id) ctx.createdOrders.push(r.data.id);
  return r;
}
const act = (token, id, action, payload = {}) => post(`/vendor/orders/${enc(id)}/actions`, token, { action, ...payload });
async function details(token, id) {
  const r = expectOk(await get(`/vendor/orders/${enc(id)}`, token));
  return r.data;
}
/** Every row of a paginated list endpoint (per_page=100). */
async function allRows(path, token) {
  const out = [];
  for (let page = 1; page < 50; page += 1) {
    const r = expectOk(await get(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`, token));
    out.push(...r.data);
    if (!r.json.pagination?.has_next) break;
  }
  return out;
}
async function mustWalkIn(token, branchId, serviceIds, extra) {
  const r = await walkIn(token, branchId, serviceIds, extra);
  expectOk(r, "precondition: walk-in creation");
  return r.data;
}

// ════════════════════════════════════════════════════════════
async function setup() {
  console.log(`\nCarzen vendor API suite — mode=${MODE} base=${BASE} run=${RUN}\n`);
  for (const [k, p] of Object.entries({ owner: PHONES.owner, adel: PHONES.adel, tamer: PHONES.tamer })) {
    const r = await login(p);
    if (r.status !== 200) throw new Error(`setup: login ${k} failed: ${describe(r)}`);
    ctx.tokens[k] = r.data.access_token;
    ctx[`${k}Account`] = r.data.account;
  }
  const s = await get("/vendor/services?branchId=all", ctx.tokens.owner);
  if (s.status !== 200) throw new Error(`setup: services ${describe(s)}`);
  ctx.services = s.data;
  const staff = await get("/vendor/staff?branchId=all", ctx.tokens.owner);
  ctx.staff = staff.data ?? [];
  ctx.emp = (b) => ctx.staff.find((x) => x.branchId === b && x.role === "employee" && x.status === "active")?.id;
  // Lifecycle branch = one with a free bay (start needs one).
  for (const b of ["br_nasr", "br_helio"]) {
    const live = await get(`/vendor/live?branchId=${b}`, ctx.tokens.owner);
    if (live.status === 200 && live.data.bays.busy + 1 < live.data.bays.capacity) {
      ctx.LB = b;
      break;
    }
  }
  ctx.LB ??= "br_nasr";
  ctx.LBmanager = ctx.LB === "br_nasr" ? "adel" : "tamer";
  ctx.otherBranchOf = (b) => (b === "br_nasr" ? "br_helio" : "br_nasr");
  console.log(`lifecycle branch: ${ctx.LB}\n`);
}

// ════════════════════════════════════════════════════════════
// 1. AUTH
async function authArea() {
  const A = "1-Auth";
  await t(A, "owner login → 200, token + account (both branches)", async () => {
    const r = expectOk(await login(PHONES.owner));
    check(typeof r.data.access_token === "string" && r.data.access_token.length >= 16, "token missing/short");
    check(r.data.token_type === "Bearer", "token_type should be Bearer");
    const a = r.data.account;
    check(a.role === "owner", `role=${a.role}`);
    const ids = a.branches.map((b) => b.id).sort();
    check(JSON.stringify(ids) === JSON.stringify(["br_helio", "br_nasr"]), `branches=${ids}`);
  });
  await t(A, "manager (Mohamed Adel) login → only br_nasr", async () => {
    const r = expectOk(await login(PHONES.adel));
    check(r.data.account.role === "manager", "role");
    check(r.data.account.branches.map((b) => b.id).join() === "br_nasr", `branches=${r.data.account.branches.map((b) => b.id)}`);
  });
  await t(A, "manager (Tamer) login → only br_helio", async () => {
    const r = expectOk(await login(PHONES.tamer));
    check(r.data.account.branches.map((b) => b.id).join() === "br_helio", `branches=${r.data.account.branches.map((b) => b.id)}`);
  });
  await t(A, "login accepts formatted phone (+20 120 000 0000)", async () => {
    expectOk(await login("+20 120 000 0000"));
  });
  await t(A, "wrong password → 401", async () => {
    expectError(await login(PHONES.owner, "wrong-password"), 401);
  });
  await t(A, "unknown phone → 401 (same message as wrong password)", async () => {
    const a = expectError(await login("01999999998"), 401);
    const b = await login(PHONES.owner, "nope");
    check(a.message === b.message, `messages differ (user enumeration): «${a.message}» vs «${b.message}»`);
  });
  await t(A, "malformed phone / empty body → 422", async () => {
    expectError(await login("abc"), 422);
    expectError(await login("12345"), 422);
    expectError(await post("/vendor/auth/login", undefined, {}), 422);
    expectError(await login(PHONES.owner, ""), 422);
  });
  await t(A, "employee (Ahmed Samir) rejected → 403", async () => {
    expectError(await login(PHONES.employee), 403);
  });
  await t(A, "no token → 401 on protected routes", async () => {
    for (const [m, p] of [["GET", "/vendor/auth/me"], ["GET", "/vendor/orders"], ["GET", "/vendor/dashboard"], ["PUT", "/vendor/settings"], ["POST", "/vendor/orders"]]) {
      expectError(await call(m, p, { body: m === "GET" ? undefined : {} }), 401);
    }
  });
  await t(A, "invalid / garbage / non-Bearer tokens → 401", async () => {
    const bad = ["garbage", "vp_tok_000_00000000", "' OR '1'='1", "Bearer", "x".repeat(4000), "eyJhbGciOiJub25lIn0.eyJzdWIiOiJzdF9vd25lcl9iaXpfY2FyemVuIn0."];
    for (const tok of bad) expectError(await call("GET", "/vendor/auth/me", { headers: { authorization: `Bearer ${tok}` } }), 401);
    expectError(await call("GET", "/vendor/auth/me", { headers: { authorization: `Basic ${Buffer.from("01200000000:demo1234").toString("base64")}` } }), 401);
    expectError(await call("GET", "/vendor/auth/me", { headers: { authorization: ctx.tokens.owner } }), 401); // missing "Bearer " prefix
  });
  await t(A, "admin token is not accepted on /vendor/*, vendor token not on /admin/*", async () => {
    const adm = await adminToken();
    expectError(await get("/vendor/auth/me", adm), 401);
    expectError(await get("/admin/washes", ctx.tokens.owner), 401);
  });
  await t(A, "/vendor/auth/me shape", async () => {
    const a = expectOk(await get("/vendor/auth/me", ctx.tokens.owner)).data;
    for (const k of ["id", "name", "phone", "role", "businessId", "businessName", "businessStatus", "homeBranchId", "branches", "permissions", "maxDiscountPct", "canEditServices"]) {
      check(k in a, `missing ${k}`);
    }
    check(a.id === "st_owner_biz_carzen" && a.businessId === "biz_carzen", `ids ${a.id}/${a.businessId}`);
    check(typeof a.businessName?.ar === "string" && typeof a.businessName?.en === "string", "businessName must be {ar,en}");
    const perms = ["confirmBooking", "cancelOrder", "closeShift", "editServices", "refund", "collectPayment", "runService", "manageStaff"];
    for (const p of perms) check(typeof a.permissions[p] === "boolean", `permissions.${p}`);
    check(typeof a.maxDiscountPct === "number" && typeof a.canEditServices === "boolean", "maxDiscountPct/canEditServices types");
    check(!("password" in a) && !JSON.stringify(a).includes(PASSWORD), "account leaks password");
    const m = expectOk(await get("/vendor/auth/me", ctx.tokens.adel)).data;
    check(m.role === "manager" && m.maxDiscountPct === 20 && m.canEditServices === false, `manager me: role=${m.role} max=${m.maxDiscountPct} canEdit=${m.canEditServices}`);
  });
  await t(A, "logout invalidates the token (other sessions untouched)", async () => {
    const tok = expectOk(await login(PHONES.owner)).data.access_token;
    expectOk(await get("/vendor/auth/me", tok));
    expectOk(await post("/vendor/auth/logout", tok, {}));
    expectError(await get("/vendor/auth/me", tok), 401, undefined);
    expectOk(await get("/vendor/auth/me", ctx.tokens.owner), "the main owner session must survive another session's logout");
  });
  await t(A, "logout without token → 401", async () => {
    expectError(await post("/vendor/auth/logout", undefined, {}), 401);
  });
}

// ════════════════════════════════════════════════════════════
// 0. SMOKE — every read route answers with a success envelope for owner and manager
async function smokeArea() {
  const A = "0-Smoke";
  const routes = [
    "/vendor/dashboard", "/vendor/dashboard?period=7d", "/vendor/dashboard?period=30d", "/vendor/live", "/vendor/orders", "/vendor/orders?view=bookings&tab=upcoming",
    "/vendor/schedule", `/vendor/schedule?date=${TOMORROW}`, "/vendor/availability", "/vendor/services", "/vendor/offers", "/vendor/staff", "/vendor/shifts",
    "/vendor/day-closing", "/vendor/customers", "/vendor/reviews", "/vendor/reports?type=orders", "/vendor/reports?type=revenue", "/vendor/reports?type=services",
    "/vendor/reports?type=source", "/vendor/reports?type=employees", "/vendor/finance", "/vendor/finance?period=today", "/vendor/branches", "/vendor/audit",
    "/vendor/notifications", "/vendor/settings", "/vendor/search?q=CZ", "/vendor/recognize?plate=ABC123",
  ];
  for (const who of ["owner", "adel"]) {
    await t(A, `all GET routes → 200 envelope (${who})`, async () => {
      const bad = [];
      for (const p of routes) {
        const r = await get(p, ctx.tokens[who]);
        if (r.status !== 200 || r.json?.status !== true || !("data" in (r.json ?? {}))) bad.push(`${p} → ${r.status}`);
        else if (r.json.pagination) {
          const pg = r.json.pagination;
          for (const k of ["current_page", "per_page", "total", "last_page", "from", "to", "has_next"]) if (!(k in pg)) bad.push(`${p} pagination.${k} missing`);
        }
      }
      check(!bad.length, bad.join("; "));
    });
  }
  await t(A, "responses carry X-Demo-Now", async () => {
    const r = await get("/vendor/auth/me", ctx.tokens.owner);
    check(!Number.isNaN(Date.parse(r.headers.get("x-demo-now") ?? "")), `x-demo-now=${r.headers.get("x-demo-now")}`);
  });
}

// ════════════════════════════════════════════════════════════
// 2. AUTHORIZATION & BRANCH SCOPE
async function authzArea() {
  const A = "2-Authz";
  const { owner, adel, tamer } = ctx.tokens;
  const firstOrder = async (b) => (await get(`/vendor/orders?branchId=${b}&tab=all&per_page=1`, owner)).data?.[0];
  const helioOrder = await firstOrder("br_helio");
  const nasrOrder = await firstOrder("br_nasr");

  await t(A, "manager reads other branch's order → 404", async () => {
    if (!helioOrder) skip("no Heliopolis order");
    expectError(await get(`/vendor/orders/${helioOrder.id}`, adel), 404);
    expectError(await get(`/vendor/orders/${helioOrder.number}`, adel), 404);
    expectError(await get(`/vendor/orders/${nasrOrder.id}`, tamer), 404);
  });
  await t(A, "manager acts on other branch's order → 404", async () => {
    if (!helioOrder) skip("no Heliopolis order");
    expectError(await act(adel, helioOrder.id, "note", { text: "QA idor probe" }), 404);
    expectError(await act(tamer, nasrOrder.id, "cancel", { reason: "QA idor probe" }), 404);
  });
  await t(A, "manager branchId=<other branch> on list/report endpoints → 403", async () => {
    const paths = [
      "/vendor/orders?branchId=br_helio", "/vendor/live?branchId=br_helio", "/vendor/schedule?branchId=br_helio",
      "/vendor/services?branchId=br_helio", "/vendor/staff?branchId=br_helio", "/vendor/customers?branchId=br_helio",
      "/vendor/finance?branchId=br_helio", "/vendor/reports?branchId=br_helio", "/vendor/audit?branchId=br_helio",
      "/vendor/reviews?branchId=br_helio", "/vendor/shifts?branchId=br_helio", "/vendor/day-closing?branchId=br_helio",
      "/vendor/dashboard?branchId=br_helio", "/vendor/offers?branchId=br_helio",
      `/vendor/availability?branchId=br_helio&serviceIds=${svcId("br_helio", "ext")}`, `/vendor/price-preview?branchId=br_helio&serviceIds=${svcId("br_helio", "ext")}`,
    ];
    const wrong = [];
    for (const p of paths) {
      const r = await get(p, adel);
      if (r.status !== 403) wrong.push(`${p} → ${r.status}`);
    }
    check(!wrong.length, `expected 403 for: ${wrong.join("; ")}`);
  });
  await t(A, "manager branchId=all only returns his branch", async () => {
    const r = expectOk(await get("/vendor/orders?branchId=all&tab=all&per_page=100", adel));
    const foreign = r.data.filter((o) => o.branchId !== "br_nasr");
    check(r.data.length > 0, "no orders returned");
    check(!foreign.length, `foreign orders leaked: ${foreign.map((o) => o.id).slice(0, 5)}`);
    const c = expectOk(await get("/vendor/customers?branchId=all&per_page=100", tamer));
    const s = expectOk(await get("/vendor/staff?branchId=all", tamer));
    check(s.data.every((x) => x.branchId === "br_helio"), `staff from other branch visible to Tamer: ${s.data.filter((x) => x.branchId !== "br_helio").map((x) => x.id)}`);
    check(c.status === 200, "customers");
    const f = expectOk(await get("/vendor/finance?branchId=all", tamer));
    check(f.data.byBranch.every((b) => b.branchId === "br_helio"), "finance byBranch leaks other branches");
  });
  await t(A, "branchId injection value → 403 (no scope bypass)", async () => {
    for (const v of ["' OR '1'='1", "br_nasr,br_helio", "%", "*", "br_helio%00"]) {
      const r = await get(`/vendor/orders?branchId=${enc(v)}`, adel);
      check(r.status === 403, `branchId=${v} → ${r.status}`);
    }
  });
  await t(A, "manager cannot edit other branch staff (404) or any staff role/permissions (403)", async () => {
    expectError(await patch("/vendor/staff/st_walid", adel, { maxDiscountPct: 50, reason: "QA idor probe" }), 404);
    expectError(await patch("/vendor/staff/st_samir", adel, { maxDiscountPct: 50, reason: "QA escalation probe" }), 403);
    expectError(await post("/vendor/staff/st_walid/status", adel, { active: false, reason: "QA idor probe" }), 404);
    expectError(await put("/vendor/staff/st_walid/schedule", adel, { shifts: [] }), 404);
  });
  await t(A, "manager cannot suspend himself (409) or another manager (404)", async () => {
    expectError(await post("/vendor/staff/st_adel/status", adel, { active: false, reason: "QA self" }), 409);
    expectError(await post("/vendor/staff/st_tamer/status", adel, { active: false, reason: "QA idor" }), 404);
  });
  await t(A, "manager cannot add a manager (owner-only) → 403", async () => {
    expectError(await post("/vendor/staff", adel, { branchId: "br_nasr", role: "manager", name: "QA Manager", phone: phone("0127") }), 403);
  });
  await t(A, "owner-only routes rejected for managers → 403", async () => {
    const calls = [
      ["PUT", "/vendor/settings", { reason: "QA probe", managerCanEditServices: true }],
      ["PATCH", "/vendor/branches/br_nasr", { reason: "QA probe", capacity: 30 }],
      ["PUT", "/vendor/branches/br_nasr/settings", { reason: "QA probe", settings: {} }],
      ["POST", "/vendor/offers", { title: { ar: "QA probe" } }],
      ["PATCH", "/vendor/offers/of_deep", { title: { ar: "QA probe" } }],
      ["POST", "/vendor/offers/of_deep/status", { enabled: false }],
    ];
    const wrong = [];
    for (const [m, p, b] of calls) {
      const r = await call(m, p, { token: adel, body: b });
      if (r.status !== 403) wrong.push(`${m} ${p} → ${r.status}`);
    }
    check(!wrong.length, wrong.join("; "));
  });
  await t(A, "manager services edit blocked while managerCanEditServices=false → 403", async () => {
    const st = expectOk(await get("/vendor/settings", owner)).data;
    if (st.managerCanEditServices) skip("managerCanEditServices is on");
    const body = { branchId: "br_nasr", name: { ar: "QA", en: "QA" }, price: 50, durationMin: 10, type: "addon", category: "exterior" };
    expectError(await post("/vendor/services", adel, body), 403);
    expectError(await patch(`/vendor/services/${svcId("br_nasr", "air")}`, adel, body), 403);
    const l = expectOk(await get("/vendor/services", adel));
    check(l.json.meta?.canEdit === false, `meta.canEdit=${l.json.meta?.canEdit}`);
  });
  await t(A, "manager customer detail never exposes other-branch orders/reviews", async () => {
    const helio = await allRows("/vendor/customers?branchId=br_helio", owner);
    const nasr = new Set((await allRows("/vendor/customers", adel)).map((c) => c.id));
    const only = helio.find((c) => !nasr.has(c.id));
    if (only) {
      expectError(await get(`/vendor/customers/${only.id}`, adel), 404);
      expectOk(await get(`/vendor/customers/${only.id}`, owner));
    }
    const both = helio.find((c) => nasr.has(c.id));
    if (!only && !both) skip("no Heliopolis customer");
    if (both) {
      const d = expectOk(await get(`/vendor/customers/${both.id}`, adel)).data;
      const leak = d.orders.filter((o) => o.branchId !== "br_nasr").map((o) => o.id);
      const leakR = d.reviews.filter((r) => r.branchId !== "br_nasr").map((r) => r.id);
      check(!leak.length && !leakR.length, `other-branch data in manager view: orders=${leak} reviews=${leakR}`);
    }
  });
  await t(A, "manager shift of other branch → 404 (read + review)", async () => {
    const sh = expectOk(await get("/vendor/shifts?branchId=br_helio&per_page=50", owner)).data[0];
    if (!sh) skip("no Heliopolis shift");
    expectError(await get(`/vendor/shifts/${sh.id}`, adel), 404);
    expectError(await post(`/vendor/shifts/${sh.id}/review`, adel, { status: "reviewed", note: "QA idor" }), 404);
  });
  await t(A, "manager reply/report on other branch review → 404", async () => {
    const rv = expectOk(await get("/vendor/reviews?branchId=br_helio&per_page=50", owner)).data[0];
    if (!rv) skip("no Heliopolis review");
    expectError(await post(`/vendor/reviews/${rv.id}/reply`, adel, { text: "QA idor probe reply" }), 404);
    expectError(await post(`/vendor/reviews/${rv.id}/report`, adel, { reason: "QA idor probe" }), 404);
  });
  await t(A, "manager blocks/unblocks other branch slots → 403/404", async () => {
    const start = addDays(5, 10, 0);
    const end = addDays(5, 10, 30);
    expectError(await post("/vendor/schedule/blocks", adel, { branchId: "br_helio", start: start.toISOString(), end: end.toISOString(), reason: "QA idor" }), 403);
    const blk = expectOk(await post("/vendor/schedule/blocks", owner, { branchId: "br_helio", start: start.toISOString(), end: end.toISOString(), reason: `QA authz block ${RUN}` })).data;
    try {
      expectError(await del(`/vendor/schedule/blocks/${blk.id}`, adel), 404);
    } finally {
      expectOk(await del(`/vendor/schedule/blocks/${blk.id}`, owner), "cleanup block");
    }
  });
  await t(A, "manager marks other branch notification as read → expected 404", async () => {
    const n = expectOk(await get("/vendor/notifications?per_page=100", owner)).data.find((x) => x.branchId === "br_helio");
    if (!n) skip("no Heliopolis-scoped notification");
    const r = await post(`/vendor/notifications/${n.id}/read`, adel, {});
    check(r.status === 404, `Adel (Nasr City) could mark Heliopolis notification ${n.id}: ${describe(r)}`);
  }, { severity: "Low" });
  await t(A, "manager bulk-confirm skips other branch bookings", async () => {
    const pend = (await get("/vendor/orders?view=bookings&tab=today&branchId=br_nasr&per_page=100", owner)).data?.find((o) => o.status === "pending");
    if (!pend) skip("no pending Nasr City booking");
    expectError(await post("/vendor/orders/bulk-confirm", tamer, { ids: [pend.id] }), 409);
    const after = await details(owner, pend.id);
    check(after.order.status === "pending", "Tamer confirmed a Nasr City booking");
  });

  // Other business ids
  await t(A, "other business order (biz_pyramid ord_py_1) → 404 for owner", async () => {
    expectError(await get(`/vendor/orders/${OTHER.order}`, owner), 404);
    expectError(await act(owner, OTHER.order, "note", { text: "QA idor" }), 404);
    expectError(await act(owner, OTHER.order, "cancel", { reason: "QA idor" }), 404);
    const adm = await adminToken();
    const o = await get(`/admin/orders/${OTHER.order}`, adm);
    if (o.status === 200 && o.data?.order?.number) expectError(await get(`/vendor/orders/${o.data.order.number}`, owner), 404);
    expectError(await post("/vendor/orders/bulk-confirm", owner, { ids: [OTHER.order] }), 409);
  });
  await t(A, "other business service/branch/offer/staff ids → 404", async () => {
    const svcBody = { branchId: OTHER.branch, name: { ar: "QA", en: "QA" }, price: 50, durationMin: 10, type: "addon", category: "exterior" };
    expectError(await patch(`/vendor/services/${OTHER.service}`, owner, svcBody), 404);
    expectError(await patch(`/vendor/branches/${OTHER.branch}`, owner, { reason: "QA idor", capacity: 3 }), 404);
    expectError(await put(`/vendor/branches/${OTHER.branch}/settings`, owner, { reason: "QA idor", settings: {} }), 404);
    expectError(await patch(`/vendor/offers/${OTHER.offer}`, owner, { title: { ar: "QA idor" } }), 404);
    expectError(await post(`/vendor/offers/${OTHER.offer}/status`, owner, { enabled: false }), 404);
    expectError(await patch(`/vendor/staff/${OTHER.ownerStaff}`, owner, { reason: "QA idor", maxDiscountPct: 1 }), 404);
    expectError(await post(`/vendor/staff/${OTHER.employee}/status`, owner, { active: false, reason: "QA idor" }), 404);
    expectError(await put(`/vendor/staff/${OTHER.employee}/schedule`, owner, { shifts: [] }), 404);
  });
  await t(A, "other business branch in branchId params / create → 403, foreign service → 422", async () => {
    expectError(await get(`/vendor/schedule?branchId=${OTHER.branch}`, owner), 403);
    expectError(await get(`/vendor/orders?branchId=${OTHER.branch}`, owner), 403);
    expectError(await post("/vendor/services", owner, { branchId: OTHER.branch, name: { ar: "QA", en: "QA" }, price: 50, durationMin: 10 }), 403);
    expectError(await post("/vendor/orders", owner, { source: "walk_in", branchId: OTHER.branch, plate: plate(), serviceIds: [OTHER.service] }), 403);
    expectError(await get(`/vendor/price-preview?branchId=br_nasr&serviceIds=${OTHER.service}`, owner), 422);
    expectError(await post("/vendor/schedule/blocks", owner, { branchId: OTHER.branch, start: addDays(5, 10).toISOString(), end: addDays(5, 11).toISOString(), reason: "QA idor" }), 403);
    expectError(await post("/vendor/day-closing", owner, { branchId: OTHER.branch, date: "2001-01-02" }), 403);
  });
  /** A platform customer with a vehicle who never ordered from Carzen Wash (resolved via the admin API). */
  const foreign = async () => {
    if (ctx.foreign !== undefined) return ctx.foreign;
    const adm = await adminToken();
    const mine = new Set((await allRows("/vendor/customers", owner)).map((c) => c.id));
    ctx.foreign = null;
    const list = (await get("/admin/customers?per_page=100", adm)).data ?? [];
    for (const c of list.filter((x) => !mine.has(x.id)).slice(0, 10)) {
      const d = await get(`/admin/customers/${c.id}`, adm);
      const v = d.data?.vehicles?.[0];
      const carzen = (d.data?.orders ?? []).some((o) => o.businessId === "biz_carzen");
      if (v && !carzen) {
        ctx.foreign = { customerId: c.id, plate: v.plate, phone: d.data.customer.phone, otherWashes: [...new Set((d.data.orders ?? []).map((o) => o.businessId))] };
        break;
      }
    }
    return ctx.foreign;
  };
  await t(A, "other business customer detail → 404", async () => {
    const f = await foreign();
    if (!f) skip("no customer that only visited other washes (admin API)");
    expectError(await get(`/vendor/customers/${f.customerId}`, owner), 404);
  });
  await t(A, "plate/phone recognition does not expose other washes' customers", async () => {
    const f = await foreign();
    if (!f) skip("no customer that only visited other washes (admin API)");
    const r = expectOk(await get(`/vendor/recognize?plate=${enc(f.plate)}`, owner));
    const p = expectOk(await get(`/vendor/recognize?phone=${enc(f.phone)}`, owner));
    check(!r.data.customer && !p.data.customer, `by phone → ${p.data.customer ? "customer returned" : "null"}; recognize?plate=${f.plate} returned a customer who never visited this wash (orders at: ${f.otherWashes.join(",") || "none"}): name=${r.data.customer?.name} phone=${r.data.customer?.phone}, visits here=${r.data.visits}`);
  }, { severity: "Medium" });
  await t(A, "recognition does not expose admin moderation data (status/statusReason)", async () => {
    const adm = await adminToken();
    const sus = ((await get("/admin/customers?per_page=100", adm)).data ?? []).find((c) => c.status === "suspended");
    if (!sus) skip("no suspended platform customer");
    const v = (await get(`/admin/customers/${sus.id}`, adm)).data?.vehicles?.[0];
    if (!v) skip("suspended customer has no vehicle");
    const r = expectOk(await get(`/vendor/recognize?plate=${enc(v.plate)}`, owner));
    const c = r.data.customer;
    check(!c || !c.statusReason, `recognize?plate=${v.plate} returns the platform's internal suspension reason «${c?.statusReason}» (status=${c?.status})`);
  }, { severity: "Medium" });
}

// ════════════════════════════════════════════════════════════
// 3. ORDER LIFECYCLE
async function ordersArea() {
  const A = "3-Orders";
  const { owner } = ctx.tokens;
  const LB = ctx.LB;
  const mgr = ctx.tokens[ctx.LBmanager];
  const emp = ctx.emp(LB);
  const otherEmp = ctx.emp(ctx.otherBranchOf(LB));
  const L = {};

  await t(A, "create walk-in → 200 waiting, CZ-2xxxx, server price", async () => {
    const r = await walkIn(owner, LB, [svcId(LB, "full")], { customerName: "QA عميل <b>bold</b>", notes: "QA initial note" });
    expectOk(r);
    const o = r.data;
    L.id = o.id;
    check(o.status === "waiting" && o.source === "walk_in", `status=${o.status} source=${o.source}`);
    check(/^CZ-2\d{4}$/.test(o.number), `number=${o.number}`);
    check(o.total === price(LB, "full") && o.paymentStatus === "pending", `total=${o.total} payment=${o.paymentStatus}`);
    check(typeof o.code === "string" && o.code.length === 5, `code=${o.code}`);
  });
  if (!L.id) return;
  await t(A, "details: allowedActions for waiting + stored customer name/note verbatim", async () => {
    const d = await details(owner, L.id);
    for (const a of ["note", "start", "cancel", "assign", "add_service", "discount"]) check(d.allowedActions.includes(a), `missing ${a}`);
    for (const a of ["complete", "collect_payment", "refund", "confirm", "check_in", "no_show"]) check(!d.allowedActions.includes(a), `unexpected ${a}`);
    check(d.customer?.name === "QA عميل <b>bold</b>", `customer name=${d.customer?.name}`);
    check(d.order.notes[0]?.text === "QA initial note", "initial note");
    check(d.locked === false && d.nextAction === "start", `locked=${d.locked} next=${d.nextAction}`);
  });
  await t(A, "invalid transitions on waiting → 409", async () => {
    const wrong = [];
    for (const [a, p] of [["complete", {}], ["collect_payment", { method: "cash" }], ["refund", { reason: "QA test" }], ["confirm", {}], ["check_in", {}], ["no_show", {}], ["teleport", {}], [undefined, {}]]) {
      const r = await act(owner, L.id, a, p);
      if (r.status !== 409) wrong.push(`${a} → ${r.status} ${r.message}`);
    }
    check(!wrong.length, wrong.join("; "));
  });
  await t(A, "note validation (422) and XSS payload stored as text", async () => {
    expectError(await act(owner, L.id, "note", { text: "" }), 422);
    expectError(await act(owner, L.id, "note", { text: "  a " }), 422);
    expectError(await act(owner, L.id, "note", { text: 12345 }), 422);
    const xss = `<script>alert('qa')</script><img src=x onerror=alert(1)> ${RUN}`;
    expectOk(await act(owner, L.id, "note", { text: xss }));
    const d = await details(owner, L.id);
    check(d.order.notes.some((n) => n.text === xss), "note not stored verbatim");
  });
  await t(A, "assign: other-branch / owner / unknown staff → 422, valid → 200", async () => {
    if (!emp) skip("no employee in lifecycle branch");
    if (otherEmp) expectError(await act(owner, L.id, "assign", { staffId: otherEmp }), 422);
    expectError(await act(owner, L.id, "assign", { staffId: "st_owner_biz_carzen" }), 422);
    expectError(await act(owner, L.id, "assign", { staffId: "st_nope" }), 422);
    expectError(await act(owner, L.id, "assign", {}), 422);
    expectError(await act(owner, L.id, "assign", { staffId: "st_emp_br_nile_maadi" }), 422);
    expectOk(await act(owner, L.id, "assign", { staffId: emp }));
    const d = await details(owner, L.id);
    check(d.staff?.id === emp, `assigned=${d.staff?.id}`);
  });
  await t(A, "add_service: primary/foreign/unknown → 422, duplicate → 409, addon → recomputed total", async () => {
    expectError(await act(owner, L.id, "add_service", { serviceId: svcId(LB, "int") }), 422);
    expectError(await act(owner, L.id, "add_service", { serviceId: svcId(ctx.otherBranchOf(LB), "tire") }), 422);
    expectError(await act(owner, L.id, "add_service", { serviceId: "svc_nope" }), 422);
    const r = expectOk(await act(owner, L.id, "add_service", { serviceId: svcId(LB, "tire") }));
    check(r.data.total === price(LB, "full") + price(LB, "tire"), `total=${r.data.total}`);
    expectError(await act(owner, L.id, "add_service", { serviceId: svcId(LB, "tire") }), 409);
  });
  await t(A, "discount validation: reason required (errors.reason), value must be > 0", async () => {
    expectError(await act(owner, L.id, "discount", { discountType: "percent", discountValue: 10 }), 422, "reason");
    expectError(await act(owner, L.id, "discount", { discountType: "percent", discountValue: 0, reason: "QA test" }), 422);
    expectError(await act(owner, L.id, "discount", { discountType: "percent", discountValue: -5, reason: "QA test" }), 422);
    expectError(await act(owner, L.id, "discount", { discountType: "percent", discountValue: "abc", reason: "QA test" }), 422);
  });
  await t(A, "discount 10% (owner) → total = subtotal × 0.9", async () => {
    const sub = price(LB, "full") + price(LB, "tire");
    const r = expectOk(await act(owner, L.id, "discount", { discountType: "percent", discountValue: 10, reason: "QA loyal customer" }));
    check(r.data.total === sub - Math.round(sub * 0.1), `total=${r.data.total}, expected ${sub - Math.round(sub * 0.1)}`);
  });
  await t(A, "start → in_service", async () => {
    const r = expectOk(await act(owner, L.id, "start", {}));
    check(r.data.status === "in_service", `status=${r.data.status}`);
  });
  await t(A, "add_service during service keeps the % discount (recomputed)", async () => {
    const r = expectOk(await act(owner, L.id, "add_service", { serviceId: svcId(LB, "wax") }));
    const sub = price(LB, "full") + price(LB, "tire") + price(LB, "wax");
    check(r.data.subtotal === sub && r.data.total === sub - Math.round(sub * 0.1), `subtotal=${r.data.subtotal} total=${r.data.total}`);
    L.total = r.data.total;
  });
  await t(A, "complete → completed, collect_payment allowed, refund not yet", async () => {
    const r = expectOk(await act(owner, L.id, "complete", {}));
    check(r.data.status === "completed" && r.data.paymentStatus === "pending", `status=${r.data.status}/${r.data.paymentStatus}`);
    const d = await details(owner, L.id);
    check(d.allowedActions.includes("collect_payment") && !d.allowedActions.includes("refund"), `allowed=${d.allowedActions}`);
  });
  await t(A, "collect_payment validation: method, insufficient cash, NaN", async () => {
    expectError(await act(owner, L.id, "collect_payment", { method: "bitcoin" }), 422);
    expectError(await act(owner, L.id, "collect_payment", {}), 422);
    expectError(await act(owner, L.id, "collect_payment", { method: "online" }), 422);
    const r = expectError(await act(owner, L.id, "collect_payment", { method: "cash", amountReceived: L.total - 1 }), 422);
    check(r.message.includes(String(L.total)), `message should state the total: ${r.message}`);
    expectError(await act(owner, L.id, "collect_payment", { method: "cash", amountReceived: "abc" }), 422);
  });
  await t(A, "collect cash with change → paid; payment amount = server total", async () => {
    const r = expectOk(await act(owner, L.id, "collect_payment", { method: "cash", amountReceived: L.total + 57, amount: 1, total: 1 }));
    check(r.message.includes("57"), `change not reported: ${r.message}`);
    const d = await details(owner, L.id);
    check(d.order.paymentStatus === "paid" && d.order.paymentMethod === "cash", `payment=${d.order.paymentStatus}/${d.order.paymentMethod}`);
    check(d.payment?.amount === L.total, `payment.amount=${d.payment?.amount} total=${L.total}`);
  });
  await t(A, "after payment: collect again / add_service / discount / cancel / start → 409", async () => {
    const wrong = [];
    for (const [a, p] of [["collect_payment", { method: "card" }], ["add_service", { serviceId: svcId(LB, "air") }], ["discount", { discountType: "percent", discountValue: 5, reason: "QA" }], ["cancel", { reason: "QA test" }], ["start", {}]]) {
      const r = await act(owner, L.id, a, p);
      if (r.status !== 409) wrong.push(`${a} → ${r.status}`);
    }
    check(!wrong.length, wrong.join("; "));
  });
  await t(A, "refund: reason required, then refunded; second refund → 409", async () => {
    expectError(await act(owner, L.id, "refund", {}), 422, "reason");
    const r = expectOk(await act(owner, L.id, "refund", { reason: "QA customer complaint" }));
    check(r.data.paymentStatus === "refunded", `payment=${r.data.paymentStatus}`);
    const d = await details(owner, L.id);
    check(d.payment?.status === "refunded", `payment row status=${d.payment?.status}`);
    expectError(await act(owner, L.id, "refund", { reason: "QA again" }), 409);
  });

  await t(A, "manager card flow: walk-in (offer) → start with staffId → complete → card", async () => {
    if (!emp) skip("no employee");
    const o = await mustWalkIn(mgr, LB, [svcId(LB, "ext")]);
    check(o.discount?.reason?.startsWith("عرض") || o.total === price(LB, "ext"), `discount=${JSON.stringify(o.discount)}`);
    expectOk(await act(mgr, o.id, "start", { staffId: emp }));
    expectOk(await act(mgr, o.id, "complete", {}));
    const r = expectOk(await act(mgr, o.id, "collect_payment", { method: "card" }));
    check(r.data.paymentStatus === "paid" && r.data.paymentMethod === "card", `${r.data.paymentStatus}/${r.data.paymentMethod}`);
  });
  await t(A, "start without any staff → 422 errors.staffId", async () => {
    const o = await mustWalkIn(owner, LB, [svcId(LB, "int")]);
    L.cancelId = o.id;
    expectError(await act(owner, o.id, "start", {}), 422, "staffId");
  });
  await t(A, "cancel: reason required (errors.reason), then cancelled; later actions → 409, note still allowed", async () => {
    const id = L.cancelId ?? (await mustWalkIn(owner, LB, [svcId(LB, "int")])).id;
    L.cancelId = id;
    expectError(await act(owner, id, "cancel", {}), 422, "reason");
    expectError(await act(owner, id, "cancel", { reason: "ab" }), 422, "reason");
    const r = expectOk(await act(owner, id, "cancel", { reason: "QA customer left" }));
    check(r.data.status === "cancelled", `status=${r.data.status}`);
    const d = await details(owner, id);
    check(d.order.cancel?.reason === "QA customer left", `cancel=${JSON.stringify(d.order.cancel)}`);
    for (const a of ["start", "cancel", "discount", "complete"]) expectError(await act(owner, id, a, { reason: "QA", discountType: "percent", discountValue: 5 }), 409);
    expectOk(await act(owner, id, "note", { text: "QA note on cancelled" }));
  });

  // Phone bookings
  const slotsFor = async (date, branch = LB, svc = "full") => expectOk(await get(`/vendor/availability?branchId=${branch}&date=${date}&serviceIds=${svcId(branch, svc)}`, owner)).data;
  const phoneBody = (scheduledAt, extra = {}) => ({ source: "phone", branchId: LB, plate: plate(), serviceIds: [svcId(LB, "full")], customerPhone: phone(), customerName: "QA هاتفي", scheduledAt, ...extra });
  let slot;
  await t(A, "availability for tomorrow returns bookable slots", async () => {
    const slots = await slotsFor(TOMORROW);
    check(Array.isArray(slots) && slots.length > 0, "no slots");
    slot = slots.find((s) => !s.past && !s.blocked && s.free > 0);
    check(slot, "no free slot tomorrow");
    for (const k of ["start", "free", "capacity", "blocked", "past"]) check(k in slot, `slot.${k}`);
  });
  await t(A, "phone booking validation: scheduledAt / customerPhone required", async () => {
    if (!slot) skip("no slot");
    expectError(await post("/vendor/orders", owner, phoneBody(undefined)), 422, "scheduledAt");
    expectError(await post("/vendor/orders", owner, phoneBody(slot.start, { customerPhone: undefined })), 422, "customerPhone");
  });
  await t(A, "phone booking in the past / misaligned slot → 409", async () => {
    expectError(await post("/vendor/orders", owner, phoneBody(addDays(-1, 12).toISOString())), 409);
    if (slot) expectError(await post("/vendor/orders", owner, phoneBody(new Date(new Date(slot.start).getTime() + 7 * 60000).toISOString())), 409);
  });
  await t(A, "phone booking with unparseable date → 409/422 (not 500)", async () => {
    const r = await post("/vendor/orders", owner, phoneBody("not-a-date"));
    if (r.status === 200) ctx.createdOrders.push(r.data.id);
    expectStatus(r, [409, 422]);
  }, { severity: "Medium" });
  await t(A, "phone booking beyond maxAdvanceDays (60 days) → rejected", async () => {
    const br = expectOk(await get("/vendor/branches", owner)).data.find((b) => b.id === LB);
    const r = await post("/vendor/orders", owner, phoneBody(addDays(60, 12, 0).toISOString()));
    if (r.status === 200) {
      ctx.createdOrders.push(r.data.id);
      await act(owner, r.data.id, "cancel", { reason: "QA cleanup (maxAdvanceDays probe)" });
    }
    check(r.status === 409 || r.status === 422, `booking 60 days ahead accepted (branch maxAdvanceDays=${br?.settings?.maxAdvanceDays}): ${describe(r)}`);
  }, { severity: "Medium" });
  await t(A, "phone booking → confirmed CZ-3xxxx; capacity decremented; no check-in/no-show before time", async () => {
    if (!slot) skip("no slot");
    const before = (await slotsFor(TOMORROW)).find((s) => s.start === slot.start);
    const body = phoneBody(slot.start);
    const r = expectOk(await post("/vendor/orders", owner, body));
    ctx.createdOrders.push(r.data.id);
    L.phoneId = r.data.id;
    L.phoneNo = body.customerPhone;
    check(r.data.status === "confirmed" && /^CZ-3\d{4}$/.test(r.data.number), `status=${r.data.status} number=${r.data.number}`);
    check(r.data.scheduledAt === slot.start, `scheduledAt=${r.data.scheduledAt}`);
    const after = (await slotsFor(TOMORROW)).find((s) => s.start === slot.start);
    check(after.free === before.free - 1, `free before=${before.free} after=${after.free}`);
    const d = await details(owner, r.data.id);
    check(!d.allowedActions.includes("check_in") && !d.allowedActions.includes("no_show"), `allowed=${d.allowedActions}`);
    expectError(await act(owner, r.data.id, "check_in", {}), 409);
    expectError(await act(owner, r.data.id, "no_show", {}), 409);
  });
  await t(A, "recognize by phone/plate returns the new customer", async () => {
    if (!L.phoneNo) skip("no phone booking");
    const r = expectOk(await get(`/vendor/recognize?phone=${L.phoneNo}`, owner));
    check(r.data.customer?.name === "QA هاتفي", `customer=${JSON.stringify(r.data.customer)}`);
    const short = expectOk(await get("/vendor/recognize?plate=A", owner));
    check(short.data.customer === null, "1-char plate should not match");
  });
  await t(A, "cancel phone booking → slot released", async () => {
    if (!L.phoneId) skip("no phone booking");
    expectOk(await act(owner, L.phoneId, "cancel", { reason: "QA cleanup booking" }));
  });
  await t(A, "no_show allowed only after grace window (read-only check on seeded bookings)", async () => {
    const list = expectOk(await get("/vendor/orders?view=bookings&tab=today&per_page=100", owner)).data;
    const nowMs = Date.now();
    const late = list.find((o) => o.status === "confirmed" && o.overdueMin > 20);
    const early = list.find((o) => o.status === "confirmed" && Date.parse(o.scheduledAt) > nowMs + 60 * 60000);
    if (!late && !early) skip("no suitable confirmed booking today");
    if (late) check((await details(owner, late.id)).allowedActions.includes("no_show"), `no_show missing for ${late.id} (${late.overdueMin} min late)`);
    if (early) check(!(await details(owner, early.id)).allowedActions.includes("no_show"), `no_show offered before time for ${early.id}`);
  });
  await t(A, "blocked slot: block, booking into it → 409, unblock (validation 422s)", async () => {
    const slots = await slotsFor(TOMORROW);
    const s2 = slots.filter((s) => !s.past && !s.blocked && s.free > 0).at(-2);
    if (!s2) skip("no slot");
    const start = new Date(s2.start);
    const end = new Date(start.getTime() + 30 * 60000);
    expectError(await post("/vendor/schedule/blocks", owner, { branchId: LB, start: end.toISOString(), end: start.toISOString(), reason: "QA" }), 422);
    expectError(await post("/vendor/schedule/blocks", owner, { branchId: LB, start: "garbage", end: end.toISOString(), reason: "QA block" }), 422);
    expectError(await post("/vendor/schedule/blocks", owner, { branchId: LB, start: start.toISOString(), end: end.toISOString() }), 422, "reason");
    const blk = expectOk(await post("/vendor/schedule/blocks", owner, { branchId: LB, start: start.toISOString(), end: end.toISOString(), reason: `QA block ${RUN}` })).data;
    try {
      const day = expectOk(await get(`/vendor/schedule?branchId=${LB}&date=${TOMORROW}`, owner)).data;
      check(day.blocks.some((b) => b.id === blk.id), "block not listed in schedule");
      const after = (await slotsFor(TOMORROW)).find((s) => s.start === s2.start);
      check(after?.blocked === true, "slot not marked blocked");
      const r = await post("/vendor/orders", owner, phoneBody(s2.start));
      if (r.status === 200) ctx.createdOrders.push(r.data.id);
      expectError(r, 409);
    } finally {
      expectOk(await del(`/vendor/schedule/blocks/${blk.id}`, owner), "unblock");
    }
    expectError(await del(`/vendor/schedule/blocks/${blk.id}`, owner), 404);
  });
  await t(A, "bulk-confirm validation: empty / non-array → 422, nothing pending → 409", async () => {
    expectError(await post("/vendor/orders/bulk-confirm", owner, { ids: [] }), 422);
    expectError(await post("/vendor/orders/bulk-confirm", owner, { ids: "ord_pend_1" }), 422);
    expectError(await post("/vendor/orders/bulk-confirm", owner, {}), 422);
    if (L.cancelId) expectError(await post("/vendor/orders/bulk-confirm", owner, { ids: [L.cancelId, "ord_nope"] }), 409);
  });
  await t(A, "bulk-confirm a pending app booking (confirms exactly the pending ones)", async () => {
    const pend = (await get("/vendor/orders?view=bookings&tab=today&per_page=100", owner)).data?.find((o) => o.status === "pending")
      ?? (await get("/vendor/orders?view=bookings&tab=upcoming&per_page=100", owner)).data?.find((o) => o.status === "pending");
    if (!pend) skip("no pending booking left (already confirmed by a previous run)");
    const r = expectOk(await post("/vendor/orders/bulk-confirm", owner, { ids: [pend.id, L.cancelId ?? "ord_nope"] }));
    check(r.data.confirmed === 1, `confirmed=${r.data.confirmed}`);
    check((await details(owner, pend.id)).order.status === "confirmed", "not confirmed");
    expectError(await act(owner, pend.id, "confirm", {}), 409);
  });

  // Create-order validation
  await t(A, "create validation: source / branch / plate / services", async () => {
    const base = { source: "walk_in", branchId: LB, plate: plate(), serviceIds: [svcId(LB, "ext")] };
    expectError(await post("/vendor/orders", owner, { ...base, source: "app" }), 422);
    expectError(await post("/vendor/orders", owner, { ...base, source: undefined }), 422);
    expectError(await post("/vendor/orders", owner, { ...base, branchId: undefined }), 403);
    expectError(await post("/vendor/orders", owner, { ...base, plate: "" }), 422, "plate");
    expectError(await post("/vendor/orders", owner, { ...base, plate: "A-B" }), 422, "plate");
    expectError(await post("/vendor/orders", owner, { ...base, serviceIds: [] }), 422);
    expectError(await post("/vendor/orders", owner, { ...base, serviceIds: [svcId(LB, "ext"), svcId(LB, "full")] }), 422);
    expectError(await post("/vendor/orders", owner, { ...base, serviceIds: [svcId(LB, "tire")] }), 422);
    expectError(await post("/vendor/orders", owner, { ...base, serviceIds: ["svc_nope"] }), 422);
    expectError(await post("/vendor/orders", owner, { ...base, serviceIds: svcId(LB, "ext") }), 422);
  });
  await t(A, "create with wrongly-typed fields → 4xx, never 500", async () => {
    const base = { source: "walk_in", branchId: LB, plate: plate(), serviceIds: [svcId(LB, "ext")] };
    const bad = [];
    for (const [label, over] of [["plate:number", { plate: 1234567 }], ["customerPhone:number", { customerPhone: 1012345678 }], ["notes:object", { notes: { x: 1 } }], ["customerName:number", { customerName: 42, customerPhone: phone() }], ["serviceIds:[null]", { serviceIds: [null] }], ["vehicleMake:array", { vehicleMake: ["x"], customerPhone: phone() }]]) {
      const r = await post("/vendor/orders", owner, { ...base, plate: plate(), ...over });
      if (r.status === 200) {
        ctx.createdOrders.push(r.data.id);
        await act(owner, r.data.id, "cancel", { reason: "QA cleanup typed fields" });
      }
      if (r.status >= 500) bad.push(`${label} → ${r.status}`);
    }
    check(!bad.length, `server errors: ${bad.join("; ")}`);
  }, { severity: "Medium" });
  await t(A, "length limits: 600-char note / 100-char customer name → 422", async () => {
    const bad = [];
    const r1 = await walkIn(owner, LB, [svcId(LB, "ext")], { notes: "ن".repeat(600) });
    const r2 = await walkIn(owner, LB, [svcId(LB, "ext")], { customerName: "x".repeat(100) });
    for (const [lbl, r] of [["note 600", r1], ["name 100", r2]]) {
      if (r.status === 200) await act(owner, r.data.id, "cancel", { reason: "QA cleanup length" });
      if (r.status !== 422) bad.push(`${lbl} → ${r.status}`);
    }
    const o = await mustWalkIn(owner, LB, [svcId(LB, "ext")]);
    const r3 = await act(owner, o.id, "note", { text: "x".repeat(5000) });
    if (r3.status !== 422) bad.push(`action note 5000 chars → ${r3.status}`);
    await act(owner, o.id, "cancel", { reason: "QA cleanup length" });
    check(!bad.length, `no server-side length limit: ${bad.join("; ")}`);
  }, { severity: "Low" });
  await t(A, "price-preview validation", async () => {
    const r = expectOk(await get(`/vendor/price-preview?branchId=${LB}&serviceIds=${svcId(LB, "full")},${svcId(LB, "tire")}`, owner));
    check(r.data.subtotal === price(LB, "full") + price(LB, "tire") && r.data.total === r.data.subtotal - r.data.offerDiscount, `preview ${JSON.stringify(r.data)}`);
    expectError(await get(`/vendor/price-preview?branchId=${LB}`, owner), 422);
    expectError(await get(`/vendor/price-preview?branchId=${LB}&serviceIds=${svcId(LB, "ext")},${svcId(LB, "full")}`, owner), 422);
  });
}

// ════════════════════════════════════════════════════════════
// 4. PRICING INTEGRITY
async function pricingArea() {
  const A = "4-Pricing";
  const { owner, adel } = ctx.tokens;
  await t(A, "client-sent prices/totals/status/ownership fields are ignored on create", async () => {
    const full = svcId("br_nasr", "full");
    const r = expectOk(await post("/vendor/orders", owner, {
      source: "walk_in", branchId: "br_nasr", plate: plate(), serviceIds: [full],
      subtotal: 1, total: 1, discount: { amount: 179, pct: 99, reason: "x" }, items: [{ serviceId: full, price: 1, durationMin: 1, type: "primary", name: { ar: "x", en: "x" } }],
      offerId: "of_deep", status: "completed", paymentStatus: "paid", paymentMethod: "cash", number: "CZ-99999", code: "AAAAA",
      businessId: "biz_nile", assignedStaffId: "st_samir", closedInDayId: "dc_fake", createdAt: "2000-01-01T00:00:00Z", durationMin: 1,
    }));
    ctx.createdOrders.push(r.data.id);
    const o = r.data;
    const exp = price("br_nasr", "full");
    const bad = [];
    if (o.total !== exp || o.subtotal !== exp) bad.push(`total=${o.total} subtotal=${o.subtotal}`);
    if (o.discount) bad.push(`discount=${JSON.stringify(o.discount)}`);
    if (o.status !== "waiting" || o.paymentStatus !== "pending") bad.push(`status=${o.status}/${o.paymentStatus}`);
    if (o.number === "CZ-99999" || o.code === "AAAAA") bad.push(`number/code from client ${o.number}/${o.code}`);
    if (o.businessId !== "biz_carzen" || o.assignedStaffId || o.closedInDayId || o.offerId) bad.push(`biz=${o.businessId} staff=${o.assignedStaffId} closed=${o.closedInDayId} offer=${o.offerId}`);
    if (o.items.length !== 1 || o.items[0].price !== exp || o.durationMin === 1) bad.push(`items=${JSON.stringify(o.items)}`);
    ctx.priceOrder = o.id;
    check(!bad.length, bad.join("; "));
  }, { severity: "Critical" });
  await t(A, "client-sent price on add_service is ignored", async () => {
    if (!ctx.priceOrder) skip("no order");
    const r = expectOk(await act(owner, ctx.priceOrder, "add_service", { serviceId: svcId("br_nasr", "tire"), price: 1, total: 1 }));
    check(r.data.total === price("br_nasr", "full") + price("br_nasr", "tire"), `total=${r.data.total}`);
    await act(owner, ctx.priceOrder, "cancel", { reason: "QA cleanup pricing" });
  }, { severity: "Critical" });
  await t(A, "created order total equals price-preview (offer on subtotal incl. add-ons)", async () => {
    const ids = [svcId("br_nasr", "ext"), svcId("br_nasr", "tire")];
    const p = expectOk(await get(`/vendor/price-preview?branchId=br_nasr&serviceIds=${ids.join(",")}`, owner)).data;
    const o = await mustWalkIn(owner, "br_nasr", ids);
    check(o.total === p.total && o.subtotal === p.subtotal, `order ${o.subtotal}/${o.total} vs preview ${p.subtotal}/${p.total}`);
    await act(owner, o.id, "cancel", { reason: "QA cleanup pricing" });
  });
  let deepOrder;
  await t(A, "active wash offer (of_deep 15%) applied automatically", async () => {
    const off = expectOk(await get("/vendor/offers", owner)).data.find((x) => x.id === "of_deep");
    if (!off || off.status !== "active") skip(`of_deep not active (${off?.status})`);
    const p = expectOk(await get(`/vendor/price-preview?branchId=br_nasr&serviceIds=${svcId("br_nasr", "deep")}`, adel)).data;
    const exp = Math.round(price("br_nasr", "deep") * 0.15);
    check(p.offerDiscount === exp, `preview offerDiscount=${p.offerDiscount} expected ${exp}`);
    deepOrder = await mustWalkIn(adel, "br_nasr", [svcId("br_nasr", "deep")]);
    check(deepOrder.total === price("br_nasr", "deep") - exp && deepOrder.discount?.reason?.startsWith("عرض") && deepOrder.offerId === "of_deep", `order total=${deepOrder.total} discount=${JSON.stringify(deepOrder.discount)} offerId=${deepOrder.offerId}`);
  });
  await t(A, "manager discount cap (maxDiscountPct=20): 25% / fixed 22% → 403; 20% ok; new manual discount replaces old", async () => {
    const o = await mustWalkIn(adel, "br_nasr", [svcId("br_nasr", "full")]);
    const sub = price("br_nasr", "full");
    const r1 = expectError(await act(adel, o.id, "discount", { discountType: "percent", discountValue: 25, reason: "QA cap probe" }), 403);
    check(r1.message.includes("20"), `cap message: ${r1.message}`);
    expectError(await act(adel, o.id, "discount", { discountType: "fixed", discountValue: Math.ceil(sub * 0.22), reason: "QA cap probe" }), 403);
    const r2 = expectOk(await act(adel, o.id, "discount", { discountType: "percent", discountValue: 20, reason: "QA within cap" }));
    check(r2.data.total === sub - Math.round(sub * 0.2), `total=${r2.data.total}`);
    const r3 = expectOk(await act(adel, o.id, "discount", { discountType: "fixed", discountValue: Math.round(sub * 0.1), reason: "QA replace" }));
    check(r3.data.total === sub - Math.round(sub * 0.1), `second manual discount should replace the first: total=${r3.data.total}, expected ${sub - Math.round(sub * 0.1)}`);
    await act(adel, o.id, "cancel", { reason: "QA cleanup cap" });
  }, { severity: "High" });
  await t(A, "repeated manual discounts on an offer order cannot exceed offer + cap", async () => {
    if (!deepOrder) skip("no offer order");
    const sub = price("br_nasr", "deep");
    const floor = sub - Math.round(sub * 0.15) - Math.round(sub * 0.2);
    let last;
    for (let i = 0; i < 3; i += 1) last = expectOk(await act(adel, deepOrder.id, "discount", { discountType: "percent", discountValue: 20, reason: `QA stack ${i + 1}` }));
    const total = last.data.total;
    await act(adel, deepOrder.id, "cancel", { reason: "QA cleanup stacking" });
    check(total >= floor, `after 3× 20% manager discounts the total is ${total} EGP (subtotal ${sub}, offer 15%, cap 20% ⇒ floor ${floor}); discounts accumulate past maxDiscountPct`);
  }, { severity: "High" });
  await t(A, "owner discount above 100% → 403", async () => {
    const o = await mustWalkIn(owner, "br_nasr", [svcId("br_nasr", "full")]);
    expectError(await act(owner, o.id, "discount", { discountType: "percent", discountValue: 101, reason: "QA cap probe" }), 403);
    await act(owner, o.id, "cancel", { reason: "QA cleanup" });
  });
}

// ════════════════════════════════════════════════════════════
// 5. CATALOG / BRANCHES / SETTINGS / TEAM
async function catalogArea() {
  const A = "5-Catalog";
  const { owner, adel } = ctx.tokens;
  const svcBody = (s, over = {}) => ({ branchId: s.branchId, name: s.name, description: s.description, price: s.price, durationMin: s.durationMin, type: s.type, category: s.category, active: s.active, ...over });
  const snap = async (id) => expectOk(await get("/vendor/services?branchId=all", owner)).data.find((s) => s.id === id);

  await t(A, "service PATCH boundaries (price 10–5000, duration 2–240) with restore", async () => {
    const s = await snap(svcId("br_helio", "air"));
    try {
      const bad = [
        [{ price: 9 }, "price"], [{ price: 5001 }, "price"], [{ price: "abc" }, "price"], [{ durationMin: 1 }, "durationMin"], [{ durationMin: 241 }, "durationMin"],
        [{ name: { ar: "", en: "Air" } }, "name.ar"], [{ name: { ar: "معطر", en: "x" } }, "name.en"],
      ];
      for (const [over, field] of bad) expectError(await patch(`/vendor/services/${s.id}`, owner, svcBody(s, over)), 422, field);
      const lo = expectOk(await patch(`/vendor/services/${s.id}`, owner, svcBody(s, { price: 10, durationMin: 2 })));
      check(lo.data.price === 10 && lo.data.durationMin === 2, "lower bounds");
      const hi = expectOk(await patch(`/vendor/services/${s.id}`, owner, svcBody(s, { price: 5000, durationMin: 240 })));
      check(hi.data.price === 5000 && hi.data.durationMin === 240, "upper bounds");
    } finally {
      expectOk(await patch(`/vendor/services/${s.id}`, owner, svcBody(s)), "restore service");
    }
    const after = await snap(s.id);
    check(after.price === s.price && after.durationMin === s.durationMin, "restore mismatch");
  });
  await t(A, "service POST validation (422/403)", async () => {
    const b = { branchId: "br_helio", name: { ar: "خدمة QA", en: "QA service" }, price: 50, durationMin: 10, type: "addon", category: "exterior", active: false };
    expectError(await post("/vendor/services", owner, { ...b, price: 9 }), 422, "price");
    expectError(await post("/vendor/services", owner, { ...b, durationMin: 241 }), 422, "durationMin");
    expectError(await post("/vendor/services", owner, { ...b, name: { ar: "x", en: "QA" } }), 422, "name.ar");
    expectError(await post("/vendor/services", owner, { ...b, branchId: undefined }), 403);
  });
  await t(A, "service POST creates (inactive QA add-on, name stored as text)", async () => {
    const name = { ar: `خدمة QA <b>${RUN}</b>`, en: `QA addon ${RUN}` };
    const r = expectOk(await post("/vendor/services", owner, { branchId: "br_helio", name, price: 10, durationMin: 2, type: "addon", category: "exterior", active: false }));
    check(r.data.active === false && r.data.name.ar === name.ar && r.data.price === 10, JSON.stringify(r.data));
    ctx.qaServiceId = r.data.id;
    check((await snap(r.data.id))?.name.ar === name.ar, "not listed");
  });
  await t(A, "managerCanEditServices toggle lets the manager edit his branch only, then restored", async () => {
    const st = expectOk(await get("/vendor/settings", owner)).data;
    const orig = st.managerCanEditServices;
    const s = await snap(svcId("br_nasr", "air"));
    const h = await snap(svcId("br_helio", "air"));
    try {
      expectOk(await put("/vendor/settings", owner, { managerCanEditServices: true, reason: "QA toggle" }));
      const me = expectOk(await get("/vendor/auth/me", adel)).data;
      check(me.canEditServices === true, "me.canEditServices not updated");
      expectOk(await patch(`/vendor/services/${s.id}`, adel, svcBody(s)));
      expectError(await patch(`/vendor/services/${h.id}`, adel, svcBody(h)), 404);
      expectError(await post("/vendor/services", adel, { ...svcBody(h), active: false }), 403);
    } finally {
      expectOk(await put("/vendor/settings", owner, { managerCanEditServices: orig, reason: "QA restore" }), "restore setting");
    }
    expectStatus(await patch(`/vendor/services/${s.id}`, adel, svcBody(s)), orig ? 200 : 403);
  });

  // Offers
  await t(A, "offer validation: percent ≤ 50, value > 0, dates, branches, title", async () => {
    const b = { title: { ar: "عرض QA", en: "QA offer" }, discountType: "percent", discountValue: 10, startAt: addDays(0, 0).toISOString(), endAt: addDays(1, 23).toISOString(), branchIds: ["br_helio"], serviceCategories: ["interior"] };
    expectError(await post("/vendor/offers", owner, { ...b, discountValue: 51 }), 422);
    expectError(await post("/vendor/offers", owner, { ...b, discountValue: 0 }), 422);
    expectError(await post("/vendor/offers", owner, { ...b, endAt: b.startAt }), 422);
    expectError(await post("/vendor/offers", owner, { ...b, startAt: "garbage" }), 422);
    expectError(await post("/vendor/offers", owner, { ...b, branchIds: [] }), 422);
    expectError(await post("/vendor/offers", owner, { ...b, branchIds: [OTHER.branch] }), 422);
    expectError(await post("/vendor/offers", owner, { ...b, title: { ar: "ab" } }), 422, "title.ar");
  });
  await t(A, "owner offer lifecycle: publish → priced in → 50% boundary → disable → no longer priced", async () => {
    const int = svcId("br_helio", "int");
    const pre = expectOk(await get(`/vendor/price-preview?branchId=br_helio&serviceIds=${int}`, owner)).data;
    const title = { ar: `عرض QA ${RUN} <i>x</i>`, en: `QA offer ${RUN}` };
    const body = { title, discountType: "percent", discountValue: 10, startAt: new Date(Date.now() - 3600e3).toISOString(), endAt: addDays(1, 23).toISOString(), branchIds: ["br_helio"], serviceCategories: ["interior"], publish: true };
    const r = expectOk(await post("/vendor/offers", owner, body));
    const id = r.data.id;
    try {
      check(r.data.status === "active", `status=${r.data.status}`);
      const p1 = expectOk(await get(`/vendor/price-preview?branchId=br_helio&serviceIds=${int}`, owner)).data;
      check(p1.offerDiscount === Math.max(pre.offerDiscount, Math.round(p1.subtotal * 0.1)), `offerDiscount=${p1.offerDiscount}`);
      expectOk(await patch(`/vendor/offers/${id}`, owner, { ...body, discountValue: 50 }));
      const p2 = expectOk(await get(`/vendor/price-preview?branchId=br_helio&serviceIds=${int}`, owner)).data;
      check(p2.offerDiscount === Math.round(p2.subtotal * 0.5) && p2.offerTitle?.ar === title.ar, `offerDiscount=${p2.offerDiscount} title=${p2.offerTitle?.ar}`);
      expectError(await patch(`/vendor/offers/${id}`, owner, { ...body, discountValue: 51 }), 422);
      expectError(await patch("/vendor/offers/of_platform", owner, body), 404);
    } finally {
      const d = expectOk(await post(`/vendor/offers/${id}/status`, owner, { enabled: false }), "disable QA offer");
      check(d.data.status === "disabled", `status after disable=${d.data.status}`);
    }
    const p3 = expectOk(await get(`/vendor/price-preview?branchId=br_helio&serviceIds=${int}`, owner)).data;
    check(p3.offerDiscount === pre.offerDiscount, `disabled offer still priced: ${p3.offerDiscount}`);
  });

  // Branches
  await t(A, "branch PATCH validation + identical save (restored)", async () => {
    const b = expectOk(await get("/vendor/branches", owner)).data.find((x) => x.id === "br_helio");
    const base = { name: b.name, address: b.address, phone: b.phone, amenities: b.amenities, capacity: b.capacity, workingHours: b.workingHours, active: b.active, reason: "QA no-op save" };
    try {
      expectError(await patch("/vendor/branches/br_helio", owner, { ...base, reason: undefined }), 422, "reason");
      expectError(await patch("/vendor/branches/br_helio", owner, { ...base, capacity: 0 }), 422, "capacity");
      expectError(await patch("/vendor/branches/br_helio", owner, { ...base, capacity: 31 }), 422, "capacity");
      expectError(await patch("/vendor/branches/br_helio", owner, { ...base, workingHours: b.workingHours.slice(0, 6) }), 422);
      expectError(await patch("/vendor/branches/br_helio", owner, { ...base, name: { ar: "", en: "x" } }), 422, "name.ar");
      const r = expectOk(await patch("/vendor/branches/br_helio", owner, base));
      check(r.data.capacity === b.capacity, "capacity changed");
    } finally {
      await patch("/vendor/branches/br_helio", owner, base);
    }
  });
  await t(A, "branch working hours: invalid time (25:99) / close before open → 422", async () => {
    const b = expectOk(await get("/vendor/branches", owner)).data.find((x) => x.id === "br_helio");
    const base = { name: b.name, address: b.address, phone: b.phone, amenities: b.amenities, capacity: b.capacity, workingHours: b.workingHours, active: b.active, reason: "QA hours probe" };
    const bad = [];
    try {
      const h1 = b.workingHours.map((d, i) => (i === 3 ? { ...d, open: "25:99" } : d));
      const r1 = await patch("/vendor/branches/br_helio", owner, { ...base, workingHours: h1 });
      if (r1.status !== 422) bad.push(`open=25:99 → ${r1.status}`);
      const h2 = b.workingHours.map((d, i) => (i === 3 ? { open: "18:00", close: "09:00", closed: false } : d));
      const r2 = await patch("/vendor/branches/br_helio", owner, { ...base, workingHours: h2 });
      if (r2.status !== 422) bad.push(`18:00→09:00 → ${r2.status}`);
      const r3 = await patch("/vendor/branches/br_helio", owner, { ...base, workingHours: [null, null, null, null, null, null, null] });
      if (r3.status !== 422) bad.push(`[null×7] → ${r3.status}`);
    } finally {
      expectOk(await patch("/vendor/branches/br_helio", owner, { ...base, reason: "QA restore hours" }), "restore branch");
    }
    check(!bad.length, bad.join("; "));
  }, { severity: "Medium" });
  await t(A, "a failed branch PATCH leaves no partial changes", async () => {
    const b = expectOk(await get("/vendor/branches", owner)).data.find((x) => x.id === "br_helio");
    const base = { name: b.name, address: b.address, phone: b.phone, amenities: b.amenities, capacity: b.capacity, workingHours: b.workingHours, active: b.active, reason: "QA atomicity probe" };
    let after;
    try {
      const r = await patch("/vendor/branches/br_helio", owner, { ...base, name: { ar: b.name.ar, en: `QA partial ${RUN}` }, capacity: b.capacity === 30 ? 29 : b.capacity + 1, workingHours: [null, null, null, null, null, null, null] });
      check(r.status >= 400, `request unexpectedly succeeded: ${describe(r)}`);
      after = expectOk(await get("/vendor/branches", owner)).data.find((x) => x.id === "br_helio");
    } finally {
      expectOk(await patch("/vendor/branches/br_helio", owner, { ...base, reason: "QA restore after atomicity probe" }), "restore branch");
    }
    check(after.name.en === b.name.en && after.capacity === b.capacity, `failed request still changed the branch: name.en=«${after.name.en}» capacity ${b.capacity}→${after.capacity}`);
  }, { severity: "Medium" });
  await t(A, "branch phone format validated", async () => {
    const b = expectOk(await get("/vendor/branches", owner)).data.find((x) => x.id === "br_helio");
    const base = { name: b.name, address: b.address, phone: b.phone, amenities: b.amenities, capacity: b.capacity, workingHours: b.workingHours, active: b.active, reason: "QA phone probe" };
    let r;
    try {
      r = await patch("/vendor/branches/br_helio", owner, { ...base, phone: "not-a-phone" });
    } finally {
      expectOk(await patch("/vendor/branches/br_helio", owner, { ...base, reason: "QA restore phone" }), "restore");
    }
    expectError(r, 422);
  }, { severity: "Low" });
  await t(A, "booking rules PUT validation (+ invalid slotInterval silently coerced?) restored", async () => {
    const b = expectOk(await get("/vendor/branches", owner)).data.find((x) => x.id === "br_helio");
    const s = b.settings;
    let coerced;
    try {
      expectError(await put("/vendor/branches/br_helio/settings", owner, { settings: s }), 422, "reason");
      for (const over of [{ leadTimeMin: 241 }, { noShowGraceMin: 4 }, { maxAdvanceDays: 31 }, { reminderMin: 1441 }, { freeCancelMin: -1 }]) {
        expectError(await put("/vendor/branches/br_helio/settings", owner, { settings: { ...s, ...over }, reason: "QA rules probe" }), 422);
      }
      expectOk(await put("/vendor/branches/br_helio/settings", owner, { settings: s, reason: "QA identical" }));
      coerced = await put("/vendor/branches/br_helio/settings", owner, { settings: { ...s, slotIntervalMin: 7 }, reason: "QA slot probe" });
    } finally {
      expectOk(await put("/vendor/branches/br_helio/settings", owner, { settings: s, reason: "QA restore rules" }), "restore rules");
    }
    check(coerced.status === 422, `slotIntervalMin=7 accepted (${coerced.status}) and stored as ${coerced.data?.settings?.slotIntervalMin}`);
  }, { severity: "Low" });

  // Settings
  await t(A, "settings GET shape + PUT validation", async () => {
    const s = expectOk(await get("/vendor/settings", owner)).data;
    for (const k of ["id", "name", "ownerName", "phone", "email", "commissionRate", "status"]) check(k in s.business, `business.${k}`);
    check(typeof s.managerCanEditServices === "boolean" && typeof s.notificationPrefs === "object" && s.roleMatrix?.length === 3, "shape");
    expectError(await put("/vendor/settings", owner, { managerCanEditServices: s.managerCanEditServices }), 422, "reason");
    expectError(await put("/vendor/settings", owner, { reason: "QA nothing" }), 422);
    expectError(await put("/vendor/settings", owner, { reason: "QA email", business: { name: s.business.name, phone: s.business.phone, email: "not-an-email" } }), 422, "email");
    expectError(await put("/vendor/settings", owner, { reason: "QA name", business: { name: { ar: "x" }, phone: s.business.phone, email: s.business.email } }), 422, "name.ar");
  });
  await t(A, "settings: XSS business name stored verbatim, restored", async () => {
    const s = expectOk(await get("/vendor/settings", owner)).data;
    const biz = { name: s.business.name, phone: s.business.phone, email: s.business.email };
    try {
      const evil = `<img src=x onerror=alert(1)> QA ${RUN}`;
      expectOk(await put("/vendor/settings", owner, { reason: "QA xss", business: { ...biz, name: { ar: evil, en: s.business.name.en } } }));
      const after = expectOk(await get("/vendor/settings", owner)).data;
      check(after.business.name.ar === evil, `stored=${after.business.name.ar}`);
    } finally {
      expectOk(await put("/vendor/settings", owner, { reason: "QA restore", business: biz }), "restore business");
    }
    const back = expectOk(await get("/vendor/settings", owner)).data;
    check(back.business.name.ar === s.business.name.ar && back.business.phone === s.business.phone, `restore mismatch name=${back.business.name.ar} phone=${back.business.phone}`);
  });
  await t(A, "settings: contact phone format validated", async () => {
    const s = expectOk(await get("/vendor/settings", owner)).data;
    const biz = { name: s.business.name, phone: s.business.phone, email: s.business.email };
    let r;
    try {
      r = await put("/vendor/settings", owner, { reason: "QA phone", business: { ...biz, phone: "call me maybe" } });
    } finally {
      expectOk(await put("/vendor/settings", owner, { reason: "QA restore", business: biz }), "restore");
    }
    expectError(r, 422);
  }, { severity: "Low" });
  await t(A, "settings: unknown notificationPrefs keys are not persisted", async () => {
    const s = expectOk(await get("/vendor/settings", owner)).data;
    let stored;
    try {
      expectOk(await put("/vendor/settings", owner, { reason: "QA prefs", notificationPrefs: { ...s.notificationPrefs, qa_unknown_key: true, new_booking: "yes" } }));
      stored = expectOk(await get("/vendor/settings", owner)).data.notificationPrefs;
    } finally {
      expectOk(await put("/vendor/settings", owner, { reason: "QA restore", notificationPrefs: s.notificationPrefs }), "restore prefs");
    }
    const bad = [];
    if ("qa_unknown_key" in stored) bad.push("unknown key qa_unknown_key persisted");
    const nonBool = Object.entries(stored).filter(([, v]) => typeof v !== "boolean");
    if (nonBool.length) bad.push(`non-boolean values persisted: ${JSON.stringify(Object.fromEntries(nonBool))}`);
    check(!bad.length, bad.join("; "));
  }, { severity: "Low" });
}

async function teamArea() {
  const A = "5-Team";
  const { owner, adel } = ctx.tokens;
  await t(A, "staff POST validation (422/409/403)", async () => {
    const b = { branchId: "br_helio", role: "employee", name: "QA Employee", phone: phone("0127") };
    expectError(await post("/vendor/staff", owner, { ...b, phone: "123" }), 422, "phone");
    expectError(await post("/vendor/staff", owner, { ...b, phone: PHONES.employee }), 409, "phone");
    expectError(await post("/vendor/staff", owner, { ...b, name: "ab" }), 422, "name");
    expectError(await post("/vendor/staff", owner, { ...b, branchId: OTHER.branch }), 403);
    expectError(await post("/vendor/staff", adel, { ...b, branchId: "br_helio" }), 403);
  });
  await t(A, "owner adds employee: discount capped at 50, name stored verbatim; PATCH bounds; suspend", async () => {
    const name = `QA Emp <script>x</script> ${RUN}`;
    const r = expectOk(await post("/vendor/staff", owner, { branchId: "br_helio", role: "employee", name, phone: phone("0127"), maxDiscountPct: 80 }));
    const id = r.data.id;
    ctx.qaStaff = id;
    try {
      check(r.data.name === name && r.data.role === "employee" && r.data.maxDiscountPct === 50, `created ${JSON.stringify({ n: r.data.name, role: r.data.role, max: r.data.maxDiscountPct })}`);
      expectError(await patch(`/vendor/staff/${id}`, owner, { maxDiscountPct: 10 }), 422, "reason");
      expectError(await patch(`/vendor/staff/${id}`, owner, { maxDiscountPct: -1, reason: "QA bounds" }), 422, "maxDiscountPct");
      expectError(await patch(`/vendor/staff/${id}`, owner, { maxDiscountPct: 51, reason: "QA bounds" }), 422, "maxDiscountPct");
      expectError(await patch(`/vendor/staff/${id}`, owner, { branchId: OTHER.branch, reason: "QA move" }), 403);
      const ok1 = expectOk(await patch(`/vendor/staff/${id}`, owner, { maxDiscountPct: 50, permissions: { refund: true }, reason: "QA bounds" }));
      check(ok1.data.maxDiscountPct === 50 && ok1.data.permissions.refund === true, "patch not applied");
      expectError(await patch("/vendor/staff/st_owner_biz_carzen", owner, { maxDiscountPct: 5, reason: "QA" }), 403);
    } finally {
      expectOk(await post(`/vendor/staff/${id}/status`, owner, { active: false, reason: "QA cleanup" }), "suspend QA employee");
    }
  });
  await t(A, "negative maxDiscountPct on create is rejected or clamped to ≥ 0", async () => {
    const r = await post("/vendor/staff", owner, { branchId: "br_helio", role: "employee", name: `QA Neg ${RUN}`, phone: phone("0127"), maxDiscountPct: -5 });
    if (r.status === 200) await post(`/vendor/staff/${r.data.id}/status`, owner, { active: false, reason: "QA cleanup" });
    check(r.status === 422 || (r.status === 200 && r.data.maxDiscountPct >= 0), `created with maxDiscountPct=${r.data?.maxDiscountPct} (${r.status})`);
  }, { severity: "Low" });
  await t(A, "manager can only grant permissions he holds when adding an employee", async () => {
    const r = await post("/vendor/staff", adel, { branchId: "br_nasr", role: "employee", name: `QA Mgr-made ${RUN}`, phone: phone("0127"), maxDiscountPct: 90, permissions: { editServices: true, manageStaff: true, refund: true } });
    expectOk(r);
    await post(`/vendor/staff/${r.data.id}/status`, adel, { active: false, reason: "QA cleanup" });
    check(r.data.maxDiscountPct <= 20, `maxDiscountPct=${r.data.maxDiscountPct}`);
    check(r.data.permissions.editServices !== true, `manager (editServices=false) granted editServices=true to new employee ${r.data.id}`);
  }, { severity: "Medium" });
  await t(A, "staff schedule validation", async () => {
    const id = ctx.qaStaff;
    if (!id) skip("no QA staff");
    const bad = [];
    for (const [label, shifts, want] of [
      ["9:00 format", [{ start: "9:00", end: "17:00", days: [1] }], 422],
      ["end<start", [{ start: "17:00", end: "09:00", days: [1] }], 422],
      ["day 7", [{ start: "09:00", end: "17:00", days: [7] }], 422],
      ["days []", [{ start: "09:00", end: "17:00", days: [] }], 422],
      ["[null]", [null], 422],
      ["days ['x']", [{ start: "09:00", end: "17:00", days: ["x"] }], 422],
    ]) {
      const r = await put(`/vendor/staff/${id}/schedule`, owner, { shifts });
      if (r.status !== want) bad.push(`${label} → ${r.status}`);
    }
    expectOk(await put(`/vendor/staff/${id}/schedule`, owner, { shifts: [{ start: "10:00", end: "18:00", days: [1, 1, 2] }] }));
    check(!bad.length, bad.join("; "));
  }, { severity: "Low" });
  await t(A, "new manager can log in; suspension kills the session", async () => {
    const ph = phone("0127");
    const r = expectOk(await post("/vendor/staff", owner, { branchId: "br_helio", role: "manager", name: `QA Manager ${RUN}`, phone: ph }));
    try {
      const l = await login(ph);
      if (l.status !== 200) skip(`new staff cannot log in on this data source (${describe(l)}) — expected with real Supabase Auth`);
      const tok = l.data.access_token;
      expectOk(await get("/vendor/auth/me", tok));
      expectOk(await post(`/vendor/staff/${r.data.id}/status`, owner, { active: false, reason: "QA suspend" }));
      expectError(await get("/vendor/auth/me", tok), 401);
      expectError(await login(ph), 403);
    } finally {
      await post(`/vendor/staff/${r.data.id}/status`, owner, { active: false, reason: "QA cleanup" });
    }
  });
  await t(A, "staff status: reason required; owner account not suspendable", async () => {
    const id = ctx.qaStaff;
    if (!id) skip("no QA staff");
    expectError(await post(`/vendor/staff/${id}/status`, owner, { active: true }), 422, "reason");
    expectError(await post("/vendor/staff/st_owner_biz_carzen/status", owner, { active: false, reason: "QA" }), 404);
  });
  await t(A, "shift review: open shift → 409, note required, re-review keeps status", async () => {
    const list = expectOk(await get("/vendor/shifts?per_page=100", owner)).data;
    const open = list.find((s) => s.status === "open");
    const reviewed = list.find((s) => s.status === "reviewed");
    if (open) expectError(await post(`/vendor/shifts/${open.id}/review`, owner, { status: "reviewed", note: "QA" }), 409);
    if (!reviewed) skip("no reviewed shift");
    expectError(await post(`/vendor/shifts/${reviewed.id}/review`, owner, { status: "reviewed" }), 422, "note");
    const r = expectOk(await post(`/vendor/shifts/${reviewed.id}/review`, owner, { status: "reviewed", note: `QA re-review ${RUN}` }));
    check(r.data.status === "reviewed", `status=${r.data.status}`);
    const d = expectOk(await get(`/vendor/shifts/${reviewed.id}`, owner)).data;
    check(d.shift.id === reviewed.id && Array.isArray(d.orders), "shift details shape");
  });
  await t(A, "reviews: reply validation, one reply only, XSS stored as text", async () => {
    const list = expectOk(await get("/vendor/reviews?replied=no&per_page=50", owner)).data;
    const rv = list[0];
    if (!rv) skip("no unreplied review left");
    expectError(await post(`/vendor/reviews/${rv.id}/reply`, owner, { text: "abc" }), 422, "text");
    expectError(await post(`/vendor/reviews/${rv.id}/reply`, owner, { text: "x".repeat(401) }), 422);
    const txt = `<script>alert(1)</script> شكرًا QA ${RUN}`;
    const r = expectOk(await post(`/vendor/reviews/${rv.id}/reply`, owner, { text: txt }));
    check(r.data.reply === txt, "reply not verbatim");
    expectError(await post(`/vendor/reviews/${rv.id}/reply`, owner, { text: "second reply QA" }), 409);
  });
  await t(A, "reviews: report validation / already reported → 409", async () => {
    const list = expectOk(await get("/vendor/reviews?per_page=100", owner)).data;
    const any = list.find((r) => !r.reportedByWash);
    if (any) expectError(await post(`/vendor/reviews/${any.id}/report`, owner, { reason: "abc" }), 422, "reason");
    const rep = list.find((r) => r.reportedByWash);
    if (rep) expectError(await post(`/vendor/reviews/${rep.id}/report`, owner, { reason: "QA again please" }), 409);
    expectError(await post("/vendor/reviews/rv_nope/reply", owner, { text: "QA hello there" }), 404);
    if (!any && !rep) skip("no reviews");
  });
  await t(A, "notifications: unknown id → 404, read-all ok", async () => {
    expectError(await post("/vendor/notifications/vn_nope/read", owner, {}), 404);
    expectOk(await post("/vendor/notifications/read-all", ctx.tokens.tamer, {}));
  });
}

// ════════════════════════════════════════════════════════════
// 6. SUSPENDED WASH
async function suspendArea() {
  const A = "6-Suspend";
  const { owner, adel } = ctx.tokens;
  await t(A, "vendor app also serves the admin namespace (/api/v1/admin/*)", async () => {
    const r = await post("/admin/auth/login", undefined, ADMIN);
    check(r.status === 404, `admin login reachable on the partner portal: ${describe(r)}`);
  }, { severity: "Medium" });
  let adm;
  try {
    adm = await adminToken();
  } catch {
    adm = null;
  }
  if (!adm) {
    await t(A, "suspension flow", async () => skip("no admin token"));
    return;
  }
  const w = await get("/admin/washes/biz_carzen", adm);
  const status = w.data?.business?.status ?? w.data?.status;
  if (status !== "active") {
    await t(A, "suspension flow", async () => skip(`biz_carzen status is ${status} (${w.status}) — not touching it`));
    return;
  }
  const existing = ctx.createdOrders.at(-1);
  let suspended = false;
  try {
    await t(A, "admin suspends biz_carzen (setup)", async () => {
      expectError(await post("/admin/washes/biz_carzen/suspend", owner, { reason: "operational_issue", note: "QA" }), 401);
      expectOk(await post("/admin/washes/biz_carzen/suspend", adm, { reason: "operational_issue", note: `QA suspension test ${RUN}`, cancelUpcoming: false }));
      suspended = true;
    });
    if (!suspended) return;
    await t(A, "vendor reads keep working while suspended; me.businessStatus=suspended", async () => {
      const me = expectOk(await get("/vendor/auth/me", owner)).data;
      check(me.businessStatus === "suspended" && typeof me.businessStatusReason === "string", `status=${me.businessStatus} reason=${me.businessStatusReason}`);
      for (const p of ["/vendor/dashboard", "/vendor/orders", "/vendor/live?branchId=br_nasr", "/vendor/services", "/vendor/finance", "/vendor/notifications"]) expectOk(await get(p, owner));
    });
    await t(A, "login still allowed while suspended", async () => {
      expectOk(await login(PHONES.adel));
    });
    await t(A, "new walk-in / phone orders → 423 with message", async () => {
      const r = expectError(await post("/vendor/orders", owner, { source: "walk_in", branchId: "br_nasr", plate: plate(), serviceIds: [svcId("br_nasr", "ext")] }), 423);
      check(/معلّقة|معلقة/.test(r.message), `message=${r.message}`);
      expectError(await post("/vendor/orders", adel, { source: "walk_in", branchId: "br_nasr", plate: plate(), serviceIds: [svcId("br_nasr", "ext")] }), 423);
      expectError(await post("/vendor/orders", owner, { source: "phone", branchId: "br_nasr", plate: plate(), serviceIds: [svcId("br_nasr", "ext")], customerPhone: phone(), scheduledAt: addDays(1, 14).toISOString() }), 423);
    });
    await t(A, "existing orders can still be annotated while suspended", async () => {
      if (!existing) skip("no order");
      expectOk(await act(owner, existing, "note", { text: "QA note while suspended" }));
    });
  } finally {
    if (suspended) {
      await t(A, "admin reactivates biz_carzen (restore)", async () => {
        let r;
        for (let i = 0; i < 3; i += 1) {
          r = await post("/admin/washes/biz_carzen/reactivate", adm, { note: `QA restore ${RUN}` });
          if (r.status === 200) break;
        }
        expectOk(r, "REACTIVATE FAILED — biz_carzen may still be suspended!");
        const me = expectOk(await get("/vendor/auth/me", owner)).data;
        check(me.businessStatus === "active", `status after restore=${me.businessStatus}`);
      });
    }
  }
}

// ════════════════════════════════════════════════════════════
// 7. DAY CLOSING
async function dayClosingArea() {
  const A = "7-DayClose";
  const { owner, adel } = ctx.tokens;
  const LB = ctx.LB;
  await t(A, "GET summary shape (today)", async () => {
    const d = expectOk(await get(`/vendor/day-closing?branchId=${LB}`, owner)).data;
    for (const k of ["branchId", "date", "completedOrders", "expected", "inServiceOrders", "unpaidOrders", "orders", "history"]) check(k in d, `missing ${k}`);
    check(d.date === TODAY && d.branchId === LB, `date=${d.date} branch=${d.branchId}`);
    for (const k of ["cash", "card", "online", "total"]) check(typeof d.expected[k] === "number", `expected.${k}`);
  });
  await t(A, "closing today is blocked while orders are open/unpaid → 409 (no real closing)", async () => {
    const o = await mustWalkIn(owner, LB, [svcId(LB, "ext")]); // guaranteed blocker (waiting, today)
    try {
      const sum = expectOk(await get(`/vendor/day-closing?branchId=${LB}`, owner)).data;
      check(sum.inServiceOrders >= 1, "our waiting order is not counted");
      if (sum.closing) skip("today already closed for this branch");
      const r = expectError(await post("/vendor/day-closing", owner, { branchId: LB, date: TODAY, actual: { cash: 0, card: 0, online: 0 } }), 409);
      check(r.message.includes(o.number) || /لا يمكن الإغلاق/.test(r.message), `message=${r.message}`);
    } finally {
      await act(owner, o.id, "cancel", { reason: "QA cleanup day closing" });
    }
  });
  await t(A, "manager cannot read/close another branch → 403", async () => {
    expectError(await get("/vendor/day-closing?branchId=br_helio", adel), 403);
    expectError(await post("/vendor/day-closing", adel, { branchId: "br_helio", date: "2001-01-03" }), 403);
  });
  await t(A, "difference without reason → 422 (past date)", async () => {
    const r = await post("/vendor/day-closing", owner, { branchId: LB, date: "2001-01-01", actual: { cash: 100 } });
    if (r.status === 409) return "2001-01-01 already closed by a previous run";
    expectError(r, 422, "reason");
  });
  await t(A, "close a past date (2001-01-01) → 200 first time, 409 afterwards", async () => {
    const r = await post("/vendor/day-closing", owner, { branchId: LB, date: "2001-01-01", actual: { cash: 0, card: 0, online: 0 } });
    expectStatus(r, [200, 409]);
    if (r.status === 200) check(r.data.ordersLocked === 0 && r.data.date === "2001-01-01", JSON.stringify(r.data));
    const again = await post("/vendor/day-closing", owner, { branchId: LB, date: "2001-01-01", actual: {} });
    expectError(again, 409);
  });
  await t(A, "invalid date (2000-13-45) → 422", async () => {
    const r = await post("/vendor/day-closing", owner, { branchId: LB, date: "2000-13-45", actual: {} });
    check(r.status === 422, `invalid date accepted: ${describe(r)}${r.status === 409 ? " (a closing for this invalid date already exists)" : ""}`);
  }, { severity: "Medium" });
  await t(A, "future date (2099-12-31) cannot be closed", async () => {
    const r = await post("/vendor/day-closing", owner, { branchId: LB, date: "2099-12-31", actual: {} });
    check(r.status === 422 || (r.status === 409 && !/مسبقًا/.test(r.message)), `future day accepted: ${describe(r)}`);
  }, { severity: "Medium" });
  await t(A, "employee-level permission: closeShift required (owner/manager have it)", async () => {
    const me = expectOk(await get("/vendor/auth/me", adel)).data;
    check(me.permissions.closeShift === true, "manager lacks closeShift");
  });
}

// ════════════════════════════════════════════════════════════
// 8. ROBUSTNESS / INJECTION
async function robustArea() {
  const A = "8-Robust";
  const { owner } = ctx.tokens;
  const baseline = expectOk(await get("/vendor/orders?tab=all&per_page=1", owner)).json.pagination.total;
  const noMatch = ["'; drop table orders;--", "' OR '1'='1", "\" OR 1=1 --", "%", "_", "\\", "%%", "') OR ('a'='a", "1; SELECT pg_sleep(5)--", "${7*7}", "{{7*7}}", "<script>alert(1)</script>"];
  const odd = ["محمد", "كارزن", "😀🚗", "x".repeat(5000), "\u0000", "a\u0000b", "￿", "%00", "Ω≈ç√"];

  await t(A, "search injection strings on /vendor/orders → 200, 0 rows, no data leak", async () => {
    const bad = [];
    for (const q of noMatch) {
      const r = await get(`/vendor/orders?tab=all&search=${enc(q)}`, owner);
      if (r.status !== 200) bad.push(`${JSON.stringify(q)} → ${r.status}`);
      else if (r.json.pagination.total !== 0) bad.push(`${JSON.stringify(q)} matched ${r.json.pagination.total} rows`);
      if (r.ms > 4000) bad.push(`${JSON.stringify(q)} took ${r.ms}ms`);
    }
    check(!bad.length, bad.join("; "));
    const after = expectOk(await get("/vendor/orders?tab=all&per_page=1", owner)).json.pagination.total;
    check(after >= baseline, `orders count dropped ${baseline} → ${after}`);
  }, { severity: "High" });
  await t(A, "unicode / NUL / very long search strings never 500", async () => {
    const bad = [];
    for (const q of odd) {
      for (const p of [`/vendor/orders?tab=all&search=${enc(q)}`, `/vendor/customers?search=${enc(q)}`, `/vendor/search?q=${enc(q)}`]) {
        const r = await get(p, owner);
        if (r.status >= 500 || r.status === 0) bad.push(`${p.split("?")[0]} ${JSON.stringify(q.slice(0, 12))}${q.length > 12 ? "…" : ""} → ${r.status}`);
      }
    }
    check(!bad.length, bad.join("; "));
  }, { severity: "Medium" });
  await t(A, "search injection on every list endpoint → no 500, no extra rows", async () => {
    const eps = ["/vendor/customers?", "/vendor/staff?", "/vendor/reviews?", "/vendor/audit?", "/vendor/services?", "/vendor/offers?"];
    const bad = [];
    for (const ep of eps) {
      for (const q of ["'; drop table orders;--", "' OR '1'='1", "%", "_"]) {
        const r = await get(`${ep}search=${enc(q)}`, owner);
        if (r.status !== 200) bad.push(`${ep}${q} → ${r.status}`);
        else if (Array.isArray(r.data) && r.data.length) {
          // A row may only match if it literally contains the term (wildcards must be escaped).
          const literal = q === "%" || q === "_";
          const offending = r.data.filter((row) => !literal || !JSON.stringify(row).includes(q));
          if (offending.length) bad.push(`${ep}search=${q} returned ${offending.length} non-matching rows`);
        }
      }
    }
    const s = await get(`/vendor/search?q=${enc("' OR '1'='1")}`, owner);
    if (s.status !== 200 || s.data.results.length) bad.push(`/vendor/search → ${s.status} ${s.data?.results?.length} results`);
    check(!bad.length, bad.join("; "));
  }, { severity: "High" });
  await t(A, "injection in path ids → 404, never 500", async () => {
    const ids = ["' OR '1'='1", "1; drop table orders", "../../admin/washes", "%", "*", "x".repeat(3000), "ord_\u0000", "CZ-%"];
    const bad = [];
    for (const id of ids) {
      for (const [m, p, b] of [["GET", `/vendor/orders/${enc(id)}`], ["GET", `/vendor/customers/${enc(id)}`], ["GET", `/vendor/shifts/${enc(id)}`], ["POST", `/vendor/orders/${enc(id)}/actions`, { action: "note", text: "QA" }], ["DELETE", `/vendor/schedule/blocks/${enc(id)}`], ["POST", `/vendor/notifications/${enc(id)}/read`, {}]]) {
        const r = await call(m, p, { token: owner, body: b });
        if (r.status !== 404) bad.push(`${m} ${p.split("/").slice(0, 3).join("/")}/${JSON.stringify(id.slice(0, 15))} → ${r.status}`);
      }
    }
    check(!bad.length, bad.join("; "));
  }, { severity: "Medium" });
  await t(A, "sort/order params: injection & unknown keys ignored (200)", async () => {
    const bad = [];
    for (const [s, o] of [["total;drop table orders", "asc"], ["unknown_col", "desc"], ["scheduledAt", "asc;--"], ["(select 1)", "desc nulls first"], ["__proto__", "asc"], ["constructor", "desc"]]) {
      for (const ep of ["/vendor/orders?tab=all&", "/vendor/customers?", "/vendor/staff?", "/vendor/reviews?"]) {
        const r = await get(`${ep}sort=${enc(s)}&order=${enc(o)}`, owner);
        if (r.status !== 200) bad.push(`${ep}sort=${s} → ${r.status}`);
      }
    }
    check(!bad.length, bad.join("; "));
  });
  await t(A, "pagination clamps (huge per_page, negative/huge/NaN page)", async () => {
    const p = async (qs) => expectOk(await get(`/vendor/orders?tab=all&${qs}`, owner)).json.pagination;
    const a = await p("per_page=1000000");
    check(a.per_page === 100, `per_page=${a.per_page}`);
    const b = await p("per_page=-5");
    check(b.per_page === 1, `per_page(-5)=${b.per_page}`);
    const c = await p("page=-1");
    check(c.current_page === 1, `page(-1)=${c.current_page}`);
    const d = await p("page=99999999");
    check(d.current_page === d.last_page, `page(huge)=${d.current_page} last=${d.last_page}`);
    const e = await p("page=abc&per_page=abc");
    check(e.current_page === 1 && e.per_page === 15, `NaN → ${e.current_page}/${e.per_page}`);
    const f = await p("per_page=0");
    check(f.per_page === 1, `per_page(0)=${f.per_page}`);
  });
  await t(A, "invalid date query params never 500", async () => {
    const bad = [];
    for (const p of [
      "/vendor/schedule?branchId=br_nasr&date=garbage", "/vendor/availability?branchId=br_nasr&date=garbage", "/vendor/reports?from=garbage",
      "/vendor/reports?to=garbage", "/vendor/audit?from=garbage", "/vendor/audit?to=2026-99-99", "/vendor/orders?tab=all&date=garbage",
      "/vendor/day-closing?branchId=br_nasr&date=garbage", "/vendor/schedule?branchId=br_nasr&date=2026-02-31", "/vendor/dashboard?period=garbage",
      "/vendor/finance?period=garbage", "/vendor/staff?period=garbage", "/vendor/reports?type=garbage",
    ]) {
      const r = await get(p, owner);
      if (r.status >= 500 || r.status === 0) bad.push(`${p} → ${r.status}`);
    }
    check(!bad.length, bad.join("; "));
  }, { severity: "Medium" });
  await t(A, "report range validation (to<from, > 92 days) → 422", async () => {
    expectError(await get("/vendor/reports?from=2026-10-10&to=2026-10-01", owner), 422);
    expectError(await get("/vendor/reports?from=2026-01-01&to=2026-12-31", owner), 422);
    expectOk(await get("/vendor/reports?type=revenue&from=2026-10-01&to=2026-10-15", owner));
  });
  await t(A, "invalid JSON / non-object bodies → 4xx (not 500)", async () => {
    const bad = [];
    for (const [p, raw] of [["/vendor/orders", "{not json"], ["/vendor/orders", "null"], ["/vendor/orders", "[1,2,3]"], ["/vendor/orders", '"string"'], ["/vendor/auth/login", "{bad"], ["/vendor/day-closing", "]["], ["/vendor/orders/bulk-confirm", "{"]]) {
      const r = await call("POST", p, { token: p.includes("login") ? undefined : owner, raw });
      if (r.status >= 500 || r.status < 400) bad.push(`${p} ${raw} → ${r.status}`);
    }
    check(!bad.length, bad.join("; "));
  });
  await t(A, "wrong HTTP methods → 404/405 JSON (not 500)", async () => {
    const bad = [];
    const statuses = [];
    for (const [m, p] of [["PUT", "/vendor/orders"], ["DELETE", "/vendor/auth/me"], ["GET", "/vendor/auth/login"], ["PATCH", "/vendor/orders/x/actions"], ["DELETE", "/vendor/settings"], ["GET", "/vendor/orders/bulk-confirm/x"]]) {
      const r = await call(m, p, { token: owner, body: m === "GET" || m === "DELETE" ? undefined : {} });
      statuses.push(`${m} ${p}=${r.status}`);
      if (![404, 405].includes(r.status) || !r.json) bad.push(`${m} ${p} → ${r.status}`);
    }
    for (const m of ["OPTIONS", "HEAD"]) {
      const r = await call(m, "/vendor/orders", { token: owner });
      statuses.push(`${m}=${r.status}`);
      if (r.status >= 500) bad.push(`${m} → ${r.status}`);
    }
    check(!bad.length, bad.join("; "));
    return statuses.join(", ");
  });
  await t(A, "unknown route / encoded traversal → 404 envelope", async () => {
    expectError(await get("/vendor/does-not-exist", owner), 404);
    const r = await call("GET", `${BASE}/api/v1/vendor/..%2f..%2fadmin%2fwashes`, { token: owner });
    check(r.status === 404, `traversal → ${r.status}`);
  });
  await t(A, "very large request bodies are rejected (expect 413) and never 500", async () => {
    const big = JSON.stringify({ phone: PHONES.owner, password: "wrong", pad: "x".repeat(8 * 1024 * 1024) });
    const r = await call("POST", "/vendor/auth/login", { raw: big, timeout: 120000 });
    check(r.status !== 0 && r.status < 500, `8 MB login body → ${r.status} (${r.ms}ms)`);
    check(r.status === 413, `8 MB body accepted and parsed (→ ${r.status} in ${r.ms}ms); no request size limit`);
  }, { severity: "Low" });
  await t(A, "API responses are JSON (application/json) so stored HTML is inert", async () => {
    const r = await get("/vendor/auth/me", owner);
    check((r.headers.get("content-type") ?? "").startsWith("application/json"), `content-type=${r.headers.get("content-type")}`);
  });
}

// ════════════════════════════════════════════════════════════
// 9. SECURITY HEADERS & BEHAVIOUR
async function headersArea() {
  const A = "9-Security";
  const { owner } = ctx.tokens;
  const api = await get("/vendor/auth/me", owner);
  const page = await call("GET", `${BASE}/dashboard`);
  const loginPage = await call("GET", `${BASE}/login`);
  const H2 = (r, h) => r.headers.get(h);
  const hdrCheck = (label, fn, sev = "Low") => t(A, label, async () => {
    const miss = [];
    for (const [name, r] of [["API", api], ["/dashboard", page], ["/login", loginPage]]) {
      const why = fn(r);
      if (why) miss.push(`${name}: ${why}`);
    }
    check(!miss.length, miss.join("; "));
  }, { severity: sev });

  await hdrCheck("X-Content-Type-Options: nosniff", (r) => (H2(r, "x-content-type-options")?.toLowerCase() === "nosniff" ? null : `got ${H2(r, "x-content-type-options")}`));
  await hdrCheck("clickjacking protection (X-Frame-Options or CSP frame-ancestors)", (r) => (H2(r, "x-frame-options") || /frame-ancestors/.test(H2(r, "content-security-policy") ?? "") ? null : "none"), "Medium");
  await hdrCheck("Content-Security-Policy present", (r) => (H2(r, "content-security-policy") ? null : "none"), "Medium");
  await hdrCheck("Referrer-Policy present", (r) => (H2(r, "referrer-policy") ? null : "none"));
  await hdrCheck("Strict-Transport-Security present (relevant once served over HTTPS)", (r) => (H2(r, "strict-transport-security") ? null : "none"));
  await hdrCheck("Cache-Control: no-store on API and portal pages", (r) => (/no-store/.test(H2(r, "cache-control") ?? "") ? null : `got ${H2(r, "cache-control")}`));
  await hdrCheck("X-Powered-By not disclosed", (r) => (H2(r, "x-powered-by") ? `x-powered-by: ${H2(r, "x-powered-by")}` : null));
  await t(A, "CORS: foreign Origin not reflected / no wildcard", async () => {
    const r = await call("GET", "/vendor/auth/me", { token: owner, headers: { origin: "https://evil.example" } });
    const acao = r.headers.get("access-control-allow-origin");
    check(!acao || (acao !== "*" && acao !== "https://evil.example"), `ACAO=${acao}`);
  });
  await t(A, "error responses do not leak stack traces / file paths", async () => {
    const samples = [await get("/vendor/orders/nope", owner), await post("/vendor/orders", owner, { source: "x" }), await call("POST", "/vendor/orders", { token: owner, raw: "{" })];
    const leaks = [];
    for (const r of samples) if (/\bat \w+.*\(|\.tsx?:\d+|node_modules|webpack|Error: /.test(r.text)) leaks.push(`${describe(r)}: ${r.text.slice(0, 160)}`);
    for (const e of H.serverErrors) if (/\bat \w+.*\(|\.tsx?:\d+|node_modules|postgres|syntax error|relation /i.test(e.body)) leaks.push(`${e.method} ${e.path} (${e.status}): ${e.body.slice(0, 160)}`);
    check(!leaks.length, leaks.join(" | "));
  }, { severity: "Medium" });
  await t(A, "session tokens are long and unpredictable (≥128-bit random)", async () => {
    const a = expectOk(await login(PHONES.tamer)).data.access_token;
    const b = expectOk(await login(PHONES.tamer)).data.access_token;
    let common = 0;
    while (common < Math.min(a.length, b.length) && a[common] === b[common]) common += 1;
    const tailA = a.split("_").at(-1);
    const bits = tailA.length * Math.log2(/^[0-9a-f]+$/i.test(tailA) ? 16 : 36);
    await post("/vendor/auth/logout", a, {});
    await post("/vendor/auth/logout", b, {});
    check(bits >= 128, `token format ${a.replace(/[a-z0-9]/gi, (c, i) => (i < common ? c : "•"))}: shared prefix ${common} chars, random tail ≈${Math.round(bits)} bits`);
  }, { severity: "Medium" });
  await t(A, "sessions expire (token TTL advertised or enforced)", async () => {
    const r = expectOk(await login(PHONES.tamer));
    await post("/vendor/auth/logout", r.data.access_token, {});
    check("expires_in" in r.data || "expires_at" in r.data, `login response has no expires_in/expires_at: keys=${Object.keys(r.data)}`);
  }, { severity: "Low" });
  if (BRUTEFORCE) {
    await t(A, "login brute force (30 rapid wrong passwords) is rate-limited", async () => {
      const victim = PHONES.tamer;
      const codes = [];
      for (let batch = 0; batch < 3; batch += 1) {
        const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => login(victim, `wrong-${batch}-${i}`)));
        codes.push(...rs.map((r) => r.status));
      }
      const valid = await login(victim);
      if (valid.status === 200) await post("/vendor/auth/logout", valid.data.access_token, {});
      const hist = codes.reduce((m, c) => ({ ...m, [c]: (m[c] ?? 0) + 1 }), {});
      check(codes.includes(429), `no throttling: ${JSON.stringify(hist)}; correct password afterwards → ${valid.status}`);
      return JSON.stringify(hist);
    }, { severity: "High" });
  }
}

// ════════════════════════════════════════════════════════════
async function cleanup() {
  const owner = ctx.tokens.owner;
  if (!owner) return;
  let fixed = 0;
  for (const id of [...new Set(ctx.createdOrders)]) {
    const r = await get(`/vendor/orders/${id}`, owner);
    if (r.status !== 200) continue;
    const o = r.data.order;
    if (["pending", "confirmed", "waiting"].includes(o.status)) {
      await act(owner, id, "cancel", { reason: "QA suite cleanup" });
      fixed += 1;
    } else if (o.status === "in_service") {
      await act(owner, id, "complete", {});
      await act(owner, id, "collect_payment", { method: "card" });
      fixed += 1;
    } else if (o.status === "completed" && o.paymentStatus === "pending") {
      await act(owner, id, "collect_payment", { method: "card" });
      fixed += 1;
    }
  }
  if (fixed) console.log(`\ncleanup: closed ${fixed} leftover QA order(s)`);
  for (const k of ["owner", "adel", "tamer", "admin"]) {
    if (ctx.tokens[k]) await post(k === "admin" ? "/admin/auth/logout" : "/vendor/auth/logout", ctx.tokens[k], {});
  }
}

function report(startedAt) {
  const res = H.results;
  const by = {};
  for (const r of res) {
    by[r.area] ??= { pass: 0, fail: 0, skip: 0 };
    by[r.area][r.status] += 1;
  }
  const totals = res.reduce((m, r) => ({ ...m, [r.status]: (m[r.status] ?? 0) + 1 }), { pass: 0, fail: 0, skip: 0 });
  console.log(`\n${"─".repeat(60)}\nSummary (${MODE} @ ${BASE})`);
  console.table(Object.fromEntries(Object.entries(by).map(([a, c]) => [a, c])));
  console.log(`TOTAL ${res.length} cases: ${totals.pass} pass, ${totals.fail} fail, ${totals.skip} skip`);
  if (totals.fail) {
    console.log("\nFailures:");
    for (const r of res.filter((x) => x.status === "fail")) console.log(`  [${r.area}]${r.severity ? ` (${r.severity})` : ""} ${r.name}\n      ${r.detail}`);
  }
  if (H.serverErrors.length) {
    console.log(`\nHTTP 5xx responses observed (${H.serverErrors.length}):`);
    for (const e of H.serverErrors) console.log(`  ${e.status} ${e.method} ${e.path}  ← ${e.test}`);
  }
  const out = join(HERE, `results-${MODE}.json`);
  mkdirSync(HERE, { recursive: true });
  writeFileSync(out, JSON.stringify({ mode: MODE, base: BASE, run: RUN, startedAt, finishedAt: new Date().toISOString(), totals, byArea: by, results: res, serverErrors: H.serverErrors }, null, 2));
  console.log(`\nresults written to ${out}`);
  return totals;
}

async function main() {
  const startedAt = new Date().toISOString();
  try {
    await setup();
    await smokeArea();
    await authArea();
    await authzArea();
    await ordersArea();
    await pricingArea();
    await catalogArea();
    await teamArea();
    await suspendArea();
    await dayClosingArea();
    await robustArea();
    await headersArea();
  } catch (e) {
    console.error("\nSUITE ABORTED:", e);
    H.results.push({ area: "0-Setup", name: "suite aborted", status: "fail", detail: String(e?.message ?? e), obs: [], ms: 0 });
  } finally {
    await cleanup().catch((e) => console.error("cleanup error", e));
  }
  const totals = report(startedAt);
  process.exitCode = totals.fail ? 1 : 0;
}

main();
