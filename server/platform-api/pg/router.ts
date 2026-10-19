import "server-only";

import type { AdminUser } from "@/types/auth";

import type { HttpMethod, VendorActor } from "../router";

/**
 * Route definitions for the Supabase data source. Same paths, params and
 * response contracts as the mock routes in `../router.ts`; handlers read and
 * write Postgres through repositories instead of receiving the mock store.
 */
export interface PgAdminContext {
  params: Record<string, string>;
  query: URLSearchParams;
  body: Record<string, unknown>;
  /** Authenticated admin (null only on public routes). */
  admin: AdminUser;
  token: string | null;
}

export interface PgVendorContext {
  params: Record<string, string>;
  query: URLSearchParams;
  body: Record<string, unknown>;
  /** Signed-in owner/manager and the branches they may see (null only on public routes). */
  actor: VendorActor;
  token: string | null;
}

export interface PgRouteDef<C> {
  method: HttpMethod;
  path: string;
  handler: (ctx: C) => Promise<Response>;
  isPublic?: boolean;
}

export function route(method: HttpMethod, path: string, handler: (ctx: PgAdminContext) => Promise<Response>, isPublic = false): PgRouteDef<PgAdminContext> {
  return { method, path, handler, isPublic };
}

export function vroute(method: HttpMethod, path: string, handler: (ctx: PgVendorContext) => Promise<Response>, isPublic = false): PgRouteDef<PgVendorContext> {
  return { method, path, handler, isPublic };
}
