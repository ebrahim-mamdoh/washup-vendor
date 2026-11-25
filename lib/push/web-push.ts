"use client";

import { send } from "@/lib/api/request";
import { isFirebaseConfigured } from "@/lib/firebase/config";
import { useAuthStore } from "@/lib/store/auth-store";

/**
 * Browser push (Firebase Cloud Messaging) for the panel. Firebase is loaded on
 * demand only — nothing is downloaded until push is enabled or already allowed.
 *
 * Config comes from NEXT_PUBLIC_FIREBASE_* (the Firebase web app of the CarZone
 * project; these values are public by design). The VAPID key is optional: the
 * Firebase SDK falls back to the project's default web push key.
 */
export type PushNamespace = "vendor" | "admin";

const VAPID_KEY = process.env.NEXT_PUBLIC_FIREBASE_VAPID_KEY || undefined;
const SW_URL = "/push-sw.js";

const tokenKey = (ns: PushNamespace) => `carzen-push-token-${ns}`;

export type PushAvailability = "unconfigured" | "unsupported" | "ready";

export function pushAvailability(): PushAvailability {
  if (!isFirebaseConfigured()) return "unconfigured";
  if (typeof window === "undefined" || !("serviceWorker" in navigator) || !("Notification" in window) || !("PushManager" in window)) {
    return "unsupported";
  }
  return "ready";
}

/**
 * GAP-049: the saved token remembers WHICH account registered it (`{ token, owner }`), so a
 * different account signing in on this browser re-binds the device to itself on the server.
 * (Older values were the bare token: treated as "owner unknown" → registered again.)
 */
type StoredPush = { token: string; owner: string | null };

function stored(ns: PushNamespace): StoredPush | null {
  try {
    const raw = localStorage.getItem(tokenKey(ns));
    if (!raw) return null;
    if (!raw.startsWith("{")) return { token: raw, owner: null };
    const v = JSON.parse(raw) as Partial<StoredPush>;
    return typeof v.token === "string" ? { token: v.token, owner: typeof v.owner === "string" ? v.owner : null } : null;
  } catch {
    return null;
  }
}

function storedToken(ns: PushNamespace): string | null {
  return stored(ns)?.token ?? null;
}

function storeToken(ns: PushNamespace, token: string | null, owner: string | null = null) {
  try {
    if (token) localStorage.setItem(tokenKey(ns), JSON.stringify({ token, owner }));
    else localStorage.removeItem(tokenKey(ns));
  } catch {
    // Private mode: the server keeps the device either way.
  }
}

const currentOwner = () => useAuthStore.getState().account?.id ?? null;

async function messaging() {
  const [{ getMessaging, isSupported }, { getFirebaseApp }] = await Promise.all([
    import("firebase/messaging"),
    import("@/lib/firebase/client"),
  ]);
  if (!(await isSupported())) throw new Error("unsupported");
  const app = getFirebaseApp();
  if (!app) throw new Error("unconfigured");
  return getMessaging(app);
}

/** Gets this browser's FCM token (registering the service worker) and saves it on the server. */
async function registerToken(ns: PushNamespace): Promise<string> {
  const registration = await navigator.serviceWorker.register(SW_URL);
  await navigator.serviceWorker.ready;
  const { getToken } = await import("firebase/messaging");
  const token = await getToken(await messaging(), { vapidKey: VAPID_KEY, serviceWorkerRegistration: registration });
  if (!token) throw new Error("no token");
  const owner = currentOwner();
  const saved = stored(ns);
  // Re-register when the token rotated OR another account is signed in now (GAP-049).
  if (token !== saved?.token || !owner || saved.owner !== owner) {
    await send<null>("post", `/${ns}/push/register`, { token, platform: "web", appVersion: "web" }, "تعذر تفعيل الإشعارات");
    storeToken(ns, token, owner);
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

/**
 * GAP-049: the session ended without an explicit logout (expired / refresh failed / revoked).
 * The server can no longer be called with that session, so the browser's FCM token is deleted
 * instead: FCM invalidates it, the next push to it fails as UNREGISTERED and the server drops the
 * device row. The next sign-in on this browser registers a fresh token for that account.
 */
export async function forgetPushDevice(ns: PushNamespace): Promise<void> {
  if (!storedToken(ns)) return;
  storeToken(ns, null);
  if (pushAvailability() !== "ready") return;
  const { deleteToken } = await import("firebase/messaging");
  await deleteToken(await messaging()).catch(() => undefined);
}

export function isPushEnabled(ns: PushNamespace): boolean {
  return pushAvailability() === "ready" && Notification.permission === "granted" && Boolean(storedToken(ns));
}
