import "server-only";

import { ok } from "../../http";
import { handlePushHook, registerDevice, unregisterDevice } from "../push";
import { route } from "../router";
import { db } from "../sql";

/** The signed-in admin's Supabase Auth user (null with local auth). */
async function adminUserId(adminId: string): Promise<string | null> {
  const [row] = await db()<{ userId: string | null }[]>`select user_id as "userId" from public.admin_users where id = ${adminId}`;
  return row?.userId ?? null;
}

/** Browser push for the Super Admin (see `../push.ts`). */
export const pushRoutes = [
  route("POST", "/admin/push/register", async ({ body, admin }) => {
    await registerDevice(db(), await adminUserId(admin.id), "admin", body);
    return ok(null, "تم تفعيل الإشعارات على هذا المتصفح");
  }),

  route("POST", "/admin/push/unregister", async ({ body, admin }) => {
    await unregisterDevice(db(), await adminUserId(admin.id), body);
    return ok(null, "تم إيقاف الإشعارات على هذا المتصفح");
  }),

  // Called by database triggers for notifications they create (applications, complaints…).
  route("POST", "/admin/push/hook", async ({ body, headers }) => ok(await handlePushHook("admin", headers.get("x-webhook-secret"), body)), true),
];
