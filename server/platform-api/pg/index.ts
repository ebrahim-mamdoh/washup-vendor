import "server-only";

import postgres from "postgres";

import { MockApiError, fail } from "../http";
import { type HttpMethod, matchPath } from "../router";
import { resolveAdmin } from "./admin/auth";
import { ADMIN_ROUTES } from "./admin";
import { identityFromToken } from "./auth";
import type { PgAdminContext, PgRouteDef, PgVendorContext } from "./router";
import { db } from "./sql";
import { VENDOR_ROUTES } from "./vendor";
import { resolveVendorActor } from "./vendor/scope";

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
 * `/api/v1/*` on the Supabase data source (CARZEN_DATA_SOURCE=supabase): same
 * routes and envelopes as the mock API, served from Postgres.
 */
export async function handleSupabaseRequest(req: Request, segments: string[]): Promise<Response> {
  const path = `/${segments.join("/")}`;
  const method = req.method.toUpperCase() as HttpMethod;
  const isVendor = path.startsWith("/vendor/");

  const table: PgRouteDef<PgAdminContext | PgVendorContext>[] = (isVendor ? VENDOR_ROUTES : ADMIN_ROUTES) as PgRouteDef<
    PgAdminContext | PgVendorContext
  >[];
  let matched: { def: PgRouteDef<PgAdminContext | PgVendorContext>; params: Record<string, string> } | null = null;
  for (const def of table) {
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
  const base = { params: matched.params, query: new URL(req.url).searchParams, body: await readBody(req), token };

  try {
    const sql = db();
    const identity = token ? await identityFromToken(token) : null;
    if (isVendor) {
      const actor = identity ? await resolveVendorActor(sql, identity) : null;
      if (!matched.def.isPublic && !actor) return fail(EXPIRED, 401);
      return await (matched.def as PgRouteDef<PgVendorContext>).handler({ ...base, actor: actor! });
    }
    const admin = identity ? await resolveAdmin(sql, identity) : null;
    if (!matched.def.isPublic && !admin) return fail(EXPIRED, 401);
    return await (matched.def as PgRouteDef<PgAdminContext>).handler({ ...base, admin: admin! });
  } catch (error) {
    if (error instanceof MockApiError) return fail(error.message, error.httpStatus, error.errors);
    // Integrity rules enforced by the database (checks, FKs, uniques) surface as validation errors.
    if (error instanceof postgres.PostgresError && error.code.startsWith("23")) {
      console.warn("[api:supabase]", method, path, error.code, error.constraint_name, error.message);
      return fail("البيانات المرسلة تخالف قواعد البيانات المسموح بها", 422);
    }
    console.error("[api:supabase]", method, path, error);
    return fail("حدث خطأ غير متوقع في الخادم", 500);
  }
}
