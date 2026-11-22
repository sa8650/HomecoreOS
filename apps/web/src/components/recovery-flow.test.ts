import { afterEach, describe, expect, it, vi } from "vitest";
import type { RecoveryDeviceHello, RecoveryDeviceStatus } from "@homecoreos/shared";
import {
  createRecoveryController,
  type RecoveryServerApi,
} from "../lib/recovery-engine";
import { RecoveryTransportError, type RecoveryTransport } from "../lib/recovery-transport";

const HELLO: RecoveryDeviceHello = {
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
};

const STATUS: RecoveryDeviceStatus = {
  proto: 1,
  mode: "normal",
  firmwareVersion: "1.5.0",
  paired: true,
  wifiConnected: true,
  ssid: "Home24G",
  rssi: -55,
  ip: "192.168.1.50",
  wifiError: null,
  mqttConnected: true,
  mqttError: null,
  backendReachable: true,
  backendAuthenticated: true,
  backendOk: true,
  configRevision: 2,
  syncedConfigRevision: 2,
  pendingConfig: false,
  heartbeatAgeSec: 10,
  heartbeatIntervalSec: 60,
  entitiesKnown: true,
  sensorsTotal: 2,
  sensorsReporting: 2,
  switchesTotal: 1,
  switchesReporting: 1,
  nodesKnown: true,
  nodesTotal: 0,
  nodesLinked: 0,
  lastError: null,
};

interface FakeTransportOptions {
  hello?: RecoveryDeviceHello;
  status?: RecoveryDeviceStatus;
  /** Statuses returned by successive `readStatus` calls. */
  statuses?: RecoveryDeviceStatus[];
  replies?: Record<string, string>;
  failConnect?: RecoveryTransportError;
  failRequest?: RecoveryTransportError;
  onRequest?: (line: string) => string | null;
}

function fakeTransport(options: FakeTransportOptions = {}) {
  const sent: string[] = [];
  let readCount = 0;
  let connected = false;
  const statuses = options.statuses ? [...options.statuses] : null;
  const transport: RecoveryTransport & { sent: string[]; released: number } = {
    kind: "usb",
    get connected() {
      return connected;
    },
    sent,
    released: 0,
    async connect() {
      if (options.failConnect) throw options.failConnect;
      connected = true;
      return { hello: options.hello ?? HELLO, status: options.status ?? STATUS };
    },
    async request(line) {
      sent.push(line);
      if (options.onRequest) {
        const custom = options.onRequest(line);
        if (custom !== null) return custom;
      }
      if (options.failRequest) throw options.failRequest;
      return (
        options.replies?.[line] ??
        options.replies?.[line.split(" ").slice(0, 2).join(" ")] ??
        '{"hc":"ack","action":"wifi","ok":true,"detail":"done"}'
      );
    },
    async readStatus() {
      readCount += 1;
      if (statuses && statuses.length > 0) {
        return statuses.length === 1 ? statuses[0]! : statuses.shift()!;
      }
      return options.status ?? STATUS;
    },
    async release() {
      transport.released += 1;
      connected = false;
    },
  };
  void readCount;
  return transport;
}

function fakeApi(
  overrides: Partial<RecoveryServerApi> = {},
  opts: { unavailable?: boolean } = {}
) {
  const calls = { start: 0, diagnostics: 0, complete: 0, abandon: 0 };
  const api: RecoveryServerApi = {
    async startSession() {
      calls.start += 1;
      if (opts.unavailable) throw new Error("Worker unavailable");
      return {
        session: {
          id: "sess-1",
          status: "active",
          stage: "discovery",
          startedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 900_000).toISOString(),
        },
        resumed: false,
        server: { diagnostics: null, plan: null },
      };
    },
    async postDiagnostics() {
      calls.diagnostics += 1;
      return {
        diagnostics: { checks: [], problems: [], status: "unknown", hasUnknowns: true },
        plan: {
          actions: [],
          requiresFirmwareWorkflow: false,
          requiresUserConsent: false,
          consentReason: null,
          summary: [],
          noActionNeeded: true,
        },
      };
    },
    async complete(_id, payload) {
      calls.complete += 1;
      return {
        report: {
          sessionId: "sess-1",
          transport: "usb",
          board: {
            boardInstanceId: "board-1",
            name: "Hallway Hub",
            boardSlug: HELLO.boardSlug,
            hardwareUid: HELLO.uidSuffix,
            firmwareVersion: HELLO.firmwareVersion,
          },
          startedAt: new Date(Date.now() - 5000).toISOString(),
          completedAt: new Date().toISOString(),
          durationMs: 5000,
          detectedProblems: [],
          diagnostics: [],
          actions: payload.outcomes.map((o) => ({
            actionId: o.actionId as never,
            status: o.status as never,
            message: o.message,
            at: new Date().toISOString(),
          })),
          verification: {
            checks: [],
            status: "verified",
            summary: "Repair verified.",
            unresolved: [],
          },
          unresolvedProblems: [],
          finalStatus: "completed",
          finalTelemetry: {
            connected: true,
            wifiSsid: "Home24G",
            wifiRssi: -55,
            ipAssigned: true,
            mqttConnected: true,
            apiReachable: true,
            lastSyncAt: null,
            lastHeartbeatAt: new Date().toISOString(),
            firmwareVersion: "1.5.0",
          },
          nextAction: null,
        } as never,
        session: {
          id: "sess-1",
          status: "completed",
          stage: "report",
          startedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 900_000).toISOString(),
        },
      };
    },
    async abandon() {
      calls.abandon += 1;
    },
    ...overrides,
  };
  return { api, calls };
}

