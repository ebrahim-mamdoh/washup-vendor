import "server-only";

import { timingSafeEqual } from "node:crypto";

import { after } from "next/server";

import type { Localized } from "@/types/common";

import { MockApiError } from "../http";
import { isPushConfigured, sendFcm } from "./fcm";
import { type Q, db } from "./sql";

/**
 * Browser push for the two panels (web FCM, same Firebase project as the
 * customer app). Devices live in `push_devices` (platform `web`; app `partner`
 * for the wash portal, `admin` for the Super Admin).
 *
 * A notification is pushed:
 * - when a panel creates it (`pushVendorNotification` / `pushAdminNotification`):
 *   queued with `after()`, so it runs once the response is sent, i.e. after the
 *   transaction committed (a rolled-back row is not found and nothing is sent);
 * - when the database creates it (customer-app bookings, applications,
 *   complaints): the trigger calls `POST /api/v1/{vendor|admin}/push/hook`.
 *
 * Messages are data-only; the panel's service worker shows them (`public/push-sw.js`).
 */
export type PushTarget = "vendor" | "admin";

type PushRow = { id: string; type: string; title: Localized; body: Localized; href: string | null };

export type PushOutcome = { sent: number; removed: number; failed: number } | null;

/** Pushes a notification row after the current response; no-op when push is not configured. */
export function queuePush(target: PushTarget, id: string): void {
  if (!isPushConfigured()) return;
  const run = () => deliverPush(target, id).catch((e) => console.error(`[push] ${target} ${id}:`, e));
  try {
    after(run);
  } catch {
    // Outside a request (scripts): send in the background.
    setTimeout(run, 0);
  }
}

async function recipientsOf(q: Q, target: PushTarget, id: string): Promise<{ row: PushRow; tokens: string[] } | null> {
  if (target === "vendor") {
    const [n] = await q<(PushRow & { businessId: string; branchId: string | null; staffId: string | null })[]>`
      select id, business_id as "businessId", branch_id as "branchId", staff_id as "staffId", type::text as type, title, body, href
      from public.vendor_notifications where id = ${id}`;
    if (!n) return null;
    // Owner and the branch's managers (every manager for a business-wide notice), or the one addressee.
    const tokens = await q<{ token: string }[]>`
      select distinct d.token from public.push_devices d
      join public.staff s on s.user_id = d.user_id
      where d.app = 'partner' and s.business_id = ${n.businessId} and s.status = 'active'
        and (${n.staffId}::text is not null and s.id = ${n.staffId}
             or ${n.staffId}::text is null and (s.role = 'owner'
                or s.role = 'manager' and (${n.branchId}::text is null or s.branch_id = ${n.branchId})))`;
    return { row: n, tokens: tokens.map((t) => t.token) };
  }
  const [n] = await q<PushRow[]>`select id, type::text as type, title, body, href from public.admin_notifications where id = ${id}`;
  if (!n) return null;
  const tokens = await q<{ token: string }[]>`
    select distinct d.token from public.push_devices d
    join public.admin_users a on a.user_id = d.user_id
    where a.status = 'active' and d.app in ('admin', 'partner')`;
  return { row: n, tokens: tokens.map((t) => t.token) };
}

/** Sends one notification to every device of its recipients; drops tokens FCM no longer knows. */
export async function deliverPush(target: PushTarget, id: string): Promise<PushOutcome> {
  const sql = db();
  const found = await recipientsOf(sql, target, id);
  if (!found || !found.tokens.length) return found ? { sent: 0, removed: 0, failed: 0 } : null;
  const { row, tokens } = found;
  const data = {
    id: row.id,
    type: row.type,
    title: row.title?.ar || row.title?.en || "Carzen",
    body: row.body?.ar || row.body?.en || "",
    href: row.href || "/notifications",
    app: target,
  };
  const results = await Promise.all(
    tokens.map((token) =>
      sendFcm({ token, data, webpush: { headers: { Urgency: "high", TTL: "86400" } } }).catch((e) => ({
        ok: false as const,
        status: 0,
        errorCode: "NETWORK",
        message: String(e?.message ?? e),
      })),
    ),
  );
  const dead = tokens.filter((_, i) => {
    const r = results[i];
    return !r.ok && (r.errorCode === "UNREGISTERED" || (r.errorCode === "INVALID_ARGUMENT" && r.message.includes("token")));
  });
  if (dead.length) await sql`delete from public.push_devices where token = any(${dead})`;
  const sent = results.filter((r) => r.ok).length;
  results.forEach((r, i) => {
    if (!r.ok && !dead.includes(tokens[i])) console.error(`[push] ${target} ${id} -> ${tokens[i].slice(0, 8)}…: ${r.status} ${r.errorCode} ${r.message}`);
  });
  return { sent, removed: dead.length, failed: tokens.length - sent - dead.length };
}

/** Saves this browser's FCM token for a signed-in panel user (one row per token). */
export async function registerDevice(q: Q, userId: string | null, app: "partner" | "admin", body: Record<string, unknown>) {
  const token = typeof body.token === "string" ? body.token.trim() : "";
  if (token.length < 20 || token.length > 4096) throw new MockApiError("رمز الجهاز غير صالح", 422);
  if (!userId) throw new MockApiError("الإشعارات على المتصفح تحتاج حساب دخول على Supabase", 409);
  const version = typeof body.appVersion === "string" ? body.appVersion.slice(0, 60) : null;
  const save = (a: string) => q`
    insert into public.push_devices (user_id, app, platform, token, app_version, last_seen_at)
    values (${userId}, ${a}, 'web', ${token}, ${version}, now())
    on conflict (token) do update set user_id = excluded.user_id, app = excluded.app, platform = 'web',
      app_version = excluded.app_version, last_seen_at = now()`;
  try {
    await save(app);
  } catch (error) {
    // Until push_devices_app_check allows 'admin' (migration 20261021100000), admins register as 'partner'.
    if (app === "admin" && (error as { code?: string }).code === "23514") await save("partner");
    else throw error;
  }
}

export async function unregisterDevice(q: Q, userId: string | null, body: Record<string, unknown>) {
  const token = typeof body.token === "string" ? body.token.trim() : "";
  if (!token || !userId) return;
  await q`delete from public.push_devices where token = ${token} and user_id = ${userId}`;
}

/**
 * Database-trigger entry point: `x-webhook-secret` must match PUSH_WEBHOOK_SECRET
 * (the same value is stored in Vault for the trigger). Fails closed.
 */
export async function handlePushHook(target: PushTarget, secret: string | null, body: Record<string, unknown>) {
  const expected = process.env.PUSH_WEBHOOK_SECRET ?? "";
  const given = Buffer.from(secret ?? "");
  if (!expected || given.length !== Buffer.byteLength(expected) || !timingSafeEqual(given, Buffer.from(expected))) {
    throw new MockApiError("غير مصرح", 401);
  }
  const id = typeof body.id === "string" ? body.id : "";
  if (!id) throw new MockApiError("معرّف الإشعار مطلوب", 422);
  return deliverPush(target, id);
}
