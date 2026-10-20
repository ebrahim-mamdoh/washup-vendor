import "server-only";

import { randomBytes } from "node:crypto";

import { MockApiError } from "../http";

/**
 * Sign-in for the Supabase data source.
 *
 * Production (default): Supabase Auth. Passwords never touch our database code:
 * login is Supabase's password grant (email for admins, phone for wash staff),
 * the Supabase access token is the API's Bearer token, and each request resolves
 * it to the auth user id (cached briefly). Profiles link through `user_id`
 * (admin_users / staff), filled by `npm run db:users:demo` or on invitation.
 *
 * Local development (`CARZEN_AUTH=local`, refused in production): there is no
 * Supabase Auth next to a local Postgres, so the demo password is accepted for
 * any active profile and sessions are kept in this process's memory.
 */
export type Identity = { kind: "supabase"; userId: string } | { kind: "local"; profileId: string };

const TOKEN_CACHE_MS = 60_000;
const SESSIONS_KEY = "__CARZEN_PG_SESSIONS__";
type Cache = { tokens: Map<string, { identity: Identity; until: number }>; local: Map<string, string> };
type GlobalWithCache = typeof globalThis & { [SESSIONS_KEY]?: Cache };

function cache(): Cache {
  const g = globalThis as GlobalWithCache;
  g[SESSIONS_KEY] ??= { tokens: new Map(), local: new Map() };
  return g[SESSIONS_KEY];
}

export function isLocalAuth(): boolean {
  if (process.env.CARZEN_AUTH !== "local") return false;
  if (process.env.NODE_ENV === "production") {
    throw new Error("CARZEN_AUTH=local is for local development only and is refused in production");
  }
  return true;
}

function supabaseEnv() {
  const url = process.env.SUPABASE_URL?.replace(/\/$/, "");
  const key = process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY are required for Supabase Auth");
  return { url, key };
}

/**
 * Checks a password. Returns the session token + identity, or null when the
 * credentials are wrong. `localProfileId` is the profile the caller already
 * matched by email/phone (used only in local mode).
 */
export async function signInWithPassword(
  credentials: { email: string } | { phone: string },
  password: string,
  localProfileId: string | null,
): Promise<{ token: string; identity: Identity } | null> {
  if (isLocalAuth()) {
    if (!localProfileId || password !== (process.env.CARZEN_LOCAL_PASSWORD ?? "demo1234")) return null;
    const token = `local_${randomBytes(24).toString("hex")}`;
    cache().local.set(token, localProfileId);
    return { token, identity: { kind: "local", profileId: localProfileId } };
  }

  const { url, key } = supabaseEnv();
  const res = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: key, "Content-Type": "application/json" },
    body: JSON.stringify({ ...credentials, password }),
  });
  if (res.status === 400 || res.status === 401 || res.status === 422) return null;
  if (res.status === 429) throw new MockApiError("محاولات كثيرة لتسجيل الدخول، حاول بعد قليل", 429);
  if (!res.ok) throw new Error(`Supabase Auth sign-in failed: ${res.status}`);
  const body = (await res.json()) as { access_token: string; expires_in?: number; user: { id: string } };
  const identity: Identity = { kind: "supabase", userId: body.user.id };
  cache().tokens.set(body.access_token, { identity, until: Date.now() + TOKEN_CACHE_MS });
  return { token: body.access_token, identity };
}

/** Bearer token → identity, or null when the session is invalid or expired. */
export async function identityFromToken(token: string): Promise<Identity | null> {
  if (isLocalAuth()) {
    const profileId = cache().local.get(token);
    return profileId ? { kind: "local", profileId } : null;
  }

  const hit = cache().tokens.get(token);
  if (hit && hit.until > Date.now()) return hit.identity;

  const { url, key } = supabaseEnv();
  const res = await fetch(`${url}/auth/v1/user`, { headers: { apikey: key, Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    cache().tokens.delete(token);
    if (res.status === 401 || res.status === 403) return null;
    throw new Error(`Supabase Auth user lookup failed: ${res.status}`);
  }
  const user = (await res.json()) as { id: string };
  const identity: Identity = { kind: "supabase", userId: user.id };
  cache().tokens.set(token, { identity, until: Date.now() + TOKEN_CACHE_MS });
  return identity;
}

/**
 * Creates the Supabase Auth login of a new wash account (phone + temporary
 * password, phone pre-confirmed) with the server-only secret key. Returns the
 * auth user id and the password to hand over, or a reason when it can't:
 * no secret key configured, or the phone already has a login (e.g. a customer
 * of the mobile app) — never linked automatically.
 */
export async function createPhoneLogin(phoneE164: string): Promise<{ userId: string; password: string } | { skipped: "no_key" | "taken" }> {
  const secret = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret) return { skipped: "no_key" };
  const { url } = supabaseEnv();
  const password = randomBytes(6).toString("base64url");
  const res = await fetch(`${url}/auth/v1/admin/users`, {
    method: "POST",
    headers: { apikey: secret, Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
    body: JSON.stringify({ phone: phoneE164, password, phone_confirm: true }),
  });
  if (res.status === 422 || res.status === 409) return { skipped: "taken" };
  if (!res.ok) throw new Error(`Supabase Auth user creation failed: ${res.status}`);
  const user = (await res.json()) as { id: string };
  return { userId: user.id, password };
}

export async function signOut(token: string): Promise<void> {
  cache().tokens.delete(token);
  if (isLocalAuth()) {
    cache().local.delete(token);
    return;
  }
  const { url, key } = supabaseEnv();
  await fetch(`${url}/auth/v1/logout`, { method: "POST", headers: { apikey: key, Authorization: `Bearer ${token}` } }).catch(
    () => undefined,
  );
}
