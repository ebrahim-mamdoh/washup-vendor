"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { type PushNamespace, disablePush, enablePush, isPushEnabled, pushAvailability, syncPush } from "@/lib/push/web-push";

type PushMessage = { id: string; title: string; body?: string; href?: string };

/**
 * Browser push state for the signed-in panel user: re-syncs the device token
 * when permission was already given, turns push on/off, and shows pushes that
 * arrive while the panel is open as toasts (refreshing the notification lists).
 */
export function useWebPush(ns: PushNamespace) {
  const router = useRouter();
  const queryClient = useQueryClient();
  // Panel content renders client-side only (auth gate), so window is available here.
  const [availability] = useState(pushAvailability);
  const [enabled, setEnabled] = useState(() => isPushEnabled(ns));
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    syncPush(ns)
      .then(setEnabled)
      .catch(() => setEnabled(false));
  }, [ns]);

  useEffect(() => {
    if (availability !== "ready") return;
    const onMessage = (event: MessageEvent<{ type?: string; data?: PushMessage }>) => {
      if (event.data?.type !== "carzen-push" || !event.data.data) return;
      const msg = event.data.data;
      void queryClient.invalidateQueries({ queryKey: ["notifications"] });
      if (document.visibilityState !== "visible") return;
      toast(msg.title, {
        id: msg.id,
        description: msg.body,
        action: msg.href ? { label: "عرض", onClick: () => router.push(msg.href!) } : undefined,
      });
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, [availability, queryClient, router]);

  const toggle = useCallback(async () => {
    setBusy(true);
    try {
      if (enabled) {
        await disablePush(ns);
        setEnabled(false);
      } else {
        await enablePush(ns);
        setEnabled(true);
        toast.success("تم تفعيل إشعارات المتصفح على هذا الجهاز");
      }
    } catch (error) {
      toast.error(error instanceof Error && error.message.length > 12 ? error.message : "تعذر تفعيل الإشعارات على هذا المتصفح");
    } finally {
      setBusy(false);
    }
  }, [enabled, ns]);

  return { availability, enabled, busy, toggle };
}
