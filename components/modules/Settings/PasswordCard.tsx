"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { LockKeyhole } from "lucide-react";

import { Button } from "@/components/ui/button";
import { changePassword } from "@/lib/services/auth.service";
import { resolveUserFacingError } from "@/lib/api/api-error-handler";
import { toast } from "sonner";

export function PasswordCard() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const mutation = useMutation({
    mutationFn: () => changePassword({ currentPassword, newPassword }),
    onSuccess: (res) => {
      toast.success(res.message ?? "تم تغيير كلمة المرور");
      setCurrentPassword("");
      setNewPassword("");
      setConfirm("");
    },
  });
  const mismatch = confirm.length > 0 && confirm !== newPassword;
  const error = mutation.error ? resolveUserFacingError(mutation.error, "تعذر تغيير كلمة المرور") : null;

  return (
    <section className="space-y-3 rounded-2xl border border-border bg-card p-4">
      <div className="flex items-center gap-2">
        <LockKeyhole className="size-4 text-primary" />
        <h3 className="text-sm font-semibold">كلمة مرور الحساب</h3>
      </div>
      <p className="text-xs text-muted-foreground">تغيير كلمة الدخول لبوابة الشركاء. الدخول يبقى برقم الموبايل.</p>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="space-y-1 text-xs font-medium">
          الحالية
          <input
            type="password"
            dir="ltr"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            className="h-10 w-full rounded-xl border border-input bg-background px-3 text-sm"
          />
        </label>
        <label className="space-y-1 text-xs font-medium">
          الجديدة
          <input
            type="password"
            dir="ltr"
            autoComplete="new-password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            className="h-10 w-full rounded-xl border border-input bg-background px-3 text-sm"
          />
        </label>
        <label className="space-y-1 text-xs font-medium">
          تأكيد الجديدة
          <input
            type="password"
            dir="ltr"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            className="h-10 w-full rounded-xl border border-input bg-background px-3 text-sm"
          />
        </label>
      </div>
      {mismatch ? <p className="text-xs text-destructive">كلمتا المرور غير متطابقتين</p> : null}
      <Button
        type="button"
        size="sm"
        disabled={!currentPassword || newPassword.length < 8 || mismatch || mutation.isPending}
        loading={mutation.isPending}
        onClick={() => mutation.mutate()}
      >
        حفظ كلمة المرور
      </Button>
    </section>
  );
}
