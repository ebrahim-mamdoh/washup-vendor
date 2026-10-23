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

export interface LoginResponse extends SessionTokens {
  admin: AdminUser;
}
