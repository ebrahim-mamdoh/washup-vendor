// Walk-in without a phone (no customer) through its whole lifecycle (paid then refunded).
// Usage: node qa/api-check/walk-in-no-phone.mjs <base> <managerPhone> <pass>
const [base, phone, password] = process.argv.slice(2);
const API = `${base}/api/v1`;
async function call(method, path, token, body) {
  const res = await fetch(API + path, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}
const out = [];
const step = async (name, method, path, token, body) => {
  const r = await call(method, path, token, body);
  out.push(`${r.status === 200 ? "PASS" : "FAIL"}  ${name}  -> ${r.status} ${r.json?.message}`);
  return r;
};
const M = (await call("POST", "/vendor/auth/login", null, { phone, password })).json.data;
const T = M.access_token;
const br = M.account.homeBranchId;
const services = (await call("GET", `/vendor/services?branchId=${br}`, T)).json.data;
const primary = services.find((s) => s.type === "primary" && s.active);
const created = await step("create walk-in WITHOUT phone", "POST", "/vendor/orders", T, { source: "walk_in", branchId: br, plate: "QA 0003", serviceIds: [primary.id] });
if (created.status === 200) {
  const o = created.json.data;
  out.push(`      order ${o.number} customerId=${o.customerId} status=${o.status}`);
  const d = (await call("GET", `/vendor/orders/${o.id}`, T)).json.data;
  const staffId = d.assignableStaff.find((s) => s.name !== "QA Employee")?.id ?? d.assignableStaff[0]?.id;
  await step("start", "POST", `/vendor/orders/${o.id}/actions`, T, { action: "start", staffId });
  await step("complete", "POST", `/vendor/orders/${o.id}/actions`, T, { action: "complete" });
  await step("collect card", "POST", `/vendor/orders/${o.id}/actions`, T, { action: "collect_payment", method: "card" });
  await step("refund (test cleanup)", "POST", `/vendor/orders/${o.id}/actions`, T, { action: "refund", reason: "طلب اختبار بدون رقم — استرداد" });
  const final = (await call("GET", `/vendor/orders/${o.id}`, T)).json.data.order;
  out.push(`      final: status=${final.status} payment=${final.paymentStatus} timeline=${final.timeline.map((e) => e.status).join(">")}`);
  console.log("ORDER_ID", o.id);
}
console.log(out.join("\n"));
