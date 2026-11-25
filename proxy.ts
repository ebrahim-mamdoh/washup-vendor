import { NextResponse, type NextRequest } from "next/server";

import { ACCESS_COOKIE, REFRESH_COOKIE } from "@/lib/auth/web-session";

/**
 * GAP-063 — runs before every page (not /api, not static files):
 *
 * 1. Server-side page guard: without a session cookie (access or refresh token, both httpOnly) a
 *    portal page redirects to /login?next=<path>. It's an optimistic check — the API validates the
 *    token on every call and `PortalAuthGate` stays as the second line (the session may be expired).
 * 2. Script CSP with a per-request nonce. Next reads the nonce from the request's
 *    `Content-Security-Policy` header and puts it on its own scripts; the root layout reads `x-nonce`
 *    for next-themes' inline script. `'strict-dynamic'` lets those trusted scripts load the rest
 *    (Google Maps, Leaflet, Firebase/gtag), so injected markup can't run scripts.
 */

const PUBLIC_PAGES = ["/login", "/register", "/forgot-password", "/reset-password"];

function isPublicPage(pathname: string): boolean {
  return PUBLIC_PAGES.some((page) => pathname === page || pathname.startsWith(`${page}/`));
}

function originOf(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
  } catch {
    return null; // relative (same-origin) or invalid
  }
}

/** Every external origin the portal loads from (see "Sessions & CSP" in PROJECT_SUMMARY.md). Add new ones here. */
function contentSecurityPolicy(nonce: string, isHttps: boolean): string {
  const isDev = process.env.NODE_ENV === "development";
  // Server env read at request time: branch photos are public objects of the Supabase storage.
  const supabase = originOf(process.env.SUPABASE_URL);
  const api = originOf(process.env.NEXT_PUBLIC_API_URL);
  // Google's documented CSP for the Maps JavaScript API includes 'unsafe-eval'; only allowed when
  // maps are configured (nonce + 'strict-dynamic' still decide which scripts may run at all).
  const mapsEval = Boolean(process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY);

  const directives: Record<string, (string | null | false)[]> = {
    "default-src": ["'self'"],
    "script-src": [
      "'self'",
      `'nonce-${nonce}'`,
      "'strict-dynamic'",
      (isDev || mapsEval) && "'unsafe-eval'",
      // Only used by browsers without 'strict-dynamic' (CSP2); newer ones ignore host sources here.
      "https://maps.googleapis.com",
      "https://maps.gstatic.com",
      "https://www.googletagmanager.com",
      "https://unpkg.com",
      "blob:",
    ],
    // Inline style attributes come from React, Google Maps and toasts; styles can't run code.
    "style-src": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://unpkg.com"],
    "img-src": [
      "'self'",
      "data:",
      "blob:",
      supabase,
      "https://*.googleapis.com",
      "https://*.gstatic.com",
      "https://*.google.com",
      "https://*.googleusercontent.com",
      "https://tile.openstreetmap.org",
      "https://www.googletagmanager.com",
      "https://*.google-analytics.com",
    ],
    "font-src": ["'self'", "data:", "https://fonts.gstatic.com"],
    "connect-src": [
      "'self'",
      api,
      supabase,
      // Maps, Places (New), Firebase installations / Cloud Messaging registrations
      "https://*.googleapis.com",
      "https://*.google.com",
      "https://*.gstatic.com",
      // Firebase Analytics (gtag)
      "https://www.googletagmanager.com",
      "https://*.google-analytics.com",
      "https://*.analytics.google.com",
      "data:",
      "blob:",
    ],
    "frame-src": ["https://*.google.com"],
    // /push-sw.js (web push) and Google Maps' blob workers
    "worker-src": ["'self'", "blob:"],
    "manifest-src": ["'self'"],
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'"],
    "frame-ancestors": ["'none'"],
  };

  const policy = Object.entries(directives).map(([name, sources]) => `${name} ${sources.filter(Boolean).join(" ")}`);
  if (isHttps) policy.push("upgrade-insecure-requests");
  return policy.join("; ");
}

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  const hasSession = request.cookies.has(ACCESS_COOKIE) || request.cookies.has(REFRESH_COOKIE);
  if (!hasSession && !isPublicPage(pathname)) {
    const login = new URL("/login", request.url);
    login.search = "";
    login.searchParams.set("next", `${pathname}${search}`);
    return NextResponse.redirect(login);
  }

  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const proto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || request.nextUrl.protocol.replace(":", "");
  const csp = contentSecurityPolicy(nonce, proto === "https");

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  matcher: [
    {
      // Pages only: not the API, Next's assets, or files from public/ (brand images, push-sw.js…).
      source: "/((?!api/|_next/static|_next/image|favicon.ico|.*\\.(?:png|jpe?g|gif|svg|ico|webp|js|css|txt|xml|json|map|woff2?)$).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
