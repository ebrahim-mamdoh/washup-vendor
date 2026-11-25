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
import { unregisterDevice } from "../push";
import { logAudit } from "../platform";
import { vroute } from "../router";
import { db } from "../sql";
import { staffUserId } from "./push";
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

  vroute("POST", "/vendor/auth/logout", async ({ token, body, actor }) => {
    // GAP-049: forget THIS device's push token (same field as /vendor/push/unregister: `token`;
    // `pushToken` also accepted). Only that row of this user is deleted, never other devices.
    const pushToken = typeof body.pushToken === "string" ? body.pushToken : typeof body.token === "string" ? body.token : "";
    if (pushToken) await unregisterDevice(db(), await staffUserId(actor.staff.id), { token: pushToken }).catch(() => undefined);
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

      // GAP-066: one answer whether or not the number has an account (no account enumeration).
      const answer = ok(
        null,
        "لو الرقم مسجل عندنا وله بريد إلكتروني، هيوصلك رابط استرجاع كلمة المرور خلال دقائق. لو ماوصلش، تواصل مع مالك المغسلة أو الدعم.",
      );
      const [staff] = await sql<{ userId: string | null; businessId: string; role: string }[]>`
        select user_id as "userId", business_id as "businessId", role from public.staff where phone = ${phone}`;
      if (!staff?.userId) return answer;

      try {
        let email = await adminUserEmail(staff.userId);
        // The business contact e-mail may become the login e-mail of the OWNER only: attaching it to a
        // manager's or employee's account would send their reset link to the owner's inbox — and this
        // is a public call, so anyone could trigger that re-pointing.
        const placeholder = !email || email.endsWith("@partner.washup.app") || email.endsWith("@carzen.demo");
        if (placeholder && staff.role === "owner") {
          const [settings] = await sql<{ email: string | null }[]>`
            select contact_email as email from public.business_settings where business_id = ${staff.businessId}`;
          const fallback = settings?.email?.trim() ?? "";
          if (fallback.includes("@") && (await adminAttachEmail(staff.userId, fallback))) email = fallback;
        } else if (placeholder) {
          email = null;
        }
        if (email) await sendRecoveryEmail(email, `${portalOrigin()}/reset-password`);
      } catch (error) {
        console.error("[forgot-password]", error);
      }
      return answer;
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
