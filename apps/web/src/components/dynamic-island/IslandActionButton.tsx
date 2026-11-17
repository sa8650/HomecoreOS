import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  RiAlertLine,
  RiCheckLine,
  RiLoader4Line,
} from "@remixicon/react";
import { toast } from "sonner";
import {
  isGestureConfigured,
  type ActionButtonGesture,
} from "@homecoreos/shared";
import { apiFetch, ApiError, invalidateApiCache } from "@/lib/api";
import {
  ActionButtonGlyph,
  actionButtonColorHex,
  aggregateStateLabel,
} from "@/components/action-button/action-button-glyphs";
import type {
  ActionButtonConfigItem,
  ActionButtonExecutionResult,
} from "@/features/types";

const ACTION_BUTTON_CHANGED_EVENT = "hc:action-button-changed";

export function notifyActionButtonConfigChanged(): void {
  window.dispatchEvent(new Event(ACTION_BUTTON_CHANGED_EVENT));
}

type RunState = "idle" | "running" | "success" | "error";

const DOUBLE_CLICK_WINDOW_MS = 340;
const SINGLE_CLICK_DELAY_MS = 260;
const LONG_PRESS_MS = 550;
const ARM_TIMEOUT_MS = 4_000;
const FEEDBACK_FLASH_MS = 1_700;

/**
 * Dedicated, customizable Dynamic Island action button.
 * Gestures: single / double / long press (each independently configurable
 * per user in User Settings → Action Button).
 *
 * Renders nothing (button and its reserved space) unless the signed-in user
 * has an active, enabled Action Button configured in User Settings.
 */
