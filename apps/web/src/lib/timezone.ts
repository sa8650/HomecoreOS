import { createContext, useContext } from "react";
import { REGIONAL_TIMEZONES, isValidIanaTimezone } from "@homecoreos/shared";

export const TimezoneContext = createContext<string>("UTC");

export function useEffectiveTimezone(): string {
  return useContext(TimezoneContext);
}

export function getTimezoneRegions() {
  const byRegion = new Map<string, Array<(typeof REGIONAL_TIMEZONES)[number]>>();
  for (const item of REGIONAL_TIMEZONES) {
    const arr = byRegion.get(item.region) ?? [];
    arr.push(item);
    byRegion.set(item.region, arr);
  }
  return Array.from(byRegion.entries()).map(([region, items]) => ({
    region,
    items,
  }));
}

export function getBrowserTimezoneFallback(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return tz && isValidIanaTimezone(tz) ? tz : "UTC";
  } catch {
    return "UTC";
  }
}

export function formatTimestamp(
  value: string | number | Date | null | undefined,
  timezone: string,
  options: Intl.DateTimeFormatOptions = {
    dateStyle: "medium",
    timeStyle: "short",
  }
): string {
  if (!value) return "Never";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "Invalid date";

  const safeZone = isValidIanaTimezone(timezone) ? timezone : "UTC";
  try {
    return new Intl.DateTimeFormat("en-US", {
      ...options,
      timeZone: safeZone,
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

export function formatShortTime(
  value: string | number | Date | null | undefined,
  timezone: string
): string {
  return formatTimestamp(value, timezone, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function formatClockWithZone(timezone: string, now = new Date()): string {
  const safeZone = isValidIanaTimezone(timezone) ? timezone : "UTC";
  try {
    return new Intl.DateTimeFormat("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: safeZone,
      timeZoneName: "short",
    }).format(now);
  } catch {
    return safeZone;
  }
}
