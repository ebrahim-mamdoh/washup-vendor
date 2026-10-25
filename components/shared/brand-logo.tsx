import Image from "next/image";

import { cn } from "../../lib/utils";

type BrandLogoProps = {
  subtitle?: string;
  collapsed?: boolean;
  /** On a brand-coloured background: the logo sits on a white tile and the subtitle turns white. */
  tone?: "default" | "light";
  className?: string;
};

/**
 * The WashUp logo from the brand file (the W ribbon is the W of "WASHUP"), cut out of its
 * background into PNGs in /public/brand: the full logo (510×96) and the W alone (176×96),
 * each with a dark-mode variant whose navy is lifted. Only the variant on screen is loaded
 * (the hidden one is a lazy image under display:none).
 */
function Themed({ name, width, height, className }: { name: "washup-logo" | "washup-mark"; width: number; height: number; className?: string }) {
  return (
    <>
      <Image src={`/brand/${name}.png`} alt="WashUp" width={width} height={height} className={cn("dark:hidden", className)} />
      <Image src={`/brand/${name}-dark.png`} alt="WashUp" width={width} height={height} className={cn("hidden dark:block", className)} />
    </>
  );
}

/** WashUp logo — one source for every WashUp web app. */
export function BrandLogo({ subtitle, collapsed, tone = "default", className }: BrandLogoProps) {
  if (collapsed) {
    return (
      <span className={cn("flex h-9 items-center", className)}>
        <Themed name="washup-mark" width={51} height={28} className="h-7 w-auto" />
      </span>
    );
  }
  const light = tone === "light";
  return (
    <div className={cn("flex w-fit flex-col items-start gap-1.5", className)}>
      {light ? (
        <span className="rounded-xl bg-white px-3 py-2 shadow-raised">
          <Image src="/brand/washup-logo.png" alt="WashUp" width={149} height={28} className="h-7 w-auto" />
        </span>
      ) : (
        <Themed name="washup-logo" width={138} height={26} className="h-[26px] w-auto" />
      )}
      {subtitle ? <p className={cn("text-[11px] leading-none font-medium", light ? "text-white/80" : "text-muted-foreground")}>{subtitle}</p> : null}
    </div>
  );
}
