import "server-only";

import type { VendorNotificationType } from "@/types/vendor/catalog";
import { MockApiError } from "../http";
import { DEFAULT_NOTIFICATION_PREFS } from "../shared/notify";

// Inbox helpers shared with the Super Admin live in `../shared/notify` (GAP-054).
export { DEFAULT_NOTIFICATION_PREFS, pushVendorNotification, vendorSettingsFor } from "../shared/notify";

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
