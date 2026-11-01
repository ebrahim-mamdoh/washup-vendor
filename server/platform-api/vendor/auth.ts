import "server-only";

import { logAudit, nid } from "../db";
import { MockApiError, ok } from "../http";
import { vroute } from "../router";
import { normalizePhone } from "./engine";
import { resolveVendorActor, toVendorAccount } from "./scope";

export const vendorAuthRoutes = [
  vroute(
    "POST",
    "/vendor/auth/login",
    ({ db, body }) => {
      const phone = normalizePhone(String(body.phone ?? ""));
      const password = String(body.password ?? "");
      if (phone.length !== 10 || !password) {
        throw new MockApiError("رقم الموبايل وكلمة المرور مطلوبان", 422);
      }
      const staff = db.staff.find((s) => normalizePhone(s.phone) === phone);
      if (!staff || db.staffPasswords[staff.id] !== password) {
        throw new MockApiError("رقم الموبايل أو كلمة المرور غير صحيحة", 401);
      }
      if (staff.status !== "active") throw new MockApiError("هذا الحساب موقوف. تواصل مع مالك المغسلة.", 403);
      const business = db.businesses.find((b) => b.id === staff.businessId);
      if (!business || business.status === "rejected") {
        throw new MockApiError("لا توجد مغسلة معتمدة مرتبطة بهذا الحساب", 403);
      }

      const token = `vp_${nid("tok")}_${Math.random().toString(36).slice(2, 10)}`;
      db.vendorSessions[token] = staff.id;
      const actor = resolveVendorActor(db, token)!;
      logAudit(db, { actorType: "staff", actorId: staff.id, action: "vendor.login", entity: "staff", entityId: staff.id, branchId: staff.branchId });
      // Mock sessions don't expire: the token is its own refresh token.
      return ok(
        { access_token: token, token_type: "Bearer", refresh_token: token, expires_in: null, account: toVendorAccount(db, actor) },
        "تم تسجيل الدخول بنجاح",
      );
    },
    true,
  ),

  vroute(
    "POST",
    "/vendor/auth/refresh",
    ({ db, body }) => {
      const token = String(body.refresh_token ?? "");
      if (!resolveVendorActor(db, token)) throw new MockApiError("انتهت الجلسة، يرجى تسجيل الدخول مرة أخرى", 401);
      return ok({ access_token: token, token_type: "Bearer", refresh_token: token, expires_in: null });
    },
    true,
  ),

  vroute("GET", "/vendor/auth/me", ({ db, actor }) => ok(toVendorAccount(db, actor))),

  vroute("POST", "/vendor/auth/logout", ({ db, token }) => {
    if (token) delete db.vendorSessions[token];
    return ok(null, "تم تسجيل الخروج");
  }),

  vroute("POST", "/vendor/auth/change-password", ({ db, body, actor }) => {
    const currentPassword = String(body.currentPassword ?? "");
    const newPassword = String(body.newPassword ?? "");
    if (newPassword.length < 8) throw new MockApiError("كلمة المرور الجديدة 8 أحرف على الأقل", 422);
    if (db.staffPasswords[actor.staff.id] !== currentPassword) throw new MockApiError("كلمة المرور الحالية غير صحيحة", 401);
    db.staffPasswords[actor.staff.id] = newPassword;
    return ok(null, "تم تغيير كلمة المرور");
  }),

  vroute(
    "POST",
    "/vendor/auth/forgot-password",
    () => {
      throw new MockApiError("استرجاع كلمة المرور متاح على بيئة الإنتاج (Supabase) فقط", 422);
    },
    true,
  ),

  vroute(
    "POST",
    "/vendor/auth/reset-password",
    () => {
      throw new MockApiError("استرجاع كلمة المرور متاح على بيئة الإنتاج (Supabase) فقط", 422);
    },
    true,
  ),
];
