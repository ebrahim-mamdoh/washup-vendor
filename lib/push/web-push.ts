"use client";

import { send } from "@/lib/api/request";

/**
 * Browser push (Firebase Cloud Messaging) for the panel. Firebase is loaded on
 * demand only — nothing is downloaded until push is enabled or already allowed.
 *
 * Config comes from NEXT_PUBLIC_FIREBASE_* (the Firebase web app of the CarZone
 * project; these values are public by design). The VAPID key is optional: the
 * Firebase SDK falls back to the project's default web push key.
 */
export type PushNamespace = "vendor" | "admin";

const CONFIG = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};
const VAPID_KEY = process.env.NEXT_PUBLIC_FIREBASE_VAPID_KEY || undefined;
const SW_URL = "/push-sw.js";

const tokenKey = (ns: PushNamespace) => `carzen-push-token-${ns}`;

export type PushAvailability = "unconfigured" | "unsupported" | "ready";

export function pushAvailability(): PushAvailability {
  if (!CONFIG.apiKey || !CONFIG.projectId || !CONFIG.messagingSenderId || !CONFIG.appId) return "unconfigured";
  if (typeof window === "undefined" || !("serviceWorker" in navigator) || !("Notification" in window) || !("PushManager" in window)) {
    return "unsupported";
  }
  return "ready";
}

function storedToken(ns: PushNamespace): string | null {
  try {
    return localStorage.getItem(tokenKey(ns));
  } catch {
    return null;
  }
}

function storeToken(ns: PushNamespace, token: string | null) {
  try {
    if (token) localStorage.setItem(tokenKey(ns), token);
    else localStorage.removeItem(tokenKey(ns));
  } catch {
    // Private mode: the server keeps the device either way.
  }
}

async function messaging() {
  const [{ getApps, initializeApp }, { getMessaging, isSupported }] = await Promise.all([import("firebase/app"), import("firebase/messaging")]);
  if (!(await isSupported())) throw new Error("unsupported");
  const app = getApps()[0] ?? initializeApp(CONFIG as Required<typeof CONFIG>);
  return getMessaging(app);
}

/** Gets this browser's FCM token (registering the service worker) and saves it on the server. */
async function registerToken(ns: PushNamespace): Promise<string> {
  const registration = await navigator.serviceWorker.register(SW_URL);
  await navigator.serviceWorker.ready;
  const { getToken } = await import("firebase/messaging");
  const token = await getToken(await messaging(), { vapidKey: VAPID_KEY, serviceWorkerRegistration: registration });
  if (!token) throw new Error("no token");
  if (token !== storedToken(ns)) {
    await send<null>("post", `/${ns}/push/register`, { token, appVersion: "web" }, "تعذر تفعيل الإشعارات");
    storeToken(ns, token);
  }
  return token;
}

/** Asks for permission (must run from a click) and turns push on for this browser. */
export async function enablePush(ns: PushNamespace): Promise<void> {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("الإذن مرفوض من المتصفح — فعّل الإشعارات من إعدادات الموقع");
  await registerToken(ns);
}

/** Keeps the server's token current when permission was already given (tokens can rotate). */
export async function syncPush(ns: PushNamespace): Promise<boolean> {
  if (pushAvailability() !== "ready" || Notification.permission !== "granted") return false;
  await registerToken(ns);
  return true;
}

/** Turns push off for this browser (and forgets the device on the server). */
export async function disablePush(ns: PushNamespace): Promise<void> {
  const token = storedToken(ns);
  if (token) await send<null>("post", `/${ns}/push/unregister`, { token }).catch(() => undefined);
  storeToken(ns, null);
  if (pushAvailability() === "ready") {
    const { deleteToken } = await import("firebase/messaging");
    await deleteToken(await messaging()).catch(() => undefined);
  }
}

export function isPushEnabled(ns: PushNamespace): boolean {
  return pushAvailability() === "ready" && Notification.permission === "granted" && Boolean(storedToken(ns));
}
