import { describe, expect, it } from "vitest";
import {
  RECOVERY_SESSION_TTL_SEC,
  buildRecoveryReport,
  buildRecoverySteps,
  buildRepairPlan,
  checkRecoverySessionGuard,
  classifyWifiError,
  describeTransportCapability,
  emptyRecoveryTelemetry,
  isRecoverySessionExpired,
  mergeRecoveryTelemetry,
  redactRecoveryText,
  repairExecutionSucceeded,
  runDiagnostics,
  verifyRecovery,
  type RecoveryBoardInfo,
  type RecoveryTelemetry,
} from "../src/recovery";

const NOW = Date.parse("2026-11-21T12:00:00.000Z");

const healthyBoard: RecoveryBoardInfo = {
  boardSlug: "esp32-s3-devkitc-1-n16r8",
  model: "ESP32-S3-DevKitC-1-N16R8",
  chip: "esp32s3",
  hardwareUid: "A1B2",
  firmwareVersion: "1.5.0",
  mode: "recovery",
  paired: true,
  supportsWifi: true,
  supportsBle: true,
  lastTransport: "ble",
  diagnosticsSupported: true,
  capabilityIssues: [],
};

function healthyTelemetry(overrides: Partial<RecoveryTelemetry> = {}): RecoveryTelemetry {
  const base = emptyRecoveryTelemetry(NOW);
  const merged: RecoveryTelemetry = {
    ...base,
    wifi: {
      available: true,
      connected: true,
      ssid: "Home24G",
      rssi: -55,
      ipAssigned: true,
      lastError: null,
      credentialsRewritten: false,
    },
    internet: { available: true, reachable: true },
    backend: { available: true, reachable: true, authenticated: true, status: 200, lastError: null },
    pairing: { available: true, paired: true, credentialsValid: true },
    mqtt: { available: true, connected: true, authenticated: true, lastError: null },
    heartbeat: {
      available: true,
      lastHeartbeatAt: "2026-11-21T11:59:40.000Z",
      lastSyncAt: "2026-11-21T11:59:30.000Z",
      nowMs: NOW,
      staleAfterSeconds: 180,
    },
    firmware: {
      available: true,
      version: "1.5.0",
      boardSlug: "esp32-s3-devkitc-1-n16r8",
      partitionScheme: "dual_ota_16mb",
      uptimeSec: 12,
      freeHeapBytes: 180_000,
      compatible: true,
      updateAvailable: null,
    },
    ota: { available: true, supported: true, pendingVerify: false, lastError: null },
    portal: { available: true, wifiApSupported: true, bleSupported: true },
    espnow: { available: true, supported: true, linkState: "linked" },
    backendUrl: { available: true, value: "https://homecoreos.example", matchesWebsite: true },
    config: { available: true, revision: 3, syncedRevision: 3, pendingSync: false, hashValid: true },
    entities: {
      available: true,
      sensorsTotal: 2,
      sensorsReporting: 2,
      switchesTotal: 1,
      switchesReporting: 1,
    },
    nodes: { available: true, total: 1, linked: 1 },
    errors: { available: true, recent: [] },
  };
  return mergeRecoveryTelemetry(merged, overrides);
}

