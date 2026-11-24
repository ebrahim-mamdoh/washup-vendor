import "server-only";

import { MockApiError, ok } from "../../http";
import {
  adminAttachEmail,
  adminUserEmail,
  changePassword,
  portalOrigin,
  refreshSession,
  sendRecoveryEmail,
  sessionTokens,
  setPasswordWithAccessToken,
  signInWithPassword,
  signOut,
} from "../auth";
import { staffPhoneFor } from "../locale";
import { logAudit } from "../platform";
import { vroute } from "../router";
import { db } from "../sql";
import { resolveVendorActor, toVendorAccount } from "./scope";

export const vendorAuthRoutes = [
  vroute(
    "POST",
    "/vendor/auth/login",
    async ({ body }) => {
      const password = String(body.password ?? "");
      const sql = db();
      // Any supported country (GAP-013): E.164 as typed, or a national number (see staffPhoneFor).
      const phone = await staffPhoneFor(sql, String(body.phone ?? ""));
      if (!phone || !password) {
        throw new MockApiError("رقم الموبايل وكلمة المرور مطلوبان", 422);
      }
      const [profile] = await sql<{ id: string }[]>`select id from public.staff where phone = ${phone}`;
      const session = await signInWithPassword({ phone }, password, profile?.id ?? null);
      if (!session) throw new MockApiError("رقم الموبايل أو كلمة المرور غير صحيحة", 401);

      const [staff] = await sql<{ id: string; status: string; role: string; branch_id: string | null }[]>`
        select id, status, role, branch_id from public.staff
        where ${session.identity.kind === "supabase" ? sql`user_id = ${session.identity.userId}` : sql`id = ${session.identity.profileId}`}`;
      if (!staff) throw new MockApiError("هذا الحساب غير مرتبط بموظف في أي مغسلة", 403);
      if (staff.status !== "active") throw new MockApiError("هذا الحساب موقوف. تواصل مع مالك المغسلة.", 403);
      const actor = await resolveVendorActor(sql, session.identity);
      if (!actor) throw new MockApiError("لا توجد مغسلة معتمدة مرتبطة بهذا الحساب", 403);

      await logAudit(sql, { actorType: "staff", actorId: actor.staff.id, action: "vendor.login", entity: "staff", entityId: actor.staff.id, branchId: staff.branch_id });
      return ok({ ...sessionTokens(session), account: await toVendorAccount(sql, actor) }, "تم تسجيل الدخول بنجاح");
    },
    true,
  ),

  // Renews an expiring session; the account is re-checked (a suspended staff member can't refresh).
  vroute(
    "POST",
    "/vendor/auth/refresh",
    async ({ body }) => {
      const session = await refreshSession(String(body.refresh_token ?? ""));
      const actor = session ? await resolveVendorActor(db(), session.identity) : null;
      if (!session || !actor) throw new MockApiError("انتهت الجلسة، يرجى تسجيل الدخول مرة أخرى", 401);
      return ok(sessionTokens(session));
    },
    true,
  ),

  vroute("GET", "/vendor/auth/me", async ({ actor }) => ok(await toVendorAccount(db(), actor))),

  vroute("POST", "/vendor/auth/logout", async ({ token }) => {
    if (token) await signOut(token);
    return ok(null, "تم تسجيل الخروج");
  }),

  vroute("POST", "/vendor/auth/change-password", async ({ body, token, actor }) => {
    const currentPassword = String(body.currentPassword ?? "");
    const newPassword = String(body.newPassword ?? "");
    if (!currentPassword || !newPassword) throw new MockApiError("كلمة المرور الحالية والجديدة مطلوبتان", 422);
    const sql = db();
    const [row] = await sql<{ phone: string }[]>`select phone from public.staff where id = ${actor.staff.id}`;
    if (!token || !row) throw new MockApiError("انتهت الجلسة، يرجى تسجيل الدخول مرة أخرى", 401);
    await changePassword(token, row.phone, currentPassword, newPassword);
    return ok(null, "تم تغيير كلمة المرور");
  }),

  vroute(
    "POST",
    "/vendor/auth/forgot-password",
    async ({ body }) => {
      const sql = db();
      const phone = await staffPhoneFor(sql, String(body.phone ?? ""));
      if (!phone) throw new MockApiError("رقم الموبايل مطلوب", 422, { phone: ["مطلوب"] });
      const [staff] = await sql<{ userId: string | null; businessId: string }[]>`
        select user_id as "userId", business_id as "businessId" from public.staff where phone = ${phone}`;
      if (!staff?.userId) {
        throw new MockApiError("لا يمكن استرجاع كلمة المرور لهذا الحساب. تواصل مع الدعم.", 422);
      }
      let email = await adminUserEmail(staff.userId);
      if (!email || email.endsWith("@partner.washup.app") || email.endsWith("@carzen.demo")) {
        const [settings] = await sql<{ email: string | null }[]>`
          select contact_email as email from public.business_settings where business_id = ${staff.businessId}`;
        const fallback = settings?.email?.trim() ?? "";
        if (fallback.includes("@")) {
          const attached = await adminAttachEmail(staff.userId, fallback);
          if (attached) email = fallback;
        }
      }
      if (!email) throw new MockApiError("لا يوجد بريد إلكتروني مرتبط بهذا الحساب. أضف بريد المغسلة من الإعدادات أو تواصل مع الدعم.", 422);
      await sendRecoveryEmail(email, `${portalOrigin()}/reset-password`);
      return ok(null, "أرسلنا رابط استرجاع كلمة المرور إلى البريد المرتبط بالحساب");
    },
    true,
  ),

  vroute(
    "POST",
    "/vendor/auth/reset-password",
    async ({ body }) => {
      const accessToken = String(body.access_token ?? body.accessToken ?? "");
      const newPassword = String(body.newPassword ?? "");
      if (!accessToken) throw new MockApiError("رابط الاسترجاع غير صالح أو منتهٍ", 401);
      await setPasswordWithAccessToken(accessToken, newPassword);
      return ok(null, "تم تعيين كلمة المرور الجديدة — سجّل الدخول");
    },
    true,
  ),
];
