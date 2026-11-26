import "server-only";

import type { PermissionKey } from "@/types/admins";
import type { AdminNotificationType } from "@/types/notifications";

/*
 * Which roles-matrix module an admin notification belongs to (GAP-012/095). Push delivery
 * (`pg/push.ts`, run by either app's push hook) and the Super Admin's notification list use it.
 * Byte-identical in both repos (`npm run check:shared`, GAP-054).
 */

/** Module whose view permission an admin needs to see a notification type (null: notifications permission only). */
export const NOTIFICATION_MODULE: Record<AdminNotificationType, PermissionKey | null> = {
  application: "applications",
  complaint: "complaints",
  critical_review: "reviews",
  payment_issue: "finance",
  finance_flag: "finance",
  unusual_activity: null,
  system: null,
};
