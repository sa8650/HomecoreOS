import { isValidIanaTimezone } from "./index";

export type AutomationOperator = "gt" | "gte" | "lt" | "lte" | "eq" | "neq";

export interface AutomationTriggerItem {
  id?: string;
  type: "sensor_value" | "device_state" | "time" | "sun_event";
  sensorId?: string;
  operator?: AutomationOperator;
  threshold?: number;
  deviceId?: string;
  switchId?: string;
  expectedState?: string | boolean;
  cronTime?: string;
  days?: string[];
  timezone?: string;
  sunEvent?: "sunrise" | "sunset";
  offsetMinutes?: number;
  latitude?: number;
  longitude?: number;
}

export interface AutomationTriggerConfig extends AutomationTriggerItem {
  triggers?: AutomationTriggerItem[];
}

export interface AutomationConditionItem {
  id?: string;
  type:
    | "sensor_value"
    | "switch_state"
    | "device_state"
    | "room_state"
    | "time_range";
  sensorId?: string;
  operator?: AutomationOperator;
  threshold?: number;
  switchId?: string;
  deviceId?: string;
  expectedState?: string | boolean;
  roomId?: string;
  roomMatch?: "all_on" | "all_off" | "any_on";
  startTime?: string;
  endTime?: string;
  days?: string[];
  timezone?: string;
}

export interface AutomationConditionGroup {
  id?: string;
  logic: "AND" | "OR";
  conditions: AutomationConditionItem[];
}

export interface AutomationConditionsGrouped {
  logic: "AND" | "OR";
  groups: AutomationConditionGroup[];
}

export type AutomationConditionsConfig =
  | AutomationConditionItem[]
  | AutomationConditionsGrouped;

export type SceneTargetItem =
  | { kind: "switch"; switchId: string; isOn: boolean }
  | { kind: "device"; deviceId: string; targetState: string };

export interface AutomationActionItem {
  id?: string;
  type: "switch_on" | "switch_off" | "device_state" | "scene";
  switchId?: string;
  deviceId?: string;
  targetState?: string;
  sceneName?: string;
  targets?: SceneTargetItem[];
}

const TIMEZONE_COORDINATES: Record<string, { lat: number; lng: number }> = {
  UTC: { lat: 51.48, lng: 0.0 },
  "America/New_York": { lat: 40.71, lng: -74.01 },
  "America/Chicago": { lat: 41.88, lng: -87.63 },
  "America/Denver": { lat: 39.74, lng: -104.99 },
  "America/Los_Angeles": { lat: 34.05, lng: -118.24 },
  "America/Toronto": { lat: 43.65, lng: -79.38 },
  "America/Sao_Paulo": { lat: -23.55, lng: -46.63 },
  "America/Mexico_City": { lat: 19.43, lng: -99.13 },
  "Europe/London": { lat: 51.51, lng: -0.13 },
  "Europe/Berlin": { lat: 52.52, lng: 13.41 },
  "Europe/Paris": { lat: 48.86, lng: 2.35 },
  "Europe/Amsterdam": { lat: 52.37, lng: 4.9 },
  "Europe/Madrid": { lat: 40.42, lng: -3.7 },
  "Europe/Rome": { lat: 41.9, lng: 12.5 },
  "Europe/Warsaw": { lat: 52.23, lng: 21.01 },
  "Europe/Istanbul": { lat: 41.01, lng: 28.98 },
  "Asia/Dhaka": { lat: 23.81, lng: 90.41 },
  "Asia/Kolkata": { lat: 28.61, lng: 77.21 },
  "Asia/Karachi": { lat: 24.86, lng: 67.01 },
  "Asia/Singapore": { lat: 1.35, lng: 103.82 },
  "Asia/Bangkok": { lat: 13.76, lng: 100.5 },
  "Asia/Jakarta": { lat: -6.21, lng: 106.85 },
  "Asia/Shanghai": { lat: 31.23, lng: 121.47 },
  "Asia/Tokyo": { lat: 35.68, lng: 139.77 },
  "Asia/Seoul": { lat: 37.57, lng: 126.98 },
  "Asia/Dubai": { lat: 25.2, lng: 55.27 },
  "Asia/Riyadh": { lat: 24.71, lng: 46.68 },
  "Africa/Cairo": { lat: 30.04, lng: 31.24 },
  "Africa/Lagos": { lat: 6.52, lng: 3.38 },
  "Africa/Johannesburg": { lat: -26.2, lng: 28.05 },
  "Australia/Sydney": { lat: -33.87, lng: 151.21 },
  "Australia/Melbourne": { lat: -37.81, lng: 144.96 },
  "Pacific/Auckland": { lat: -36.85, lng: 174.76 },
};

