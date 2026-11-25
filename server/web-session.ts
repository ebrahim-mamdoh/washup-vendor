import "server-only";

import { cookies } from "next/headers";

import { ACCESS_COOKIE, REFRESH_COOKIE, WEB_CLIENT_HEADER, WEB_CLIENT_VALUE } from "@/lib/auth/web-session";

/**
 * GAP-063 — cookie sessions for the browser portal, applied in the API route around the
 * platform API (which itself only knows `Authorization: Bearer` and `refresh_token` in the body):
 *
 * - login / refresh (web): the tokens are moved out of the JSON body into httpOnly cookies;
 * - any web request without `Authorization`: the access-token cookie is sent as the Bearer token;
 * - refresh (web) without `refresh_token` in the body: the refresh-token cookie is used;
 * - logout (web): both cookies are cleared.
 *
 * Requests without `X-Washup-Client: web` never reach this module (see the route): the owner
 * mobile app keeps getting its tokens in the body, and a cookie alone authenticates nothing.
 */

/** The refresh token's lifetime on our side (Supabase refresh tokens don't expire on their own). */
const REFRESH_MAX_AGE = 30 * 24 * 60 * 60;
/** Same limit as the platform API's body check: bigger bodies are passed through untouched (→ 413). */
const MAX_BODY_BYTES = 1_000_000;

type AuthAction = "login" | "refresh" | "logout" | null;

export function isWebClient(req: Request): boolean {
  return req.headers.get(WEB_CLIENT_HEADER)?.trim().toLowerCase() === WEB_CLIENT_VALUE;
}

function authAction(segments: string[], method: string): AuthAction {
  if (method.toUpperCase() !== "POST" || segments.length !== 3 || segments[0] !== "vendor" || segments[1] !== "auth") return null;
  const action = segments[2];
  return action === "login" || action === "refresh" || action === "logout" ? action : null;
}

/** `Secure` everywhere except plain-http localhost (`next dev` / `next start` on a laptop). */
function isSecureRequest(req: Request): boolean {
  const url = new URL(req.url);
  const proto = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || url.protocol.replace(":", "");
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  return !(local && proto === "http");
}

function cookieOptions(secure: boolean, maxAge: number) {
  return { httpOnly: true, secure, sameSite: "lax" as const, path: "/", maxAge };
}

async function readJsonBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const json: unknown = await req.json();
    return json && typeof json === "object" && !Array.isArray(json) ? (json as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

type Jar = Awaited<ReturnType<typeof cookies>>;

function clearSessionCookies(jar: Jar, secure: boolean) {
  jar.set(ACCESS_COOKIE, "", cookieOptions(secure, 0));
  jar.set(REFRESH_COOKIE, "", cookieOptions(secure, 0));
}

/** Adds the cookie session to the request (only what's missing), without touching anything else. */
async function withCookieSession(req: Request, action: AuthAction, jar: Jar): Promise<Request> {
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return req;
  const access = jar.get(ACCESS_COOKIE)?.value;
  const refresh = jar.get(REFRESH_COOKIE)?.value;
  const headers = new Headers(req.headers);
  const hasBody = req.method !== "GET" && req.method !== "HEAD" && req.method !== "DELETE";

  if (action === "refresh") {
    const body = await readJsonBody(req);
    if (!body.refresh_token && refresh) body.refresh_token = refresh;
    headers.set("content-type", "application/json");
    headers.delete("content-length");
    return new Request(req.url, { method: req.method, headers, body: JSON.stringify(body), signal: req.signal });
  }

  if (action === "login" || !access || headers.has("authorization")) return req;
  headers.set("authorization", `Bearer ${access}`);
  const body = hasBody ? await req.arrayBuffer() : undefined;
  return new Request(req.url, { method: req.method, headers, body, signal: req.signal });
}

/** Moves the tokens of a successful login/refresh response into cookies; the body keeps the rest. */
async function tokensToCookies(res: Response, jar: Jar, secure: boolean): Promise<Response> {
  const payload = (await res
    .clone()
    .json()
    .catch(() => null)) as { status?: unknown; data?: Record<string, unknown> | null } | null;
  const data = payload?.data;
  if (payload?.status !== true || !data || typeof data.access_token !== "string" || !data.access_token) return res;

  const { access_token: accessToken, refresh_token: refreshToken, ...rest } = data;
  const expiresIn = typeof data.expires_in === "number" && data.expires_in > 0 ? data.expires_in : null;
  // Access cookie ≈ token lifetime; mock tokens never expire, so they live as long as the refresh cookie.
  jar.set(ACCESS_COOKIE, accessToken, cookieOptions(secure, expiresIn ?? REFRESH_MAX_AGE));
  if (typeof refreshToken === "string" && refreshToken) jar.set(REFRESH_COOKIE, refreshToken, cookieOptions(secure, REFRESH_MAX_AGE));
  else jar.set(REFRESH_COOKIE, "", cookieOptions(secure, 0));

  const headers = new Headers(res.headers);
  headers.delete("content-length");
  return new Response(JSON.stringify({ ...payload, data: rest }), { status: res.status, statusText: res.statusText, headers });
}

/** Runs a web (`X-Washup-Client: web`) request through `dispatch` with the cookie session applied. */
export async function handleWebRequest(
  req: Request,
  segments: string[],
  dispatch: (req: Request) => Promise<Response>,
): Promise<Response> {
  const action = authAction(segments, req.method);
  const jar = await cookies();
  const secure = isSecureRequest(req);
  const res = await dispatch(await withCookieSession(req, action, jar));

  if (action === "logout") {
    // Even when the session had already ended (401): the browser must not keep it.
    clearSessionCookies(jar, secure);
    return res;
  }
  if (action === "refresh" && (res.status === 401 || res.status === 403)) {
    clearSessionCookies(jar, secure);
    return res;
  }
  if ((action === "login" || action === "refresh") && res.ok) return tokensToCookies(res, jar, secure);
  return res;
}
