import { describe, expect, it } from "vitest";
import {
  boardInfoFromHello,
  bleRecoveryCommandPayload,
  buildRecoveryCommand,
  HOMECORE_BLE_DEFAULT_ATT_MTU,
  bleFragmentBudget,
  buildBleFragmentedWrite,
  createBleNoteReassembler,
  createBleReadWindowReader,
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
    // The STATUS_JSON fixture is a v1 payload without the setup/repair facts, so
    // those checks stay Unknown — never a failure.
    expect(diag.checks.filter((c) => c.status === "unknown").map((c) => c.id).sort()).toEqual([
      "backend_url",
      "espnow",
      "local_portal",
      "ota",
    ]);
  });

  it("diagnoses the full setup/repair contract from a complete status payload", () => {
    const fullStatus = {
      ...(parseRecoveryDeviceMessage(STATUS_JSON) as { status: RecoveryDeviceStatus }).status,
      boardSlug: "esp32-s3-devkitc-1-n16r8",
      chip: "esp32s3",
      partitionScheme: "dual_ota_16mb",
      uptimeSec: 20,
      freeHeapBytes: 190_000,
      backendUrl: "https://homecoreos.example",
      otaSupported: true,
      otaPendingVerify: false,
      wifiApSupported: true,
      bleSupported: true,
      espnowSupported: true,
      espnowLinkState: "linked",
    };
    const telemetry = telemetryFromDeviceStatus(
      fullStatus,
      NOW,
      emptyRecoveryTelemetry(NOW),
      "https://homecoreos.example"
    );
    expect(telemetry.backendUrl.matchesWebsite).toBe(true);
    expect(telemetry.firmware.uptimeSec).toBe(20);
    expect(telemetry.ota.supported).toBe(true);
    expect(telemetry.espnow.linkState).toBe("linked");

    const diag = runDiagnostics({
      board: boardInfoFromHello({
        proto: 1,
        boardSlug: "esp32-s3-devkitc-1-n16r8",
        chip: "esp32s3",
        firmwareVersion: "1.5.0",
        mode: "recovery",
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
    expect(diag.checks.every((c) => c.status !== "unknown")).toBe(true);
  });

  it("flags a wrong server URL and an ESP-NOW outage as repairable problems", () => {
    const status = {
      ...(parseRecoveryDeviceMessage(STATUS_JSON) as { status: RecoveryDeviceStatus }).status,
      backendUrl: "https://old-deployment.example",
      espnowSupported: true,
      espnowLinkState: "controller_lost",
      otaSupported: false,
    };
    expect(problemsFromDeviceStatus(status, "https://homecoreos.example")).toEqual(
      expect.arrayContaining(["backend_url_mismatch", "espnow_link_down", "ota_unavailable"])
    );
    const telemetry = telemetryFromDeviceStatus(
      status,
      NOW,
      emptyRecoveryTelemetry(NOW),
      "https://homecoreos.example"
    );
    expect(telemetry.backendUrl.matchesWebsite).toBe(false);
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

  it("surfaces an unsynchronized or unreachable board instead of a clean bill of health", () => {
    // These used to be hardcoded healthy in the firmware snapshot, so a board
    // whose stored config never reached the server looked perfect locally.
    const board = boardInfoFromHello({
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
    });
    const base = (parseRecoveryDeviceMessage(STATUS_JSON) as { status: RecoveryDeviceStatus }).status;

    // A configuration that was applied but never persisted to the server is a
    // real fault, both in the device-reported problem list and in diagnostics.
    const unsyncedStatus = { ...base, configRevision: 7, syncedConfigRevision: 3, pendingConfig: true };
    expect(problemsFromDeviceStatus(unsyncedStatus)).toContain("config_unsynced");
    const unsynced = telemetryFromDeviceStatus(unsyncedStatus, NOW);
    expect(unsynced.config.pendingSync).toBe(true);
    expect(
      runDiagnostics({ board, telemetry: unsynced, nowMs: NOW, transport: "usb" }).checks.find(
        (c) => c.id === "config"
      )?.problem
    ).toBe("config_unsynced");

    // A board that cannot reach the Worker must fail reachability, not pass.
    const unreachableStatus = {
      ...base,
      backendReachable: false,
      backendAuthenticated: false,
      backendOk: false,
    };
    const unreachable = telemetryFromDeviceStatus(unreachableStatus, NOW);
    expect(unreachable.backend.reachable).toBe(false);
    expect(
      runDiagnostics({ board, telemetry: unreachable, nowMs: NOW, transport: "usb" }).checks.find(
        (c) => c.id === "backend"
      )?.status
    ).toBe("fail");
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

/**
 * GATT MTU framing — the fix for "GATT operation failed for unknown reason".
 *
 * The page cannot raise the ATT MTU and must never issue an operation larger
 * than the negotiated budget, so it frames writes and joins framed reads and
 * notifications. firmware/main/ble_protocol_logic.c is the other half of this
 * contract; these tests pin the byte layout both sides agree on.
 */
describe("BLE GATT MTU framing", () => {
  it("sizes the write budget from the negotiated MTU", () => {
    expect(bleFragmentBudget(23)).toBe(20);
    expect(bleFragmentBudget(247)).toBe(244);
    expect(bleFragmentBudget(517)).toBe(514);
    // Missing or nonsense values fall back to the default every stack supports.
    expect(bleFragmentBudget(undefined)).toBe(20);
    expect(bleFragmentBudget(null)).toBe(20);
    expect(bleFragmentBudget(0)).toBe(20);
    expect(HOMECORE_BLE_DEFAULT_ATT_MTU).toBe(23);
  });

  it("fragments a Client Hello so no write exceeds one ATT packet", () => {
    const value = new Uint8Array(66);
    value[0] = 0x01;
    for (let i = 1; i < value.length; i++) value[i] = i;

    const frames: Uint8Array[] = [];
    let offset = 0;
    while (offset < value.length) {
      const frame = buildBleFragmentedWrite(value, offset, 20);
      expect(frame).not.toBeNull();
      expect(frame!.byteLength).toBeLessThanOrEqual(20);
      frames.push(frame!);
      offset += frame!.byteLength - 5;
    }

    // Four writes at 15 bytes of payload each.
    expect(frames).toHaveLength(5);
    expect(frames[0][0]).toBe(0x10);
    expect(frames[0][1] | (frames[0][2] << 8)).toBe(66);
    expect(frames[0][3] | (frames[0][4] << 8)).toBe(0);
    expect(frames[4][3] | (frames[4][4] << 8)).toBe(60);
  });

  it("refuses to build a write that cannot be framed", () => {
    const value = new Uint8Array(10);
    expect(buildBleFragmentedWrite(value, 0, 4)).toBeNull();
    expect(buildBleFragmentedWrite(value, 10, 20)).toBeNull();
    expect(buildBleFragmentedWrite(new Uint8Array(0), 0, 20)).toBeNull();
  });

  it("joins read windows regardless of the order they arrive in", () => {
    const value = new Uint8Array(130);
    for (let i = 0; i < value.length; i++) value[i] = i % 251;

    const reader = createBleReadWindowReader();
    const window = (offset: number, size: number) => {
      const slice = value.subarray(offset, Math.min(offset + size, value.length));
      const frame = new Uint8Array(5 + slice.byteLength);
      frame[0] = 0x20;
      frame[1] = value.length & 0xff;
      frame[2] = (value.length >> 8) & 0xff;
      frame[3] = offset & 0xff;
      frame[4] = (offset >> 8) & 0xff;
      frame.set(slice, 5);
      return frame;
    };

    expect(reader.total()).toBeNull();
    expect(reader.push(window(0, 18))).toBeNull();
    expect(reader.total()).toBe(130);
    expect(reader.complete()).toBe(false);

    // A repeated window is idempotent: it does not shift the rest of the value.
    expect(reader.push(window(0, 18))).toBeNull();
    expect(reader.push(window(18, 18))).toBeNull();

    let done: Uint8Array | null | undefined = null;
    let offset = 36;
    while (!done) {
      done = reader.push(window(offset, 18));
      offset += 18;
    }
    expect(done!.byteLength).toBe(130);
    expect(Array.from(done!)).toEqual(Array.from(value));
    expect(reader.total()).toBeNull();

    // Out-of-order windows still assemble: the header carries the offset.
    const shuffled = createBleReadWindowReader();
    expect(shuffled.push(window(36, 18))).toBeNull();
    expect(shuffled.push(window(0, 18))).toBeNull();
    expect(shuffled.complete()).toBe(false);
    // Covering 54..125 leaves only 18..35 and 126..129 missing.
    for (let at = 54; at < 130; at += 18) expect(shuffled.push(window(at, 18))).toBeNull();
    expect(shuffled.complete()).toBe(false);
    const last = shuffled.push(window(18, 18));
    expect(last).not.toBeNull();
    expect(Array.from(last!)).toEqual(Array.from(value));
  });

  it("returns a whole value unchanged and rejects malformed windows", () => {
    const small = new Uint8Array([1, 2, 3, 4]);
    expect(createBleReadWindowReader().push(small)).toEqual(small);

    const reader = createBleReadWindowReader();
    const frame = (offset: number, total: number, byte: number) => {
      const out = new Uint8Array(6);
      out[0] = 0x20;
      out[1] = total & 0xff;
      out[2] = (total >> 8) & 0xff;
      out[3] = offset & 0xff;
      out[4] = 0;
      out[5] = byte;
      return out;
    };

    // A window that overruns the announced length is rejected outright rather
    // than written past the end of the buffer.
    expect(reader.push(frame(8, 8, 1))).toBeUndefined();
    expect(reader.total()).toBeNull();

    // A declared length larger than the caller allows is rejected too.
    const huge = frame(0, 0xff, 1);
    huge[2] = 0xff;
    expect(createBleReadWindowReader(256).push(huge)).toBeUndefined();
  });

  it("joins notification fragments before decryption", () => {
    const ciphertext = new Uint8Array(400);
    for (let i = 0; i < ciphertext.length; i++) ciphertext[i] = i % 256;

    const payload = 16; // 20-byte notification budget minus the 4-byte header
    const total = Math.ceil(ciphertext.length / payload);
    const reassembler = createBleNoteReassembler();
    expect(reassembler.inProgress()).toBe(false);
    let completed: Uint8Array | null = null;
    for (let i = 0; i < total; i++) {
      const slice = ciphertext.subarray(i * payload, Math.min((i + 1) * payload, ciphertext.length));
      const frame = new Uint8Array(4 + slice.byteLength);
      frame[0] = 0x30;
      frame[1] = i;
      frame[2] = total & 0xff;
      frame[3] = (total >> 8) & 0xff;
      frame.set(slice, 4);
      completed = reassembler.push(frame);
      if (i < total - 1) {
        expect(completed).toBeNull();
        expect(reassembler.inProgress()).toBe(true);
      }
    }
    expect(completed).not.toBeNull();
    expect(Array.from(completed!)).toEqual(Array.from(ciphertext));
    expect(reassembler.inProgress()).toBe(false);

    // An unfragmented notification (a link that negotiated a large MTU) passes
    // straight through.
    const whole = new Uint8Array([9, 9, 9]);
    expect(createBleNoteReassembler().push(whole)).toEqual(whole);

    // A missing piece is never guessed at.
    const broken = createBleNoteReassembler();
    expect(broken.push(new Uint8Array([0x30, 0, 3, 0, 1]))).toBeNull();
    expect(broken.push(new Uint8Array([0x30, 2, 3, 0, 3]))).toBeNull();
    expect(broken.inProgress()).toBe(false);
  });
});
