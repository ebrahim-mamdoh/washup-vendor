"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useMutation } from "@tanstack/react-query";

import { BrandLogo } from "@/components/shared/brand-logo";
import { Button } from "@/components/ui/button";
import { resetPassword } from "@/lib/services/auth.service";
import { resolveUserFacingError } from "@/lib/api/api-error-handler";

function tokenFromLocation(): string {
  if (typeof window === "undefined") return "";
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const query = new URLSearchParams(window.location.search);
  return hash.get("access_token") || query.get("access_token") || "";
}

export default function ResetPasswordPage() {
  const accessToken = useMemo(() => tokenFromLocation(), []);
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const mutation = useMutation({
    mutationFn: () => resetPassword({ access_token: accessToken, newPassword }),
  });
  const error = mutation.error ? resolveUserFacingError(mutation.error, "تعذر تعيين كلمة المرور") : null;
  const mismatch = confirm.length > 0 && confirm !== newPassword;

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center px-5 py-10">
      <div className="w-full max-w-sm space-y-6">
        <BrandLogo subtitle="بوابة الشركاء" />
        <div className="space-y-1.5">
          <h1 className="text-2xl font-bold">تعيين كلمة مرور جديدة</h1>
          <p className="text-sm text-muted-foreground">بعد الرابط المرسل إلى بريدك. ثم سجّل الدخول برقم الموبايل.</p>
        </div>
        {!accessToken ? (
          <p className="rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
            الرابط غير مكتمل. اطلب استرجاعًا جديدًا من صفحة نسيت كلمة المرور.
          </p>
        ) : mutation.isSuccess ? (
          <p className="rounded-xl border border-success/30 bg-success/10 p-3 text-sm">{mutation.data.message}</p>
        ) : (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (!mismatch) mutation.mutate();
            }}
          >
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
            <label className="block space-y-1 text-sm font-medium">
              كلمة المرور الجديدة
              <input
                type="password"
                dir="ltr"
                autoComplete="new-password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className="h-11 w-full rounded-xl border border-input bg-card px-3 text-sm"
              />
            </label>
            <label className="block space-y-1 text-sm font-medium">
              تأكيد كلمة المرور
              <input
                type="password"
                dir="ltr"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                className="h-11 w-full rounded-xl border border-input bg-card px-3 text-sm"
              />
            </label>
            {mismatch ? <p className="text-xs text-destructive">كلمتا المرور غير متطابقتين</p> : null}
            <Button type="submit" className="h-11 w-full" disabled={newPassword.length < 8 || mismatch} loading={mutation.isPending}>
              حفظ
            </Button>
          </form>
        )}
        <Link href="/login" className="block text-center text-sm text-primary hover:underline">
          العودة لتسجيل الدخول
        </Link>
      </div>
    </div>
  );
}
