import "server-only";

import { ok } from "../http";
import { route } from "../router";

/** Browser push needs the Supabase data source (push_devices + FCM); the mock store accepts and ignores it. */
export const pushRoutes = [
  route("POST", "/admin/push/register", () => ok(null, "الإشعارات على المتصفح تعمل مع مصدر بيانات Supabase فقط")),
  route("POST", "/admin/push/unregister", () => ok(null)),
];
