import { describe, expect, it } from "vitest";
import type { SensorItem } from "../features/types";
import {
  formatMultiMetricSummary,
  getSensorThresholdConfig,
  isSensorThresholdExceeded,
  resolveSensorReadings,
} from "./sensor-readings";

function makeSensor(overrides: Partial<SensorItem>): SensorItem {
  return {
    id: "sen-1",
    account_id: "acc-1",
    home_id: "home-1",
    room_id: "room-1",
    board_instance_id: "ctrl-1",
    name: "Living Sensor",
    sensor_type: "temperature_dht22",
    gpio_pin: 21,
    driver_id: "dht22",
    unit: "°C",
    last_value: 24.5,
    last_raw_payload: null,
    is_online: true,
    last_reading_at: "2026-11-25T10:00:00Z",
    ...overrides,
  };
}

describe("sensor-readings", () => {
  it("resolves both temperature and humidity for a DHT22 sensor from last_raw_payload", () => {
    const dht = makeSensor({
      driver_id: "dht22",
      sensor_type: "temperature_dht22",
      last_value: 25.2,
      last_raw_payload: { humidity_dht22: 61 },
    });

    const readings = resolveSensorReadings(dht);
    expect(readings).toHaveLength(2);
    expect(readings[0]).toMatchObject({
      measurement: "temperature_dht22",
      label: "Temperature",
      value: 25.2,
      unit: "°C",
      formatted: "25.2°C",
    });
    expect(readings[1]).toMatchObject({
      measurement: "humidity_dht22",
      label: "Humidity",
      value: 61,
      unit: "%",
      formatted: "61%",
    });
    expect(formatMultiMetricSummary(dht)).toBe("25.2°C · 61%");
  });

  it("resolves all 3 readings (temperature, humidity, pressure) for a BME280 sensor", () => {
    const bme = makeSensor({
      driver_id: "bme280",
      sensor_type: "temperature_bme280",
      gpio_pin: null,
      i2c_address: "0x76",
      last_value: 22.8,
      last_raw_payload: {
        humidity: 54,
        pressure: 1013.2,
      },
    });

    const readings = resolveSensorReadings(bme);
    expect(readings).toHaveLength(3);
    expect(readings.map((r) => r.formatted)).toEqual([
      "22.8°C",
      "54%",
      "1013.2 hPa",
    ]);
    expect(formatMultiMetricSummary(bme)).toBe("22.8°C · 54% · 1013.2 hPa");
  });

  it("resolves sibling sensor readings on the same pin", () => {
    const temp = makeSensor({
      id: "sen-t",
      driver_id: "dht22",
      sensor_type: "temperature_dht22",
      gpio_pin: 21,
      last_value: 27.4,
    });
    const hum = makeSensor({
      id: "sen-h",
      driver_id: "dht22",
      sensor_type: "humidity_dht22",
      gpio_pin: 21,
      unit: "%",
      last_value: 58,
    });

    const readings = resolveSensorReadings(temp, [temp, hum]);
    expect(readings[0]?.formatted).toBe("27.4°C");
    expect(readings[1]?.formatted).toBe("58%");
  });

  it("detects when a sensor threshold is exceeded", () => {
    const sensor = makeSensor({
      last_value: 32.5,
      last_raw_payload: {
        threshold_enabled: true,
        threshold_value: 30,
      },
    });

    expect(getSensorThresholdConfig(sensor)).toEqual({
      enabled: true,
      value: 30,
    });
    expect(isSensorThresholdExceeded(sensor)).toEqual({
      exceeded: true,
      currentValue: 32.5,
      thresholdValue: 30,
      unit: "°C",
    });

    const normalSensor = makeSensor({
      last_value: 28,
      last_raw_payload: {
        threshold_enabled: true,
        threshold_value: 30,
      },
    });
    expect(isSensorThresholdExceeded(normalSensor).exceeded).toBe(false);
  });
});