describe("Recovery engine — discovery & capability", () => {
  it("describes each transport honestly instead of silently claiming availability", () => {
    const bleOnS2 = describeTransportCapability({
      transport: "ble",
      browserSupported: true,
      boardSupportsWifi: true,
      boardSupportsBle: false,
      boardFirmwareSupportsDiagnostics: true,
    });
    expect(bleOnS2.available).toBe(false);
    expect(bleOnS2.unavailableReason).toMatch(/no Bluetooth LE radio/i);

    const bleUnsupportedBrowser = describeTransportCapability({
      transport: "ble",
      browserSupported: false,
      browserReason: "Web Bluetooth is unavailable in this browser.",
      boardSupportsWifi: true,
      boardSupportsBle: true,
      boardFirmwareSupportsDiagnostics: true,
    });
    expect(bleUnsupportedBrowser.available).toBe(false);
    expect(bleUnsupportedBrowser.unavailableReason).toContain("Web Bluetooth");

    const usbNoSerial = describeTransportCapability({
      transport: "usb",
      browserSupported: false,
      browserReason: "Web Serial requires a Chromium browser.",
      boardSupportsWifi: true,
      boardSupportsBle: true,
      boardFirmwareSupportsDiagnostics: true,
    });
    expect(usbNoSerial.available).toBe(false);

    const wifi = describeTransportCapability({
      transport: "wifi",
      browserSupported: true,
      boardSupportsWifi: true,
      boardSupportsBle: true,
      boardFirmwareSupportsDiagnostics: true,
    });
    expect(wifi.available).toBe(true);
    expect(wifi.supportsWifiRepair).toBe(true);
    expect(wifi.supportsRePair).toBe(true);
  });

  it("is one engine for all three transports: the same ordered steps exist for each", () => {
    const ids = buildRecoverySteps().map((s) => s.id);
    expect(ids).toEqual([
      "detect",
      "read",
      "wifi_check",
      "backend_check",
      "link_check",
      "system_check",
      "plan",
      "repair",
      "restart",
      "verify",
      "report",
    ]);
    // The full contract is diagnosed for every transport: Wi-Fi, ESP-NOW, MQTT,
    // local webpage/temporary Wi-Fi, pairing, firmware validity and OTA.
    for (const transport of ["wifi", "ble", "usb"] as const) {
      const capability = describeTransportCapability({
        transport,
        browserSupported: true,
        boardSupportsWifi: true,
        boardSupportsBle: true,
        boardFirmwareSupportsDiagnostics: true,
      });
      expect(capability.available).toBe(true);
      expect(capability.supportsDiagnostics).toBe(true);
    }
  });
});

describe("Recovery engine — diagnostics never invent failures", () => {
  it("reports Unknown separately from a confirmed failure when telemetry is unavailable", () => {
    const telemetry = emptyRecoveryTelemetry(NOW);
    const result = runDiagnostics({ board: healthyBoard, telemetry, transport: "ble" });
    expect(result.hasUnknowns).toBe(true);
    expect(result.status).toBe("unknown");
    const wifi = result.checks.find((c) => c.id === "wifi_connection")!;
    expect(wifi.status).toBe("unknown");
    expect(wifi.problem).toBeNull();
    // Nothing to repair: no action may invent a Wi-Fi rewrite.
    const plan = buildRepairPlan({ board: healthyBoard, diagnostics: result, transport: "ble" });
    expect(plan.actions).toEqual([]);
    expect(plan.noActionNeeded).toBe(true);
  });

  it("classifies the wrong Wi-Fi password from the firmware's recorded error", () => {
    expect(classifyWifiError("Wi-Fi authentication failed")).toBe("wifi_auth_failed");
    expect(classifyWifiError("Wi-Fi network not found")).toBe("wifi_network_not_found");
    expect(classifyWifiError("no address")).toBe("dhcp_no_address");
    expect(classifyWifiError(null)).toBeNull();

    const telemetry = healthyTelemetry({
      wifi: {
        available: true,
        connected: false,
        ssid: "Home24G",
        rssi: null,
        ipAssigned: null,
        lastError: "Wi-Fi authentication failed",
        credentialsRewritten: false,
      },
      mqtt: { available: true, connected: false, authenticated: null, lastError: null },
      backend: { available: true, reachable: false, authenticated: null, status: null, lastError: "no route" },
      heartbeat: {
        available: true,
        lastHeartbeatAt: "2026-11-21T09:00:00.000Z",
        lastSyncAt: null,
        nowMs: NOW,
        staleAfterSeconds: 180,
      },
    });
    const result = runDiagnostics({ board: healthyBoard, telemetry, transport: "wifi" });
    expect(result.status).toBe("offline");
    expect(result.problems).toContain("wifi_auth_failed");
    expect(result.problems).toContain("backend_unreachable");
    expect(result.problems).toContain("heartbeat_stale");
    const wificheck = result.checks.find((c) => c.id === "wifi_connection")!;
    expect(wificheck.summary).toMatch(/password|authentication/i);
  });

  it("flags a weak signal as a warning, not a failure", () => {
    const telemetry = healthyTelemetry({
      wifi: {
        available: true,
        connected: true,
        ssid: "Home24G",
        rssi: -88,
        ipAssigned: true,
        lastError: null,
        credentialsRewritten: false,
      },
    });
    const result = runDiagnostics({ board: healthyBoard, telemetry, transport: "ble" });
    expect(result.checks.find((c) => c.id === "wifi_signal")!.status).toBe("warning");
    expect(result.status).toBe("degraded");
  });
});

