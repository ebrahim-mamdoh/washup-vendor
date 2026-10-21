"use client";

import { useEffect } from "react";

/**
 * Starts Firebase Analytics once, after the portal is in the browser. Firebase is
 * imported here on demand so it never weighs on the first paint of any page.
 */
export function FirebaseAnalytics() {
  useEffect(() => {
    void import("@/lib/firebase/analytics").then((m) => m.initFirebaseAnalytics());
  }, []);
  return null;
}
