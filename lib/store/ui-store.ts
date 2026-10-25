"use client";

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

/** Optional data to start the new-order sheet with (e.g. from a customer profile). */
export type NewOrderPrefill = { phone?: string; plate?: string; name?: string };

type UIState = {
  /** Desktop sidebar collapsed to icons (per-viewer preference, persisted). */
  sidebarCollapsed: boolean;
  /** Owner's branch filter ("all" or a branch id). Managers are always forced to their branch. */
  selectedBranchId: string;
  mobileNavOpen: boolean;
  commandOpen: boolean;
  /** Global "new order" sheet (walk-in / phone booking), reachable from anywhere. */
  newOrderOpen: boolean;
  newOrderPrefill: NewOrderPrefill | null;
  /** Welcome / setup-steps dialog (opened from the sidebar card, or once on its own). */
  setupOpen: boolean;
  toggleSidebar: () => void;
  setSelectedBranchId: (id: string) => void;
  setMobileNavOpen: (open: boolean) => void;
  setCommandOpen: (open: boolean) => void;
  setNewOrderOpen: (open: boolean) => void;
  /** Opens the new-order sheet prefilled (recognition runs on the prefilled phone/plate). */
  openNewOrder: (prefill?: NewOrderPrefill) => void;
  setSetupOpen: (open: boolean) => void;
};

export const useUIStore = create<UIState>()(
  persist(
    (set) => ({
      sidebarCollapsed: false,
      selectedBranchId: "all",
      mobileNavOpen: false,
      commandOpen: false,
      newOrderOpen: false,
      newOrderPrefill: null,
      setupOpen: false,
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      setSelectedBranchId: (selectedBranchId) => set({ selectedBranchId }),
      setMobileNavOpen: (mobileNavOpen) => set({ mobileNavOpen }),
      setCommandOpen: (commandOpen) => set({ commandOpen }),
      setNewOrderOpen: (newOrderOpen) => set(newOrderOpen ? { newOrderOpen } : { newOrderOpen, newOrderPrefill: null }),
      openNewOrder: (prefill) => set({ newOrderOpen: true, newOrderPrefill: prefill ?? null }),
      setSetupOpen: (setupOpen) => set({ setupOpen }),
    }),
    {
      name: "carzen-vendor-ui-v1",
      storage: createJSONStorage(() => localStorage),
      skipHydration: true,
      partialize: (s) => ({ sidebarCollapsed: s.sidebarCollapsed, selectedBranchId: s.selectedBranchId }),
    },
  ),
);