export function getCoordinatesForTimezone(
  timezone: string,
  latitude?: number,
  longitude?: number
): { lat: number; lng: number } {
  if (
    typeof latitude === "number" &&
    Number.isFinite(latitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    typeof longitude === "number" &&
    Number.isFinite(longitude) &&
    longitude >= -180 &&
    longitude <= 180
  ) {
    return { lat: latitude, lng: longitude };
  }
  return TIMEZONE_COORDINATES[timezone] ?? { lat: 23.81, lng: 90.41 };
}

/**
 * Pure NOAA solar equation calculator for sunrise & sunset in a target timezone.
 * Returns 24h "HH:MM" formatted local wall-clock time after applying offsetMinutes.
 */
export function computeSunTimeHHMM(params: {
  date: Date;
  event: "sunrise" | "sunset";
  timezone: string;
  offsetMinutes?: number;
  latitude?: number;
  longitude?: number;
}): string {
  const safeTz = isValidIanaTimezone(params.timezone) ? params.timezone : "UTC";
  const { lat, lng } = getCoordinatesForTimezone(
    safeTz,
    params.latitude,
    params.longitude
  );

  // Extract local calendar date parts in target timezone
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: safeTz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(params.date);
  const map = new Map(parts.map((p) => [p.type, p.value]));
  const year = Number(map.get("year") ?? params.date.getUTCFullYear());
  const month = Number(map.get("month") ?? params.date.getUTCMonth() + 1);
  const day = Number(map.get("day") ?? params.date.getUTCDate());

  const dayOfYear = Math.floor(
    (Date.UTC(year, month - 1, day) - Date.UTC(year, 0, 0)) / 86_400_000
  );
  const rad = Math.PI / 180;
  const deg = 180 / Math.PI;
  const lngHour = lng / 15;
  const approxTime =
    dayOfYear + ((params.event === "sunrise" ? 6 : 18) - lngHour) / 24;

  const meanAnomaly = 0.9856 * approxTime - 3.289;
  const trueLong =
    (meanAnomaly +
      1.916 * Math.sin(meanAnomaly * rad) +
      0.02 * Math.sin(2 * meanAnomaly * rad) +
      282.634 +
      360) %
    360;

  let ra = deg * Math.atan(0.91764 * Math.tan(trueLong * rad));
  ra = (ra + 360) % 360;
  const lQuad = Math.floor(trueLong / 90) * 90;
  const raQuad = Math.floor(ra / 90) * 90;
  ra = (ra + (lQuad - raQuad)) / 15;

  const sinDec = 0.39782 * Math.sin(trueLong * rad);
  const cosDec = Math.cos(Math.asin(sinDec));
  const zenithCos = Math.cos(90.833 * rad);
  const cosH =
    (zenithCos - sinDec * Math.sin(lat * rad)) / (cosDec * Math.cos(lat * rad));
  const clampedCosH = Math.max(-0.99, Math.min(0.99, cosH));

  let hourAngle =
    params.event === "sunrise"
      ? 360 - deg * Math.acos(clampedCosH)
      : deg * Math.acos(clampedCosH);
  hourAngle /= 15;

  const localMeanTime = hourAngle + ra - 0.06571 * approxTime - 6.622;
  const utcHours = ((localMeanTime - lngHour) % 24 + 24) % 24;

  // Determine timezone UTC offset in minutes at local noon on that day
  const noonUtc = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  const tzParts = new Intl.DateTimeFormat("en-US", {
    timeZone: safeTz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(noonUtc);
  const tzMap = new Map(tzParts.map((p) => [p.type, p.value]));
  const tzAsUtc = Date.UTC(
    Number(tzMap.get("year")),
    Number(tzMap.get("month")) - 1,
    Number(tzMap.get("day")),
    Number(tzMap.get("hour") === "24" ? 0 : tzMap.get("hour")),
    Number(tzMap.get("minute"))
  );
  const tzOffsetMin = Math.round((tzAsUtc - noonUtc.getTime()) / 60_000);

  const totalLocalMin =
    Math.round(utcHours * 60) + tzOffsetMin + (params.offsetMinutes ?? 0);
  const wrapped = ((totalLocalMin % 1440) + 1440) % 1440;
  const hh = String(Math.floor(wrapped / 60)).padStart(2, "0");
  const mm = String(wrapped % 60).padStart(2, "0");
  return `${hh}:${mm}`;
}

export function normalizeTriggerList(
  triggerConfig: AutomationTriggerConfig | null | undefined
): AutomationTriggerItem[] {
  if (!triggerConfig) return [];
  if (Array.isArray(triggerConfig.triggers) && triggerConfig.triggers.length > 0) {
    return triggerConfig.triggers;
  }
  return [triggerConfig];
}

export function buildTriggerConfigFromList(
  triggers: AutomationTriggerItem[]
): AutomationTriggerConfig {
  const first = triggers[0] ?? { type: "sensor_value" as const };
  if (triggers.length <= 1) {
    return { ...first };
  }
  return {
    ...first,
    triggers: triggers.map((t) => ({ ...t })),
  };
}

export function normalizeConditionGroups(
  conditionsConfig: AutomationConditionsConfig | null | undefined
): AutomationConditionsGrouped {
  if (!conditionsConfig) {
    return { logic: "AND", groups: [] };
  }
  if (Array.isArray(conditionsConfig)) {
    if (conditionsConfig.length === 0) {
      return { logic: "AND", groups: [] };
    }
    return {
      logic: "AND",
      groups: [{ id: "group-1", logic: "AND", conditions: conditionsConfig }],
    };
  }
  return {
    logic: conditionsConfig.logic === "OR" ? "OR" : "AND",
    groups: Array.isArray(conditionsConfig.groups)
      ? conditionsConfig.groups.map((g, idx) => ({
          id: g.id ?? `group-${idx + 1}`,
          logic: g.logic === "OR" ? "OR" : "AND",
          conditions: Array.isArray(g.conditions) ? g.conditions : [],
        }))
      : [],
  };
}

export function validateAutomationDraft(params: {
  name: string;
  triggers: AutomationTriggerItem[];
  conditions: AutomationConditionsGrouped;
  actions: AutomationActionItem[];
  fallbackTimezone?: string;
}): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!params.name.trim()) {
    errors.push("Automation name is required.");
  }

  if (params.triggers.length === 0) {
    errors.push("Add at least one WHEN trigger.");
  }

  params.triggers.forEach((trig, idx) => {
    const label = `Trigger #${idx + 1}`;
    if (trig.type === "sensor_value") {
      if (!trig.sensorId) errors.push(`${label}: select a sensor.`);
      if (!trig.operator) errors.push(`${label}: select a comparison operator.`);
      if (typeof trig.threshold !== "number" || !Number.isFinite(trig.threshold)) {
        errors.push(`${label}: enter a numeric threshold.`);
      }
    } else if (trig.type === "device_state") {
      const hasSw = Boolean(trig.switchId);
      const hasDev = Boolean(trig.deviceId);
      if (hasSw === hasDev) {
        errors.push(`${label}: select a switch or device to monitor.`);
      }
      if (hasSw && trig.expectedState === undefined) {
        errors.push(`${label}: choose expected switch state (ON/OFF).`);
      }
      if (hasDev && !String(trig.expectedState ?? "").trim()) {
        errors.push(`${label}: enter expected device state.`);
      }
    } else if (trig.type === "time") {
      if (!trig.cronTime || !/^([01]\d|2[0-3]):[0-5]\d$/.test(trig.cronTime)) {
        errors.push(`${label}: enter a valid HH:MM schedule time.`);
      }
      const tz = trig.timezone ?? params.fallbackTimezone;
      if (tz && !isValidIanaTimezone(tz)) {
        errors.push(`${label}: invalid timezone "${tz}".`);
      }
    } else if (trig.type === "sun_event") {
      if (trig.sunEvent !== "sunrise" && trig.sunEvent !== "sunset") {
        errors.push(`${label}: select sunrise or sunset.`);
      }
      if (
        trig.offsetMinutes !== undefined &&
        (!Number.isFinite(trig.offsetMinutes) ||
          trig.offsetMinutes < -180 ||
          trig.offsetMinutes > 180)
      ) {
        errors.push(`${label}: sun offset must be between -180 and +180 minutes.`);
      }
    }
  });

  params.conditions.groups.forEach((grp, gIdx) => {
    grp.conditions.forEach((cond, cIdx) => {
      const label = `Condition group #${gIdx + 1}, rule #${cIdx + 1}`;
      if (cond.type === "sensor_value") {
        if (!cond.sensorId) errors.push(`${label}: select a sensor.`);
        if (typeof cond.threshold !== "number" || !Number.isFinite(cond.threshold)) {
          errors.push(`${label}: enter a numeric threshold.`);
        }
      } else if (cond.type === "switch_state") {
        if (!cond.switchId) errors.push(`${label}: select a switch.`);
      } else if (cond.type === "device_state") {
        if (!cond.deviceId || !String(cond.expectedState ?? "").trim()) {
          errors.push(`${label}: select a device and state.`);
        }
      } else if (cond.type === "room_state") {
        if (!cond.roomId) errors.push(`${label}: select a room.`);
      } else if (cond.type === "time_range") {
        if (
          !cond.startTime ||
          !/^([01]\d|2[0-3]):[0-5]\d$/.test(cond.startTime) ||
          !cond.endTime ||
          !/^([01]\d|2[0-3]):[0-5]\d$/.test(cond.endTime)
        ) {
          errors.push(`${label}: provide valid HH:MM start and end times.`);
        }
      }
    });
  });

  if (params.actions.length === 0) {
    errors.push("Add at least one THEN action.");
  }

  params.actions.forEach((act, idx) => {
    const label = `Action #${idx + 1}`;
    if ((act.type === "switch_on" || act.type === "switch_off") && !act.switchId) {
      errors.push(`${label}: select a target switch.`);
    } else if (act.type === "device_state") {
      if (!act.deviceId || !String(act.targetState ?? "").trim()) {
        errors.push(`${label}: select a target device and state.`);
      }
    } else if (act.type === "scene") {
      if (!act.sceneName?.trim()) {
        errors.push(`${label}: enter a scene name.`);
      }
      if (!Array.isArray(act.targets) || act.targets.length === 0) {
        errors.push(`${label}: add at least one switch or device to the scene.`);
      }
    }
  });

  return { valid: errors.length === 0, errors };
}

export function analyzeLocalAutomationCapability(params: {
  triggers: AutomationTriggerItem[];
  conditions: AutomationConditionsGrouped;
  actions: AutomationActionItem[];
  switchControllerById: Map<string, string>;
  deviceControllerById: Map<string, string>;
  sensorControllerById: Map<string, string>;
}): {
  supported: boolean;
  controllerId: string | null;
  reasons: string[];
} {
  const reasons: string[] = [];
  const controllerIds = new Set<string>();

  for (const t of params.triggers) {
    if (t.type === "time" || t.type === "sun_event") {
      reasons.push(
        t.type === "sun_event"
          ? "Sunrise/sunset triggers use cloud solar computation."
          : "Time schedules run via cloud cron scheduler."
      );
    }
    if (t.sensorId) {
      const c = params.sensorControllerById.get(t.sensorId);
      if (c) controllerIds.add(c);
    }
    if (t.switchId) {
      const c = params.switchControllerById.get(t.switchId);
      if (c) controllerIds.add(c);
    }
    if (t.deviceId) {
      const c = params.deviceControllerById.get(t.deviceId);
      if (c) controllerIds.add(c);
    }
  }

  for (const grp of params.conditions.groups) {
    if (grp.logic === "OR" && grp.conditions.length > 1) {
      reasons.push("OR condition groups evaluate in the cloud engine.");
    }
    for (const c of grp.conditions) {
      if (c.type === "room_state" || c.type === "time_range") {
        reasons.push("Room-wide and time-window conditions evaluate in the cloud engine.");
      }
      if (c.sensorId) {
        const ctrl = params.sensorControllerById.get(c.sensorId);
        if (ctrl) controllerIds.add(ctrl);
      }
      if (c.switchId) {
        const ctrl = params.switchControllerById.get(c.switchId);
        if (ctrl) controllerIds.add(ctrl);
      }
      if (c.deviceId) {
        const ctrl = params.deviceControllerById.get(c.deviceId);
        if (ctrl) controllerIds.add(ctrl);
      }
    }
  }

  for (const a of params.actions) {
    if (a.type === "scene") {
      for (const target of a.targets ?? []) {
        const ctrl =
          target.kind === "switch"
            ? params.switchControllerById.get(target.switchId)
            : params.deviceControllerById.get(target.deviceId);
        if (ctrl) controllerIds.add(ctrl);
      }
    }
    if (a.switchId) {
      const ctrl = params.switchControllerById.get(a.switchId);
      if (ctrl) controllerIds.add(ctrl);
    }
    if (a.deviceId) {
      const ctrl = params.deviceControllerById.get(a.deviceId);
      if (ctrl) controllerIds.add(ctrl);
    }
  }

  if (controllerIds.size > 1) {
    reasons.push(
      "Targets span multiple controllers; cross-hub automations require cloud routing."
    );
  } else if (controllerIds.size === 0 && reasons.length === 0) {
    reasons.push("Assign hardware on one controller to enable local fallback.");
  }

  const supported = reasons.length === 0 && controllerIds.size === 1;
  return {
    supported,
    controllerId: supported ? Array.from(controllerIds)[0]! : null,
    reasons,
  };
}

const ACTIVE_DEVICE_STATES = new Set([
  "on",
  "active",
  "open",
  "unlocked",
  "true",
  "1",
]);

export function isDeviceStateActive(state: string | null | undefined): boolean {
  if (!state) return false;
  return ACTIVE_DEVICE_STATES.has(state.trim().toLowerCase());
}
