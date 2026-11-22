import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  WAVESHARE_ESP_OFFICIAL_BOARDS,
  buildFirmwareDriverManifest,
  evaluateControllerSensorCompatibility,
  extractFirmwareDriverManifestFromRelease,
} from "@homecoreos/shared";
import {
  HardwareDetailsModal,
  SensorEditorModal,
} from "../components/hardware/EntityModals";
import type { HardwareContext } from "../lib/board-pin-helpers";
import type { BoardProfileItem, ControllerItem, SensorItem } from "./types";
import { resetApiCache } from "../lib/api";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetApiCache();
});

function buildRelay6Board() {
  const seed = WAVESHARE_ESP_OFFICIAL_BOARDS.find(
    (b) => b.seed.slug === "waveshare-esp32-s3-relay-6ch"
  )!.seed;
  const board: BoardProfileItem = {
    id: "board-relay-6ch",
    slug: seed.slug,
    manufacturer: seed.manufacturer,
    model: seed.model,
    revision: seed.revision,
    chip_family: seed.chip_family,
    chip_variant: seed.chip_variant,
    flash_size_mb: seed.flash_size_mb,
    psram_size_mb: seed.psram_size_mb,
    gpio_definitions: seed.gpio_definitions,
    board_layout: seed.board_layout,
  };
  return { board, seed };
}

function makeController(
  id: string,
  name: string,
  board: BoardProfileItem,
  sensorCompatibility: ControllerItem["sensor_compatibility"]
): ControllerItem {
  return {
    id,
    account_id: "acc-1",
    home_id: "home-1",
    board_profile_id: board.id,
    custom_board_profile_id: null,
    name,
    hardware_uid: "AA:BB:CC:DD:EE:01",
    board_model: board.model,
    chip_variant: board.chip_variant,
    flash_size_mb: board.flash_size_mb,
    psram_size_mb: board.psram_size_mb,
    firmware_version: "1.4.0",
    status: "online",
    mqtt_connected: true,
    wifi_ssid: "LabWiFi",
    wifi_rssi: -52,
    local_ip: "192.168.1.50",
    last_heartbeat_at: null,
    last_communication_at: null,
    paired_at: null,
    connection_history: [],
    sensor_compatibility: sensorCompatibility,
  };
}

