import { getData, send } from "@/lib/api/request";
import type { VendorAccount, VendorLoginPayload, VendorLoginResponse } from "@/types/vendor/auth";

export function login(payload: VendorLoginPayload) {
  return send<VendorLoginResponse>("post", "/vendor/auth/login", payload, "تعذر تسجيل الدخول");
}

export function fetchMe() {
  return getData<VendorAccount>("/vendor/auth/me", undefined, "تعذر تحميل بيانات الحساب");
}

export function logout() {
  return send<null>("post", "/vendor/auth/logout");
}

export function changePassword(payload: { currentPassword: string; newPassword: string }) {
  return send<null>("post", "/vendor/auth/change-password", payload, "تعذر تغيير كلمة المرور");
}

export function forgotPassword(payload: { phone: string }) {
  return send<null>("post", "/vendor/auth/forgot-password", payload, "تعذر إرسال رابط الاسترجاع");
}

export function resetPassword(payload: { access_token: string; newPassword: string }) {
  return send<null>("post", "/vendor/auth/reset-password", payload, "تعذر تعيين كلمة المرور");
}
