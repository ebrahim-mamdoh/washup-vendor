// Vendor API robustness + rules check (malformed input never 500, scopes, validation, discount cap, security headers).
// Usage: node qa/api-check/robustness.mjs <base> <ownerPhone> <ownerPass> [managerPhone managerPass] [--throttle]
// Writes: with a manager, one walk-in (cancelled at the end) and one test employee. --throttle locks logins from this IP for 5 min.
const [base, ownerPhone, ownerPass, mgrPhone, mgrPass] = process.argv.slice(2);
const API = `${base}/api/v1`;
const results = [];
const check = (name, cond, detail = "") => results.push(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  -> " + detail}`);

async function call(method, path, token, body) {
  const res = await fetch(API + path, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}
async function login(phone, password) {
  const r = await call("POST", "/vendor/auth/login", null, { phone, password });
  if (r.status !== 200) throw new Error(`login ${phone} -> ${r.status} ${r.json?.message}`);
  return r.json.data;
}

const owner = await login(ownerPhone, ownerPass);
const T = owner.access_token;
const branch = owner.account.branches[0].id;
console.log("owner:", owner.account.name, "branches:", owner.account.branches.map((b) => b.id).join(","));

// ── 500s → 4xx ──
for (const p of ["/vendor/orders/%25", "/vendor/customers/CZ-%25", "/vendor/shifts/ord_%00"]) {
  const r = await call("GET", p, T);
  check(`GET ${p} → 404`, r.status === 404, r.status);
}
for (const p of ["/vendor/orders?tab=all&sort=__proto__", "/vendor/customers?sort=constructor", "/vendor/staff?sort=__proto__", "/vendor/reviews?sort=__proto__"]) {
  const r = await call("GET", p, T);
  check(`GET ${p} → 200`, r.status === 200, r.status);
}
for (const p of ["/vendor/orders?tab=all&search=a%00b", "/vendor/customers?search=%00", "/vendor/search?q=a%00b"]) {
  const r = await call("GET", p, T);
  check(`GET ${p} → not 500`, r.status < 500, r.status);
}
for (const p of [`/vendor/schedule?branchId=${branch}&date=garbage`, `/vendor/availability?branchId=${branch}&date=garbage`, "/vendor/reports?from=garbage", "/vendor/audit?to=2026-99-99"]) {
  const r = await call("GET", p, T);
  check(`GET ${p} → 4xx`, r.status >= 400 && r.status < 500, r.status);
}
{
  const r = await call("POST", "/vendor/orders", T, { source: "walk_in", branchId: branch, plate: 12345, serviceIds: ["x"] });
  check("create order with numeric plate → 422", r.status === 422, `${r.status} ${r.json?.message}`);
}
{
  const r = await call("POST", "/admin/auth/login", null, { email: "a@b.c", password: "x" });
  check("admin namespace hidden → 404", r.status === 404, r.status);
}

// ── Recognition ──
{
  const r = await call("GET", "/vendor/recognize?plate=JBL131", T);
  const c = r.json?.data?.customer;
  check("recognize never returns status/statusReason", !c || (c.statusReason === null && c.status === "active"), JSON.stringify(c));
}

// ── Booking rules / validation ──
{
  const r = await call("PATCH", `/vendor/branches/${branch}`, T, { reason: "qa test", name: { ar: "x" }, address: { ar: "xxx" }, capacity: 3, workingHours: Array(7).fill(null) });
  check("branch hours [null×7] → 422", r.status === 422, `${r.status} ${r.json?.message}`);
}
{
  const r = await call("PUT", `/vendor/branches/${branch}/settings`, T, { reason: "qa test", settings: { slotIntervalMin: 7, leadTimeMin: 30, maxAdvanceDays: 7, freeCancelMin: 60, noShowGraceMin: 15, reminderMin: 60 } });
  check("slotInterval 7 → 422", r.status === 422, `${r.status} ${r.json?.message}`);
}
{
  const r = await call("PUT", "/vendor/settings", T, { reason: "qa test", notificationPrefs: { qa_unknown_key: true } });
  check("unknown notification pref → 422", r.status === 422, `${r.status} ${r.json?.message}`);
}
{
  const r = await call("POST", "/vendor/day-closing", T, { branchId: branch, date: "2099-12-31", actual: {} });
  check("close future day → 422", r.status === 422, `${r.status} ${r.json?.message}`);
}
{
  const staff = await call("GET", `/vendor/staff?branchId=${branch}`, T);
  const emp = staff.json?.data?.find((s) => s.role !== "owner");
  if (emp) {
    const r = await call("PUT", `/vendor/staff/${emp.id}/schedule`, T, { shifts: [null] });
    check("staff schedule [null] → 422", r.status === 422, `${r.status} ${r.json?.message}`);
  }
}
{
  const branches = await call("GET", "/vendor/branches", T);
  const b = branches.json.data.find((x) => x.id === branch);
  const far = new Date(Date.now() + (b.settings.maxAdvanceDays + 5) * 86400000);
  const day = `${far.getFullYear()}-${String(far.getMonth() + 1).padStart(2, "0")}-${String(far.getDate()).padStart(2, "0")}`;
  const r = await call("GET", `/vendor/availability?branchId=${branch}&date=${day}`, T);
  check(`availability beyond maxAdvanceDays (${b.settings.maxAdvanceDays}) → empty`, r.status === 200 && r.json.data.length === 0, `${r.status} ${r.json?.data?.length}`);
}

// ── Discount stacking (manager, repeated discounts) ──
if (mgrPhone) {
  const mgr = await login(mgrPhone, mgrPass);
  const M = mgr.access_token;
  const mb = mgr.account.homeBranchId;
  const services = await call("GET", `/vendor/services?branchId=${mb}`, M);
  const primary = services.json.data.find((s) => s.type === "primary" && s.active);
  const plate = `QA${Math.floor(Math.random() * 9000 + 1000)}`;
  const created = await call("POST", "/vendor/orders", M, { source: "walk_in", branchId: mb, plate, serviceIds: [primary.id] });
  check("manager creates walk-in", created.status === 200, `${created.status} ${created.json?.message}`);
  if (created.status === 200) {
    const o = created.json.data;
    const offer = o.discount?.amount ?? 0;
    const pct = mgr.account.maxDiscountPct;
    let last;
    for (let i = 0; i < 3; i++) last = await call("POST", `/vendor/orders/${o.id}/actions`, M, { action: "discount", discountType: "percent", discountValue: pct, reason: "qa discount" });
    const floor = o.subtotal - offer - Math.round((o.subtotal * pct) / 100);
    check(`3× ${pct}% discounts stay at offer+cap (total ${last.json?.data?.total}, expected ${floor})`, last.json?.data?.total === floor, JSON.stringify(last.json?.data?.discount));
    await call("POST", `/vendor/orders/${o.id}/actions`, M, { action: "cancel", reason: "qa cleanup" });
  }
  // Manager can't grant permissions he lacks
  if (!mgr.account.permissions.editServices) {
    const phone = `015${Math.floor(Math.random() * 9e7 + 1e7)}`;
    const r = await call("POST", "/vendor/staff", M, { branchId: mb, name: "QA Employee", phone, role: "employee", permissions: { editServices: true } });
    check("manager grant capped (editServices stays false)", r.status === 200 && r.json.data.permissions.editServices === false, `${r.status} ${JSON.stringify(r.json?.data?.permissions)}`);
  }
}

if (process.argv.includes("--throttle")) {
  const codes = [];
  for (let i = 0; i < 12; i++) codes.push((await call("POST", "/vendor/auth/login", null, { phone: "01299999999", password: "wrong" })).status);
  check("login throttled after 10 attempts", codes.includes(429), codes.join(","));
}

{
  const res = await fetch(`${base}/login`);
  check("security headers on /login", res.headers.get("x-frame-options") === "DENY" && res.headers.get("x-content-type-options") === "nosniff" && !res.headers.get("x-powered-by"), [...res.headers.keys()].join(","));
}

console.log(results.join("\n"));
console.log(`\n${results.filter((r) => r.startsWith("PASS")).length}/${results.length} passed`);
