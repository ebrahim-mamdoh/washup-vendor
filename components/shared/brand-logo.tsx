import { useId } from "react";

import { cn } from "../../lib/utils";

type BrandLogoProps = {
  subtitle?: string;
  collapsed?: boolean;
  /** On a brand-coloured background: the mark sits on a white tile and the wordmark turns white. */
  tone?: "default" | "light";
  className?: string;
};

/**
 * The W ribbon of the WashUp mark (same artwork as the website, washup-eg.vercel.app):
 * a sky-blue ribbon folding over a navy one. In dark mode the navy ribbon is lifted
 * so it stays visible on the dark sidebar.
 */
export function WashUpMark({ className }: { className?: string }) {
  const id = useId().replace(/:/g, "");
  return (
    <svg
      viewBox="0 0 128 80"
      className={cn("[--wu-n0:#0b2152] [--wu-n1:#163d8f] [--wu-n2:#1d4fb3] dark:[--wu-n0:#2b5cc4] dark:[--wu-n1:#3a72dd] dark:[--wu-n2:#4d88ee]", className)}
      aria-hidden
    >
      <defs>
        <linearGradient id={`wu-sky-${id}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#5fd0ff" />
          <stop offset="0.55" stopColor="#2aa4ff" />
          <stop offset="1" stopColor="#1b74f5" />
        </linearGradient>
        <linearGradient id={`wu-navy-${id}`} x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" style={{ stopColor: "var(--wu-n0)" }} />
          <stop offset="0.6" style={{ stopColor: "var(--wu-n1)" }} />
          <stop offset="1" style={{ stopColor: "var(--wu-n2)" }} />
        </linearGradient>
        <linearGradient id={`wu-fold-${id}`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#1b74f5" />
          <stop offset="1" stopColor="#0f2a66" />
        </linearGradient>
      </defs>
      <g fill="none" strokeWidth="15">
        <path stroke={`url(#wu-navy-${id})`} d="M74 28 C84 28 85 70 96 70 C108 70 110 30 126 11" />
        <path stroke={`url(#wu-sky-${id})`} d="M2 12 C18 4 30 16 36 32 C42 50 44 70 55 70 C67 70 68 28 77 28" />
        <path stroke={`url(#wu-fold-${id})`} opacity="0.35" strokeWidth="9" d="M77 28 C80 30 81 34 82 38" />
      </g>
    </svg>
  );
}

/** WashUp mark + "WASHUP" wordmark — one source for every WashUp web app. */
export function BrandLogo({ subtitle, collapsed, tone = "default", className }: BrandLogoProps) {
  const light = tone === "light";
  const mark = <WashUpMark className={light ? "h-6 w-auto" : "h-7 w-auto"} />;
  return (
    <div dir="ltr" className={cn("flex w-fit items-center gap-2.5", className)}>
      {light ? <span className="flex h-10 w-13 shrink-0 items-center justify-center rounded-xl bg-white shadow-raised">{mark}</span> : <span className="flex h-9 shrink-0 items-center">{mark}</span>}
      {!collapsed ? (
        <div className="min-w-0 leading-tight">
          <p
            className={cn("font-wordmark text-[17px] leading-none font-extrabold tracking-[-0.02em]", light ? "text-white" : "text-[#0b2152] dark:text-white")}
          >
            WASH<span className={light ? "text-[#bfe3ff]" : "text-[#1769e8] dark:text-[#59b1ff]"}>UP</span>
          </p>
          {subtitle ? (
            <p dir="rtl" className={cn("mt-1 text-start text-[11px] font-medium", light ? "text-white/80" : "text-muted-foreground")}>
              {subtitle}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
