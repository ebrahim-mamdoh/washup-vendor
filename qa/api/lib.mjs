// Tiny dependency-free test harness for the Carzen Partners API suite (Node >= 20, built-in fetch).
import { AssertionError } from "node:assert";

export class Skip extends Error {}
export const skip = (msg) => {
  throw new Skip(msg);
};

export function createHarness({ api, only, verbose }) {
  const results = [];
  const serverErrors = [];
  let current = null;

  const short = (p) => {
    const s = p.replace(api, "");
    return s.length > 140 ? `${s.slice(0, 137)}...` : s;
  };

  async function call(method, path, { token, body, raw, headers = {}, timeout = 60000 } = {}) {
    const h = { ...headers };
    if (token) h.authorization = `Bearer ${token}`;
    let payload;
    if (raw !== undefined) {
      payload = raw;
      if (!Object.keys(h).some((k) => k.toLowerCase() === "content-type")) h["content-type"] = "application/json";
    } else if (body !== undefined) {
      payload = JSON.stringify(body);
      h["content-type"] = "application/json";
    }
    const url = path.startsWith("http") ? path : api + path;
    const t0 = Date.now();
    let res;
    try {
      res = await fetch(url, { method, headers: h, body: payload, signal: AbortSignal.timeout(timeout), redirect: "manual" });
    } catch (e) {
      const r = { status: 0, json: null, text: String(e), headers: new Headers(), ms: Date.now() - t0, method, path: url, data: undefined, message: `network error: ${e.message}` };
      if (current) current.obs.push({ method, path: short(url), status: 0, message: r.message });
      return r;
    }
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    const r = {
      status: res.status,
      json,
      text,
      headers: res.headers,
      ms: Date.now() - t0,
      method,
      path: url,
      data: json?.data,
      message: json?.message,
    };
    if (current) current.obs.push({ method, path: short(url), status: res.status, message: json?.message ?? null });
    if (res.status >= 500) serverErrors.push({ test: current ? `${current.area} / ${current.name}` : "(setup)", method, path: short(url), status: res.status, body: text.slice(0, 400) });
    return r;
  }

  const describe = (r) => `${r.method} ${short(r.path)} -> ${r.status}${r.message ? ` «${r.message}»` : ""}`;

  function expectStatus(r, expected, hint = "") {
    const list = Array.isArray(expected) ? expected : [expected];
    if (!list.includes(r.status)) {
      throw new AssertionError({ message: `expected ${list.join("|")}, got ${describe(r)}${hint ? ` — ${hint}` : ""}` });
    }
    return r;
  }

  /** Error envelope: {status:false, message, data:null} (+ errors[field] when given). */
  function expectError(r, code, field) {
    expectStatus(r, code);
    check(r.json && r.json.status === false && typeof r.json.message === "string" && r.json.message.length > 0, `error envelope malformed: ${r.text.slice(0, 200)}`);
    check(r.json.data === null, `error envelope data should be null: ${r.text.slice(0, 200)}`);
    if (field) check(r.json.errors && Array.isArray(r.json.errors[field]), `expected errors.${field} in ${describe(r)} — errors=${JSON.stringify(r.json.errors)}`);
    return r;
  }

  function expectOk(r, hint = "") {
    expectStatus(r, 200, hint);
    check(r.json && r.json.status === true, `success envelope expected: ${r.text.slice(0, 200)}`);
    return r;
  }

  function check(cond, msg) {
    if (!cond) throw new AssertionError({ message: msg });
  }

  async function t(area, name, fn, opts = {}) {
    if (only && !only.some((o) => area.toLowerCase().includes(o))) return;
    const rec = { area, name, status: "pass", detail: "", severity: opts.severity ?? null, obs: [], ms: 0 };
    current = rec;
    const t0 = Date.now();
    try {
      const out = await fn(rec);
      if (typeof out === "string") rec.detail = out;
    } catch (e) {
      if (e instanceof Skip) {
        rec.status = "skip";
        rec.detail = e.message;
      } else {
        rec.status = "fail";
        rec.detail = e instanceof AssertionError ? e.message : `${e.name}: ${e.message}`;
        if (verbose && !(e instanceof AssertionError)) console.error(e);
      }
    }
    rec.ms = Date.now() - t0;
    current = null;
    results.push(rec);
    const mark = rec.status === "pass" ? "PASS" : rec.status === "skip" ? "SKIP" : "FAIL";
    const line = `${mark}  [${area}] ${name}${rec.status !== "pass" && rec.detail ? `\n        -> ${rec.detail}` : verbose && rec.detail ? `  (${rec.detail})` : ""}`;
    console.log(line);
    return rec;
  }

  return { call, t, check, expectStatus, expectError, expectOk, describe, results, serverErrors };
}
