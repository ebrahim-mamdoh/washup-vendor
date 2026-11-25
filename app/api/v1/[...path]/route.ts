import { handleMockRequest } from "@/server/platform-api";
import { handleWebRequest, isWebClient } from "@/server/web-session";

/**
 * Mock Carzen platform API (vendor + admin namespaces) (`/api/v1/*`).
 * Stands in for the Laravel backend until it exists — point NEXT_PUBLIC_API_URL
 * at the real API and this route is simply never called.
 *
 * GAP-063: requests of the browser portal (`X-Washup-Client: web`) get their session from
 * httpOnly cookies (see server/web-session.ts); every other client (the owner mobile app) is
 * served exactly as before — tokens in the JSON body, `Authorization: Bearer`.
 */
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ path: string[] }> };

async function handle(req: Request, { params }: RouteContext) {
  const { path } = await params;
  if (!isWebClient(req)) return handleMockRequest(req, path);
  return handleWebRequest(req, path, (forwarded) => handleMockRequest(forwarded, path));
}

export { handle as GET, handle as POST, handle as PUT, handle as PATCH, handle as DELETE };
