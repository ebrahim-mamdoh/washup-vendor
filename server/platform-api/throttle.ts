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

export function isLoginPath(segments: string[]): boolean {
  return segments.length === 3 && segments[1] === "auth" && segments[2] === "login";
}

/** Records an attempt; returns 0 when allowed, else the seconds to wait. */
export function loginThrottle(req: Request): number {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "local";
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
