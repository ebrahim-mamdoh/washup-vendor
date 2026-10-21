import "server-only";

import type { Localized } from "@/types/common";
import type { AdminNotificationType } from "@/types/notifications";
import type { ActorType } from "@/types/orders";
import type { VendorNotificationType } from "@/types/vendor/catalog";

import type { VendorBusinessSettings } from "../schema";
import { DEFAULT_NOTIFICATION_PREFS } from "../vendor/notify";
import { apiPhone } from "./entities";
import { queuePush } from "./push";
import type { Q } from "./sql";

/**
 * Cross-cutting writes every module shares: the audit log, admin and vendor
 * notifications, plus platform-level reads (default commission, wash settings).
 * Same rules as the mock helpers in `../db.ts` and `../vendor/notify.ts`.
 */

const toText = (v: unknown) => (v === undefined || v === null ? null : typeof v === "string" ? v : JSON.stringify(v));

export async function logAudit(
  q: Q,
  entry: {
    actorId: string;
    action: string;
    entity: string;
    entityId: string;
    oldValue?: unknown;
    newValue?: unknown;
    reason?: string | null;
    branchId?: string | null;
    actorType?: ActorType;
  },
): Promise<void> {
  await q`
    insert into public.audit_logs (actor_type, actor_id, actor_name, action, entity, entity_id, branch_id, old_value, new_value, reason, at)
    values (
      ${entry.actorType ?? "admin"}, ${entry.actorId},
      coalesce((select name from public.admin_users where id = ${entry.actorId}), (select name from public.staff where id = ${entry.actorId})),
      ${entry.action}, ${entry.entity}, ${entry.entityId},
      (select id from public.branches where id = ${entry.branchId ?? null}),
      ${toText(entry.oldValue)}, ${toText(entry.newValue)}, ${entry.reason?.trim() || null},
      -- clock_timestamp, not now(): entries written in one transaction keep their order.
      clock_timestamp()
    )`;
}

export async function pushAdminNotification(
  q: Q,
  type: AdminNotificationType,
  title: Localized,
  body: Localized,
  href: string,
): Promise<void> {
  const [row] = await q<{ id: string }[]>`
    insert into public.admin_notifications (type, title, body, href) values (${type}, ${q.json(title)}, ${q.json(body)}, ${href}) returning id`;
  queuePush("admin", row.id);
}

export async function vendorSettingsFor(q: Q, businessId: string): Promise<VendorBusinessSettings> {
  const [row] = await q<{ m: boolean; phone: string | null; email: string | null; prefs: Record<string, boolean> }[]>`
    select manager_can_edit_services as m, contact_phone as phone, contact_email as email, notification_prefs as prefs
    from public.business_settings where business_id = ${businessId}`;
  return {
    managerCanEditServices: row?.m ?? false,
    phone: apiPhone(row?.phone ?? null),
    email: row?.email ?? "",
    notificationPrefs: { ...DEFAULT_NOTIFICATION_PREFS, ...(row?.prefs ?? {}) },
  };
}

/**
 * Adds a notification to the wash's inbox (owner + managers), unless the owner
 * muted that type. Platform notices are always delivered.
 */
export async function pushVendorNotification(
  q: Q,
  businessId: string,
  branchId: string | null,
  type: VendorNotificationType,
  title: string,
  body: string,
  href: string,
): Promise<void> {
  if (type !== "platform" && !(await vendorSettingsFor(q, businessId)).notificationPrefs[type]) return;
  const [row] = await q<{ id: string }[]>`
    insert into public.vendor_notifications (business_id, branch_id, type, title, body, href)
    values (${businessId}, ${branchId}, ${type}, ${q.json({ ar: title, en: title })}, ${q.json({ ar: body, en: body })}, ${href})
    returning id`;
  queuePush("vendor", row.id);
}

export async function defaultCommissionPct(q: Q): Promise<number> {
  const [row] = await q<{ pct: number | null }[]>`select (value ->> 'defaultPct')::numeric as pct from public.platform_settings where key = 'commission'`;
  return row?.pct ?? 7;
}
