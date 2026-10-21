"use client";

import { getApps, initializeApp, type FirebaseApp } from "firebase/app";

import { firebaseOptions } from "@/lib/firebase/config";

/** One Firebase app for the portal (Analytics and Cloud Messaging share it). */
export function getFirebaseApp(): FirebaseApp | null {
  const options = firebaseOptions();
  if (!options) return null;
  return getApps()[0] ?? initializeApp(options);
}
