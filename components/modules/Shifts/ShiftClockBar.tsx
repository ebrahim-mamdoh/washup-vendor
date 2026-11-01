"use client";

import { useState } from "react";
import { Timer } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { formatTime } from "@/lib/format";
import { useClockIn, useClockOut, useCurrentShift } from "@/hooks/use-team";

export function ShiftClockBar() {
  const { data: shift, isLoading } = useCurrentShift();
  const clockIn = useClockIn();
  const clockOut = useClockOut();
  const [open, setOpen] = useState(false);
  const [actualCash, setActualCash] = useState("");
  const [reason, setReason] = useState("");

  const pending = clockIn.isPending || clockOut.isPending;

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border/80 bg-card px-4 py-3 shadow-soft">
        <p className="flex items-center gap-2 text-sm">
          <Timer className="size-4 text-muted-foreground" />
          {isLoading ? (
            <span className="text-muted-foreground">الوردية…</span>
          ) : shift ? (
            <span>
              ورديتك مفتوحة من <span className="num font-semibold">{formatTime(shift.actualStart ?? shift.scheduledStart)}</span>
            </span>
          ) : (
            <span className="text-muted-foreground">لم تبدأ ورديتك بعد — افتحها قبل تشغيل السيارات</span>
          )}
        </p>
        {shift ? (
          <Button size="sm" variant="outline" disabled={pending} onClick={() => setOpen(true)}>
            إنهاء الوردية
          </Button>
        ) : (
          <Button size="sm" disabled={pending || isLoading} onClick={() => clockIn.mutate(undefined)}>
            بدء الوردية
          </Button>
        )}
      </div>

      <Dialog open={open} onOpenChange={(o) => !pending && setOpen(o)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>إنهاء الوردية</DialogTitle>
            <DialogDescription>أدخل النقدية الموجودة في الصندوق. لو فيه فرق عن المتوقع، اكتب السبب (3 أحرف على الأقل).</DialogDescription>
          </DialogHeader>
          <label className="space-y-1.5 text-sm">
            <span className="font-medium">النقدية الفعلية (ج.م)</span>
            <input
              inputMode="decimal"
              dir="ltr"
              value={actualCash}
              onChange={(e) => setActualCash(e.target.value.replace(/[^\d.]/g, "").replace(/(\..*)\./g, "$1"))}
              className="num h-11 w-full rounded-xl border border-input bg-card px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/25"
            />
          </label>
          <label className="space-y-1.5 text-sm">
            <span className="font-medium">سبب الفرق (إن وجد)</span>
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} />
          </label>
          <DialogFooter>
            <Button variant="ghost" disabled={pending} onClick={() => setOpen(false)}>
              رجوع
            </Button>
            <Button
              disabled={pending || actualCash === ""}
              onClick={() => {
                clockOut.mutate(
                  { actualCash: Number(actualCash), reason: reason.trim() || undefined },
                  { onSuccess: () => { setOpen(false); setActualCash(""); setReason(""); } },
                );
              }}
            >
              تأكيد الإنهاء
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
