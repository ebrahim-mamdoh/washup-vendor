// Full order lifecycle + every write route the portal uses, on one clearly-marked test order.
// Usage: node qa/api-check/flows.mjs <base> <ownerPhone> <pass> <managerPhone> <pass>
// Writes test data: a walk-in (paid then refunded), a phone booking (cancelled), a draft offer (disabled),
// a block/unblock, unchanged saves of settings, booking rules, a branch, a service and a staff schedule.
const [base, ownerPhone, ownerPass, mgrPhone, mgrPass] = process.argv.slice(2);
const API = `${base}/api/v1`;
const out = [];
const log = (ok, name, detail = "") => out.push(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
async function call(method, path, token, body) {
  const res = await fetch(API + path, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json, msg: json?.message };
}
const step = async (name, method, path, token, body, expect = 200) => {
  const r = await call(method, path, token, body);
  log(r.status === expect, name, r.status === expect ? r.msg : `${r.status} ${r.msg}`);
  return r;
};
const login = async (p, pw) => (await call("POST", "/vendor/auth/login", null, { phone: p, password: pw })).json.data;

const owner = await login(ownerPhone, ownerPass);
const mgr = await login(mgrPhone, mgrPass);
const O = owner.access_token, M = mgr.access_token;
const br = mgr.account.homeBranchId;

// Reads used by every screen (owner, all branches + one branch)
for (const p of ["/vendor/auth/me", "/vendor/dashboard?branchId=all&period=today", "/vendor/dashboard?branchId=all&period=7d", "/vendor/dashboard?branchId=all&period=30d",
  `/vendor/live?branchId=${br}`, "/vendor/orders?view=bookings&tab=today", "/vendor/orders?view=bookings&tab=upcoming", "/vendor/orders?tab=active", "/vendor/orders?tab=all&page=2",
  `/vendor/schedule?branchId=${br}`, `/vendor/services?branchId=all`, "/vendor/offers?branchId=all", "/vendor/staff?branchId=all", "/vendor/shifts?branchId=all",
  `/vendor/day-closing?branchId=${br}`, "/vendor/customers?branchId=all", "/vendor/reviews?branchId=all", "/vendor/finance?branchId=all&period=30d",
  "/vendor/reports?type=orders", "/vendor/reports?type=revenue", "/vendor/reports?type=services", "/vendor/reports?type=source", "/vendor/reports?type=employees",
  "/vendor/branches", "/vendor/audit", "/vendor/notifications", "/vendor/settings", "/vendor/search?q=CZ"]) {
  const t0 = Date.now();
  const r = await call("GET", p, O);
  log(r.status === 200, `GET ${p} (${Date.now() - t0} ms)`, r.status === 200 ? "" : `${r.status} ${r.msg}`);
}

// Detail pages
const firstOrder = (await call("GET", "/vendor/orders?tab=all", O)).json.data[0];
await step("order details", "GET", `/vendor/orders/${firstOrder.id}`, O);
const cust = (await call("GET", "/vendor/customers?branchId=all", O)).json.data[0];
if (cust) await step("customer details", "GET", `/vendor/customers/${cust.id}`, O);
const shift = (await call("GET", "/vendor/shifts?branchId=all", O)).json.data[0];
if (shift) await step("shift details", "GET", `/vendor/shifts/${shift.id}`, O);

// New order sheet: services → price preview → availability
const services = (await call("GET", `/vendor/services?branchId=${br}`, M)).json.data;
const primary = services.find((s) => s.type === "primary" && s.active);
const addon = services.find((s) => s.type === "addon" && s.active);
await step("price preview", "GET", `/vendor/price-preview?branchId=${br}&serviceIds=${primary.id}`, M);
await step("recognize plate", "GET", "/vendor/recognize?plate=QA0001", M);

// Walk-in with phone → full lifecycle
const created = await step("create walk-in (with phone)", "POST", "/vendor/orders", M, {
  source: "walk_in", branchId: br, plate: "QA 0001", customerPhone: "01099990001", customerName: "اختبار QA", vehicleMake: "Test", serviceIds: [primary.id], notes: "طلب اختبار من Claude — QA",
});
if (created.status === 200) {
  const id = created.json.data.id;
  console.log("test order:", created.json.data.number, id);
  const details = (await call("GET", `/vendor/orders/${id}`, M)).json.data;
  const staffId = details.assignableStaff[0]?.id;
  if (addon) await step("add add-on", "POST", `/vendor/orders/${id}/actions`, M, { action: "add_service", serviceId: addon.id });
  await step("note", "POST", `/vendor/orders/${id}/actions`, M, { action: "note", text: "ملاحظة اختبار" });
  await step("discount 10%", "POST", `/vendor/orders/${id}/actions`, M, { action: "discount", discountType: "percent", discountValue: 10, reason: "اختبار الخصم" });
  if (staffId) await step("assign", "POST", `/vendor/orders/${id}/actions`, M, { action: "assign", staffId });
  await step("start", "POST", `/vendor/orders/${id}/actions`, M, { action: "start", staffId });
  await step("complete", "POST", `/vendor/orders/${id}/actions`, M, { action: "complete" });
  const total = (await call("GET", `/vendor/orders/${id}`, M)).json.data.order.total;
  await step("collect cash (short) → 422", "POST", `/vendor/orders/${id}/actions`, M, { action: "collect_payment", method: "cash", amountReceived: total - 1 }, 422);
  await step("collect cash", "POST", `/vendor/orders/${id}/actions`, M, { action: "collect_payment", method: "cash", amountReceived: total + 50 });
  await step("refund", "POST", `/vendor/orders/${id}/actions`, M, { action: "refund", reason: "طلب اختبار — استرداد" });
}

// Phone booking: slot → create → cancel
const tomorrow = new Date(Date.now() + 86400000);
const day = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, "0")}-${String(tomorrow.getDate()).padStart(2, "0")}`;
const slots = (await call("GET", `/vendor/availability?branchId=${br}&date=${day}&serviceIds=${primary.id}`, M)).json.data ?? [];
const slot = slots.find((s) => !s.past && !s.blocked && s.free > 0);
log(Boolean(slot), `availability tomorrow (${slots.length} slots)`);
if (slot) {
  const ph = await step("create phone booking", "POST", "/vendor/orders", M, { source: "phone", branchId: br, plate: "QA 0002", customerPhone: "01099990001", serviceIds: [primary.id], scheduledAt: slot.start });
  if (ph.status === 200) await step("cancel booking", "POST", `/vendor/orders/${ph.json.data.id}/actions`, M, { action: "cancel", reason: "حجز اختبار — إلغاء" });
}

// Schedule block / unblock (tomorrow late evening)
const bs = new Date(tomorrow); bs.setHours(23, 0, 0, 0);
const be = new Date(bs.getTime() + 30 * 60000);
const block = await step("block slot", "POST", "/vendor/schedule/blocks", M, { branchId: br, start: bs.toISOString(), end: be.toISOString(), reason: "اختبار حجب" });
if (block.status === 200) await step("unblock slot", "DELETE", `/vendor/schedule/blocks/${block.json.data.id}`, M);

// Notifications
const notes = (await call("GET", "/vendor/notifications", M)).json.data;
if (notes[0]) await step("mark notification read", "POST", `/vendor/notifications/${notes[0].id}/read`, M);
await step("mark all read", "POST", "/vendor/notifications/read-all", M);

// Settings round trip (owner, same values)
const settings = (await call("GET", "/vendor/settings", O)).json.data;
await step("save notification prefs (unchanged)", "PUT", "/vendor/settings", O, { reason: "اختبار حفظ", notificationPrefs: settings.notificationPrefs });
const branches = (await call("GET", "/vendor/branches", O)).json.data;
const b = branches.find((x) => x.id === br);
await step("save booking rules (unchanged)", "PUT", `/vendor/branches/${br}/settings`, O, { reason: "اختبار حفظ", settings: b.settings });
await step("save branch (unchanged)", "PATCH", `/vendor/branches/${br}`, O, { reason: "اختبار حفظ", name: b.name, address: b.address, phone: b.phone, capacity: b.capacity, amenities: b.amenities, workingHours: b.workingHours, active: b.active });

// Services: save one unchanged
const svc = services[0];
await step("save service (unchanged, owner)", "PATCH", `/vendor/services/${svc.id}`, O, { ...svc, description: svc.description ?? { ar: "", en: "" } });

// Offers: create draft → edit → disable
const now = new Date();
const draft = await step("create offer draft", "POST", "/vendor/offers", O, { title: { ar: "عرض اختبار QA" }, discountType: "percent", discountValue: 5, startAt: now.toISOString(), endAt: new Date(now.getTime() + 86400000).toISOString(), branchIds: [br], publish: false });
if (draft.status === 200) {
  await step("edit offer", "PATCH", `/vendor/offers/${draft.json.data.id}`, O, { title: { ar: "عرض اختبار QA 2" }, discountType: "percent", discountValue: 6, startAt: now.toISOString(), endAt: new Date(now.getTime() + 86400000).toISOString(), branchIds: [br] });
  await step("disable offer", "POST", `/vendor/offers/${draft.json.data.id}/status`, O, { enabled: false });
}

// Reviews: reply to one without a reply
const reviews = (await call("GET", "/vendor/reviews?branchId=all&filter=unreplied", O)).json.data;
log(true, `reviews loaded (${reviews.length}); reply/report not sent (would reach real customers / Carzen)`);

// Staff schedule: save unchanged
const staff = (await call("GET", `/vendor/staff?branchId=${br}`, O)).json.data.find((s) => s.role === "employee");
if (staff) await step("save staff schedule (unchanged)", "PUT", `/vendor/staff/${staff.id}/schedule`, O, { shifts: staff.scheduledShifts });

console.log(out.join("\n"));
console.log(`\n${out.filter((l) => l.startsWith("PASS")).length}/${out.length} passed`);
