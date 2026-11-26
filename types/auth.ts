import type { PermissionKey, PermissionLevel } from "./admins";

export type AdminRole = "super" | "operations" | "finance" | "support";

export type AdminStatus = "active" | "inactive";

export interface AdminUser {
  id: string;
  name: string;
  email: string;
  role: AdminRole;
  status: AdminStatus;
  lastLoginAt: string | null;
  createdAt: string;
}

/** What the signed-in admin may do per module (roles matrix; super = full access). */
export type AdminPermissions = Record<PermissionKey, PermissionLevel>;

/** The signed-in admin as returned by login and `/admin/auth/me` (GAP-012, GAP-046). */
export interface AdminSession extends AdminUser {
  permissions: AdminPermissions;
  /** True only on the bundled demo (mock) data source; false on real data. */
  demoData: boolean;
}

export interface LoginPayload {
  email: string;
  password: string;
}

/** Token fields of a login or refresh response (`expires_in` in seconds; null = no expiry). */
export interface SessionTokens {
  access_token: string;
  token_type: string;
  refresh_token?: string;
  expires_in?: number | null;
}

/** Login response; for the web client (`X-Washup-Client: web`) the tokens are cookies, not body fields (GAP-063). */
export interface LoginResponse extends Partial<SessionTokens> {
  admin: AdminSession;
}
