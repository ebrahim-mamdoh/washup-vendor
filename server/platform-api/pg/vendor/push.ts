import "server-only";

import { ok } from "../../http";
import { handlePushHook, registerDevice, unregisterDevice } from "../push";
import { vroute } from "../router";
import { db } from "../sql";

/** The signed-in staff member's Supabase Auth user (null with local auth). */
async function staffUserId(staffId: string): Promise<string | null> {
  const [row] = await db()<{ userId: string | null }[]>`select user_id as "userId" from public.staff where id = ${staffId}`;
  return row?.userId ?? null;
}

/** Browser push for the wash portal (see `../push.ts`). */
export const vendorPushRoutes = [
  vroute("POST", "/vendor/push/register", async ({ body, actor }) => {
    await registerDevice(db(), await staffUserId(actor.staff.id), "partner", body);
    return ok(null, "تم تفعيل الإشعارات على هذا المتصفح");
  }),

  vroute("POST", "/vendor/push/unregister", async ({ body, actor }) => {
    await unregisterDevice(db(), await staffUserId(actor.staff.id), body);
    return ok(null, "تم إيقاف الإشعارات على هذا المتصفح");
  }),

  // Called by database triggers for notifications they create (customer-app bookings…).
  vroute("POST", "/vendor/push/hook", async ({ body, headers }) => ok(await handlePushHook("vendor", headers.get("x-webhook-secret"), body)), true),
];
