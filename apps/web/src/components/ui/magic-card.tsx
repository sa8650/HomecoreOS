"use client";

import React, { useCallback, useEffect, useRef } from "react";
import {
  motion,
  useMotionTemplate,
  useMotionValue,
  useSpring,
} from "motion/react";

import type { HeroTone } from "@/components/shared/PageHeroHeader";
import { useIsDarkTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";

interface SpotlightThemeColors {
  glowFrom: string;
  glowTo: string;
  gradientFrom: string;
  gradientTo: string;
}

/**
 * Soft spotlight & border glow palettes derived directly from each page's
 * `.hc-hero-{tone}` radial background colors in `globals.css`.
 */
export const HERO_SPOTLIGHT_PALETTES: Record<
  HeroTone,
  { light: SpotlightThemeColors; dark: SpotlightThemeColors }
> = {
  orange: {
    light: {
      glowFrom: "rgba(244, 152, 98, 0.24)",
      glowTo: "rgba(251, 146, 60, 0.16)",
      gradientFrom: "rgba(244, 152, 98, 0.42)",
      gradientTo: "rgba(253, 186, 116, 0.24)",
    },
    dark: {
      glowFrom: "rgba(234, 128, 72, 0.22)",
      glowTo: "rgba(251, 146, 60, 0.15)",
      gradientFrom: "rgba(251, 146, 60, 0.44)",
      gradientTo: "rgba(234, 128, 72, 0.20)",
    },
  },
  yellow: {
    light: {
      glowFrom: "rgba(245, 158, 11, 0.22)",
      glowTo: "rgba(251, 191, 36, 0.16)",
      gradientFrom: "rgba(245, 158, 11, 0.40)",
      gradientTo: "rgba(253, 224, 71, 0.24)",
    },
    dark: {
      glowFrom: "rgba(245, 158, 11, 0.22)",
      glowTo: "rgba(251, 191, 36, 0.15)",
      gradientFrom: "rgba(251, 191, 36, 0.44)",
      gradientTo: "rgba(245, 158, 11, 0.20)",
    },
  },
  green: {
    light: {
      glowFrom: "rgba(16, 185, 129, 0.21)",
      glowTo: "rgba(52, 211, 153, 0.16)",
      gradientFrom: "rgba(16, 185, 129, 0.40)",
      gradientTo: "rgba(110, 231, 183, 0.24)",
    },
    dark: {
      glowFrom: "rgba(16, 185, 129, 0.22)",
      glowTo: "rgba(52, 211, 153, 0.15)",
      gradientFrom: "rgba(52, 211, 153, 0.44)",
      gradientTo: "rgba(16, 185, 129, 0.18)",
    },
  },
  purple: {
    light: {
      glowFrom: "rgba(139, 92, 246, 0.21)",
      glowTo: "rgba(167, 139, 250, 0.16)",
      gradientFrom: "rgba(139, 92, 246, 0.40)",
      gradientTo: "rgba(196, 181, 253, 0.24)",
    },
    dark: {
      glowFrom: "rgba(139, 92, 246, 0.24)",
      glowTo: "rgba(167, 139, 250, 0.16)",
      gradientFrom: "rgba(167, 139, 250, 0.44)",
      gradientTo: "rgba(139, 92, 246, 0.20)",
    },
  },
  blue: {
    light: {
      glowFrom: "rgba(59, 130, 246, 0.21)",
      glowTo: "rgba(56, 189, 248, 0.16)",
      gradientFrom: "rgba(59, 130, 246, 0.40)",
      gradientTo: "rgba(147, 197, 253, 0.24)",
    },
    dark: {
      glowFrom: "rgba(59, 130, 246, 0.24)",
      glowTo: "rgba(56, 189, 248, 0.16)",
      gradientFrom: "rgba(96, 165, 250, 0.44)",
      gradientTo: "rgba(56, 189, 248, 0.20)",
    },
  },
  red: {
    light: {
      glowFrom: "rgba(239, 68, 68, 0.19)",
      glowTo: "rgba(244, 63, 94, 0.15)",
      gradientFrom: "rgba(239, 68, 68, 0.36)",
      gradientTo: "rgba(253, 164, 175, 0.22)",
    },
    dark: {
      glowFrom: "rgba(239, 68, 68, 0.21)",
      glowTo: "rgba(244, 63, 94, 0.15)",
      gradientFrom: "rgba(248, 113, 113, 0.42)",
      gradientTo: "rgba(244, 63, 94, 0.18)",
    },
  },
  teal: {
    light: {
      glowFrom: "rgba(20, 184, 166, 0.20)",
      glowTo: "rgba(6, 182, 212, 0.15)",
      gradientFrom: "rgba(20, 184, 166, 0.40)",
      gradientTo: "rgba(94, 234, 212, 0.24)",
    },
    dark: {
      glowFrom: "rgba(20, 184, 166, 0.21)",
      glowTo: "rgba(6, 182, 212, 0.15)",
      gradientFrom: "rgba(45, 212, 191, 0.44)",
      gradientTo: "rgba(6, 182, 212, 0.18)",
    },
  },
  pink: {
    light: {
      glowFrom: "rgba(236, 72, 153, 0.19)",
      glowTo: "rgba(192, 132, 252, 0.15)",
      gradientFrom: "rgba(236, 72, 153, 0.36)",
      gradientTo: "rgba(249, 168, 212, 0.22)",
    },
    dark: {
      glowFrom: "rgba(236, 72, 153, 0.21)",
      glowTo: "rgba(192, 132, 252, 0.15)",
      gradientFrom: "rgba(244, 114, 182, 0.42)",
      gradientTo: "rgba(192, 132, 252, 0.18)",
    },
  },
};

interface MagicCardBaseProps {
  children?: React.ReactNode;
  className?: string;
  contentClassName?: string;
  spotlightTone?: HeroTone;
  gradientSize?: number;
  gradientFrom?: string;
  gradientTo?: string;
}

interface MagicCardGradientProps extends MagicCardBaseProps {
  mode?: "gradient";

  gradientColor?: string;
  gradientOpacity?: number;

  glowFrom?: never;
  glowTo?: never;
  glowAngle?: never;
  glowSize?: never;
  glowBlur?: never;
  glowOpacity?: never;
}

interface MagicCardOrbProps extends MagicCardBaseProps {
  mode: "orb";

  glowFrom?: string;
  glowTo?: string;
  glowAngle?: number;
  glowSize?: number;
  glowBlur?: number;
  glowOpacity?: number;

  gradientColor?: never;
  gradientOpacity?: never;
}

export type MagicCardProps = MagicCardGradientProps | MagicCardOrbProps;
type ResetReason = "enter" | "leave" | "global" | "init";

function isOrbMode(props: MagicCardProps): props is MagicCardOrbProps {
  return props.mode === "orb";
}

export function MagicCard(props: MagicCardProps) {
  const isDark = useIsDarkTheme();
  const {
    children,
    className,
    contentClassName,
    spotlightTone,
    gradientSize = 200,
    gradientColor = "#262626",
    gradientOpacity = 0.8,
    gradientFrom: explicitGradientFrom,
    gradientTo: explicitGradientTo,
    mode = "gradient",
  } = props;

  const tonePalette = spotlightTone
    ? HERO_SPOTLIGHT_PALETTES[spotlightTone][isDark ? "dark" : "light"]
    : null;

  const gradientFrom = explicitGradientFrom ?? tonePalette?.gradientFrom ?? "#9E7AFF";
  const gradientTo = explicitGradientTo ?? tonePalette?.gradientTo ?? "#FE8BBB";

  const glowFrom = isOrbMode(props)
    ? (props.glowFrom ?? tonePalette?.glowFrom ?? "#ee4f27")
    : "#ee4f27";
  const glowTo = isOrbMode(props)
    ? (props.glowTo ?? tonePalette?.glowTo ?? "#6b21ef")
    : "#6b21ef";
  const glowAngle = isOrbMode(props) ? (props.glowAngle ?? 90) : 90;
  const glowSize = isOrbMode(props) ? (props.glowSize ?? 420) : 420;
  const glowBlur = isOrbMode(props) ? (props.glowBlur ?? 60) : 60;
  const glowOpacity = isOrbMode(props)
    ? (props.glowOpacity ?? (tonePalette ? 0.78 : 0.9))
    : 0.9;

  const mouseX = useMotionValue(-gradientSize);
  const mouseY = useMotionValue(-gradientSize);

  const orbX = useSpring(mouseX, { stiffness: 250, damping: 30, mass: 0.6 });
  const orbY = useSpring(mouseY, { stiffness: 250, damping: 30, mass: 0.6 });
  const orbVisible = useSpring(0, { stiffness: 300, damping: 35 });

  const modeRef = useRef(mode);
  const glowOpacityRef = useRef(glowOpacity);
  const gradientSizeRef = useRef(gradientSize);

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  useEffect(() => {
    glowOpacityRef.current = glowOpacity;
  }, [glowOpacity]);

  useEffect(() => {
    gradientSizeRef.current = gradientSize;
  }, [gradientSize]);

  const reset = useCallback(
    (reason: ResetReason = "leave") => {
      const currentMode = modeRef.current;

      if (currentMode === "orb") {
        if (reason === "enter") orbVisible.set(glowOpacityRef.current);
        else orbVisible.set(0);
        return;
      }

      const off = -gradientSizeRef.current;
      mouseX.set(off);
      mouseY.set(off);
    },
    [mouseX, mouseY, orbVisible]
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      mouseX.set(e.clientX - rect.left);
      mouseY.set(e.clientY - rect.top);
    },
    [mouseX, mouseY]
  );

  useEffect(() => {
    reset("init");
  }, [reset]);

  useEffect(() => {
    const handleGlobalPointerOut = (e: PointerEvent) => {
      if (!e.relatedTarget) reset("global");
    };
    const handleBlur = () => reset("global");
    const handleVisibility = () => {
      if (document.visibilityState !== "visible") reset("global");
    };

    window.addEventListener("pointerout", handleGlobalPointerOut);
    window.addEventListener("blur", handleBlur);
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      window.removeEventListener("pointerout", handleGlobalPointerOut);
      window.removeEventListener("blur", handleBlur);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [reset]);

  return (
    <motion.div
      data-slot="magic-card"
      data-mode={mode}
      data-spotlight-tone={spotlightTone}
      className={cn(
        "group relative isolate overflow-hidden rounded-[inherit] border border-transparent",
        className
      )}
      onPointerMove={handlePointerMove}
      onPointerLeave={() => reset("leave")}
      onPointerEnter={() => reset("enter")}
      style={{
        background: useMotionTemplate`
          linear-gradient(var(--color-card) 0 0) padding-box,
          radial-gradient(${gradientSize}px circle at ${mouseX}px ${mouseY}px,
            ${gradientFrom},
            ${gradientTo},
            var(--color-border) 100%
          ) border-box
        `,
      }}
    >
      <div className="bg-card absolute inset-px z-20 rounded-[inherit]" />

      {mode === "gradient" && (
        <motion.div
          suppressHydrationWarning
          className="pointer-events-none absolute inset-px z-30 rounded-[inherit] opacity-0 transition-opacity duration-300 group-hover:opacity-100"
          style={{
            background: useMotionTemplate`
              radial-gradient(${gradientSize}px circle at ${mouseX}px ${mouseY}px,
                ${gradientColor},
                transparent 100%
              )
            `,
            opacity: gradientOpacity,
          }}
        />
      )}

      {mode === "orb" && (
        <motion.div
          suppressHydrationWarning
          aria-hidden="true"
          className="pointer-events-none absolute z-30 mix-blend-multiply dark:mix-blend-screen"
          style={{
            width: glowSize,
            height: glowSize,
            x: orbX,
            y: orbY,
            translateX: "-50%",
            translateY: "-50%",
            borderRadius: 9999,
            filter: `blur(${glowBlur}px)`,
            opacity: orbVisible,
            background: `linear-gradient(${glowAngle}deg, ${glowFrom}, ${glowTo})`,
            willChange: "transform, opacity",
          }}
        />
      )}
      <div className={cn("relative z-40", contentClassName)}>{children}</div>
    </motion.div>
  );
}
