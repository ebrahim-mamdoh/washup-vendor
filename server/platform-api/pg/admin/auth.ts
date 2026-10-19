import "server-only";

import type { AdminUser } from "@/types/auth";

import { MockApiError, ok } from "../../http";
import { type Identity, signInWithPassword, signOut } from "../auth";
import { adminsWhere } from "../entities";
import { logAudit } from "../platform";
import { route } from "../router";
import { type Q, db } from "../sql";

/** Signed-in identity → active admin profile, or null. */
export async function resolveAdmin(q: Q, identity: Identity): Promise<AdminUser | null> {
  const [admin] =
    identity.kind === "supabase"
      ? await adminsWhere(q, q`a.user_id = ${identity.userId}`)
      : await adminsWhere(q, q`a.id = ${identity.profileId}`);
  return admin && admin.status === "active" ? admin : null;
}

export const authRoutes = [
  route(
    "POST",
    "/admin/auth/login",
    async ({ body }) => {
      const email = String(body.email ?? "").trim().toLowerCase();
      const password = String(body.password ?? "");
      if (!email || !password) {
        throw new MockApiError("البريد الإلكتروني وكلمة المرور مطلوبان", 422);
      }

      const sql = db();
      const [profile] = await adminsWhere(sql, sql`lower(a.email) = ${email}`);
      const session = await signInWithPassword({ email }, password, profile?.id ?? null);
      if (!session) throw new MockApiError("البريد الإلكتروني أو كلمة المرور غير صحيحة", 401);

      const [admin] =
        session.identity.kind === "supabase"
          ? await adminsWhere(sql, sql`a.user_id = ${session.identity.userId}`)
          : await adminsWhere(sql, sql`a.id = ${session.identity.profileId}`);
      if (!admin) throw new MockApiError("هذا الحساب غير مرتبط بملف إداري في كارزن", 403);
      if (admin.status !== "active") {
        throw new MockApiError("هذا الحساب موقوف. تواصل مع مدير النظام.", 403);
      }
      if (admin.role !== "super") {
        throw new MockApiError(
          "هذه اللوحة مخصصة لحسابات Super Admin فقط. استخدم لوحة الإدارة العامة لدورك.",
          403,
        );
      }

      const [updated] = await sql<{ lastLoginAt: string }[]>`
        update public.admin_users set last_login_at = now() where id = ${admin.id} returning last_login_at as "lastLoginAt"`;
      await logAudit(sql, { actorId: admin.id, action: "admin.login", entity: "admins", entityId: admin.id });

      return ok(
        { access_token: session.token, token_type: "Bearer", admin: { ...admin, lastLoginAt: updated.lastLoginAt } },
        "تم تسجيل الدخول بنجاح",
      );
    },
    true,
  ),

  route("GET", "/admin/auth/me", async ({ admin }) => ok(admin)),

  route("POST", "/admin/auth/logout", async ({ token }) => {
    if (token) await signOut(token);
    return ok(null, "تم تسجيل الخروج");
  }),
];
