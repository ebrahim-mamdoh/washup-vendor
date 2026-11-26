import "server-only";

import type { HttpMethod, VendorActor } from "../router";

/**
 * Route definitions for the Supabase data source. Same paths, params and
 * response contracts as the mock routes in `../router.ts`; handlers read and
 * write Postgres through repositories instead of receiving the mock store.
 * (The admin namespace and its `PgAdminContext` live in the Super Admin app.)
 */
export interface PgVendorContext {
  params: Record<string, string>;
  query: URLSearchParams;
  body: Record<string, unknown>;
  /** Signed-in owner/manager and the branches they may see (null only on public routes). */
  actor: VendorActor;
  token: string | null;
  headers: Headers;
}

export interface PgRouteDef<C> {
  method: HttpMethod;
  path: string;
  handler: (ctx: C) => Promise<Response>;
  isPublic?: boolean;
}

export function vroute(method: HttpMethod, path: string, handler: (ctx: PgVendorContext) => Promise<Response>, isPublic = false): PgRouteDef<PgVendorContext> {
  return { method, path, handler, isPublic };
}
