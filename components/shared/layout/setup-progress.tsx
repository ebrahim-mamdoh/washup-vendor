"use client";

import Link from "next/link";
import { useEffect, type ReactNode } from "react";
import { ArrowLeft, Check, Clock, Rocket, Sparkles, Store, UserPlus } from "lucide-react";

import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useSetupChecklist } from "@/hooks/use-operations";
import { useAuthStore } from "@/lib/store/auth-store";
import { useUIStore } from "@/lib/store/ui-store";
import { cn } from "@/lib/utils";
import type { SetupChecklist, SetupStep } from "@/types/vendor/dashboard";

const STEP_META: Record<SetupStep["key"], { icon: ReactNode; hint: string }> = {
  branch: { icon: <Store />, hint: "رقم الهاتف والعنوان الظاهران للعملاء في التطبيق" },
  services: { icon: <Sparkles />, hint: "خدمتان على الأقل بالسعر والمدة" },
  hours: { icon: <Clock />, hint: "مواعيد كل يوم وعدد السيارات في نفس الوقت" },
  staff: { icon: <UserPlus />, hint: "فني أو مدير يستلم الطلبات ويتابع التنفيذ" },
  live: { icon: <Rocket />, hint: "بعدها تظهر المغسلة للعملاء وتبدأ في استقبال الحجوزات" },
};

/** The welcome dialog opens by itself once per business on this browser; afterwards only from the card. */
const SEEN_KEY = "carzen-vendor-setup-seen-v1";

function seenFor(businessId: string) {
  try {
    return localStorage.getItem(SEEN_KEY) === businessId;
  } catch {
    return true;
  }
}

function markSeen(businessId: string) {
  try {
    localStorage.setItem(SEEN_KEY, businessId);
  } catch {
    // Storage blocked: the dialog may show again next visit, nothing breaks.
  }
}

const pct = (s: SetupChecklist) => Math.round((s.done / s.total) * 100);

function Bar({ value, className }: { value: number; className?: string }) {
  return (
    <div className={cn("h-1.5 w-full overflow-hidden rounded-full bg-primary/15", className)} role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={100}>
      <div className="h-full rounded-full bg-primary transition-[width] duration-500 ease-fluid" style={{ width: `${value}%` }} />
    </div>
  );
}

