import "server-only";

import type { PermissionKey, PermissionLevel, RolesMatrix } from "@/types/admins";
import type { AdminRole, AdminUser } from "@/types/auth";

import { MockApiError, ok, requireText } from "../../http";
import { DEFAULT_ROLES_MATRIX } from "../../seed";
import { isLocalAuth } from "../auth";
import { adminsWhere } from "../entities";
import { logAudit } from "../platform";
import { route } from "../router";
import { type Q, db, tx } from "../sql";

const ROLES: AdminRole[] = ["super", "operations", "finance", "support"];
const LEVELS: PermissionLevel[] = ["none", "view", "manage"];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Permission keys in the matrix's display order (same order as the mock's seeded matrix). */
const PERMISSION_KEYS = Object.keys(DEFAULT_ROLES_MATRIX.super) as PermissionKey[];

async function adminById(q: Q, id: string): Promise<AdminUser> {
  const [admin] = await adminsWhere(q, q`a.id = ${id}`);
  if (!admin) throw new MockApiError("المسؤول غير موجود", 404);
  return admin;
}

async function activeSupers(q: Q): Promise<number> {
  const [{ n }] = await q<{ n: number }[]>`select count(*)::int as n from public.admin_users where role = 'super' and status = 'active'`;
  return n;
}

/** `admin_role_permissions` rows → the roles matrix (every role × every key; missing rows read as "none"). */
async function rolesMatrix(q: Q): Promise<RolesMatrix> {
  const rows = await q<{ role: AdminRole; key: PermissionKey; level: PermissionLevel }[]>`
    select role, permission_key as key, level from public.admin_role_permissions`;
  const matrix = Object.fromEntries(
    ROLES.map((role) => [role, Object.fromEntries(PERMISSION_KEYS.map((key) => [key, "none"]))]),
  ) as RolesMatrix;
  for (const r of rows) if (matrix[r.role] && PERMISSION_KEYS.includes(r.key)) matrix[r.role][r.key] = r.level;
  return matrix;
}

