"use client";

import type { ReactNode } from "react";
import { ThemeProvider } from "next-themes";

import { AuthBootstrap } from "@/components/providers/auth-bootstrap";
import { FirebaseAnalytics } from "@/components/providers/firebase-analytics";
import { QueryProvider } from "@/components/providers/query-provider";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";

type AppProvidersProps = {
  children: ReactNode;
  /** CSP nonce for next-themes' inline script (GAP-063). */
  nonce?: string;
};

export function AppProviders({ children, nonce }: AppProvidersProps) {
  return (
    <ThemeProvider nonce={nonce} attribute="class" defaultTheme="light" enableSystem disableTransitionOnChange>
      <QueryProvider>
        <AuthBootstrap>
          <TooltipProvider delay={250}>
            {children}
            <FirebaseAnalytics />
            <Toaster />
          </TooltipProvider>
        </AuthBootstrap>
      </QueryProvider>
    </ThemeProvider>
  );
}
