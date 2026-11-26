import "server-only";

/**
 * Login brute-force guard: at most `MAX_ATTEMPTS` sign-in attempts per client
 * IP in a sliding `WINDOW_MS`. Kept in this process's memory (one app server);
 * Supabase Auth applies its own limits behind it on the Supabase data source.
 */
const WINDOW_MS = 5 * 60_000;
const MAX_ATTEMPTS = 10;
const KEY = "__CARZEN_LOGIN_THROTTLE__";
type GlobalWithThrottle = typeof globalThis & { [KEY]?: Map<string, number[]> };

function attempts(): Map<string, number[]> {
  const g = globalThis as GlobalWithThrottle;
  g[KEY] ??= new Map();
  return g[KEY];
}

/**
 * The caller's IP from a header only the hosting platform sets (GAP-064): on Vercel
 * `x-vercel-forwarded-for` (then `x-real-ip`), both written by Vercel's edge. Elsewhere only the header
 * named in TRUSTED_CLIENT_IP_HEADER (set by your own proxy) is used; a client-sent `x-forwarded-for`
 * is never trusted, so it can't be rotated to dodge the limit. Without one, all callers share a bucket.
 */
export function clientIp(req: Request): string {
  const first = (name: string) => req.headers.get(name)?.split(",")[0]?.trim() || "";
  if (process.env.VERCEL) return first("x-vercel-forwarded-for") || first("x-real-ip") || "unknown";
  const trusted = process.env.TRUSTED_CLIENT_IP_HEADER?.trim().toLowerCase();
  return (trusted && first(trusted)) || "local";
}

export function isLoginPath(segments: string[]): boolean {
  return segments.length === 3 && segments[1] === "auth" && (segments[2] === "login" || segments[2] === "forgot-password");
}

/**
 * Records an attempt; returns 0 when allowed, else the seconds to wait.
 * `bucket` keeps separate budgets (sign-in vs. application lookups) for the same IP.
 */
export function loginThrottle(req: Request, bucket = "login"): number {
  const ip = `${bucket}:${clientIp(req)}`;
  const at = Date.now();
  const map = attempts();
  const recent = (map.get(ip) ?? []).filter((t) => at - t < WINDOW_MS);
  if (recent.length >= MAX_ATTEMPTS) {
    map.set(ip, recent);
    return Math.ceil((recent[0] + WINDOW_MS - at) / 1000);
  }
  recent.push(at);
  map.set(ip, recent);
  // Keep the map small: drop clients with no attempt in the window.
  if (map.size > 5000) for (const [k, v] of map) if (!v.some((t) => at - t < WINDOW_MS)) map.delete(k);
  return 0;
}
