import "server-only";

import { getDb, persistDb } from "./db";
import { MockApiError, fail } from "./http";
import { handleSupabaseRequest } from "./pg";
import { type HttpMethod, type VendorRouteDef, matchPath } from "./router";
import { isLoginPath, loginThrottle } from "./throttle";
import { VENDOR_ROUTES } from "./vendor";
import { resolveVendorActor } from "./vendor/scope";

/** Public "join as a wash" submission (GAP-030): same per-IP budget as sign-in, its own bucket. */
function isApplicationSubmit(segments: string[]): boolean {
  return segments.length === 2 && segments[0] === "vendor" && segments[1] === "applications";
}

/**
 * Public application lookup by phone number (anything that isn't an `app_…` id): it answers
 * whether a phone has applied, so it gets the same per-IP budget as sign-in.
 */
function isApplicationPhoneLookup(segments: string[]): boolean {
  return segments.length === 3 && segments[0] === "vendor" && segments[1] === "applications" && !segments[2].startsWith("app_");
}

/** Simulated network latency so loading states are visible (set MOCK_API_LATENCY=0 to disable). */
function latency() {
  const base = Number(process.env.MOCK_API_LATENCY ?? 280);
  if (!base) return Promise.resolve();
  return new Promise((r) => setTimeout(r, base + Math.floor(Math.random() * base * 0.6)));
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  if (req.method === "GET" || req.method === "DELETE") return {};
  try {
    const json = await req.json();
    return json && typeof json === "object" ? (json as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** JSON bodies of this API are small; anything bigger is refused before parsing. */
const MAX_BODY_BYTES = 1_000_000;

export async function handleMockRequest(req: Request, segments: string[]): Promise<Response> {
  const isProduction = process.env.NODE_ENV === "production";
  // The partner portal only serves /vendor/*: the admin namespace lives in the Super Admin app (GAP-054).
  if (segments[0] !== "vendor") {
    return fail(`المسار ${req.method.toUpperCase()} /${segments.join("/")} غير موجود`, 404);
  }
  // Fail closed: a production deploy without CARZEN_DATA_SOURCE=supabase would otherwise serve the
  // seeded mock store (demo logins, writes to an ephemeral file) under the real URL.
  if (isProduction && process.env.CARZEN_DATA_SOURCE !== "supabase") {
    console.error("[platform-api] CARZEN_DATA_SOURCE must be \"supabase\" in production");
    return fail("الخدمة غير متاحة حاليًا", 503);
  }
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return fail("حجم الطلب أكبر من المسموح", 413);
  if (isLoginPath(segments) && req.method === "POST") {
    const wait = loginThrottle(req);
    if (wait) return fail(`محاولات كثيرة لتسجيل الدخول، حاول بعد ${wait} ثانية`, 429);
  }
  if (isApplicationSubmit(segments) && req.method === "POST") {
    const wait = loginThrottle(req, "application-submit");
    if (wait) return fail(`محاولات إرسال كثيرة، حاول بعد ${wait} ثانية`, 429);
  }
  if (isApplicationPhoneLookup(segments) && req.method === "GET") {
    const wait = loginThrottle(req, "application-lookup");
    if (wait) return fail(`محاولات بحث كثيرة، حاول بعد ${wait} ثانية`, 429);
  }

  // Real data: the same routes served from the Supabase Postgres database.
  if (process.env.CARZEN_DATA_SOURCE === "supabase") return handleSupabaseRequest(req, segments);

  const path = `/${segments.join("/")}`;
  const method = req.method.toUpperCase() as HttpMethod;
  let matched: { def: VendorRouteDef; params: Record<string, string> } | null = null;
  for (const def of VENDOR_ROUTES) {
    if (def.method !== method) continue;
    const params = matchPath(def.path, path);
    if (params) {
      matched = { def, params };
      break;
    }
  }
  if (!matched) return fail(`المسار ${method} ${path} غير موجود`, 404);

  await latency();
  const db = getDb();

  const header = req.headers.get("authorization") ?? "";
  const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : null;
  const base = { db, params: matched.params, query: new URL(req.url).searchParams, body: await readBody(req), token };

  try {
    const actor = token ? resolveVendorActor(db, token) : null;
    if (!matched.def.isPublic && !actor) return fail("انتهت الجلسة، يرجى تسجيل الدخول مرة أخرى", 401);
    const response = await matched.def.handler({ ...base, actor: actor! });
    // Successful writes are flushed to the shared store so other apps see them immediately.
    if (method !== "GET" && response.ok) persistDb(db);
    return response;
  } catch (error) {
    if (error instanceof MockApiError) return fail(error.message, error.httpStatus, error.errors);
    // Invalid dates in the request ("Invalid time value") are the client's error.
    if (error instanceof RangeError) return fail("قيمة غير صالحة في الطلب", 422);
    console.error("[mock-api]", method, path, error);
    return fail("حدث خطأ غير متوقع في الخادم", 500);
  }
}