function SetupDialog({ setup, open, onOpenChange }: { setup: SetupChecklist; open: boolean; onOpenChange: (open: boolean) => void }) {
  const value = pct(setup);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="grid-cols-[minmax(0,1fr)] gap-0 overflow-hidden p-0 sm:max-w-md" showCloseButton={false}>
        <div className="bg-[linear-gradient(135deg,#2aa4ff_0%,#1463ff_45%,#0f3a9e_100%)] px-5 pt-5 pb-4 text-white">
          <DialogTitle className="text-lg leading-snug font-bold">أهلاً بك في بوابة الشركاء 👋</DialogTitle>
          <DialogDescription className="mt-1.5 text-[13px] leading-relaxed text-white/85">
            {setup.total} خطوات سريعة وتبدأ في استقبال حجوزات العملاء من التطبيق.
          </DialogDescription>
          <div className="mt-4 flex items-center justify-between text-xs font-medium text-white/90">
            <span>
              <span className="num">{setup.done}</span> من <span className="num">{setup.total}</span> مكتمل
            </span>
            <span className="num">{value}%</span>
          </div>
          <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-white/25" role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={100}>
            <div className="h-full rounded-full bg-white transition-[width] duration-500 ease-fluid" style={{ width: `${value}%` }} />
          </div>
        </div>

        <ol className="divide-y divide-border">
          {setup.steps.map((s, i) => {
            const meta = STEP_META[s.key];
            return (
              <li key={s.key}>
                <Link
                  href={s.href}
                  onClick={() => onOpenChange(false)}
                  className="group flex items-center gap-3 px-5 py-3.5 transition-colors hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:outline-none"
                >
                  <span
                    className={cn(
                      "flex size-9 shrink-0 items-center justify-center rounded-xl [&_svg]:size-[18px]",
                      s.done ? "bg-success/12 text-success" : "bg-primary/10 text-primary",
                    )}
                  >
                    {s.done ? <Check /> : meta.icon}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className={cn("block text-sm font-semibold", s.done && "text-muted-foreground line-through decoration-muted-foreground/50")}>
                      <span className="num me-1 text-muted-foreground">{i + 1}.</span>
                      {s.label}
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-muted-foreground">{meta.hint}</span>
                  </span>
                  {s.done ? (
                    <span className="shrink-0 text-xs font-medium text-success">تم</span>
                  ) : (
                    <span className="flex shrink-0 items-center gap-1 text-xs font-semibold text-primary">
                      ابدأ
                      <ArrowLeft className="size-3.5 transition-transform group-hover:-translate-x-0.5" />
                    </span>
                  )}
                </Link>
              </li>
            );
          })}
        </ol>

        <div className="border-t border-border px-5 py-3 text-center">
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            تخطي الإعداد الآن
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** The owner's unfinished checklist, or null (managers, loading, or all steps done). */
function usePendingSetup() {
  const account = useAuthStore((s) => s.account);
  const isOwner = account?.role === "owner";
  const { data: setup } = useSetupChecklist(isOwner);
  return { setup: isOwner && setup && setup.done < setup.total ? setup : null, businessId: account?.businessId };
}

/**
 * The welcome dialog, mounted once (desktop sidebar). Opens by itself the first time
 * an owner with an unfinished setup lands in the portal, then from the sidebar card.
 */
export function SetupWelcome() {
  const { setup, businessId } = usePendingSetup();
  const open = useUIStore((s) => s.setupOpen);
  const setOpen = useUIStore((s) => s.setSetupOpen);

  useEffect(() => {
    if (setup && businessId && !seenFor(businessId)) setOpen(true);
  }, [setup, businessId, setOpen]);

  if (!setup) return null;
  return (
    <SetupDialog
      setup={setup}
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next && businessId) markSeen(businessId);
      }}
    />
  );
}

/**
 * Sidebar card for a wash that hasn't finished its setup (owners only — the steps
 * are owner pages): "إكمال الإعداد n/5" + progress; opens the welcome dialog.
 * Renders nothing once the checklist is done (the server returns null).
 */
export function SetupProgress({ collapsed, onOpen }: { collapsed?: boolean; onOpen?: () => void }) {
  const { setup } = usePendingSetup();
  const setOpen = useUIStore((s) => s.setSetupOpen);
  if (!setup) return null;

  const show = () => {
    onOpen?.();
    setOpen(true);
  };
  const value = pct(setup);

  return (
    <>
      {collapsed ? (
        <button
          type="button"
          onClick={show}
          aria-label={`إكمال الإعداد ${setup.done} من ${setup.total}`}
          title={`إكمال الإعداد ${setup.done}/${setup.total}`}
          className="relative mx-auto mb-2 flex size-11 items-center justify-center rounded-xl transition-colors hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          <svg viewBox="0 0 36 36" className="size-8 -rotate-90" aria-hidden>
            <circle cx="18" cy="18" r="15" fill="none" strokeWidth="3.5" className="stroke-primary/15" />
            <circle cx="18" cy="18" r="15" fill="none" strokeWidth="3.5" strokeLinecap="round" className="stroke-primary" pathLength={100} strokeDasharray={`${value} 100`} />
          </svg>
          <span className="num absolute text-[10px] font-bold text-primary">
            {setup.done}/{setup.total}
          </span>
        </button>
      ) : (
        <button
          type="button"
          onClick={show}
          className="mx-3 mt-3 block rounded-xl border border-primary/15 bg-card p-3 text-start shadow-soft transition-colors hover:border-primary/30 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          <span className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-2 text-xs font-semibold">
              <span className="flex size-6 items-center justify-center rounded-lg bg-primary/10 text-primary [&_svg]:size-3.5">
                <Rocket />
              </span>
              إكمال الإعداد
            </span>
            <span className="num text-xs font-bold text-primary">
              {setup.done}/{setup.total}
            </span>
          </span>
          <Bar value={value} className="mt-2.5" />
        </button>
      )}
    </>
  );
}
