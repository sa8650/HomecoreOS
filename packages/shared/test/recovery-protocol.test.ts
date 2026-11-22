import { describe, expect, it } from "vitest";
import {
  boardInfoFromHello,
  bleRecoveryCommandPayload,
  buildRecoveryCommand,
  createBleStatusReassembler,
  createSerialLineBuffer,
  parseBleStatusChunk,
  parseRecoveryDeviceMessage,
  problemsFromDeviceStatus,
  telemetryFromDeviceStatus,
  type RecoveryDeviceHello,
  type RecoveryDeviceStatus,
} from "../src/recovery-protocol";
import { emptyRecoveryTelemetry, runDiagnostics } from "../src/recovery";

const NOW = Date.parse("2026-11-21T12:00:00.000Z");

const HELLO_JSON =
  '{"hc":"recovery","proto":1,"board":"esp32-s3-devkitc-1-n16r8","chip":"esp32s3","fw":"1.5.0",' +
  '"mode":"recovery","paired":true,"wifi":true,"ble":true,"recovery_supported":true,"uid_suffix":"EE12"}';

const STATUS_JSON =
  '{"hc":"status","proto":1,"mode":"normal","fw":"1.5.0","paired":true,"wifi_connected":true,' +
  '"ssid":"Home24G","rssi":-58,"ip":"192.168.1.50","wifi_error":"","mqtt_connected":true,' +
  '"mqtt_error":"","backend_reachable":true,"backend_authenticated":true,"backend_ok":true,' +
  '"config_revision":3,"synced_config_revision":3,"pending_config":false,"heartbeat_age_sec":12,' +
  '"heartbeat_interval_sec":60,"entities_known":true,"sensors_total":4,"sensors_reporting":4,' +
  '"switches_total":2,"switches_reporting":2,"nodes_known":true,"nodes_total":1,"nodes_linked":1,' +
  '"last_error":""}';

