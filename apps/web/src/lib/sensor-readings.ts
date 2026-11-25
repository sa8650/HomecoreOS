import {
  getSensorDriverById,
  getSensorDriverForMeasurement,
  type SupportedSensorType,
} from "@homecoreos/shared";
import type { SensorItem } from "../features/types";

export interface ResolvedSensorReading {
  measurement: string;
  label: string;
  shortLabel: string;
  value: number | null;
  unit: string;
  formatted: string;
}

const METRIC_LABELS: Record<string, { label: string; shortLabel: string; keys: string[] }> = {
  temperature: { label: "Temperature", shortLabel: "Temp", keys: ["temperature", "temp"] },
  humidity: { label: "Humidity", shortLabel: "Hum", keys: ["humidity", "hum", "rh"] },
  pressure: { label: "Pressure", shortLabel: "Press", keys: ["pressure", "press", "hpa"] },
  motion: { label: "Motion", shortLabel: "Motion", keys: ["motion"] },
  presence: { label: "Presence", shortLabel: "Pres", keys: ["presence"] },
  distance: { label: "Distance", shortLabel: "Dist", keys: ["distance", "dist"] },
  light: { label: "Light", shortLabel: "Light", keys: ["light", "lux", "illuminance"] },
  tvoc: { label: "TVOC", shortLabel: "TVOC", keys: ["tvoc"] },
  eco2: { label: "eCO2", shortLabel: "eCO2", keys: ["eco2", "co2"] },
  voltage: { label: "Voltage", shortLabel: "Volt", keys: ["voltage", "volt"] },
  current: { label: "Current", shortLabel: "Curr", keys: ["current", "amp"] },
  power: { label: "Power", shortLabel: "Power", keys: ["power", "watt"] },
  contact: { label: "Contact", shortLabel: "Contact", keys: ["contact"] },
  water_leak: { label: "Water Leak", shortLabel: "Leak", keys: ["water_leak", "leak"] },
  water_level: { label: "Water Level", shortLabel: "Level", keys: ["water_level", "level"] },
  soil_moisture: { label: "Soil Moisture", shortLabel: "Soil", keys: ["soil_moisture", "moisture"] },
  rain_level: { label: "Rain", shortLabel: "Rain", keys: ["rain_level", "rain"] },
  analog_voltage: { label: "Voltage", shortLabel: "Volt", keys: ["analog_voltage", "voltage"] },
};

function getMetricMeta(measurement: string): { label: string; shortLabel: string; keys: string[] } {
  const lower = measurement.toLowerCase();
  if (METRIC_LABELS[lower]) return METRIC_LABELS[lower];
  const prefix = lower.split("_")[0] ?? lower;
  if (METRIC_LABELS[prefix]) return METRIC_LABELS[prefix];
  const pretty = prefix.charAt(0).toUpperCase() + prefix.slice(1);
  return { label: pretty, shortLabel: pretty, keys: [lower, prefix] };
}

