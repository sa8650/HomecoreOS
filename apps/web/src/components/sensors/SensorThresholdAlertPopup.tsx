import { useCallback, useEffect, useMemo, useState } from "react";
import { apiFetch } from "../../lib/api";
import { useLiveSync } from "../../lib/realtime/RealtimeProvider";
import type { SensorItem } from "../../features/types";
import {
  formatReadingValue,
  isSensorThresholdExceeded,
} from "../../lib/sensor-readings";
import { Button } from "../ui/button";

export function SensorThresholdAlertPopup() {
  const [sensors, setSensors] = useState<SensorItem[]>([]);
  const [dismissedKeys, setDismissedKeys] = useState<Set<string>>(() => new Set());

  const loadSensors = useCallback(async () => {
    try {
      const res = await apiFetch<{ sensors: SensorItem[] }>("/api/sensors");
      setSensors(res.sensors ?? []);
    } catch {
      // Ignore transient fetch errors in background alert watcher
    }
  }, []);

  useEffect(() => {
    void loadSensors();
  }, [loadSensors]);

  useLiveSync(loadSensors, { kinds: ["sensor"] });

  const activeAlerts = useMemo(() => {
    const alerts: Array<{
      key: string;
      sensorId: string;
      sensorName: string;
      currentFormatted: string;
      thresholdFormatted: string;
    }> = [];

    for (const sensor of sensors) {
      const check = isSensorThresholdExceeded(sensor, sensors);
      if (!check.exceeded || check.currentValue === null || check.thresholdValue === null) {
        continue;
      }
      const key = `${sensor.id}:${check.currentValue}:${check.thresholdValue}`;
      if (dismissedKeys.has(key)) continue;
      alerts.push({
        key,
        sensorId: sensor.id,
        sensorName: sensor.name,
        currentFormatted: formatReadingValue(check.currentValue, check.unit),
        thresholdFormatted: formatReadingValue(check.thresholdValue, check.unit),
      });
    }
    return alerts;
  }, [sensors, dismissedKeys]);

  if (activeAlerts.length === 0) return null;

  const dismiss = (key: string) => {
    setDismissedKeys((prev) => {
      const next = new Set(prev);
      next.add(key);
      return next;
    });
  };

  return (
    <div
      className="fixed bottom-4 right-4 z-50 flex max-w-sm flex-col gap-2.5"
      role="alertdialog"
      aria-live="assertive"
      aria-label="Sensor threshold alert"
      data-testid="sensor-threshold-alert-popup"
    >
      {activeAlerts.map((alert) => (
        <div
          key={alert.key}
          className="flex items-start gap-3 rounded-xl border border-destructive/40 bg-background/95 p-4 shadow-xl backdrop-blur-md"
        >
          <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-destructive/15 text-destructive">
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-foreground">
              Threshold Alert: {alert.sensorName}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Current reading{" "}
              <span className="font-semibold text-destructive">
                {alert.currentFormatted}
              </span>{" "}
              exceeded threshold ({alert.thresholdFormatted}).
            </p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0"
            aria-label={`Dismiss alert for ${alert.sensorName}`}
            onClick={() => dismiss(alert.key)}
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </Button>
        </div>
      ))}
    </div>
  );
}
