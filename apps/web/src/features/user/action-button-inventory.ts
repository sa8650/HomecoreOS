import { useEffect, useState } from "react";
import { cachedGet } from "@/lib/api";
import type {
  AutomationTriggerConfig,
} from "@homecoreos/shared";
import type {
  DeviceItem,
  RoomItem,
  SwitchItem,
} from "@/features/types";

export interface ActionButtonAutomationOption {
  id: string;
  name: string;
  scene: boolean;
}

export interface ActionButtonInventory {
  switches: SwitchItem[];
  devices: DeviceItem[];
  rooms: RoomItem[];
  automations: ActionButtonAutomationOption[];
  loading: boolean;
}

const EMPTY: Omit<ActionButtonInventory, "loading"> = {
  switches: [],
  devices: [],
  rooms: [],
  automations: [],
};

interface AutomationApiRule {
  id: string;
  name: string;
  trigger_config?: AutomationTriggerConfig | null;
}

function isSceneRule(rule: AutomationApiRule): boolean {
  const trig: AutomationTriggerConfig | null | undefined = rule.trigger_config;
  if (!trig) return false;
  const list =
    Array.isArray(trig.triggers) && trig.triggers.length > 0 ? trig.triggers : [trig];
  return list.every(
    (item: { type: string }) => item.type === "manual"
  );
}

/** Loads the account's controllable resources once and caches them. */
export function useActionButtonInventory(enabled = true): ActionButtonInventory {
  const [inventory, setInventory] = useState<ActionButtonInventory>({
    ...EMPTY,
    loading: enabled,
  });

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setInventory((prev) => ({ ...prev, loading: true }));
    Promise.all([
      cachedGet<{ switches?: SwitchItem[] }>("/api/switches", { ttlMs: 12_000 }).catch(
        () => ({ switches: [] as SwitchItem[] })
      ),
      cachedGet<{ devices?: DeviceItem[] }>("/api/devices", { ttlMs: 12_000 }).catch(
        () => ({ devices: [] as DeviceItem[] })
      ),
      cachedGet<{ rooms?: RoomItem[] }>("/api/homes/rooms", { ttlMs: 20_000 }).catch(
        () => ({ rooms: [] as RoomItem[] })
      ),
      cachedGet<{ automations?: AutomationApiRule[] }>("/api/automations", {
        ttlMs: 15_000,
      }).catch(() => ({ automations: [] as AutomationApiRule[] })),
    ])
      .then(([swRes, devRes, roomRes, autoRes]) => {
        if (cancelled) return;
        setInventory({
          switches: swRes.switches ?? [],
          devices: devRes.devices ?? [],
          rooms: roomRes.rooms ?? [],
          automations: (autoRes.automations ?? []).map((rule) => ({
            id: rule.id,
            name: rule.name,
            scene: isSceneRule(rule),
          })),
          loading: false,
        });
      })
      .catch(() => {
        if (cancelled) return;
        setInventory({ ...EMPTY, loading: false });
      });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return inventory;
}