export const adminRoutes = [
  // admin_role enum order is super → operations → finance → support (same as ROLES); within a role, oldest first
  // (the mock keeps insertion order — the seeded demo admins are the one place where that differs from created_at).
  route("GET", "/admin/admins", async () => {
    const sql = db();
    return ok(await adminsWhere(sql, sql`true`, sql`order by a.role, a.created_at, a.id`));
  }),

  /**
   * Creates the admin profile only. The Supabase Auth account is created or
   * invited separately and linked through admin_users.user_id (null until then).
   */
  route("POST", "/admin/admins", async ({ body, admin }) => {
    const name = requireText(body.name, "name", "الاسم", 3);
    const email = requireText(body.email, "email", "البريد الإلكتروني", 5).toLowerCase();
    if (!EMAIL_RE.test(email)) throw new MockApiError("صيغة البريد الإلكتروني غير صحيحة", 422, { email: ["صيغة البريد غير صحيحة"] });
    const role = String(body.role) as AdminRole;

    const record = await tx(async (t) => {
      const [taken] = await t`select 1 from public.admin_users where lower(email) = ${email}`;
      if (taken) throw new MockApiError("هذا البريد مستخدم بالفعل", 409, { email: ["هذا البريد مستخدم بالفعل"] });
      if (!ROLES.includes(role)) throw new MockApiError("اختر دورًا صالحًا", 422);
      const [row] = await t<{ id: string }[]>`
        insert into public.admin_users (name, email, role, status) values (${name}, ${email}, ${role}, 'active') returning id`;
      await logAudit(t, { actorId: admin.id, action: "create_admin_user", entity: "admins", entityId: row.id, newValue: { email, role } });
      return adminById(t, row.id);
    });
    // Local auth accepts the demo password for any active profile; on Supabase Auth the account is invited separately.
    const message = isLocalAuth()
      ? `تمت دعوة ${name} — كلمة المرور المؤقتة demo1234`
      : `تمت إضافة ${name} — أرسل له دعوة الدخول من Supabase Auth لتفعيل حسابه`;
    return ok(record, message);
  }),

  route("PATCH", "/admin/admins/:id", async ({ params, body, admin }) => {
    const target = await tx(async (t) => {
      const current = await adminById(t, params.id);
      if (body.role !== undefined) {
        const role = String(body.role) as AdminRole;
        if (!ROLES.includes(role)) throw new MockApiError("اختر دورًا صالحًا", 422);
        if (current.id === admin.id && role !== "super") throw new MockApiError("لا يمكنك تغيير دورك بنفسك", 409);
        if (current.role === "super" && role !== "super" && (await activeSupers(t)) <= 1) {
          throw new MockApiError("لا يمكن إزالة آخر Super Admin", 409);
        }
        await logAudit(t, {
          actorId: admin.id,
          action: "change_admin_role",
          entity: "admins",
          entityId: current.id,
          oldValue: current.role,
          newValue: role,
        });
        await t`update public.admin_users set role = ${role} where id = ${current.id}`;
      }
      if (typeof body.name === "string" && body.name.trim()) {
        await t`update public.admin_users set name = ${body.name.trim()} where id = ${current.id}`;
      }
      return adminById(t, current.id);
    });
    return ok(target, "تم تحديث المسؤول");
  }),

  route("POST", "/admin/admins/:id/status", async ({ params, body, admin }) => {
    const status = body.status === "inactive" ? "inactive" : "active";
    const target = await tx(async (t) => {
      const current = await adminById(t, params.id);
      const reason = requireText(body.reason, "reason", "السبب");
      if (current.id === admin.id) throw new MockApiError("لا يمكنك إيقاف حسابك", 409);
      if (status === "inactive" && current.role === "super" && (await activeSupers(t)) <= 1) {
        throw new MockApiError("لا يمكن إيقاف آخر Super Admin", 409);
      }
      // Open sessions end with the status: every request resolves the profile and rejects inactive admins.
      await t`update public.admin_users set status = ${status} where id = ${current.id}`;
      await logAudit(t, {
        actorId: admin.id,
        action: status === "inactive" ? "deactivate_admin" : "activate_admin",
        entity: "admins",
        entityId: current.id,
        oldValue: current.status,
        newValue: status,
        reason,
      });
      return adminById(t, current.id);
    });
    return ok(target, status === "inactive" ? "تم إيقاف الحساب وإنهاء جلساته" : "تم تفعيل الحساب");
  }),

  route("GET", "/admin/roles", async () => ok(await rolesMatrix(db()))),

  route("PUT", "/admin/roles", async ({ body, admin }) => {
    const reason = requireText(body.reason, "reason", "سبب التعديل", 5);
    const matrix = body.matrix as RolesMatrix | undefined;
    if (!matrix) throw new MockApiError("المصفوفة مطلوبة", 422);

    const { result, count } = await tx(async (t) => {
      const current = await rolesMatrix(t);
      const changes: string[] = [];
      const updates: { role: AdminRole; key: PermissionKey; level: PermissionLevel }[] = [];
      for (const role of ROLES) {
        if (role === "super") continue; // Super admin always keeps full access.
        for (const key of PERMISSION_KEYS) {
          const next = matrix[role]?.[key];
          if (!next || !LEVELS.includes(next)) continue;
          if (current[role][key] !== next) {
            if (key === "audit" && next === "manage") throw new MockApiError("سجل التدقيق للقراءة فقط ولا يمكن منح صلاحية إدارته", 422);
            changes.push(`${role}.${key}: ${current[role][key]} → ${next}`);
            updates.push({ role, key, level: next });
          }
        }
      }
      if (!changes.length) throw new MockApiError("لا توجد تغييرات للحفظ", 422);
      await t`
        insert into public.admin_role_permissions (role, permission_key, level)
        select u.role::public.admin_role, u.key, u.level::public.permission_level
        from jsonb_to_recordset(${t.json(updates)}::jsonb) as u(role text, key text, level text)
        on conflict (role, permission_key) do update set level = excluded.level`;
      await logAudit(t, {
        actorId: admin.id,
        action: "update_roles_matrix",
        entity: "roles",
        entityId: "matrix",
        newValue: changes.join(" · "),
        reason,
      });
      return { result: await rolesMatrix(t), count: changes.length };
    });
    return ok(result, `تم حفظ ${count} تعديل — يسري فورًا على المستخدمين`);
  }),
];