describe("device recovery protocol (shared by Wi-Fi, BLE and USB)", () => {
  it("parses the discovery answer and maps it to board info", () => {
    const msg = parseRecoveryDeviceMessage(HELLO_JSON);
    expect(msg.kind).toBe("hello");
    if (msg.kind !== "hello") return;

    expect(msg.hello.uidSuffix).toBe("EE12");
    expect(msg.hello.recoverySupported).toBe(true);

    const info = boardInfoFromHello(msg.hello, { model: "ESP32-S3-DevKitC-1 N16R8" });
    expect(info.boardSlug).toBe("esp32-s3-devkitc-1-n16r8");
    expect(info.hardwareUid).toBe("EE12");
    expect(info.mode).toBe("recovery");
    expect(info.diagnosticsSupported).toBe(true);
    expect(info.capabilityIssues).toEqual([]);
  });

  it("flags firmware that predates the recovery protocol instead of pretending it works", () => {
    const hello: RecoveryDeviceHello = {
      proto: 0,
      boardSlug: "esp32-s3-devkitc-1-n16r8",
      chip: "esp32s3",
      firmwareVersion: "1.2.0",
      mode: "recovery",
      paired: false,
      hasWifi: true,
      hasBle: false,
      // An old firmware without this protocol would not answer at all; if it
      // does answer, it must not be treated as diagnostics-capable.
      recoverySupported: false,
      uidSuffix: "1234",
    };
    const info = boardInfoFromHello(hello);
    expect(info.diagnosticsSupported).toBe(false);
    expect(info.capabilityIssues.join(" ")).toMatch(/predates Repair & Recovery/i);
  });

  it("reports a board without a Wi-Fi radio as unsupported rather than broken", () => {
    const info = boardInfoFromHello({
      proto: 1,
      boardSlug: "esp32-h2-devkitm-1",
      chip: "esp32h2",
      firmwareVersion: "1.5.0",
      mode: "unprovisioned",
      paired: true,
      hasWifi: false,
      hasBle: true,
      recoverySupported: true,
      uidSuffix: "AAAA",
    });
    expect(info.supportsWifi).toBe(false);
    expect(info.capabilityIssues.join(" ")).toMatch(/no integrated Wi-Fi radio/i);
  });

  it("maps a healthy device status into telemetry that the engine verifies", () => {
    const msg = parseRecoveryDeviceMessage(STATUS_JSON);
    expect(msg.kind).toBe("status");
    if (msg.kind !== "status") return;

    const telemetry = telemetryFromDeviceStatus(msg.status, NOW, emptyRecoveryTelemetry(NOW));
    expect(telemetry.wifi.connected).toBe(true);
    expect(telemetry.wifi.ipAssigned).toBe(true);
    expect(telemetry.backend.reachable).toBe(true);
    expect(telemetry.mqtt.authenticated).toBe(true);
    expect(telemetry.config.revision).toBe(3);
    expect(telemetry.heartbeat.lastHeartbeatAt).toBe("2026-11-21T11:59:48.000Z");
    expect(telemetry.entities.sensorsReporting).toBe(4);

    const diag = runDiagnostics({
      board: boardInfoFromHello({
        proto: 1,
        boardSlug: "esp32-s3-devkitc-1-n16r8",
        chip: "esp32s3",
        firmwareVersion: "1.5.0",
        mode: "normal",
        paired: true,
        hasWifi: true,
        hasBle: true,
        recoverySupported: true,
        uidSuffix: "EE12",
      }),
      telemetry,
      transport: "usb",
    });
    expect(diag.problems).toEqual([]);
    expect(diag.status).toBe("healthy");
  });

  it("keeps 'cannot tell' separate from 'broken' when the board reports no entities", () => {
    const status: RecoveryDeviceStatus = {
      ...(parseRecoveryDeviceMessage(STATUS_JSON) as { status: RecoveryDeviceStatus }).status,
      entitiesKnown: false,
      nodesKnown: false,
      sensorsTotal: 0,
      sensorsReporting: 0,
      switchesTotal: 0,
      switchesReporting: 0,
    };
    const telemetry = telemetryFromDeviceStatus(status, NOW);
    expect(telemetry.entities.available).toBe(false);
    expect(telemetry.nodes.available).toBe(false);
  });

  it("turns a bad Wi-Fi password into a specific problem, not a generic failure", () => {
    const status: RecoveryDeviceStatus = {
      ...(parseRecoveryDeviceMessage(STATUS_JSON) as { status: RecoveryDeviceStatus }).status,
      wifiConnected: false,
      ssid: "Home24G",
      ip: null,
      wifiError: "WIFI_REASON_AUTH_FAIL (4-way handshake timeout)",
      mqttConnected: false,
      backendReachable: false,
      backendAuthenticated: false,
      backendOk: false,
      heartbeatAgeSec: null,
    };
    expect(problemsFromDeviceStatus(status)).toContain("wifi_auth_failed");

    const telemetry = telemetryFromDeviceStatus(status, NOW);
    // No IP can be assigned while Wi-Fi is down: that is "nothing to assign
    // yet", not a DHCP failure.
    expect(telemetry.wifi.ipAssigned).toBeNull();
    expect(telemetry.errors.available).toBe(true);
    expect(telemetry.errors.recent.map((e) => e.message)).toContain(
      "WIFI_REASON_AUTH_FAIL (4-way handshake timeout)"
    );
    // No heartbeat yet is "unknown", never "stale by 0 seconds".
    expect(telemetry.heartbeat.lastHeartbeatAt).toBeNull();
  });

  it("builds one command line for every transport", () => {
    expect(buildRecoveryCommand("STATUS")).toBe("HC STATUS");
    expect(
      buildRecoveryCommand("REPAIR", { action: "wifi", ssid: "Home", password: "Pass1234" })
    ).toBe('HC REPAIR {"action":"wifi","ssid":"Home","password":"Pass1234"}');
    expect(buildRecoveryCommand("REPAIR", { action: "factory_reset", confirm: true })).toBe(
      'HC REPAIR {"action":"factory_reset","confirm":true}'
    );
    expect(
      buildRecoveryCommand("REPAIR", {
        action: "pair",
        pairCode: "123456",
        backendUrl: "https://hc.example",
      })
    ).toBe('HC REPAIR {"action":"pair","backend_url":"https://hc.example","pair_code":"123456"}');
    expect(bleRecoveryCommandPayload("HC PING")).toEqual({ action: "hc HC PING" });
  });

  it("reassembles chunked BLE responses and drops an incomplete set", () => {
    const reassembler = createBleStatusReassembler();
    expect(reassembler.push({ chunk: { i: 0, n: 2, d: '{"hc":"status",' } })).toBeNull();
    expect(reassembler.inProgress()).toBe(true);
    expect(reassembler.push({ chunk: { i: 1, n: 2, d: '"ok":true}' } })).toBe(
      '{"hc":"status","ok":true}'
    );
    expect(reassembler.inProgress()).toBe(false);

    // A missing middle chunk must not be guessed at.
    expect(reassembler.push({ chunk: { i: 0, n: 3, d: "a" } })).toBeNull();
    expect(reassembler.push({ chunk: { i: 2, n: 3, d: "c" } })).toBeNull();
    expect(reassembler.inProgress()).toBe(true);
    reassembler.reset();
    expect(reassembler.inProgress()).toBe(false);

    // A plain payload passes through unchanged.
    expect(reassembler.push({ hc: "pong", proto: 1 })).toBe('{"hc":"pong","proto":1}');
  });

  it("rejects malformed chunk envelopes instead of accepting them", () => {
    expect(parseBleStatusChunk({ chunk: { i: 0, n: 0, d: "x" } })).toBeNull();
    expect(parseBleStatusChunk({ chunk: { i: 3, n: 2, d: "x" } })).toBeNull();
    expect(parseBleStatusChunk({ chunk: { i: 0, n: 2 } })).toBeNull();
    expect(parseBleStatusChunk("nope")).toBeNull();
  });

  it("buffers split and merged serial lines", () => {
    const buffer = createSerialLineBuffer();
    expect(buffer.push('{"hc":"po')).toEqual([]);
    expect(buffer.push('ng","proto":1}\n')).toEqual(['{"hc":"pong","proto":1}']);
    expect(buffer.push('{"hc":"ack"}\r\n{"hc":"error"}\n\r')).toEqual([
      '{"hc":"ack"}',
      '{"hc":"error"}',
    ]);
    buffer.push("x".repeat(5000));
    expect(buffer.push('{"hc":"pong"}\n')).toEqual(['{"hc":"pong"}']);
  });

  it("never throws on garbage from a flaky transport", () => {
    expect(parseRecoveryDeviceMessage("").kind).toBe("unknown");
    expect(parseRecoveryDeviceMessage("<html>login</html>").kind).toBe("unknown");
    expect(parseRecoveryDeviceMessage("[1,2,3]").kind).toBe("unknown");
    expect(parseRecoveryDeviceMessage('{"hc":"ack","action":"wifi","ok":false,"detail":"nope"}')).toEqual({
      kind: "ack",
      ack: { action: "wifi", ok: false, detail: "nope" },
    });
  });
});