describe("Recovery engine — plan is minimal and guarded", () => {
  it("repairs Wi-Fi only, without touching pairing, when the password is wrong", () => {
    const telemetry = healthyTelemetry({
      wifi: {
        available: true,
        connected: false,
        ssid: "Home24G",
        rssi: null,
        ipAssigned: null,
        lastError: "Wi-Fi authentication failed",
        credentialsRewritten: false,
      },
    });
    const diagnostics = runDiagnostics({ board: healthyBoard, telemetry, transport: "ble" });
    const plan = buildRepairPlan({ board: healthyBoard, diagnostics, transport: "ble" });
    expect(plan.actions.map((a) => a.id)).toEqual(["rewrite_wifi"]);
    expect(plan.requiresUserConsent).toBe(false);
    expect(plan.summary[0].problem).toMatch(/password/i);
    expect(plan.summary[0].verification).toMatch(/IP address/i);
  });

  it("requires explicit consent for identity-changing re-pairing", () => {
    const telemetry = healthyTelemetry({
      pairing: { available: true, paired: false, credentialsValid: null },
      mqtt: { available: true, connected: false, authenticated: false, lastError: "not authorized" },
    });
    const diagnostics = runDiagnostics({ board: healthyBoard, telemetry, transport: "usb" });
    const plan = buildRepairPlan({ board: healthyBoard, diagnostics, transport: "usb" });
    expect(plan.actions.map((a) => a.id)).toEqual(["repair_pairing"]);
    expect(plan.requiresUserConsent).toBe(true);
    expect(plan.consentReason).toMatch(/preserved|kept/i);
  });

  it("hands firmware incompatibility to the separate Flash Board workflow", () => {
    const telemetry = healthyTelemetry({
      firmware: { available: true, version: "0.9.0", compatible: false, updateAvailable: null },
    });
    const diagnostics = runDiagnostics({ board: healthyBoard, telemetry, transport: "wifi" });
    const plan = buildRepairPlan({ board: healthyBoard, diagnostics, transport: "wifi" });
    expect(plan.requiresFirmwareWorkflow).toBe(true);
    expect(plan.noActionNeeded).toBe(false);
    expect(plan.actions).toEqual([]);
  });

  it("does not propose a repair for advisory-only findings", () => {
    const telemetry = healthyTelemetry({
      firmware: { available: true, version: "1.4.0", compatible: true, updateAvailable: "1.5.0" },
    });
    const diagnostics = runDiagnostics({ board: healthyBoard, telemetry, transport: "ble" });
    const plan = buildRepairPlan({ board: healthyBoard, diagnostics, transport: "ble" });
    expect(plan.actions).toEqual([]);
    expect(plan.requiresFirmwareWorkflow).toBe(false);
  });
});

