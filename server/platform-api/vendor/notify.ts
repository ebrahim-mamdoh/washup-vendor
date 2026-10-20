import "server-only";

import type { VendorNotificationType } from "@/types/vendor/catalog";
import { nid, now } from "../db";
import { MockApiError } from "../http";
import type { MockDatabase, VendorBusinessSettings } from "../schema";

export const DEFAULT_NOTIFICATION_PREFS: Record<VendorNotificationType, boolean> = {
  new_booking: true,
  booking_cancelled: true,
  cash_difference: true,
  high_cancellation: true,
  branch_issue: true,
  daily_summary: true,
  review: true,
  platform: true,
  payout: true,
};

/** Known preference keys with boolean values only, merged over `current`; anything else is a 422. */
export function cleanNotificationPrefs(raw: unknown, current: Record<VendorNotificationType, boolean>): Record<VendorNotificationType, boolean> {
  const out = { ...DEFAULT_NOTIFICATION_PREFS, ...current };
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!Object.hasOwn(DEFAULT_NOTIFICATION_PREFS, key) || typeof value !== "boolean") {
      throw new MockApiError("إعدادات الإشعارات غير صالحة", 422, { notificationPrefs: [key] });
    }
    out[key as VendorNotificationType] = value;
  }
  return out;
}

/** Booking slot length: one of the offered intervals, else a 422 (never silently changed). */
export function slotInterval(raw: unknown): number {
  const n = Number(raw);
  if (![15, 20, 30, 45, 60].includes(n)) throw new MockApiError("مدة الموعد يجب أن تكون 15 أو 20 أو 30 أو 45 أو 60 دقيقة", 422);
  return n;
}

export function vendorSettingsFor(db: MockDatabase, businessId: string): VendorBusinessSettings {
  if (!db.vendorSettings[businessId]) {
    db.vendorSettings[businessId] = {
      managerCanEditServices: false,
      phone: "",
      email: "",
      notificationPrefs: { ...DEFAULT_NOTIFICATION_PREFS },
    };
  }
  return db.vendorSettings[businessId];
}

/**
 * Adds a notification to the wash's inbox (owner + managers), unless the owner
 * muted that type. Used by both the vendor API and admin actions, so platform
 * decisions (suspension, payouts, moderation) reach the wash in real time.
 */
export function pushVendorNotification(
  db: MockDatabase,
  businessId: string,
  branchId: string | null,
  type: VendorNotificationType,
  title: string,
  body: string,
  href: string,
) {
  // Platform notices are always delivered; everything else respects preferences.
  if (type !== "platform" && !vendorSettingsFor(db, businessId).notificationPrefs[type]) return;
  db.vendorNotifications.unshift({
    id: nid("vn"),
    businessId,
    branchId,
    type,
    title: { ar: title, en: title },
    body: { ar: body, en: body },
    href,
    read: false,
    createdAt: now().toISOString(),
  });
}
