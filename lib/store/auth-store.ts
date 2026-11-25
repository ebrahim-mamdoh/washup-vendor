"use client";

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import type { VendorAccount } from "@/types/vendor/auth";

export const AUTH_STORE_KEY = "carzen-vendor-auth-v1";

/**
 * GAP-063: the session tokens live in httpOnly cookies set by the API (never readable here).
 * This store keeps only what the UI needs: the signed-in account and when the access token
 * expires (to renew it in time). Neither is a secret.
 */
export type EstablishSessionInput = {
  account: VendorAccount;
  /** Seconds until the access token expires; null/undefined = no expiry. */
  expiresIn?: number | null;
};

type AuthState = {
  account: VendorAccount | null;
  /** Epoch ms the access token expires at; null = no expiry. */
  expiresAt: number | null;
  /** True once the persisted session has been read from storage. */
  hasHydrated: boolean;
  establishSession: (session: EstablishSessionInput) => void;
  setSessionExpiry: (expiresIn: number | null | undefined) => void;
  setAccount: (account: VendorAccount) => void;
  clearAuth: () => void;
};

const expiryFrom = (expiresIn: number | null | undefined) => (expiresIn ? Date.now() + expiresIn * 1000 : null);

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      account: null,
      expiresAt: null,
      hasHydrated: false,
      establishSession: ({ account, expiresIn }) => set({ account, expiresAt: expiryFrom(expiresIn) }),
      setSessionExpiry: (expiresIn) => set({ expiresAt: expiryFrom(expiresIn) }),
      setAccount: (account) => set({ account }),
      clearAuth: () => {
        // GAP-049: any end of session (also expiry / failed refresh) stops this browser's pushes.
        // Loaded on demand; a no-op unless push was enabled here.
        void import("@/lib/push/web-push").then((m) => m.forgetPushDevice("vendor")).catch(() => undefined);
        set({ account: null, expiresAt: null });
      },
    }),
    {
      name: AUTH_STORE_KEY,
      storage: createJSONStorage(() => localStorage),
      // Rehydrated manually after mount (AuthBootstrap) to avoid SSR mismatches.
      skipHydration: true,
      // v1 (GAP-063): tokens moved to httpOnly cookies. A v0 value still holds the old Bearer and
      // refresh tokens: they are dropped (the migrated state is written back right away) and the
      // user signs in again, which creates the cookie session.
      version: 1,
      migrate: () => ({ account: null, expiresAt: null }),
      partialize: (state) => ({
        account: state.account,
        expiresAt: state.expiresAt,
      }),
      onRehydrateStorage: () => () => {
        useAuthStore.setState({ hasHydrated: true });
      },
    },
  ),
);
