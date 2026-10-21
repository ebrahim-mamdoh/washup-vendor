"use client";

import { BellRing } from "lucide-react";

import { Switch } from "@/components/ui/switch";
import type { useWebPush } from "@/hooks/use-web-push";

/**
 * "Browser notifications" row of the notifications menu; hidden until Firebase
 * is configured. The state comes from `useWebPush`, called by the always-mounted
 * bell so pushes are received while the menu is closed.
 */
export function PushToggle({ availability, enabled, busy, toggle }: ReturnType<typeof useWebPush>) {
  if (availability === "unconfigured") return null;

  return (
    <div className="flex items-center gap-3 border-b px-4 py-2.5">
      <BellRing className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium">إشعارات المتصفح</p>
        <p className="text-[11px] text-muted-foreground">
          {availability === "unsupported" ? "هذا المتصفح لا يدعم الإشعارات" : "تصلك حتى لو كانت اللوحة مغلقة"}
        </p>
      </div>
      <Switch
        checked={enabled}
        disabled={busy || availability === "unsupported"}
        onCheckedChange={() => void toggle()}
        aria-label="إشعارات المتصفح"
      />
    </div>
  );
}
