/**
 * Endpoint throughput/latency benchmark for the vendor API (autocannon).
 *
 *   node qa/perf/autocannon.mjs --base http://localhost:3301 [--connections 20] [--duration 15] [--out results.json]
 *
 * Needs autocannon on the module path (e.g. `npx -p autocannon@8 node qa/perf/autocannon.mjs …`, or
 * NODE_PATH pointing at a folder where it is installed). Signs in as the owner, then hits each
 * read endpoint for --duration seconds and prints req/s, p50/p97.5/p99 latency and error counts.
 */
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import path from "node:path";

const require = createRequire(path.join(process.env.AUTOCANNON_HOME ?? process.cwd(), "noop.js"));
const autocannon = require("autocannon");

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const base = arg("base", "http://localhost:3301");
const connections = Number(arg("connections", 20));
const duration = Number(arg("duration", 15));
const out = arg("out", null);

const login = await fetch(`${base}/api/v1/vendor/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ phone: arg("phone", "01200000000"), password: "demo1234" }),
}).then((r) => r.json());
if (!login.status) throw new Error(`login failed: ${login.message}`);
const headers = { Authorization: `Bearer ${login.data.access_token}` };

const ENDPOINTS = [
  ["auth/me", "/api/v1/vendor/auth/me"],
  ["dashboard today", "/api/v1/vendor/dashboard?period=today"],
  ["dashboard 30d", "/api/v1/vendor/dashboard?period=30d"],
  ["live board", "/api/v1/vendor/live"],
  ["orders list", "/api/v1/vendor/orders?per_page=20"],
  ["order detail", "/api/v1/vendor/orders/ord_host_0"],
  ["availability", "/api/v1/vendor/availability?branchId=br_nasr"],
  ["customers", "/api/v1/vendor/customers"],
  ["reports revenue", "/api/v1/vendor/reports?type=revenue"],
  ["finance 30d", "/api/v1/vendor/finance?period=30d"],
  ["search", "/api/v1/vendor/search?q=" + encodeURIComponent("أحمد")],
  ["page /dashboard (HTML)", "/dashboard"],
];

const rows = [];
for (const [name, url] of ENDPOINTS) {
  const r = await autocannon({ url: base + url, connections, duration, headers });
  rows.push({
    endpoint: name,
    "req/s": Math.round(r.requests.average),
    "p50 ms": r.latency.p50,
    "p97.5 ms": r.latency.p97_5,
    "p99 ms": r.latency.p99,
    "max ms": r.latency.max,
    "2xx": r["2xx"],
    non2xx: r.non2xx,
    errors: r.errors + r.timeouts,
  });
  console.log(`${name}: ${Math.round(r.requests.average)} req/s, p99 ${r.latency.p99} ms, non2xx ${r.non2xx}, errors ${r.errors + r.timeouts}`);
}
console.table(rows);
if (out) writeFileSync(out, JSON.stringify({ base, connections, duration, at: new Date().toISOString(), rows }, null, 2));
