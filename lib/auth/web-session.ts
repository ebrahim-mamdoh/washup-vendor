/**
 * GAP-063: the browser portal keeps its session in httpOnly cookies (never readable by JS).
 * Shared by the client (header), the API route (cookies) and `proxy.ts` (page guard).
 *
 * - Web requests say so with `X-Washup-Client: web`. Only those may be authenticated by cookie:
 *   a custom header forces a CORS preflight, so another site can't send it (CSRF defence, with
 *   SameSite=Lax on the cookies).
 * - Other clients (the owner mobile app) are unchanged: tokens in the JSON body + `Authorization: Bearer`.
 *
 * Names are portal-specific: browsers don't isolate cookies by port, so on localhost the
 * Super Admin and the vendor portal would otherwise overwrite each other's session.
 */
export const WEB_CLIENT_HEADER = "X-Washup-Client";
export const WEB_CLIENT_VALUE = "web";

export const ACCESS_COOKIE = "wu_vendor_at";
export const REFRESH_COOKIE = "wu_vendor_rt";
