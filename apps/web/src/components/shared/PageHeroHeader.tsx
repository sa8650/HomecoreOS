import type { ReactNode } from "react";
import { RiCloseLine, RiSearchLine } from "@remixicon/react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";

export type HeroTone =
  | "orange"
  | "yellow"
  | "green"
  | "purple"
  | "blue"
  | "red"
  | "teal"
  | "pink";

const HERO_BG_CLASSES: Record<HeroTone, string> = {
  orange: "hc-hero-orange",
  yellow: "hc-hero-yellow",
  green: "hc-hero-green",
  purple: "hc-hero-purple",
  blue: "hc-hero-blue",
  red: "hc-hero-red",
  teal: "hc-hero-teal",
  pink: "hc-hero-pink",
};

const HERO_ICON_TINTS: Record<HeroTone, string> = {
  orange: "text-[#d97746]/85 dark:text-amber-400/75",
  yellow: "text-amber-500/85 dark:text-amber-400/75",
  green: "text-emerald-600/80 dark:text-emerald-400/75",
  purple: "text-violet-500/85 dark:text-violet-400/75",
  blue: "text-blue-500/85 dark:text-sky-400/75",
  red: "text-rose-500/85 dark:text-rose-400/75",
  teal: "text-teal-600/80 dark:text-teal-400/75",
  pink: "text-pink-500/85 dark:text-pink-400/75",
};

export interface PageHeroHeaderProps {
  tone: HeroTone;
  ariaLabel: string;
  title: string;
  subtitle: ReactNode;
  leftIcons: [ReactNode, ReactNode, ReactNode];
  rightIcons: [ReactNode, ReactNode, ReactNode];
  searchValue?: string;
  onSearchChange?: (next: string) => void;
  searchPlaceholder?: string;
  searchAriaLabel?: string;
  actions?: ReactNode;
  className?: string;
}

export function PageHeroHeader({
  tone,
  ariaLabel,
  title,
  subtitle,
  leftIcons,
  rightIcons,
  searchValue,
  onSearchChange,
  searchPlaceholder,
  searchAriaLabel,
  actions,
  className,
}: PageHeroHeaderProps) {
  const showSearch = typeof onSearchChange === "function";

  return (
    <section
      aria-label={ariaLabel}
      data-hero-tone={tone}
      className={cn(
        HERO_BG_CLASSES[tone],
        "relative overflow-hidden rounded-2xl border border-border/80 px-4 pt-12 pb-9 shadow-xs sm:px-8 sm:pt-14 sm:pb-10",
        className
      )}
    >
      {/* Left Floating Outline Hardware Illustrations */}
      <div
        aria-hidden="true"
        className={cn("pointer-events-none hidden md:block", HERO_ICON_TINTS[tone])}
      >
        <div className="absolute bottom-12 left-[calc(50%-350px)] size-9 -rotate-12 xl:left-[calc(50%-390px)]">
          {leftIcons[0]}
        </div>
        <div className="absolute top-24 left-[calc(50%-315px)] size-8 rotate-6 xl:left-[calc(50%-345px)]">
          {leftIcons[1]}
        </div>
        <div className="absolute top-6 left-[calc(50%-275px)] size-8 -rotate-12 xl:left-[calc(50%-300px)]">
          {leftIcons[2]}
        </div>
      </div>

      {/* Right Floating Outline Hardware Illustrations */}
      <div
        aria-hidden="true"
        className={cn("pointer-events-none hidden md:block", HERO_ICON_TINTS[tone])}
      >
        <div className="absolute top-6 right-[calc(50%-275px)] size-8 rotate-12 xl:right-[calc(50%-300px)]">
          {rightIcons[0]}
        </div>
        <div className="absolute top-24 right-[calc(50%-315px)] size-8 -rotate-6 xl:right-[calc(50%-345px)]">
          {rightIcons[1]}
        </div>
        <div className="absolute right-[calc(50%-350px)] bottom-12 size-9 rotate-6 xl:right-[calc(50%-390px)]">
          {rightIcons[2]}
        </div>
      </div>

      {/* Centered Hero Content */}
      <div className="relative z-10 mx-auto max-w-2xl text-center">
        <h1 className="text-2xl font-bold tracking-tight text-foreground sm:text-4xl">
          {title}
        </h1>
        <p className="mx-auto mt-3 max-w-xl text-sm leading-relaxed text-muted-foreground sm:text-[15px]">
          {subtitle}
        </p>

        {showSearch && (
          <div className="mx-auto mt-6 w-full max-w-lg">
            <div className="relative flex items-center rounded-xl border border-border/80 bg-background/95 shadow-[0_8px_26px_-8px_rgba(15,23,42,0.12)] transition-shadow focus-within:border-primary/50 focus-within:ring-3 focus-within:ring-primary/15 dark:bg-card/95 dark:shadow-[0_10px_28px_-8px_rgba(0,0,0,0.45)]">
              <Input
                aria-label={searchAriaLabel ?? `Search ${title}`}
                placeholder={searchPlaceholder ?? `Search in ${title}...`}
                value={searchValue ?? ""}
                onChange={(e) => onSearchChange(e.target.value)}
                className="h-11 w-full rounded-xl border-0 bg-transparent pr-16 pl-4 text-sm text-foreground shadow-none placeholder:text-muted-foreground focus-visible:border-0 focus-visible:ring-0 sm:h-12"
              />
              <div className="absolute right-3 flex items-center gap-1.5">
                {searchValue?.trim() && (
                  <button
                    type="button"
                    aria-label="Clear search"
                    onClick={() => onSearchChange("")}
                    className="flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  >
                    <RiCloseLine className="size-4" aria-hidden="true" />
                  </button>
                )}
                <RiSearchLine
                  className="pointer-events-none size-4 text-muted-foreground"
                  aria-hidden="true"
                />
              </div>
            </div>
          </div>
        )}

        {actions && (
          <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
            {actions}
          </div>
        )}
      </div>
    </section>
  );
}
