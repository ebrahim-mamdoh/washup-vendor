/**
 * Summarises a V8 .cpuprofile (from `node --cpu-prof`): top functions by self
 * time and by inclusive time, plus time per source package/folder.
 *
 *   node qa/perf/analyze-cpuprofile.mjs <file.cpuprofile> [top=25] [fromSec] [toSec]
 *
 * fromSec/toSec keep only samples in that window (skip server start-up and idle tail).
 */
import { readFileSync } from "node:fs";

const [file, topArg, fromArg, toArg] = process.argv.slice(2);
const from = Number(fromArg ?? 0) * 1e6;
const to = toArg ? Number(toArg) * 1e6 : Infinity;
const top = Number(topArg ?? 25);
const p = JSON.parse(readFileSync(file, "utf8"));
const byId = new Map(p.nodes.map((n) => [n.id, n]));
const dt = new Map();
let clock = 0;
for (let i = 0; i < p.samples.length; i += 1) {
  clock += p.timeDeltas[i] ?? 0;
  if (clock < from || clock > to) continue;
  dt.set(p.samples[i], (dt.get(p.samples[i]) ?? 0) + (p.timeDeltas[i] ?? 0));
}
const total = [...dt.values()].reduce((a, b) => a + b, 0);
const parent = new Map();
for (const n of p.nodes) for (const c of n.children ?? []) parent.set(c, n.id);

const label = (n) => {
  const f = n.callFrame;
  const url = (f.url || "").replace(/^file:\/\/\/?/, "").replace(/.*?(server\/platform-api|node_modules\/[^/]+|\.next\/server)/, "$1");
  return `${f.functionName || "(anonymous)"} ${url ? `[${url}:${f.lineNumber + 1}]` : `(${f.url || "native"})`}`;
};
const bucket = (n) => {
  const u = n.callFrame.url || "";
  if (!u) return n.callFrame.functionName.startsWith("(") ? n.callFrame.functionName : "(native/builtin)";
  const m = u.match(/node_modules\/((@[^/]+\/)?[^/]+)/);
  if (m) return `node_modules/${m[1]}`;
  if (u.includes("platform-api")) return "server/platform-api";
  if (u.includes(".next")) return ".next (app bundle)";
  return "node internals";
};

const self = new Map(), incl = new Map(), buckets = new Map();
for (const [id, t] of dt) {
  const n = byId.get(id);
  const k = label(n);
  self.set(k, (self.get(k) ?? 0) + t);
  buckets.set(bucket(n), (buckets.get(bucket(n)) ?? 0) + t);
  const seen = new Set();
  for (let cur = id; cur !== undefined; cur = parent.get(cur)) {
    const l = label(byId.get(cur));
    if (!seen.has(l)) incl.set(l, (incl.get(l) ?? 0) + t), seen.add(l);
  }
}
const pct = (t) => `${((t / total) * 100).toFixed(1)}%`;
const show = (title, m) => {
  console.log(`\n## ${title}`);
  for (const [k, t] of [...m].sort((a, b) => b[1] - a[1]).slice(0, top)) console.log(`${pct(t).padStart(6)}  ${(t / 1000).toFixed(0).padStart(7)} ms  ${k}`);
};
console.log(`profile: ${(total / 1e6).toFixed(1)} s sampled`);
show("Time by area", buckets);
show("Top self time", self);
show("Top inclusive time (excluding idle/program/root)", new Map([...incl].filter(([k]) => !/^\((root|idle|program|garbage collector)\)/.test(k))));
