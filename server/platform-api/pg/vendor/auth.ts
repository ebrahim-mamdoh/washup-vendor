import "server-only";

import { MockApiError, ok } from "../../http";
import { normalizePhone } from "../../vendor/engine";
import { signInWithPassword, signOut } from "../auth";
import { e164 } from "../entities";
import { logAudit } from "../platform";
import { vroute } from "../router";
import { db } from "../sql";
import { resolveVendorActor, toVendorAccount } from "./scope";

export const vendorAuthRoutes = [
  vroute(
    "POST",
    "/vendor/auth/login",
    async ({ body }) => {
      const phone = normalizePhone(String(body.phone ?? ""));
      const password = String(body.password ?? "");
      if (phone.length !== 10 || !password) {
        throw new MockApiError("رقم الموبايل وكلمة المرور مطلوبان", 422);
      }
      const sql = db();
      const [profile] = await sql<{ id: string }[]>`select id from public.staff where phone = ${e164(phone)}`;
      const session = await signInWithPassword({ phone: e164(phone) }, password, profile?.id ?? null);
      if (!session) throw new MockApiError("رقم الموبايل أو كلمة المرور غير صحيحة", 401);

      const [staff] = await sql<{ id: string; status: string; role: string; branch_id: string | null }[]>`
        select id, status, role, branch_id from public.staff
        where ${session.identity.kind === "supabase" ? sql`user_id = ${session.identity.userId}` : sql`id = ${session.identity.profileId}`}`;
      if (!staff) throw new MockApiError("هذا الحساب غير مرتبط بموظف في أي مغسلة", 403);
      if (staff.status !== "active") throw new MockApiError("هذا الحساب موقوف. تواصل مع مالك المغسلة.", 403);
      if (staff.role === "employee") {
        throw new MockApiError("بوابة الشركاء مخصصة للمالك ومديري الفروع. الموظفون يستخدمون تطبيق الموظف.", 403);
      }
      const actor = await resolveVendorActor(sql, session.identity);
      if (!actor) throw new MockApiError("لا توجد مغسلة معتمدة مرتبطة بهذا الحساب", 403);

      await logAudit(sql, { actorType: "staff", actorId: actor.staff.id, action: "vendor.login", entity: "staff", entityId: actor.staff.id, branchId: staff.branch_id });
      return ok(
        { access_token: session.token, token_type: "Bearer", account: await toVendorAccount(sql, actor) },
        "تم تسجيل الدخول بنجاح",
      );
    },
    true,
  ),

  vroute("GET", "/vendor/auth/me", async ({ actor }) => ok(await toVendorAccount(db(), actor))),

  vroute("POST", "/vendor/auth/logout", async ({ token }) => {
    if (token) await signOut(token);
    return ok(null, "تم تسجيل الخروج");
  }),
];