describe("Recovery engine — verification requires fresh telemetry", () => {
  it("reports an unverifiable repair as unverified instead of success", () => {
    const before = healthyTelemetry({
      wifi: {
        available: true,
        connected: false,
        ssid: "Home24G",
        rssi: null,
        ipAssigned: null,
        lastError: "Wi-Fi authentication failed",
        credentialsRewritten: false,
      },
    });
    const diagnostics = runDiagnostics({ board: healthyBoard, telemetry: before, transport: "ble" });
    const plan = buildRepairPlan({ board: healthyBoard, diagnostics, transport: "ble" });
    const after = emptyRecoveryTelemetry(NOW); // board went quiet: nothing confirmed
    const verification = verifyRecovery({ board: healthyBoard, before, after, plan });
    expect(verification.status).toBe("unverified");
    expect(verification.summary).toMatch(/could not be verified/i);
  });

  it("verifies a repair only when post-repair telemetry passes", () => {
    const before = emptyRecoveryTelemetry(NOW);
    const plan = buildRepairPlan({
      board: healthyBoard,
      diagnostics: runDiagnostics({
        board: healthyBoard,
        telemetry: healthyTelemetry({
          mqtt: { available: true, connected: false, authenticated: false, lastError: "denied" },
        }),
        transport: "ble",
      }),
      transport: "ble",
    });
    const after = healthyTelemetry();
    const verification = verifyRecovery({ board: healthyBoard, before, after, plan });
    expect(verification.status).toBe("verified");
    expect(verification.checks.find((c) => c.id === "mqtt_connected")!.status).toBe("pass");
  });

  it("fails verification when the controller still reports a failure", () => {
    const before = emptyRecoveryTelemetry(NOW);
    const diagnostics = runDiagnostics({
      board: healthyBoard,
      telemetry: healthyTelemetry({
        wifi: {
          available: true,
          connected: false,
          ssid: "Home24G",
          rssi: null,
          ipAssigned: null,
          lastError: "Wi-Fi authentication failed",
          credentialsRewritten: false,
        },
      }),
      transport: "usb",
    });
    const plan = buildRepairPlan({ board: healthyBoard, diagnostics, transport: "usb" });
    const after = healthyTelemetry({
      wifi: {
        available: true,
        connected: false,
        ssid: "Home24G",
        rssi: null,
        ipAssigned: null,
        lastError: "Wi-Fi authentication failed",
        credentialsRewritten: true,
      },
    });
    const verification = verifyRecovery({ board: healthyBoard, before, after, plan });
    expect(verification.status).toBe("failed");
    expect(verification.unresolved).toContain("wifi_not_connected");
  });

  it("treats a transmitted-but-unacknowledged repair as not succeeded", () => {
    expect(
      repairExecutionSucceeded({
        transportFailed: false,
        outcomes: [{ actionId: "reconnect_mqtt", status: "unknown", message: "sent", at: "" }],
      })
    ).toBe(false);
    expect(
      repairExecutionSucceeded({
        transportFailed: false,
        outcomes: [{ actionId: "reconnect_mqtt", status: "applied", message: "ok", at: "" }],
      })
    ).toBe(true);
  });
});

