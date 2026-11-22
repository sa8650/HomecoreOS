import { useEffect, useState, type ReactNode } from "react";
import {
  RiCheckboxCircleLine,
  RiCloseCircleLine,
  RiErrorWarningLine,
  RiInformationLine,
  RiMoonLine,
  RiSunLine,
} from "@remixicon/react";
import { cn } from "@/lib/utils";
import { getBrowserTimezoneFallback, getTimezoneRegions } from "@/lib/timezone";
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "@/components/reui/alert";
import { IconStack } from "@/components/reui/icon-stack";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4 border-b pb-4">
      <div className="min-w-0 space-y-1">
        {eyebrow && (
          <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-primary">
            {eyebrow}
          </p>
        )}
        <h1 className="text-xl font-bold tracking-tight text-foreground sm:text-2xl">
          {title}
        </h1>
        {description && (
          <p className="max-w-2xl text-xs leading-relaxed text-muted-foreground sm:text-sm">
            {description}
          </p>
        )}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function StatCard({
  label,
  value,
  sub,
  sublabel,
  tone = "neutral",
  icon,
}: {
  label: string;
  value: string | number;
  sub?: string;
  sublabel?: string;
  tone?: "neutral" | "accent" | "success" | "warning" | "danger";
  icon?: ReactNode;
}) {
  const detail = sublabel ?? sub;
  const iconColors: Record<string, string> = {
    neutral: "text-muted-foreground bg-muted",
    accent: "text-primary bg-primary/10",
    success: "text-success bg-success/12",
    warning: "text-warning bg-warning/12",
    danger: "text-destructive bg-destructive/10",
  };
  return (
    <Card className="group relative overflow-hidden border-border/60 bg-gradient-to-br from-card via-card to-primary/[0.06] py-5 shadow-sm transition-all duration-300 hover:-translate-y-0.5 hover:shadow-lg">
      <CardContent className="relative flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <p className="text-xs font-medium text-muted-foreground">{label}</p>
          <p className="text-2xl font-bold tracking-tight tabular-nums text-foreground">
            {value}
          </p>
          {detail && <p className="truncate text-[11px] text-muted-foreground">{detail}</p>}
        </div>
        {icon && (
          <div
            className={cn(
              "flex size-11 shrink-0 items-center justify-center rounded-2xl ring-1 ring-inset ring-current/10 transition-transform group-hover:scale-105",
              iconColors[tone]
            )}
          >
            {icon}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function StatusAlert({
  tone = "info",
  title,
  action,
  className,
  children,
}: {
  tone?: "info" | "success" | "warning" | "danger";
  title?: string;
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  const variantMap = {
    info: "info",
    success: "success",
    warning: "warning",
    danger: "destructive",
  } as const;

  const iconMap = {
    info: <RiInformationLine className="size-4" aria-hidden="true" />,
    success: <RiCheckboxCircleLine className="size-4" aria-hidden="true" />,
    warning: <RiErrorWarningLine className="size-4" aria-hidden="true" />,
    danger: <RiCloseCircleLine className="size-4" aria-hidden="true" />,
  };

  return (
    <Alert variant={variantMap[tone]} className={className}>
      {iconMap[tone]}
      {title && <AlertTitle>{title}</AlertTitle>}
      <AlertDescription>{children}</AlertDescription>
      {action && <AlertAction>{action}</AlertAction>}
    </Alert>
  );
}

export function EmptyStatePanel({
  icon,
  tone = "primary",
  title,
  description,
  action,
  compact = false,
  className,
}: {
  icon: ReactNode;
  tone?: "primary" | "success" | "warning" | "danger" | "neutral";
  title: string;
  description: string;
  action?: ReactNode;
  compact?: boolean;
  className?: string;
}) {
  const stackToneClass: Record<typeof tone, string> = {
    primary: "text-primary [&_[data-slot=icon-stack-content]]:text-primary",
    success: "text-success [&_[data-slot=icon-stack-content]]:text-success",
    warning: "text-warning [&_[data-slot=icon-stack-content]]:text-warning",
    danger: "text-destructive [&_[data-slot=icon-stack-content]]:text-destructive",
    neutral: "text-muted-foreground [&_[data-slot=icon-stack-content]]:text-muted-foreground",
  };

  return (
    <Empty
      className={cn(
        "border bg-card/60 shadow-2xs",
        compact ? "gap-2.5 p-5" : "gap-4 px-6 py-10",
        className
      )}
    >
      <EmptyHeader>
        <EmptyMedia>
          <IconStack
            className={cn(
              compact ? "h-16 w-14" : "h-20 w-18",
              "[&_[data-slot=icon-stack-content]_svg]:size-5",
              stackToneClass[tone]
            )}
          >
            {icon}
          </IconStack>
        </EmptyMedia>
        <EmptyTitle className={compact ? "text-sm" : "text-base font-semibold"}>
          {title}
        </EmptyTitle>
        <EmptyDescription className="text-xs leading-relaxed">
          {description}
        </EmptyDescription>
      </EmptyHeader>
      {action && <EmptyContent>{action}</EmptyContent>}
    </Empty>
  );
}

export function ConfirmDeleteDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Delete",
  busy = false,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel?: string;
  busy?: boolean;
  onConfirm: () => Promise<void> | void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={busy}
            onClick={(e) => {
              e.preventDefault();
              void onConfirm();
            }}
          >
            {busy ? "Working..." : confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function FormField({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-xs font-medium text-muted-foreground">
        {label}
      </Label>
      {children}
      {error ? (
        <p className="text-[11px] font-medium text-destructive">{error}</p>
      ) : (
        hint && <p className="text-[11px] text-muted-foreground">{hint}</p>
      )}
    </div>
  );
}

export function ThemeToggleButton({
  themeMode,
  onToggleTheme,
}: {
  themeMode?: "light" | "dark";
  onToggleTheme?: () => void;
}) {
  const [localDark, setLocalDark] = useState<boolean>(() => {
    if (typeof document === "undefined") return false;
    return document.documentElement.classList.contains("dark");
  });

  const isControlled = themeMode !== undefined && onToggleTheme !== undefined;
  const dark = isControlled ? themeMode === "dark" : localDark;

  useEffect(() => {
    if (isControlled) return;
    if (localDark) {
      document.documentElement.classList.add("dark");
      try {
        localStorage.setItem("homecoreos:theme", "dark");
      } catch {
        // ignore storage restrictions
      }
    } else {
      document.documentElement.classList.remove("dark");
      try {
        localStorage.setItem("homecoreos:theme", "light");
      } catch {
        // ignore storage restrictions
      }
    }
  }, [isControlled, localDark]);

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={() => {
        if (onToggleTheme) {
          onToggleTheme();
        } else {
          setLocalDark((d) => !d);
        }
      }}
      title={dark ? "Switch to light mode" : "Switch to dark mode"}
      aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
    >
      {dark ? (
        <RiSunLine className="size-4" aria-hidden="true" />
      ) : (
        <RiMoonLine className="size-4" aria-hidden="true" />
      )}
      <span className="hidden sm:inline">{dark ? "Light" : "Dark"}</span>
    </Button>
  );
}

export function TimezoneSelect({
  id = "timezone-select",
  ariaLabel,
  value,
  onChange,
  onValueChange,
  inheritLabel,
  disabled = false,
  includeBrowserAuto = false,
  className,
}: {
  id?: string;
  ariaLabel?: string;
  value: string;
  onChange?: (tz: string) => void;
  onValueChange?: (tz: string) => void;
  inheritLabel?: string;
  disabled?: boolean;
  includeBrowserAuto?: boolean;
  className?: string;
}) {
  const regions = getTimezoneRegions();
  const browserTz = getBrowserTimezoneFallback();
  const handleSelect = (next: string) => {
    onValueChange?.(next);
    onChange?.(next);
  };
  const knownValues = new Set<string>(
    regions.flatMap((r) => r.items.map((item) => item.value))
  );
  const hasCurrent =
    value === "auto" || value === "__default__" || knownValues.has(value);

  return (
    <Select value={value} onValueChange={handleSelect} disabled={disabled}>
      <SelectTrigger id={id} aria-label={ariaLabel} className={cn("w-full", className)}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {inheritLabel && (
          <SelectItem value="__default__">{inheritLabel}</SelectItem>
        )}
        {includeBrowserAuto && (
          <SelectItem value="auto">
            Auto-detect browser ({browserTz})
          </SelectItem>
        )}
        {!hasCurrent && <SelectItem value={value}>{value}</SelectItem>}
        {regions.map((group) => (
          <SelectGroup key={group.region}>
            <SelectLabel>{group.region}</SelectLabel>
            {group.items.map((tz) => (
              <SelectItem key={tz.value} value={tz.value}>
                {tz.label}
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  );
}