describe("SensorEditorModal — Board + Installed Firmware Compatibility", () => {
  it("filters sensors to board + installed firmware drivers, shows update alert & default I2C bus, and submits valid I2C sensor", async () => {
    const user = userEvent.setup();
    const { board, seed } = buildRelay6Board();

    const partialManifest = buildFirmwareDriverManifest({
      firmwareVersion: "1.4.0",
      chipFamily: "esp32s3",
      targetBoardSlug: board.slug,
      partitionScheme: "dual_ota_16mb",
      flashSizeMb: 16,
      psramMode: "octal",
      driverIds: ["bme280", "pir"],
    });
    const resolved = extractFirmwareDriverManifestFromRelease({
      id: "rel-partial",
      version: "1.4.0",
      chip_family: "esp32s3",
      target_board_slug: board.slug,
      driver_manifest: partialManifest,
      compiled_sensor_drivers: ["bme280", "pir"],
      supported_sensor_types: partialManifest.supported_sensor_types,
      manifest_version: partialManifest.manifest_version,
      manifest_hash: null,
    });
    const compatReport = evaluateControllerSensorCompatibility({
      board: seed,
      installedFirmware: resolved,
    });

    const ctrl = makeController("ctrl-relay", "Relay Panel 6CH", board, compatReport);
    const ctx: HardwareContext = {
      rooms: [],
      controllers: [ctrl],
      boardsById: new Map([[board.id, board]]),
      usedPinsByController: new Map(),
      sensorCompatibilityByController: new Map([[ctrl.id, compatReport]]),
    };

    const requests: Array<{ url: string; method: string; body: unknown }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
      requests.push({
        url,
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return new Response(JSON.stringify({ sensor: { id: "sen-new" } }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    });

    const onSaved = vi.fn();
    render(
      <SensorEditorModal
        open
        onOpenChange={vi.fn()}
        sensorItem={null}
        ctx={ctx}
        onSaved={onSaved}
      />
    );

    // Shows amber firmware update recommendation banner for uncompiled drivers
    expect(screen.getByText("Firmware update needed for additional sensors")).toBeInTheDocument();
    // Shows Waveshare Relay-6CH default I2C bus hint (GPIO8 / GPIO9)
    expect(screen.getByText(/SDA GPIO8 \/ SCL GPIO9/)).toBeInTheDocument();

    // Fill sensor name and I2C address, submit
    await user.type(screen.getByLabelText("Sensor Name"), "Panel Climate");
    await user.type(screen.getByLabelText("I2C Address (Optional)"), "0x76");
    await user.click(screen.getByRole("button", { name: "Add Sensor" }));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(requests).toEqual([
      {
        url: "/api/sensors",
        method: "POST",
        body: {
          name: "Panel Climate",
          sensorType: "temperature_bme280",
          boardInstanceId: "ctrl-relay",
          roomId: null,
          gpioPin: null,
          i2cAddress: "0x76",
        },
      },
    ]);
  });

  it("blocks submission cleanly when installed firmware lacks a verified driver manifest", () => {
    const { board, seed } = buildRelay6Board();
    const legacyResolved = extractFirmwareDriverManifestFromRelease({
      id: "rel-legacy",
      version: "1.0.0",
      chip_family: "esp32s3",
      target_board_slug: board.slug,
      driver_manifest: null,
      compiled_sensor_drivers: [],
      supported_sensor_types: [],
      manifest_version: null,
      manifest_hash: null,
    });
    const legacyCompat = evaluateControllerSensorCompatibility({
      board: seed,
      installedFirmware: legacyResolved,
    });

    const ctrl = makeController("ctrl-legacy", "Old Hub", board, legacyCompat);
    const ctx: HardwareContext = {
      rooms: [],
      controllers: [ctrl],
      boardsById: new Map([[board.id, board]]),
      usedPinsByController: new Map(),
      sensorCompatibilityByController: new Map([[ctrl.id, legacyCompat]]),
    };

    render(
      <SensorEditorModal
        open
        onOpenChange={vi.fn()}
        sensorItem={null}
        ctx={ctx}
        onSaved={vi.fn()}
      />
    );

    expect(screen.getByText("Firmware update needed for additional sensors")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add Sensor" })).toBeDisabled();
  });

  it("fetches live controller sensor compatibility when fetchLiveCompatibility is enabled", async () => {
    const { board, seed } = buildRelay6Board();
    const manifest = buildFirmwareDriverManifest({
      firmwareVersion: "1.5.0",
      chipFamily: "esp32s3",
      targetBoardSlug: board.slug,
      partitionScheme: "dual_ota_16mb",
      flashSizeMb: 16,
      psramMode: "octal",
      driverIds: ["bh1750"],
    });
    const resolved = extractFirmwareDriverManifestFromRelease({
      id: "rel-bh",
      version: "1.5.0",
      chip_family: "esp32s3",
      target_board_slug: board.slug,
      driver_manifest: manifest,
      compiled_sensor_drivers: ["bh1750"],
      supported_sensor_types: manifest.supported_sensor_types,
      manifest_version: manifest.manifest_version,
      manifest_hash: null,
    });
    const liveReport = evaluateControllerSensorCompatibility({
      board: seed,
      installedFirmware: resolved,
    });

    const ctrl = makeController("ctrl-live", "Live Hub", board, null);
    const ctx: HardwareContext = {
      rooms: [],
      controllers: [ctrl],
      boardsById: new Map([[board.id, board]]),
      usedPinsByController: new Map(),
      sensorCompatibilityByController: new Map(),
    };

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ boardInstanceId: ctrl.id, ...liveReport }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    render(
      <SensorEditorModal
        open
        onOpenChange={vi.fn()}
        sensorItem={null}
        ctx={ctx}
        fetchLiveCompatibility
        onSaved={vi.fn()}
      />
    );

    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/board-instances/ctrl-live/sensor-compatibility",
        expect.anything()
      )
    );
    await waitFor(() => {
      expect(screen.getAllByText(/BH1750/i).length).toBeGreaterThan(0);
      expect(screen.getByText("Driver v1.0.0")).toBeInTheDocument();
    });
  });

  it("allows sharing GPIO 5 between DHT22 temperature & humidity while blocking onboard relay GPIO 1", async () => {
    const user = userEvent.setup();
    const { board, seed } = buildRelay6Board();
    const manifest = buildFirmwareDriverManifest({
      firmwareVersion: "1.6.0",
      chipFamily: "esp32s3",
      targetBoardSlug: board.slug,
      partitionScheme: "dual_ota_16mb",
      flashSizeMb: 16,
      psramMode: "octal",
      driverIds: ["dht22"],
    });
    const resolved = extractFirmwareDriverManifestFromRelease({
      id: "rel-dht",
      version: "1.6.0",
      chip_family: "esp32s3",
      target_board_slug: board.slug,
      driver_manifest: manifest,
      compiled_sensor_drivers: ["dht22"],
      supported_sensor_types: manifest.supported_sensor_types,
      manifest_version: manifest.manifest_version,
      manifest_hash: null,
    });
    const compatReport = evaluateControllerSensorCompatibility({
      board: seed,
      installedFirmware: resolved,
    });

    // Only humidity_dht22 selected by giving a manifest whose first compatible is humidity_dht22,
    // or directly select GPIO 5 when temperature_dht22 already uses GPIO 5:
    const ctrl = makeController("ctrl-dht", "Relay Panel DHT", board, compatReport);
    const ctx: HardwareContext = {
      rooms: [],
      controllers: [ctrl],
      boardsById: new Map([[board.id, board]]),
      usedPinsByController: new Map([
        [
          ctrl.id,
          [
            {
              pin: 5,
              entityKind: "sensor",
              id: "sen-dht-temp",
              name: "Panel DHT Temp",
              sensorType: "temperature_dht22",
            },
          ],
        ],
      ]),
      sensorCompatibilityByController: new Map([[ctrl.id, compatReport]]),
    };

    const existingHumidity: SensorItem = {
      id: "sen-dht-hum",
      account_id: "acc-1",
      home_id: "home-1",
      room_id: null,
      board_instance_id: ctrl.id,
      name: "Panel DHT Humidity",
      sensor_type: "humidity_dht22",
      gpio_pin: 5,
      i2c_address: null,
      unit: "%",
      last_value: 52,
      last_raw_payload: null,
      is_online: true,
      last_reading_at: null,
    };

    const requests: Array<{ url: string; method: string; body: unknown }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
      requests.push({
        url,
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return new Response(JSON.stringify({ sensor: existingHumidity }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const onSaved = vi.fn();
    render(
      <SensorEditorModal
        open
        onOpenChange={vi.fn()}
        sensorItem={existingHumidity}
        ctx={ctx}
        onSaved={onSaved}
      />
    );

    // GPIO 5 (shared with sibling temperature_dht22) must be AVAILABLE and NOT blocked!
    const gpio5Tile = document.querySelector('button[data-pin="5"]');
    expect(gpio5Tile).toHaveAttribute("data-state", "available");

    // Onboard relay GPIO 1 must be restricted for sensor inputs!
    const gpio1Tile = document.querySelector('button[data-pin="1"]');
    expect(gpio1Tile).toHaveAttribute("data-state", "restricted");

    const saveBtn = screen.getByRole("button", { name: "Save Sensor" });
    expect(saveBtn).toBeEnabled();
    await user.click(saveBtn);
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(requests[0]?.body).toMatchObject({
      sensorType: "humidity_dht22",
      gpioPin: 5,
      i2cAddress: null,
    });
  });

  it("preserves i2c_address from last_raw_payload when editing an I2C sensor and renders it in HardwareDetailsModal", async () => {
    const user = userEvent.setup();
    const { board, seed } = buildRelay6Board();
    const manifest = buildFirmwareDriverManifest({
      firmwareVersion: "1.6.0",
      chipFamily: "esp32s3",
      targetBoardSlug: board.slug,
      partitionScheme: "dual_ota_16mb",
      flashSizeMb: 16,
      psramMode: "octal",
      driverIds: ["bme280"],
    });
    const resolved = extractFirmwareDriverManifestFromRelease({
      id: "rel-bme",
      version: "1.6.0",
      chip_family: "esp32s3",
      target_board_slug: board.slug,
      driver_manifest: manifest,
      compiled_sensor_drivers: ["bme280"],
      supported_sensor_types: manifest.supported_sensor_types,
      manifest_version: manifest.manifest_version,
      manifest_hash: null,
    });
    const compatReport = evaluateControllerSensorCompatibility({
      board: seed,
      installedFirmware: resolved,
    });

    const ctrl = makeController("ctrl-bme", "Relay Panel BME", board, compatReport);
    const ctx: HardwareContext = {
      rooms: [],
      controllers: [ctrl],
      boardsById: new Map([[board.id, board]]),
      usedPinsByController: new Map(),
      sensorCompatibilityByController: new Map([[ctrl.id, compatReport]]),
    };

    // Simulate a sensor object whose i2c_address is in last_raw_payload
    const existingBme: SensorItem = {
      id: "sen-bme-1",
      account_id: "acc-1",
      home_id: "home-1",
      room_id: null,
      board_instance_id: ctrl.id,
      name: "Panel BME",
      sensor_type: "temperature_bme280",
      gpio_pin: null,
      unit: "°C",
      last_value: 22.5,
      last_raw_payload: { i2c_address: "0x76", driver_id: "bme280" },
      is_online: true,
      last_reading_at: null,
    };

    const requests: Array<{ url: string; method: string; body: unknown }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
      requests.push({
        url,
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return new Response(JSON.stringify({ sensor: existingBme }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const onSaved = vi.fn();
    const { unmount } = render(
      <SensorEditorModal
        open
        onOpenChange={vi.fn()}
        sensorItem={existingBme}
        ctx={ctx}
        onSaved={onSaved}
      />
    );

    const addrInput = screen.getByLabelText("I2C Address (Optional)") as HTMLInputElement;
    expect(addrInput.value).toBe("0x76");

    await user.click(screen.getByRole("button", { name: "Save Sensor" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(requests[0]?.body).toMatchObject({
      name: "Panel BME",
      i2cAddress: "0x76",
    });

    unmount();

    // HardwareDetailsModal also displays 0x76 from last_raw_payload
    render(
      <HardwareDetailsModal
        open
        onOpenChange={vi.fn()}
        subject={{ kind: "sensor", data: existingBme }}
        controller={ctrl}
        room={undefined}
        timezone="UTC"
        canManage
      />
    );
    expect(screen.getByText(/0x76/)).toBeInTheDocument();
  });
});
