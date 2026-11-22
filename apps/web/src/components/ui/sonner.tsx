import type { CSSProperties } from "react";
import {
  RiCheckboxCircleLine,
  RiCloseCircleLine,
  RiErrorWarningLine,
  RiInformationLine,
  RiLoader4Line,
} from "@remixicon/react";
import { Toaster as Sonner, type ToasterProps } from "sonner";
import { useIsDarkTheme } from "@/lib/theme";

export function Toaster({ theme, ...props }: ToasterProps) {
  const isDark = useIsDarkTheme();

  return (
    <Sonner
      theme={theme ?? (isDark ? "dark" : "light")}
      position="bottom-right"
      richColors
      closeButton
      className="toaster group"
      icons={{
        success: <RiCheckboxCircleLine className="size-4" aria-hidden="true" />,
        info: <RiInformationLine className="size-4" aria-hidden="true" />,
        warning: <RiErrorWarningLine className="size-4" aria-hidden="true" />,
        error: <RiCloseCircleLine className="size-4" aria-hidden="true" />,
        loading: (
          <RiLoader4Line className="size-4 animate-spin" aria-hidden="true" />
        ),
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
        } as CSSProperties
      }
      {...props}
    />
  );
}
