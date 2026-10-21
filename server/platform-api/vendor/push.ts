import "server-only";

import { ok } from "../http";
import { vroute } from "../router";

/** Browser push needs the Supabase data source (push_devices + FCM); the mock store accepts and ignores it. */
export const vendorPushRoutes = [
  vroute("POST", "/vendor/push/register", () => ok(null, "الإشعارات على المتصفح تعمل مع مصدر بيانات Supabase فقط")),
  vroute("POST", "/vendor/push/unregister", () => ok(null)),
];