describe("Recovery engine — report & session safety", () => {
  it("produces a complete report with a next action when repairs fail", () => {
    const diagnostics = runDiagnostics({
      board: healthyBoard,
      telemetry: healthyTelemetry({
        backend: {
          available: true,
          reachable: false,
          authenticated: null,
          status: null,
          lastError: "connect timeout",
        },
      }),
      transport: "wifi",
    });
    const plan = buildRepairPlan({ board: healthyBoard, diagnostics, transport: "wifi" });
    const verification = verifyRecovery({
      board: healthyBoard,
      before: healthyTelemetry(),
      after: healthyTelemetry({
        backend: {
          available: true,
          reachable: false,
          authenticated: null,
          status: null,
          lastError: "connect timeout",
        },
      }),
      plan,
    });
    const report = buildRecoveryReport({
      sessionId: "sess-1",
      boardInstanceId: "board-1",
      boardName: "Living Room",
      board: healthyBoard,
      transport: "wifi",
      startedAt: "2026-11-21T11:58:00.000Z",
      completedAt: "2026-11-21T12:00:00.000Z",
      diagnostics,
      plan,
      execution: {
        transportFailed: false,
        outcomes: [{ actionId: "verify_network", status: "applied", message: "network re-checked", at: "2026-11-21T11:59:00.000Z" }],
      },
      verification,
      finalTelemetry: healthyTelemetry({
        backend: {
          available: true,
          reachable: false,
          authenticated: null,
          status: null,
          lastError: "connect timeout",
        },
      }),
    });
    expect(report.durationMs).toBe(120_000);
    expect(report.finalStatus).not.toBe("completed");
    expect(report.nextAction).toMatch(/Worker|443/i);
    expect(report.board.boardInstanceId).toBe("board-1");
    expect(report.verification.checks.length).toBeGreaterThan(5);
  });

  it("blocks a concurrent recovery of the same board but lets the owner resume", () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const blocked = checkRecoverySessionGuard({
      boardInstanceId: "board-1",
      userId: "user-c",
      existing: [
        { id: "s1", boardInstanceId: "board-1", userId: "user-a", status: "active", expiresAt },
        { id: "s2", boardInstanceId: "board-1", userId: "user-b", status: "active", expiresAt },
      ],
    });
    expect(blocked.allowed).toBe(false);

    const resumed = checkRecoverySessionGuard({
      boardInstanceId: "board-1",
      userId: "user-a",
      existing: [{ id: "s1", boardInstanceId: "board-1", userId: "user-a", status: "active", expiresAt }],
    });
    expect(resumed).toEqual({ allowed: true, resumeSessionId: "s1" });

    const expired = checkRecoverySessionGuard({
      boardInstanceId: "board-1",
      userId: "user-b",
      existing: [
        {
          id: "s3",
          boardInstanceId: "board-1",
          userId: "user-a",
          status: "active",
          expiresAt: new Date(Date.now() - 1000).toISOString(),
        },
      ],
    });
    expect(expired.allowed).toBe(true);
    expect(isRecoverySessionExpired(new Date(Date.now() - 1).toISOString())).toBe(true);
    expect(RECOVERY_SESSION_TTL_SEC).toBe(900);
  });

  it("redacts secrets from anything that can be logged or shown", () => {
    const text =
      'password=hunter2 mqtt_password: "abc123secret" Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload and identity_key=ZZZ';
    const redacted = redactRecoveryText(text);
    expect(redacted).not.toContain("hunter2");
    expect(redacted).not.toContain("abc123secret");
    expect(redacted).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(redacted).not.toContain("ZZZ");
    expect(redacted).toContain("«redacted»");
  });

  it("merges telemetry fragments without upgrading availability", () => {
    const base = emptyRecoveryTelemetry(NOW);
    const merged = mergeRecoveryTelemetry(base, {
      wifi: {
        available: true,
        connected: true,
        ssid: "Home24G",
        rssi: -50,
        ipAssigned: true,
        lastError: null,
        credentialsRewritten: true,
      },
    });
    expect(merged.wifi.available).toBe(true);
    expect(merged.wifi.ssid).toBe("Home24G");
    expect(merged.mqtt.available).toBe(false);
  });
});

