"use client";

import { useState } from "react";
import Link from "next/link";
import { useMutation } from "@tanstack/react-query";

import { BrandLogo } from "@/components/shared/brand-logo";
import { Button } from "@/components/ui/button";
import { forgotPassword } from "@/lib/services/auth.service";
import { resolveUserFacingError } from "@/lib/api/api-error-handler";

export default function ForgotPasswordPage() {
  const [phone, setPhone] = useState("");
  const mutation = useMutation({
    mutationFn: () => forgotPassword({ phone }),
  });
  const error = mutation.error ? resolveUserFacingError(mutation.error, "تعذر إرسال الرابط") : null;

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center px-5 py-10">
      <div className="w-full max-w-sm space-y-6">
        <BrandLogo subtitle="بوابة الشركاء" />
        <div className="space-y-1.5">
          <h1 className="text-2xl font-bold">نسيت كلمة المرور</h1>
          <p className="text-sm text-muted-foreground">أدخل رقم موبايل الحساب. سنرسل رابط الاسترجاع إلى البريد المرتبط بالمغسلة عبر Supabase.</p>
        </div>
        {mutation.isSuccess ? (
          <p className="rounded-xl border border-success/30 bg-success/10 p-3 text-sm">{mutation.data.message}</p>
        ) : (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              mutation.mutate();
            }}
          >
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
            <label className="block space-y-1 text-sm font-medium">
              رقم الموبايل
              <input
                type="tel"
                dir="ltr"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                className="h-11 w-full rounded-xl border border-input bg-card px-3 text-sm"
              />
            </label>
            <Button type="submit" className="h-11 w-full" loading={mutation.isPending}>
              إرسال رابط الاسترجاع
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
