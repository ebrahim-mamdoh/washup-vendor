import type { FirebaseOptions } from "firebase/app";

/**
 * Public Firebase web config (`NEXT_PUBLIC_FIREBASE_*`). These values are
 * public by design; the service account stays server-only.
 */
export function firebaseOptions(): FirebaseOptions | null {
  const apiKey = process.env.NEXT_PUBLIC_FIREBASE_API_KEY;
  const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
  const messagingSenderId = process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID;
  const appId = process.env.NEXT_PUBLIC_FIREBASE_APP_ID;
  if (!apiKey || !projectId || !messagingSenderId || !appId) return null;

  const authDomain = process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN;
  const storageBucket = process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET;
  const measurementId = process.env.NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID;

  return {
    apiKey,
    projectId,
    messagingSenderId,
    appId,
    ...(authDomain ? { authDomain } : {}),
    ...(storageBucket ? { storageBucket } : {}),
    ...(measurementId ? { measurementId } : {}),
  };
}

export function isFirebaseConfigured(): boolean {
  return firebaseOptions() !== null;
}
