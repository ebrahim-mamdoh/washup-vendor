import "server-only";

import postgres from "postgres";

import { MockApiError, fail } from "../http";
import { type HttpMethod, matchPath } from "../router";
import { identityFromToken } from "./auth";
import type { PgRouteDef, PgVendorContext } from "./router";
import { db, tenantRoleEnabled, withTenantScope } from "./sql";
import { VENDOR_ROUTES } from "./vendor";
import { resolveVendorActor } from "./vendor/scope";
import { enterVendorTenant } from "./vendor/tenant";

async function readBody(req: Request): Promise<Record<string, unknown>> {
  if (req.method === "GET" || req.method === "DELETE") return {};
  try {
    const json = await req.json();
    return json && typeof json === "object" ? (json as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const EXPIRED = "انتهت الجلسة، يرجى تسجيل الدخول مرة أخرى";

/**
 * GAP-027: vendor routes that keep the server role even with CARZEN_DB_TENANT_ROLE=1. They run
 * before any tenant exists and must find the account by phone / auth user across every business
 * (sign-in, session refresh, password reset), or fan a notification out to its recipients for the
 * database push trigger (secret-authenticated). They take no business or branch id from the client.
 */
const TENANT_EXEMPT = new Set([
  "POST /vendor/auth/login",
  "POST /vendor/auth/refresh",
  "POST /vendor/auth/forgot-password",
  "POST /vendor/auth/reset-password",
  "POST /vendor/push/hook",
]);

/**
 * `/api/v1/vendor/*` on the Supabase data source (CARZEN_DATA_SOURCE=supabase): same
 * routes and envelopes as the mock API, served from Postgres. The admin namespace lives in the
 * Super Admin app; the caller (`../index.ts`) has already refused every other path.
 */
export async function handleSupabaseRequest(req: Request, segments: string[]): Promise<Response> {
  const path = `/${segments.join("/")}`;
  const method = req.method.toUpperCase() as HttpMethod;
  let matched: { def: PgRouteDef<PgVendorContext>; params: Record<string, string> } | null = null;
  for (const def of VENDOR_ROUTES) {
    if (def.method !== method) continue;
    const params = matchPath(def.path, path);
    if (params) {
      matched = { def, params };
      break;
    }
  }
  if (!matched) return fail(`المسار ${method} ${path} غير موجود`, 404);

  const header = req.headers.get("authorization") ?? "";
  const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : null;
  const base = { params: matched.params, query: new URL(req.url).searchParams, body: await readBody(req), token, headers: req.headers };

  try {
    if (tenantRoleEnabled() && !TENANT_EXEMPT.has(`${method} ${matched.def.path}`)) {
      // GAP-027: the whole request runs in one transaction as the RLS-bound tenant role.
      const def = matched.def;
      // Public routes always run in the public context (no business), even with a token.
      const identity = token && !def.isPublic ? await identityFromToken(token) : null;
      return await withTenantScope(async (t) => {
        const actor = await enterVendorTenant(t, identity);
        if (!def.isPublic && !actor) return fail(EXPIRED, 401);
        return def.handler({ ...base, actor: actor! });
      });
    }
    const sql = db();
    const identity = token ? await identityFromToken(token) : null;
    const actor = identity ? await resolveVendorActor(sql, identity) : null;
    if (!matched.def.isPublic && !actor) return fail(EXPIRED, 401);
    return await matched.def.handler({ ...base, actor: actor! });
  } catch (error) {
    if (error instanceof MockApiError) return fail(error.message, error.httpStatus, error.errors);
    // Integrity rules enforced by the database (checks, FKs, uniques) surface as validation errors.
    if (error instanceof postgres.PostgresError && error.code.startsWith("23")) {
      console.warn("[api:supabase]", method, path, error.code, error.constraint_name, error.message);
      return fail("البيانات المرسلة تخالف قواعد البيانات المسموح بها", 422);
    }
    // Malformed values Postgres can't store or cast (NUL bytes, bad dates/numbers) are the client's error.
    if ((error instanceof postgres.PostgresError && error.code.startsWith("22")) || error instanceof RangeError) {
      console.warn("[api:supabase]", method, path, error instanceof postgres.PostgresError ? error.code : "", error.message);
      return fail("قيمة غير صالحة في الطلب", 422);
    }
    console.error("[api:supabase]", method, path, error);
    return fail("حدث خطأ غير متوقع في الخادم", 500);
  }
}
