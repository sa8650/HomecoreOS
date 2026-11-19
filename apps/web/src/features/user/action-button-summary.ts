import type { ActionButtonStep } from "@homecoreos/shared";
import type { ActionButtonInventory } from "./action-button-inventory";

export function summarizeStep(
  step: ActionButtonStep,
  inventory: ActionButtonInventory
): string {
  const opLabel = (op: string) =>
    op === "toggle" ? "Toggle" : op.toUpperCase();
  switch (step.kind) {
    case "switch": {
      const sw = inventory.switches.find((s) => s.id === step.switchId);
      return `${sw?.name ?? "Switch"} → ${opLabel(step.op)}`;
    }
    case "device": {
      const dev = inventory.devices.find((d) => d.id === step.deviceId);
      return `${dev?.name ?? "Device"} → ${opLabel(step.op)}`;
    }
    case "room": {
      const room = inventory.rooms.find((r) => r.id === step.roomId);
      const target =
        step.target === "all" ? "switches & devices" : step.target;
      return `${room?.name ?? "Room"} · ${target} → ${opLabel(step.op)}`;
    }
    case "all": {
      const target =
        step.target === "all" ? "All switches & devices" : `All ${step.target}`;
      return `${target} → ${opLabel(step.op)}`;
    }
    case "automation": {
      const rule = inventory.automations.find((a) => a.id === step.automationId);
      const prefix = rule?.scene ? "Scene" : "Automation";
      return `Run ${prefix} "${rule?.name ?? "Unknown"}"`;
    }
    case "delay":
      return step.ms >= 1000 && step.ms % 1000 === 0
        ? `Wait ${step.ms / 1000}s`
        : `Wait ${step.ms} ms`;
  }
}

let stepUidCounter = 0;
/** Stable-enough unique id for steps (client-side only). */
export function nextStepId(): string {
  stepUidCounter += 1;
  return `step-${Date.now().toString(36)}-${stepUidCounter}-${Math.random()
    .toString(36)
    .slice(2, 7)}`;
}