export function IslandActionButton() {
  const [configs, setConfigs] = useState<ActionButtonConfigItem[] | null>(null);
  const [runState, setRunState] = useState<RunState>("idle");
  const [armed, setArmed] = useState(false);
  const [flashStates, setFlashStates] = useState<
    { on: number; off: number } | null | undefined
  >(undefined);

  const inFlightRef = useRef(false);
  const runResetTimerRef = useRef<number | null>(null);
  const armTimerRef = useRef<number | null>(null);
  const singleClickTimerRef = useRef<number | null>(null);
  const longPressTimerRef = useRef<number | null>(null);
  const lastClickAtRef = useRef(0);
  const suppressClickRef = useRef(false);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch<{ configs?: ActionButtonConfigItem[] }>(
        "/api/action-button/configs"
      );
      setConfigs(res.configs ?? []);
      // Live server state supersedes the short-lived post-execution flash.
      setFlashStates(undefined);
    } catch {
      setConfigs([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Refresh when the User Settings section mutates configurations
  useEffect(() => {
    const onChanged = () => void load();
    window.addEventListener(ACTION_BUTTON_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(ACTION_BUTTON_CHANGED_EVENT, onChanged);
  }, [load]);

  useEffect(() => {
    return () => {
      for (const ref of [
        runResetTimerRef,
        armTimerRef,
        singleClickTimerRef,
        longPressTimerRef,
      ]) {
        if (ref.current !== null) window.clearTimeout(ref.current);
      }
    };
  }, []);

  const active = configs?.find((c) => c.isActive) ?? null;
  const enabled = active && active.isEnabled ? active : null;
  const states =
    flashStates !== undefined ? flashStates : enabled?.states ?? null;
  const stateLabel = aggregateStateLabel(states);
  const colorHex = actionButtonColorHex(enabled?.color);

  const disarm = useCallback(() => {
    setArmed(false);
    if (armTimerRef.current !== null) {
      window.clearTimeout(armTimerRef.current);
      armTimerRef.current = null;
    }
  }, []);

  const flashFeedback = useCallback((next: RunState) => {
    setRunState(next);
    if (runResetTimerRef.current !== null) {
      window.clearTimeout(runResetTimerRef.current);
    }
    runResetTimerRef.current = window.setTimeout(
      () => setRunState("idle"),
      FEEDBACK_FLASH_MS
    );
  }, []);

  const execute = useCallback(
    async (config: ActionButtonConfigItem, gesture: ActionButtonGesture) => {
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      setRunState("running");
      disarm();
      try {
        const res = await apiFetch<ActionButtonExecutionResult>(
          `/api/action-button/configs/${config.id}/execute`,
          { method: "POST", body: JSON.stringify({ gesture }) }
        );
        const execution = res.execution;
        setFlashStates(execution.states ?? null);
        if (execution.failedCount === 0) {
          flashFeedback("success");
          toast.success(
            execution.executedCount === 1
              ? `${config.name}: done.`
              : `${config.name}: ${execution.executedCount} actions completed.`
          );
        } else {
          flashFeedback("error");
          const firstErrors = execution.results
            .filter((r) => r.error)
            .slice(0, 2)
            .map((r) => r.error)
            .join(" ");
          toast.error(
            execution.executedCount > 0
              ? `${config.name}: partly completed — ${firstErrors}`
              : `${config.name}: failed — ${firstErrors}`
          );
        }
        invalidateApiCache(
          "/api/switches",
          "/api/devices",
          "/api/homes/overview",
          "/api/activity"
        );
        void load();
      } catch (err) {
        flashFeedback("error");
        toast.error(
          err instanceof ApiError ? err.message : "Action failed to run."
        );
      } finally {
        inFlightRef.current = false;
      }
    },
    [disarm, flashFeedback, load]
  );

  const runGesture = useCallback(
    (gesture: ActionButtonGesture) => {
      if (!enabled) return;
      if (gesture !== "single" && !isGestureConfigured(enabled.config, gesture)) {
        toast.message(
          gesture === "double"
            ? "Double press isn't configured for this button"
            : "Long press isn't configured for this button",
          { description: "Open User Settings → Action Button to assign one." }
        );
        return;
      }
      void execute(enabled, gesture);
    },
    [enabled, execute]
  );

  const handleSinglePress = useCallback(() => {
    if (!enabled) return;
    // Optional confirmation: first tap arms the button, second tap runs it.
    if (enabled.confirmationRequired && !armed) {
      setArmed(true);
      if (armTimerRef.current !== null) window.clearTimeout(armTimerRef.current);
      armTimerRef.current = window.setTimeout(() => setArmed(false), ARM_TIMEOUT_MS);
      return;
    }

    const hasDouble = isGestureConfigured(enabled.config, "double");
    if (hasDouble) {
      // Delay so a double click can preempt the single-press action.
      if (singleClickTimerRef.current !== null) {
        window.clearTimeout(singleClickTimerRef.current);
      }
      singleClickTimerRef.current = window.setTimeout(
        () => void execute(enabled, "single"),
        SINGLE_CLICK_DELAY_MS
      );
    } else {
      void execute(enabled, "single");
    }
  }, [armed, enabled, execute]);

  const handleDoublePress = useCallback(() => {
    if (!enabled) return;
    if (singleClickTimerRef.current !== null) {
      window.clearTimeout(singleClickTimerRef.current);
      singleClickTimerRef.current = null;
    }
    setArmed(false);
    runGesture("double");
  }, [enabled, runGesture]);

  const clearLongPressTimer = useCallback(() => {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);

  const handlePointerDown = useCallback(() => {
    if (!enabled) return;
    if (!isGestureConfigured(enabled.config, "long")) return;
    clearLongPressTimer();
    longPressTimerRef.current = window.setTimeout(() => {
      suppressClickRef.current = true;
      setArmed(false);
      runGesture("long");
    }, LONG_PRESS_MS);
  }, [clearLongPressTimer, enabled, runGesture]);

  const handleClick = useCallback(() => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    // While armed for confirmation, any tap confirms immediately.
    if (armed && enabled?.confirmationRequired) {
      setArmed(false);
      void execute(enabled, "single");
      return;
    }
    const now = Date.now();
    if (now - lastClickAtRef.current < DOUBLE_CLICK_WINDOW_MS) {
      lastClickAtRef.current = 0;
      handleDoublePress();
      return;
    }
    lastClickAtRef.current = now;
    handleSinglePress();
  }, [armed, enabled, execute, handleDoublePress, handleSinglePress]);

  // ── Loading or unconfigured: render nothing at all ──────────────────────
  // No button, no reserved space, no placeholder or settings shortcut — the
  // surrounding island controls simply close up the gap.
  if (!enabled) {
    return null;
  }

  // ── Configured button ────────────────────────────────────────────────────
  const renderIcon = () => {
    if (runState === "running") {
      return <RiLoader4Line className="size-4 animate-spin" aria-hidden="true" />;
    }
    if (runState === "success") {
      return <RiCheckLine className="size-4" aria-hidden="true" />;
    }
    if (runState === "error") {
      return <RiAlertLine className="size-4" aria-hidden="true" />;
    }
    return (
      <ActionButtonGlyph
        icon={enabled.icon}
        className="size-4"
        style={{ color: runState === "idle" ? colorHex : undefined }}
      />
    );
  };

  const ariaLabel = [
    `${enabled.name} action button`,
    stateLabel ? `currently ${stateLabel}` : null,
    armed ? "tap again to confirm" : null,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <button
      type="button"
      data-island-control=""
      className="island-action"
      data-testid="island-action-button"
      data-state={runState}
      data-armed={armed ? "true" : undefined}
      aria-label={ariaLabel}
      title={
        armed
          ? "Tap again to confirm"
          : `${enabled.name}${stateLabel ? ` · ${stateLabel}` : ""}${
              isGestureConfigured(enabled.config, "double") ||
              isGestureConfigured(enabled.config, "long")
                ? " · supports double / long press"
                : ""
            }`
      }
      onPointerDown={handlePointerDown}
      onPointerUp={clearLongPressTimer}
      onPointerLeave={clearLongPressTimer}
      onPointerCancel={clearLongPressTimer}
      onContextMenu={(e) => {
        if (isGestureConfigured(enabled.config, "long")) e.preventDefault();
      }}
      onClick={handleClick}
    >
      {renderIcon()}
      <span className="island-action-label">
        {armed ? "Confirm?" : enabled.name}
      </span>
      {stateLabel && runState === "idle" && (
        <span className="island-action-state" data-testid="island-action-state" data-tone={stateLabel.toLowerCase()}>
          {stateLabel}
        </span>
      )}
    </button>
  );
}
