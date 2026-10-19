/**
 * k6 load test for the vendor portal: realistic page loads (each page fires the
 * same API calls the UI does) for owners and managers, plus a steady stream of
 * walk-in orders driven through their lifecycle.
 *
 *   k6 run -e BASE=http://localhost:3301 qa/perf/k6-vendor.js
 *   k6 run -e BASE=http://localhost:3301 -e PROFILE=smoke qa/perf/k6-vendor.js
 *
 * PROFILE: smoke (1 VU, 30s) · load (default: ramps to 30 VUs) · stress (ramps to 100 VUs).
 */
import http from "k6/http";
import { check, group, sleep } from "k6";
import { Trend, Rate } from "k6/metrics";

const BASE = __ENV.BASE || "http://localhost:3301";
const PROFILE = __ENV.PROFILE || "load";
const API = `${BASE}/api/v1/vendor`;

const pageTime = new Trend("page_load_api_ms", true);
const writeTime = new Trend("order_write_ms", true);
const businessErrors = new Rate("business_errors");

const browseStages = {
  smoke: [{ duration: "30s", target: 1 }],
  load: [
    { duration: "30s", target: 10 },
    { duration: "1m", target: 30 },
    { duration: "30s", target: 30 },
    { duration: "20s", target: 0 },
  ],
  stress: [
    { duration: "30s", target: 30 },
    { duration: "1m", target: 100 },
    { duration: "30s", target: 100 },
    { duration: "20s", target: 0 },
  ],
}[PROFILE];

export const options = {
  scenarios: {
    browse: { executor: "ramping-vus", stages: browseStages, exec: "browse" },
    ...(PROFILE === "smoke"
      ? {}
      : { walk_ins: { executor: "constant-arrival-rate", rate: 1, timeUnit: "2s", duration: "2m", preAllocatedVUs: 5, exec: "walkIn", startTime: "20s" } }),
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    "http_req_duration{kind:read}": ["p(95)<800"],
    "http_req_duration{kind:write}": ["p(95)<1500"],
    checks: ["rate>0.99"],
  },
};

function login(phone) {
  const r = http.post(`${API}/auth/login`, JSON.stringify({ phone, password: "demo1234" }), {
    headers: { "Content-Type": "application/json" },
  });
  if (r.status !== 200) throw new Error(`login ${phone} failed: ${r.status} ${r.body}`);
  return r.json("data.access_token");
}

export function setup() {
  return { owner: login("01200000000"), manager: login("01005550102") };
}

const auth = (token) => ({ headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } });

// The API calls each screen makes on load (see the network panel / hooks/*).
const PAGES = {
  dashboard: ["/dashboard?period=today", "/notifications?page=1", "/reviews?replied=no&per_page=1", "/shifts?filter=submitted&per_page=1", "/auth/me"],
  live: ["/live", "/notifications?page=1"],
  orders: ["/orders?per_page=20", "/notifications?page=1"],
  bookings: ["/orders?view=bookings&tab=today&per_page=20"],
  orderDetail: ["/orders/ord_host_0"],
  schedule: ["/schedule?branchId=br_nasr", "/availability?branchId=br_nasr"],
  customers: ["/customers"],
  reports: ["/reports?type=revenue"],
  finance: ["/finance?period=7d"],
  staff: ["/staff?period=7d"],
  search: ["/search?q=CZ"],
};
const NAMES = Object.keys(PAGES);

export function browse(data) {
  const token = __VU % 3 === 0 ? data.manager : data.owner;
  const page = NAMES[Math.floor(Math.random() * NAMES.length)];
  group(`page ${page}`, () => {
    const started = Date.now();
    const responses = http.batch(PAGES[page].map((p) => ["GET", API + p, null, { ...auth(token), tags: { kind: "read", name: `GET ${p.split("?")[0]}` } }]));
    pageTime.add(Date.now() - started, { page });
    for (const r of responses) {
      const ok = check(r, { "status 200": (x) => x.status === 200, "envelope ok": (x) => x.status !== 200 || x.json("status") === true });
      businessErrors.add(!ok);
    }
  });
  sleep(1 + Math.random() * 2); // think time
}

export function walkIn(data) {
  const o = auth(data.owner);
  const tag = (name) => ({ ...o, tags: { kind: "write", name } });
  const plate = `K6 ${__VU}${__ITER}${Date.now() % 100000}`;
  let started = Date.now();
  const created = http.post(
    `${API}/orders`,
    JSON.stringify({ source: "walk_in", branchId: "br_nasr", plate, serviceIds: ["svc_br_nasr_ext"], customer: { name: "K6 Load", phone: "0100" + String(Date.now()).slice(-7) } }),
    tag("POST /orders"),
  );
  writeTime.add(Date.now() - started, { step: "create" });
  if (!check(created, { "order created": (r) => r.status === 200 && r.json("status") === true })) {
    businessErrors.add(true);
    return;
  }
  const id = created.json("data.id") || created.json("data.order.id");
  for (const action of [{ action: "note", text: "k6 load test" }]) {
    started = Date.now();
    const r = http.post(`${API}/orders/${id}/actions`, JSON.stringify(action), tag("POST /orders/:id/actions"));
    writeTime.add(Date.now() - started, { step: action.action });
    businessErrors.add(!check(r, { [`action ${action.action}`]: (x) => x.status === 200 }));
  }
  // Cancel so load-test orders never occupy bays or block a day closing.
  const c = http.post(`${API}/orders/${id}/actions`, JSON.stringify({ action: "cancel", reason: "k6 load test cleanup" }), tag("POST /orders/:id/actions"));
  businessErrors.add(!check(c, { "cancelled": (x) => x.status === 200 }));
}
