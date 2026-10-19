#!/usr/bin/env node
/**
 * Mode-difference report: compares qa/api/results-<a>.json with results-<b>.json (default mock vs supabase).
 *   node qa/api/compare.mjs [modeA] [modeB]
 * A case is listed when its outcome (pass/fail/skip) differs, or when the HTTP status sequence or the
 * (number-normalised) messages of its requests differ between the two data sources.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const [a = "mock", b = "supabase"] = process.argv.slice(2);
const load = (m) => JSON.parse(readFileSync(join(HERE, `results-${m}.json`), "utf8"));
const A = load(a);
const B = load(b);

// Normalise volatile parts: numbers, ids, tokens, plates.
const RUNS = [A.run, B.run].filter(Boolean);
const norm = (s) =>
  RUNS.reduce((acc, r) => acc.split(r).join("#RUN"), s ?? "")
    .replace(/CZ-\d{5}/g, "CZ-#")
    .replace(/\b(st|ord|cu|ve|svc|of|blk|dc|vn|tok|pay)_[a-z0-9_]+/gi, "$1_#")
    .replace(/QA[A-Z0-9]{6,}/g, "QA#")
    .replace(/\d+(\.\d+)?/g, "#");
const normPath = (p) => norm(p).replace(/run=[^&]+/, "");

const key = (r) => `${r.area} :: ${r.name}`;
const mapB = new Map(B.results.map((r) => [key(r), r]));
const diffs = [];
for (const ra of A.results) {
  const rb = mapB.get(key(ra));
  if (!rb) {
    diffs.push({ case: key(ra), kind: "missing", detail: `only in ${a}` });
    continue;
  }
  mapB.delete(key(ra));
  if (ra.status !== rb.status) diffs.push({ case: key(ra), kind: "outcome", detail: `${a}=${ra.status} ${b}=${rb.status}`, a: ra.detail, b: rb.detail });
  const n = Math.min(ra.obs.length, rb.obs.length);
  const codeDiff = [];
  const msgDiff = [];
  for (let i = 0; i < n; i += 1) {
    const x = ra.obs[i];
    const y = rb.obs[i];
    if (normPath(x.path) !== normPath(y.path)) break; // request sequences diverged (data-dependent branch)
    if (x.status !== y.status) codeDiff.push(`${x.method} ${x.path}: ${a}=${x.status} ${b}=${y.status}${x.message || y.message ? ` («${x.message ?? ""}» vs «${y.message ?? ""}»)` : ""}`);
    else if (norm(x.message) !== norm(y.message)) msgDiff.push(`${x.method} ${x.path} (${x.status}): «${x.message}» vs «${y.message}»`);
  }
  if (codeDiff.length) diffs.push({ case: key(ra), kind: "status", detail: codeDiff.join("\n      ") });
  if (msgDiff.length) diffs.push({ case: key(ra), kind: "message", detail: msgDiff.join("\n      ") });
}
for (const [k] of mapB) diffs.push({ case: k, kind: "missing", detail: `only in ${b}` });

console.log(`Mode differences: ${a} (${A.base}, run ${A.run}) vs ${b} (${B.base}, run ${B.run})`);
console.log(`${a}: ${JSON.stringify(A.totals)}   ${b}: ${JSON.stringify(B.totals)}\n`);
if (!diffs.length) console.log("No differences.");
for (const d of diffs) {
  console.log(`[${d.kind}] ${d.case}\n      ${d.detail}`);
  if (d.kind === "outcome") console.log(`      ${a}: ${d.a || "-"}\n      ${b}: ${d.b || "-"}`);
}
const only5xx = (R) => new Set(R.serverErrors.map((e) => `${e.method} ${normPath(e.path)}`));
const sa = only5xx(A);
const sb = only5xx(B);
const x = [...sa].filter((e) => !sb.has(e));
const y = [...sb].filter((e) => !sa.has(e));
if (x.length || y.length) {
  console.log(`\n5xx only in ${a}: ${x.join(", ") || "-"}`);
  console.log(`5xx only in ${b}: ${y.join(", ") || "-"}`);
}