describe("Recovery engine — endpoint, ESP-NOW and restart contract", () => {
  it("re-configures the server URL automatically instead of asking the user to type it", () => {
    const telemetry = healthyTelemetry({
      backendUrl: { available: true, value: "", matchesWebsite: null },
      backend: { available: true, reachable: false, authenticated: null, status: null, lastError: "no route" },
    });
    const diagnostics = runDiagnostics({ board: healthyBoard, telemetry, transport: "ble" });
    expect(diagnostics.problems).toContain("backend_url_missing");
    const plan = buildRepairPlan({ board: healthyBoard, diagnostics, transport: "ble" });
    const endpoint = plan.actions.find((a) => a.id === "configure_endpoint");
    expect(endpoint).toBeDefined();
    // The repair never asks for a secret: the website already knows its own URL.
    expect(endpoint!.requiresSecret).toBeNull();
    expect(endpoint!.changesIdentity).toBe(false);
    // It must not silently re-pair the board either.
    expect(plan.actions.some((a) => a.changesIdentity)).toBe(false);
    expect(plan.requiresUserConsent).toBe(false);
  });

  it("re-establishes a down ESP-NOW link without touching credentials", () => {
    const telemetry = healthyTelemetry({
      espnow: { available: true, supported: true, linkState: "controller_lost" },
    });
    const diagnostics = runDiagnostics({ board: healthyBoard, telemetry, transport: "usb" });
    const plan = buildRepairPlan({ board: healthyBoard, diagnostics, transport: "usb" });
    const relink = plan.actions.find((a) => a.id === "relink_espnow");
    expect(relink).toBeDefined();
    expect(relink!.requiresSecret).toBeNull();
    expect(plan.actions.some((a) => a.id === "rewrite_wifi")).toBe(false);
  });

  it("treats OTA capability as information, never as an automatic firmware write", () => {
    const telemetry = healthyTelemetry({
      ota: { available: true, supported: false, pendingVerify: null, lastError: "app partition too small" },
    });
    const diagnostics = runDiagnostics({ board: healthyBoard, telemetry, transport: "wifi" });
    expect(diagnostics.problems).toContain("ota_unavailable");
    const plan = buildRepairPlan({ board: healthyBoard, diagnostics, transport: "wifi" });
    expect(plan.actions.some((a) => a.id === "rewrite_wifi")).toBe(false);
    expect(plan.requiresFirmwareWorkflow).toBe(false);
    expect(plan.noActionNeeded).toBe(true);
  });

  it("hands a missing firmware image to the Flash Board workflow and never flashes", () => {
    const telemetry = healthyTelemetry({
      firmware: {
        available: true,
        version: null,
        boardSlug: null,
        partitionScheme: null,
        uptimeSec: null,
        freeHeapBytes: null,
        compatible: null,
        updateAvailable: null,
      },
    });
    const diagnostics = runDiagnostics({ board: healthyBoard, telemetry, transport: "ble" });
    const plan = buildRepairPlan({ board: healthyBoard, diagnostics, transport: "ble" });
    expect(diagnostics.problems).toContain("firmware_missing");
    expect(plan.requiresFirmwareWorkflow).toBe(true);
    expect(plan.summary.map((row) => row.action).join(" ")).toMatch(/never flashes or updates firmware/i);
  });

  it("verifies a restart from a fresh uptime and never from a silent board", () => {
    const before = healthyTelemetry();
    const diagnostics = runDiagnostics({ board: healthyBoard, telemetry: before, transport: "ble" });
    const plan = buildRepairPlan({ board: healthyBoard, diagnostics, transport: "ble" });

    const restarted = verifyRecovery({
      board: healthyBoard,
      before,
      after: healthyTelemetry({
        firmware: {
          available: true,
          version: "1.5.0",
          boardSlug: "esp32-s3-devkitc-1-n16r8",
          partitionScheme: "dual_ota_16mb",
          uptimeSec: 9,
          freeHeapBytes: 180_000,
          compatible: true,
          updateAvailable: null,
        },
      }),
      plan,
    });
    expect(restarted.checks.find((c) => c.id === "restart_verified")!.status).toBe("pass");

    const silent = verifyRecovery({ board: healthyBoard, before, after: emptyRecoveryTelemetry(NOW), plan });
    expect(silent.checks.find((c) => c.id === "restart_verified")!.status).toBe("unknown");
    expect(silent.status).toBe("unverified");
  });

  it("reports the temporary setup interfaces as closed once the board is normal", () => {
    const before = healthyTelemetry();
    const plan = buildRepairPlan({
      board: healthyBoard,
      diagnostics: runDiagnostics({ board: healthyBoard, telemetry: before, transport: "wifi" }),
      transport: "wifi",
    });
    const verification = verifyRecovery({
      board: { ...healthyBoard, mode: "normal" },
      before,
      after: healthyTelemetry({
        portal: { available: true, wifiApSupported: false, bleSupported: false },
      }),
      plan,
    });
    expect(verification.checks.find((c) => c.id === "temporary_interfaces_closed")!.status).toBe("pass");
  });
});
