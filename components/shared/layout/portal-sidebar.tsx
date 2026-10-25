"use client";

import Link from "next/link";
import type { CSSProperties } from "react";
import { PanelRightClose, PanelRightOpen } from "lucide-react";

import { BrandLogo } from "@/components/shared/brand-logo";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { BUSINESS_STATUS } from "@/lib/constants/labels";
import { cn } from "@/lib/utils";
import { SetupProgress, SetupWelcome } from "@/components/shared/layout/setup-progress";
import { SidebarNav } from "@/components/shared/layout/sidebar-nav";
import { useAuthStore } from "@/lib/store/auth-store";
import { useUIStore } from "@/lib/store/ui-store";

function BusinessCard() {
  const account = useAuthStore((s) => s.account);
  if (!account) return null;
  const meta = BUSINESS_STATUS[account.businessStatus];
  return (
    <div className="m-3 rounded-xl border border-sidebar-border bg-card/80 p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="truncate text-xs font-semibold">{account.businessName.ar}</p>
        <span style={{ "--tone": meta.tone } as CSSProperties} className="tone-dot size-2 shrink-0 rounded-full" aria-label={meta.label} />
      </div>
      <p className="mt-0.5 text-[11px] text-muted-foreground">
        {account.role === "owner" ? `${account.branches.length} فروع · مالك` : `مدير فرع · ${account.branches[0]?.name.ar ?? ""}`}
      </p>
    </div>
  );
}

/** Desktop sidebar (collapsible to icons) + mobile sheet. */
export function PortalSidebar() {
  const collapsed = useUIStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const mobileOpen = useUIStore((s) => s.mobileNavOpen);
  const setMobileOpen = useUIStore((s) => s.setMobileNavOpen);

  return (
    <>
      <aside
        className={cn(
          "sticky top-0 hidden h-dvh shrink-0 flex-col border-e border-sidebar-border bg-sidebar transition-[width] duration-200 ease-fluid lg:flex",
          collapsed ? "w-[76px]" : "w-[264px]",
        )}
      >
        <div className={cn("flex h-16 items-center border-b border-sidebar-border", collapsed ? "justify-center px-2" : "justify-between px-4")}>
          <Link href="/dashboard" aria-label="الرئيسية" className="rounded-xl focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none">
            <BrandLogo subtitle="بوابة الشركاء" collapsed={collapsed} />
          </Link>
          {!collapsed ? (
            <Button variant="ghost" size="icon-sm" onClick={toggleSidebar} aria-label="طي القائمة">
              <PanelRightClose />
            </Button>
          ) : null}
        </div>
        <div className="flex-1 overflow-y-auto px-3 py-4">
          <SidebarNav collapsed={collapsed} />
        </div>
        <SetupProgress collapsed={collapsed} />
        {collapsed ? (
          <div className="border-t border-sidebar-border p-3">
            <Button variant="ghost" size="icon" className="w-full" onClick={toggleSidebar} aria-label="توسيع القائمة">
              <PanelRightOpen />
            </Button>
          </div>
        ) : (
          <BusinessCard />
        )}
      </aside>

      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent side="right" className="w-[280px] gap-0 bg-sidebar p-0">
          <SheetTitle className="sr-only">القائمة الرئيسية</SheetTitle>
          <div className="flex h-16 items-center border-b px-4">
            <BrandLogo subtitle="بوابة الشركاء" />
          </div>
          <div className="flex-1 overflow-y-auto px-3 py-4">
            <SidebarNav onNavigate={() => setMobileOpen(false)} />
          </div>
          <SetupProgress onOpen={() => setMobileOpen(false)} />
          <BusinessCard />
        </SheetContent>
      </Sheet>
      <SetupWelcome />
    </>
  );
}