function capability(kind: "usb" | "ble" | "wifi", availableFlag = true) {
  return {
    transport: kind,
    label:
      kind === "usb"
        ? "Repair / Recover with USB"
        : kind === "ble"
          ? "Repair / Recover with BLE"
          : "Repair / Recover with Wi-Fi",
    description: "Test transport.",
    requirements: [],
    available: availableFlag,
    unavailableReason: availableFlag ? null : "Web Serial is not available in this browser.",
    supportsWifiRepair: true,
    supportsRePair: true,
    supportsDiagnostics: true,
  };
}

function build(overrides: {
  transport?: ReturnType<typeof fakeTransport>;
  api?: RecoveryServerApi;
  capabilityFor?: (kind: "usb" | "ble" | "wifi") => ReturnType<typeof capability>;
  verifyTimeoutMs?: number;
  verifyPollMs?: number;
  restartWaitMs?: number;
  expectedHardwareUid?: string;
  backendUrl?: string;
} = {}) {
  const transport = overrides.transport ?? fakeTransport();
  const { api, calls } = fakeApi();
  const controller = createRecoveryController({
    api: overrides.api ?? api,
    boardInstanceId: "board-1",
    backendUrl: overrides.backendUrl,
    expectedHardwareUid: overrides.expectedHardwareUid,
    createTransport: () => transport,
    capabilityFor: (kind) => (overrides.capabilityFor ?? (() => capability(kind)))(kind as never),
    verifyTimeoutMs: overrides.verifyTimeoutMs ?? 50,
    verifyPollMs: overrides.verifyPollMs ?? 1,
    restartWaitMs: overrides.restartWaitMs ?? 0,
    now: () => Date.now(),
  });
  return { controller, transport, calls };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("recovery flow (one engine, three transports)", () => {
  it("repairs the website endpoint without requesting new Wi-Fi credentials", async () => {
    const transport = fakeTransport({ status: { ...STATUS, backendReachable: false, backendOk: false } });
    const { controller } = build({ transport, backendUrl: "https://homecore.example" });
    await controller.connect("usb");
    await controller.diagnose();
    expect(controller.getState().plan?.actions.some((a) => a.id === "rewrite_wifi")).toBe(false);
    expect(controller.getState().plan?.actions.some((a) => a.id === "resync_config")).toBe(true);
    await controller.repair({});
    expect(transport.sent).toContain('HC REPAIR {"action":"config","backend_url":"https://homecore.example"}');
    expect(transport.sent.some((line) => line.includes('"action":"factory_reset"'))).toBe(false);
  });

  it("identifies the board through the transport and reports what it read", async () => {
    const { controller } = build();
    await controller.connect("usb");
    const state = controller.getState();

    expect(state.phase).toBe("identified");
    expect(state.board.boardSlug).toBe(HELLO.boardSlug);
    expect(state.board.hardwareUid).toBe("EE12");
    expect(state.board.firmwareVersion).toBe("1.5.0");
    expect(state.steps[0]?.state).toBe("done");
    expect(state.steps[1]?.state).toBe("done");
    expect(state.error).toBeNull();
  });

  it("refuses a connected controller with the wrong identity", async () => {
    const { controller, transport } = build({ expectedHardwareUid: "AA:BB:CC:DD:FF:FF" });
    await controller.connect("usb");
    expect(controller.getState().error?.code).toBe("identity_mismatch");
    expect(transport.sent).toEqual([]);
    expect(transport.released).toBe(1);
  });

  it.each([401, 403, 404, 409, 410])("does not fall back to local repair after server refusal %s", async (status) => {
    const { api } = fakeApi({ startSession: async () => { throw Object.assign(new Error("Recovery refused"), { status }); } });
    const { controller, transport } = build({ api });
    await controller.connect("usb");
    await controller.diagnose();
    expect(controller.getState().phase).toBe("error");
    expect(controller.getState().plan).toBeNull();
    await controller.repair({});
    expect(transport.sent.filter((line) => line.startsWith("HC REPAIR"))).toEqual([]);
  });

  it("refuses a transport the browser cannot support, and says why", async () => {
    const { controller } = build({ capabilityFor: (kind) => capability(kind, false) });
    await controller.connect("ble");
    const state = controller.getState();
    expect(state.phase).toBe("error");
    expect(state.error?.code).toBe("transport_unavailable");
    expect(state.error?.retryable).toBe(false);
    expect(state.error?.message).toMatch(/Web Serial|not available/i);
  });

  it("proposes nothing when the controller is already healthy", async () => {
    const { controller } = build();
    await controller.connect("usb");
    await controller.diagnose();
    const state = controller.getState();
    expect(state.phase).toBe("plan");
    expect(state.plan?.actions).toEqual([]);
    expect(state.plan?.noActionNeeded).toBe(true);
    expect(state.sessionId).toBe("sess-1");
  });

  it("asks for Wi-Fi credentials before repairing a wrong-password failure", async () => {
    const transport = fakeTransport({
      status: {
        ...STATUS,
        wifiConnected: false,
        ip: null,
        rssi: null,
        mqttConnected: false,
        backendReachable: false,
        backendAuthenticated: false,
        backendOk: false,
        wifiError: "WIFI_REASON_AUTH_FAIL",
      },
      replies: { "HC STATUS": '{"hc":"status","proto":1,"wifi_connected":false,"ssid":"Home24G"}' },
    });
    const { controller } = build({ transport });
    await controller.connect("usb");
    await controller.diagnose();

    expect(controller.getState().plan?.actions.map((a) => a.id)).toContain("rewrite_wifi");

    await controller.repair({});
    const state = controller.getState();
    expect(state.phase).toBe("awaiting_input");
    expect(state.needs?.kind).toBe("wifi_credentials");
    // Nothing was sent to the board: the flow waits for the user.
    expect(transport.sent.filter((line) => line.startsWith("HC REPAIR"))).toEqual([]);
  });

  it("rejects a too-short Wi-Fi password without touching the board", async () => {
    const transport = fakeTransport({
      status: { ...STATUS, wifiConnected: false, ip: null, mqttConnected: false },
    });
    const { controller } = build({ transport });
    await controller.connect("usb");
    await controller.diagnose();
    await controller.repair({ wifi: { ssid: "Home24G", password: "short" } });

    const state = controller.getState();
    expect(state.phase).toBe("awaiting_input");
    expect(state.needs?.message).toMatch(/8–63/);
    expect(transport.sent.filter((line) => line.startsWith("HC REPAIR"))).toEqual([]);
  });

  it("repairs Wi-Fi with exactly one command and verifies from fresh telemetry", async () => {
    const offline = {
      ...STATUS,
      wifiConnected: false,
      ip: null,
      mqttConnected: false,
      backendReachable: false,
      backendAuthenticated: false,
      backendOk: false,
    };
    // First read: broken. Every read after the repair: healthy.
    const transport = fakeTransport({
      status: offline,
      statuses: [offline, { ...STATUS }, { ...STATUS }],
      onRequest: (line) =>
        line === "HC STATUS" ? JSON.stringify({ hc: "status", ...STATUS }) : null,
    });
    const { controller } = build({ transport });
    await controller.connect("usb");
    await controller.diagnose();
    await controller.repair({ wifi: { ssid: "Home24G", password: "Pass1234" } });

    const state = controller.getState();
    const repairs = transport.sent.filter((line) => line.startsWith("HC REPAIR"));
    const wifiRepairs = repairs.filter((line) => line.includes('"action":"wifi"'));
    // One Wi-Fi repair, and no command repeated.
    expect(wifiRepairs).toHaveLength(1);
    expect(new Set(repairs).size).toBe(repairs.length);
    expect(wifiRepairs[0]).toContain('"ssid":"Home24G"');
    expect(state.phase).toBe("report");
    expect(state.report?.finalStatus).toBe("completed");
    expect(state.steps.at(-1)?.state).toBe("done");
    // The board was released after the repair, exactly once.
    expect(transport.released).toBe(1);
  });

  it("never reports success when the board stays offline after the repair", async () => {
    const offline: RecoveryDeviceStatus = {
      ...STATUS,
      wifiConnected: false,
      ip: null,
      mqttConnected: false,
      backendReachable: false,
      backendAuthenticated: false,
      backendOk: false,
      heartbeatAgeSec: null,
    };
    const transport = fakeTransport({
      status: offline,
      onRequest: (line) => (line === "HC STATUS" ? JSON.stringify({ hc: "status", ...offline }) : null),
    });
    const { controller } = build({
      transport,
      api: fakeApi(
        {},
        {}
      ).api,
      verifyTimeoutMs: 30,
      verifyPollMs: 1,
    });
    await controller.connect("usb");
    await controller.diagnose();
    await controller.repair({ wifi: { ssid: "Home24G", password: "Pass1234" } });

    const state = controller.getState();
    expect(state.verification?.status).not.toBe("verified");
    expect(state.verification?.checks.some((c) => c.id === "wifi_connected" && c.status === "fail")).toBe(
      true
    );
    expect(state.steps[9]?.id).toBe("verify");
    expect(state.steps[9]?.state).toBe("error");
    expect(transport.sent.filter((line) => line.startsWith("HC REPAIR") && !line.includes('"action":"wifi"'))).toEqual([]);
  });

  it("does not repeat a refused repair and surfaces the controller's reason", async () => {
    const transport = fakeTransport({
      status: { ...STATUS, paired: false, mqttConnected: false, backendAuthenticated: false },
      onRequest: (line) =>
        line.startsWith("HC REPAIR")
          ? '{"hc":"error","code":"not_paired","message":"Re-pair the controller first."}'
          : null,
    });
    const { controller } = build({ transport });
    await controller.connect("usb");
    await controller.diagnose();
    await controller.repair({ pairingCode: "123456", consentToRePair: true });

    const state = controller.getState();
    expect(state.outcomes[0]?.status).toBe("failed");
    expect(state.outcomes[0]?.message).toMatch(/Re-pair/i);
    // One attempt, not three: the board gave a definitive answer.
    expect(transport.sent.filter((line) => line.startsWith("HC REPAIR"))).toHaveLength(1);
  });

  it("reports a BLE disconnect instead of hanging", async () => {
    const transport = fakeTransport({
      failConnect: new RecoveryTransportError(
        "ble_disconnected",
        "Bluetooth disconnected from the controller. Move closer and reconnect."
      ),
    });
    const { controller } = build({ transport });
    await controller.connect("ble");
    const state = controller.getState();
    expect(state.phase).toBe("error");
    expect(state.error?.code).toBe("ble_disconnected");
    expect(state.error?.retryable).toBe(true);
  });

  it("reports a yanked USB cable during the repair as a failure, not a success", async () => {
    const transport = fakeTransport({
      status: { ...STATUS, wifiConnected: false, ip: null, mqttConnected: false },
      failRequest: new RecoveryTransportError(
        "usb_disconnected",
        "The USB connection to the controller was lost. Reconnect the cable and retry."
      ),
      onRequest: (line) => (line === "HC STATUS" ? JSON.stringify({ hc: "status", ...STATUS }) : null),
    });
    const { controller } = build({ transport });
    await controller.connect("usb");
    await controller.diagnose();
    await controller.repair({ wifi: { ssid: "Home24G", password: "Pass1234" } });

    const state = controller.getState();
    expect(state.outcomes[0]?.status).toBe("failed");
    expect(state.outcomes[0]?.message).toMatch(/USB connection/i);
    expect(state.report?.finalStatus).not.toBe("completed");
  });

  it("keeps working when the Worker is unreachable, and says the report is local", async () => {
    const { api } = fakeApi();
    const transport = fakeTransport({
      status: { ...STATUS, wifiConnected: false, ip: null, mqttConnected: false },
      onRequest: (line) => (line === "HC STATUS" ? JSON.stringify({ hc: "status", ...STATUS }) : null),
    });
    const { controller } = build({
      transport,
      api: {
        ...api,
        async startSession() {
          throw new Error("Worker unavailable");
        },
      },
    });
    await controller.connect("usb");
    await controller.diagnose();
    expect(controller.getState().plan?.actions.length).toBeGreaterThan(0);

    await controller.repair({ wifi: { ssid: "Home24G", password: "Pass1234" } });
    const state = controller.getState();
    expect(state.phase).toBe("report");
    expect(state.report?.sessionId).toBe("local");
    expect(state.technical.join(" ")).toMatch(/Worker unavailable/);
  });

  it("records an expired session as unverified rather than successful", async () => {
    const { api } = fakeApi();
    const transport = fakeTransport({
      status: { ...STATUS, wifiConnected: false, ip: null, mqttConnected: false },
      onRequest: (line) => (line === "HC STATUS" ? JSON.stringify({ hc: "status", ...STATUS }) : null),
    });
    const { controller } = build({
      transport,
      api: {
        ...api,
        async complete() {
          throw new Error("This recovery session expired. Start a new one.");
        },
      },
    });
    await controller.connect("usb");
    await controller.diagnose();
    await controller.repair({ wifi: { ssid: "Home24G", password: "Pass1234" } });

    const state = controller.getState();
    expect(state.report).not.toBeNull();
    expect(state.technical.join(" ")).toMatch(/expired/i);
  });

  it("abandons the session and releases the board when cancelled", async () => {
    const transport = fakeTransport();
    const { calls } = fakeApi();
    const { controller } = build({ transport, api: fakeApi().api });
    await controller.connect("usb");
    await controller.diagnose();
    await controller.cancel("user closed the dialog");

    expect(controller.getState().phase).toBe("idle");
    expect(transport.released).toBe(1);
    void calls;
  });

  it("resets every step so a retry starts clean", async () => {
    const { controller } = build({
      transport: fakeTransport({
        failConnect: new RecoveryTransportError("usb_no_answer", "No answer."),
      }),
    });
    await controller.connect("usb");
    expect(controller.getState().phase).toBe("error");
    controller.reset();
    const state = controller.getState();
    expect(state.phase).toBe("idle");
    expect(state.steps.every((s) => s.state === "pending")).toBe(true);
    expect(state.board.boardSlug).toBeNull();
  });

  it("restarts the controller after a configuration repair and proves the reboot from fresh telemetry", async () => {
    const restarted: RecoveryDeviceStatus = {
      ...STATUS,
      wifiConnected: false,
      ip: null,
      mqttConnected: false,
      backendOk: true,
      backendUrl: "https://app.homecoreos.test",
      uptimeSec: 6,
    };
    const reconnect: RecoveryDeviceStatus = {
      ...STATUS,
      backendUrl: "https://app.homecoreos.test",
      uptimeSec: 12,
    };
    const transport = fakeTransport({
      status: { ...STATUS, backendUrl: "", backendOk: false, mqttConnected: false },
      statuses: [restarted, reconnect, reconnect, reconnect, reconnect],
    });
    const { controller, calls } = build({
      transport,
      backendUrl: "https://app.homecoreos.test",
      verifyTimeoutMs: 200,
      verifyPollMs: 1,
    });

    await controller.connect("usb");
    await controller.diagnose();
    // The missing server URL is the root cause, so it is repaired before the
    // MQTT reconnect that depends on it.
    expect(controller.getState().plan?.actions.map((action) => action.id)).toEqual([
      "configure_endpoint",
      "reconnect_mqtt",
    ]);

    await controller.repair({});

    const state = controller.getState();
    expect(state.steps.map((step) => step.id)).toContain("restart");
    expect(state.steps[8]?.id).toBe("restart");
    expect(state.steps[8]?.state).toBe("done");
    // The restart is the last thing sent, and it carries nothing but intent.
    expect(transport.sent.at(-1)).toContain('"action":"restart"');
    const repairLines = transport.sent.filter((line) => line.startsWith("HC REPAIR"));
    expect(repairLines[0]).toContain('"action":"config"');
    expect(repairLines[0]).toContain("https://app.homecoreos.test");
    // Verification only sees telemetry read after the restart.
    expect(state.verification?.checks.find((check) => check.id === "backend_url_verified")?.status).toBe("pass");
    expect(state.verification?.checks.find((check) => check.id === "restart_verified")?.status).toBe("pass");
    expect(state.verification?.checks.find((check) => check.id === "restart_verified")?.required).toBe(false);
    expect(state.phase).toBe("report");
    expect(calls.complete).toBe(1);
  });

  it("does not restart a controller when nothing needed changing", async () => {
    const transport = fakeTransport();
    const { controller } = build({ transport });
    await controller.connect("usb");
    await controller.diagnose();
    await controller.repair({});
    expect(transport.sent.filter((line) => line.includes('"action":"restart"'))).toEqual([]);
    expect(controller.getState().steps[8]?.state).toBe("done");
    expect(controller.getState().steps[8]?.detail).toMatch(/No restart was needed/i);
  });

  it("exposes the same eleven steps for every transport", async () => {
    const kinds = ["wifi", "ble", "usb"] as const;
    for (const kind of kinds) {
      const transport = fakeTransport();
      const { controller } = build({ transport });
      await controller.connect(kind);
      const steps = controller.getState().steps.map((s) => s.id);
      expect(steps).toEqual([
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
      await controller.dispose();
    }
  });
});
