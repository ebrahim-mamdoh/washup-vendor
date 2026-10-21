import "server-only";

import { createSign } from "node:crypto";

/**
 * FCM HTTP v1 client (same contract as the customer app's `send-push` Edge
 * Function): signs a Google OAuth JWT with the Firebase service account,
 * caches the access token and sends one message per call.
 *
 * The service account comes from FIREBASE_SERVICE_ACCOUNT (raw JSON or base64
 * of it), server-only. It is never logged. Without it push is simply off.
 */
type ServiceAccount = { project_id: string; client_email: string; private_key: string };

export type SendResult = { ok: true } | { ok: false; status: number; errorCode: string; message: string };

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const KEY = "__CARZEN_FCM__";
type Cache = { sa: ServiceAccount | null; token: { value: string; expiresAt: number } | null };
type GlobalWithFcm = typeof globalThis & { [KEY]?: Cache };

function parseServiceAccount(raw: string | undefined): ServiceAccount | null {
  if (!raw) return null;
  try {
    const text = raw.trim().startsWith("{") ? raw : Buffer.from(raw.trim(), "base64").toString("utf8");
    const sa = JSON.parse(text) as ServiceAccount;
    return sa?.project_id && sa.client_email && sa.private_key ? sa : null;
  } catch {
    return null;
  }
}

function cache(): Cache {
  const g = globalThis as GlobalWithFcm;
  g[KEY] ??= { sa: parseServiceAccount(process.env.FIREBASE_SERVICE_ACCOUNT), token: null };
  return g[KEY];
}

export function isPushConfigured(): boolean {
  return cache().sa !== null;
}

const b64url = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");

async function accessToken(sa: ServiceAccount): Promise<string> {
  const c = cache();
  if (c.token && c.token.expiresAt - 60_000 > Date.now()) return c.token.value;
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64url({ alg: "RS256", typ: "JWT" })}.${b64url({ iss: sa.client_email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 })}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(sa.private_key).toString("base64url");
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${signature}` }),
  });
  const json = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
  if (!res.ok || !json.access_token) throw new Error(`Google OAuth token request failed (${res.status}): ${json.error ?? "no token"}`);
  c.token = { value: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 };
  return c.token.value;
}

/** FCM puts the useful code (UNREGISTERED, …) in error.details[].errorCode. */
function fcmErrorCode(body: unknown): string {
  const err = (body as { error?: { status?: string; details?: { errorCode?: string }[] } })?.error;
  return err?.details?.find((d) => d?.errorCode)?.errorCode ?? err?.status ?? "UNKNOWN";
}

export async function sendFcm(message: Record<string, unknown>): Promise<SendResult> {
  const sa = cache().sa;
  if (!sa) return { ok: false, status: 0, errorCode: "NOT_CONFIGURED", message: "FIREBASE_SERVICE_ACCOUNT is not set" };
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
    method: "POST",
    headers: { Authorization: `Bearer ${await accessToken(sa)}`, "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  });
  if (res.ok) return { ok: true };
  const json = await res.json().catch(() => ({}));
  if (res.status === 401) cache().token = null;
  return { ok: false, status: res.status, errorCode: fcmErrorCode(json), message: (json as { error?: { message?: string } })?.error?.message ?? "" };
}
