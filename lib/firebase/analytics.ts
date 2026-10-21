"use client";

import { getFirebaseApp } from "@/lib/firebase/client";

let started: Promise<void> | null = null;

/** Browser-only. No-ops when the web config or this browser can't run Analytics. */
export function initFirebaseAnalytics(): Promise<void> {
  if (started) return started;
  started = (async () => {
    const app = getFirebaseApp();
    if (!app?.options.measurementId) return;
    const { getAnalytics, isSupported } = await import("firebase/analytics");
    if (!(await isSupported())) return;
    getAnalytics(app);
  })();
  return started;
}