function toFiniteNumber(val: unknown): number | null {
  if (typeof val === "number" && Number.isFinite(val)) return val;
  if (typeof val === "string" && val.trim() !== "") {
    const n = Number(val);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function readFromPayload(
  payload: Record<string, unknown> | null | undefined,
  measurement: string,
  keys: string[]
): number | null {
  if (!payload) return null;
  const containers: Record<string, unknown>[] = [payload];
  if (payload.readings && typeof payload.readings === "object") {
    containers.push(payload.readings as Record<string, unknown>);
  }
  if (payload.values && typeof payload.values === "object") {
    containers.push(payload.values as Record<string, unknown>);
  }
  for (const container of containers) {
    const direct = toFiniteNumber(container[measurement]);
    if (direct !== null) return direct;
    for (const k of keys) {
      const v = toFiniteNumber(container[k]);
      if (v !== null) return v;
    }
  }
  return null;
}

function findSiblingReading(
  sensor: SensorItem,
  measurement: string,
  allSensors?: SensorItem[]
): number | null {
  if (!allSensors || allSensors.length === 0) return null;
  const sensorI2c =
    sensor.i2c_address ??
    (typeof sensor.last_raw_payload?.i2c_address === "string"
      ? sensor.last_raw_payload.i2c_address
      : null);

  for (const other of allSensors) {
    if (other.id === sensor.id) continue;
    if (other.sensor_type !== measurement) continue;
    if (other.board_instance_id !== sensor.board_instance_id) continue;

    const samePhysical =
      Boolean(sensor.physical_sensor_id) &&
      other.physical_sensor_id === sensor.physical_sensor_id;
    const samePin =
      sensor.gpio_pin !== null &&
      sensor.gpio_pin !== undefined &&
      other.gpio_pin === sensor.gpio_pin;
    const otherI2c =
      other.i2c_address ??
      (typeof other.last_raw_payload?.i2c_address === "string"
        ? other.last_raw_payload.i2c_address
        : null);
    const sameI2c = Boolean(sensorI2c) && otherI2c === sensorI2c;

    if (samePhysical || samePin || sameI2c) {
      if (other.last_value !== null && other.last_value !== undefined) {
        return other.last_value;
      }
    }
  }
  return null;
}

export function formatReadingValue(value: number | null, unit: string): string {
  if (value === null || value === undefined) return "—";
  if (!unit) return String(value);
  if (unit === "°C" || unit === "°F" || unit === "%") {
    return `${value}${unit}`;
  }
  return `${value} ${unit}`;
}

export function resolveSensorReadings(
  sensor: SensorItem,
  allSensors?: SensorItem[]
): ResolvedSensorReading[] {
  const driverId =
    sensor.driver_id ??
    (typeof sensor.last_raw_payload?.driver_id === "string"
      ? sensor.last_raw_payload.driver_id
      : null);
  const driver =
    (driverId ? getSensorDriverById(driverId) : undefined) ??
    getSensorDriverForMeasurement(sensor.sensor_type as SupportedSensorType);

  const measurements: string[] = driver?.measurements?.length
    ? [...driver.measurements]
    : [sensor.sensor_type];

  return measurements.map((measurement) => {
    const meta = getMetricMeta(measurement);
    const defaultUnit =
      driver?.defaultUnits?.[measurement as SupportedSensorType] ?? "";
    const unit =
      measurement === sensor.sensor_type
        ? sensor.unit || defaultUnit
        : defaultUnit;

    let value: number | null = null;
    if (measurement === sensor.sensor_type) {
      value = sensor.last_value ?? null;
    }
    if (value === null) {
      value = readFromPayload(sensor.last_raw_payload, measurement, meta.keys);
    }
    if (value === null) {
      value = findSiblingReading(sensor, measurement, allSensors);
    }

    return {
      measurement,
      label: meta.label,
      shortLabel: meta.shortLabel,
      value,
      unit,
      formatted: formatReadingValue(value, unit),
    };
  });
}

export function formatMultiMetricSummary(
  sensor: SensorItem,
  allSensors?: SensorItem[]
): string {
  const readings = resolveSensorReadings(sensor, allSensors);
  if (readings.length <= 1) {
    return readings[0]?.formatted ?? "—";
  }
  const hasAny = readings.some((r) => r.value !== null);
  if (!hasAny) return "—";
  return readings.map((r) => r.formatted).join(" · ");
}

export function getSensorThresholdConfig(sensor: SensorItem): {
  enabled: boolean;
  value: number | null;
} {
  const raw = sensor.last_raw_payload;
  const enabled =
    sensor.threshold_enabled ??
    (typeof raw?.threshold_enabled === "boolean" ? raw.threshold_enabled : false);
  const value =
    sensor.threshold_value ??
    (typeof raw?.threshold_value === "number" && Number.isFinite(raw.threshold_value)
      ? raw.threshold_value
      : null);
  return { enabled, value };
}

export function isSensorThresholdExceeded(
  sensor: SensorItem,
  allSensors?: SensorItem[]
): {
  exceeded: boolean;
  currentValue: number | null;
  thresholdValue: number | null;
  unit: string;
} {
  const { enabled, value: thresholdValue } = getSensorThresholdConfig(sensor);
  if (!enabled || thresholdValue === null) {
    return { exceeded: false, currentValue: null, thresholdValue, unit: sensor.unit };
  }
  const readings = resolveSensorReadings(sensor, allSensors);
  for (const r of readings) {
    if (r.value !== null && r.value > thresholdValue) {
      return {
        exceeded: true,
        currentValue: r.value,
        thresholdValue,
        unit: r.unit || sensor.unit,
      };
    }
  }
  return {
    exceeded: false,
    currentValue: sensor.last_value,
    thresholdValue,
    unit: sensor.unit,
  };
}
