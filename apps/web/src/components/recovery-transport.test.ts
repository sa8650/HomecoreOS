import { describe, expect, it, vi } from "vitest";
import {
  RecoveryTransportError,
  createBleRecoveryTransport,
  createUsbRecoveryTransport,
  createWifiRecoveryTransport,
  isRecoverySerialSupported,
  type RecoveryBleSession,
  type RecoverySerialPort,
} from "../lib/recovery-transport";

const HELLO = {
  hc: "recovery",
  proto: 1,
  board: "esp32-s3-devkitc-1-n16r8",
  chip: "esp32s3",
  fw: "1.5.0",
  mode: "recovery",
  paired: true,
  wifi: true,
  ble: true,
  recovery_supported: true,
  uid_suffix: "EE12",
};

const STATUS = {
  hc: "status",
  proto: 1,
  mode: "normal",
  fw: "1.5.0",
  paired: true,
  wifi_connected: true,
  ssid: "Home24G",
  rssi: -55,
  ip: "192.168.1.50",
  wifi_error: "",
  mqtt_connected: true,
  mqtt_error: "",
  backend_reachable: true,
  backend_authenticated: true,
  backend_ok: true,
  config_revision: 2,
  synced_config_revision: 2,
  pending_config: false,
  heartbeat_age_sec: 10,
  heartbeat_interval_sec: 60,
  entities_known: true,
  sensors_total: 1,
  sensors_reporting: 1,
  switches_total: 1,
  switches_reporting: 1,
  nodes_known: true,
  nodes_total: 0,
  nodes_linked: 0,
  last_error: "",
};

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

describe("Wi-Fi setup-portal transport", () => {
  it("reads discovery and diagnostics in one round trip", async () => {
    const calls: string[] = [];
    const transport = createWifiRecoveryTransport({
      fetchImpl: async (url) => {
        calls.push(url);
        return jsonResponse({ recovery: HELLO, status: STATUS });
      },
    });
    const { hello, status } = await transport.connect();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/^http:\/\/192\.168\.4\.1\/api\/recovery\?t=\d+$/);
    expect(hello.uidSuffix).toBe("EE12");
    expect(status.ssid).toBe("Home24G");
    expect(transport.connected).toBe(true);
  });

  it("explains a missing portal address instead of timing out silently", async () => {
    const transport = createWifiRecoveryTransport({
      fetchImpl: async () => {
        throw new TypeError("Failed to fetch");
      },
    });
    await expect(transport.connect()).rejects.toMatchObject({
      code: "portal_unreachable",
      retryable: true,
    });
    await expect(transport.connect()).rejects.toThrow(/HomecoreOS-Setup-XXXX/i);
  });

  it("detects a portal without the recovery endpoint", async () => {
    const transport = createWifiRecoveryTransport({
      fetchImpl: async () => ({ ok: false, status: 404, text: async () => "Not found" }),
    });
    await expect(transport.connect()).rejects.toMatchObject({ code: "portal_unreachable" });
    await expect(transport.connect()).rejects.toThrow(/no recovery page/i);
  });

  it("sends one command per POST and returns the board's answer", async () => {
    const posts: Array<{ url: string; body?: string }> = [];
    const transport = createWifiRecoveryTransport({
      fetchImpl: async (url, init) => {
        if (init?.method === "POST") {
          posts.push({ url, body: init.body });
          return jsonResponse({ hc: "ack", action: "wifi", ok: true, detail: "saved" });
        }
        return jsonResponse({ recovery: HELLO, status: STATUS });
      },
    });
    await transport.connect();
    const reply = await transport.request('HC REPAIR {"action":"mqtt"}');
    expect(posts).toHaveLength(1);
    expect(JSON.parse(posts[0]!.body!)).toEqual({ command: 'HC REPAIR {"action":"mqtt"}' });
    expect(JSON.parse(reply).hc).toBe("ack");
  });

  it("has nothing to release, but reports disconnected afterwards", async () => {
    const transport = createWifiRecoveryTransport({
      fetchImpl: async () => jsonResponse({ recovery: HELLO, status: STATUS }),
    });
    await transport.connect();
    await transport.release();
    expect(transport.connected).toBe(false);
  });

  it("never serves a cached read, so a post-repair status is the real one", async () => {
    const calls: string[] = [];
    const transport = createWifiRecoveryTransport({
      fetchImpl: async (url) => {
        calls.push(url);
        return jsonResponse({ recovery: HELLO, status: STATUS });
      },
    });
    await transport.connect();
    await transport.connect();
    expect(calls[0]).toMatch(/^http:\/\/192\.168\.4\.1\/api\/recovery\?t=\d+$/);
    expect(calls[1]).toMatch(/^http:\/\/192\.168\.4\.1\/api\/recovery\?t=\d+$/);
    // Any timestamp satisfies the cache-buster; the two reads must not be the
    // identical URL, which is all a browser would cache.
    expect(calls[0]?.replace(/t=\d+/, "t=*")).toBe(calls[1]?.replace(/t=\d+/, "t=*"));
  });

  it("submits SSID, password, website URL and the recovery code as the same protocol lines BLE and USB send", async () => {
    const commands: unknown[] = [];
    const urls: string[] = [];
    const transport = createWifiRecoveryTransport({
      codeState: { code: "123456", generated: true },
      fetchImpl: async (fetchUrl, init) => {
        if (init?.method === "POST") {
          urls.push(fetchUrl);
          commands.push(JSON.parse(String(init.body)).command);
          return jsonResponse({ hc: "ack", action: "config", ok: true, detail: "saved" });
        }
        return jsonResponse({ recovery: HELLO, status: STATUS });
      },
    });
    await transport.connect();

    const result = await transport.submitForm!({
      ssid: "Home24G",
      password: "Secret123",
      backendUrl: "https://app.homecoreos.test",
      recoveryCode: "654321",
    });

    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/recovery code/i);
    expect(commands.map((command) => JSON.parse(String(command).replace(/^HC REPAIR /, "")))).toEqual([
      { action: "wifi", ssid: "Home24G", password: "Secret123", backend_url: "https://app.homecoreos.test" },
      { action: "pair", backend_url: "https://app.homecoreos.test", pair_code: "654321" },
    ]);
    // A write never carries the cache-busting query a read uses.
    expect(urls).toEqual(["http://192.168.4.1/api/recovery", "http://192.168.4.1/api/recovery"]);
  });

  it("repairs only the website URL when the Wi-Fi network itself is still correct", async () => {
    const commands: string[] = [];
    const transport = createWifiRecoveryTransport({
      fetchImpl: async (_fetchUrl, init) => {
        if (init?.method === "POST") {
          commands.push(JSON.parse(String(init.body)).command);
          return jsonResponse({ hc: "ack", action: "config", ok: true, detail: "saved" });
        }
        return jsonResponse({ recovery: HELLO, status: STATUS });
      },
    });
    await transport.connect();

    const result = await transport.submitForm!({
      ssid: "",
      password: "",
      backendUrl: "https://app.homecoreos.test",
      recoveryCode: "",
    });

    expect(result.ok).toBe(true);
    expect(commands.map((command) => JSON.parse(command.replace(/^HC REPAIR /, "")))).toEqual([
      { action: "config", backend_url: "https://app.homecoreos.test" },
    ]);
  });

  it("refuses an empty local-page form and repeats the controller's refusal verbatim", async () => {
    const transport = createWifiRecoveryTransport({
      fetchImpl: async (_fetchUrl, init) => {
        if (init?.method === "POST") {
          return jsonResponse({ hc: "ack", action: "wifi", ok: false, detail: "wrong_password" });
        }
        return jsonResponse({ recovery: HELLO, status: STATUS });
      },
    });
    await transport.connect();

    expect(
      await transport.submitForm!({ ssid: "", password: "", backendUrl: "", recoveryCode: "" })
    ).toEqual({
      ok: false,
      message: expect.stringMatching(/Enter a Wi-Fi network, a server URL or a recovery code/i),
    });
    expect(
      await transport.submitForm!({ ssid: "Home24G", password: "wrong", backendUrl: "", recoveryCode: "" })
    ).toEqual({ ok: false, message: "wrong_password" });
  });

  it("says the address is not a HomecoreOS board instead of guessing", async () => {
    const transport = createWifiRecoveryTransport({
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => "<html>router admin</html>" }),
    });
    await expect(transport.connect()).rejects.toThrow(/not a HomecoreOS controller/i);
  });

  it("keeps a custom recovery address and trims its trailing slash", async () => {
    const urls: string[] = [];
    const transport = createWifiRecoveryTransport({
      origin: "http://10.0.0.1/",
      fetchImpl: async (url) => {
        urls.push(url);
        return jsonResponse({ recovery: HELLO, status: STATUS });
      },
    });
    await transport.connect();
    expect(urls[0]).toMatch(/^http:\/\/10\.0\.0\.1\/api\/recovery\?t=\d+$/);
  });
});

describe("Bluetooth transport", () => {
  function fakeSession(options: {
    chunks?: unknown[];
    failWrite?: Error;
    onStatus?: (cb: (payload: unknown) => void) => void;
  }) {
    let statusCb: ((payload: unknown) => void) | null = null;
    let authenticated = false;
    const session: RecoveryBleSession & { sent: string[]; disconnected: boolean } = {
      sent: [],
      disconnected: false,
      isConnected: true,
      async connectAndAuthenticate() {
        authenticated = true;
        return { deviceInfo: { mac_suffix: "EE12", chip: "esp32s3", fw: "1.5.0" } };
      },
      async sendEncryptedCommand(payload) {
        session.sent.push(payload.action);
        if (options.failWrite) throw options.failWrite;
        const line = payload.action.replace(/^hc /, "");
        if (options.chunks) {
          // Deliver a chunked response one notification at a time.
          const raw = JSON.stringify(
            line === "HC HELLO" ? HELLO : line === "HC STATUS" ? STATUS : { hc: "pong", proto: 1 }
          );
          const size = 150;
          const total = Math.ceil(raw.length / size);
          for (let i = 0; i < total; i++) {
            const d = raw.slice(i * size, (i + 1) * size);
            queueMicrotask(() => statusCb?.({ chunk: { i, n: total, d } }));
          }
        } else {
          queueMicrotask(() =>
            statusCb?.(
              line === "HC HELLO" ? HELLO : line === "HC STATUS" ? STATUS : { hc: "pong", proto: 1 }
            )
          );
        }
      },
      onStatusUpdate(cb) {
        // Real client ignores registrations before it has a session key.
        if (!authenticated) return;
        statusCb = cb;
        options.onStatus?.(cb);
      },
      disconnect() {
        session.disconnected = true;
        session.isConnected = false;
      },
    };
    return session;
  }

  it("reassembles chunked status notifications across three commands", async () => {
    const session = fakeSession({ chunks: [] });
    const transport = createBleRecoveryTransport({ createClient: () => session });
    const { hello, status } = await transport.connect();
    expect(hello.boardSlug).toBe("esp32-s3-devkitc-1-n16r8");
    expect(status.configRevision).toBe(2);
    expect(session.sent).toEqual(["hc HC HELLO", "hc HC STATUS"]);
  });

  it("refuses to start when the browser has no Web Bluetooth", async () => {
    const transport = createBleRecoveryTransport({
      createClient: () => fakeSession({}),
      support: { supported: false, reason: "Web Bluetooth is unavailable in this browser." },
    });
    await expect(transport.connect()).rejects.toMatchObject({
      code: "ble_unsupported",
      retryable: false,
    });
  });

  it("surfaces a write failure as a retryable transport error", async () => {
    const transport = createBleRecoveryTransport({
      createClient: () => fakeSession({ failWrite: new Error("GATT link lost") }),
    });
    await expect(transport.connect()).rejects.toMatchObject({ code: "ble_write_failed" });
  });

  it("releases the BLE session and its characteristic listener", async () => {
    const session = fakeSession({});
    const transport = createBleRecoveryTransport({ createClient: () => session });
    await transport.connect();
    await transport.release();
    expect(session.disconnected).toBe(true);
    expect(transport.connected).toBe(false);
  });
});

describe("USB serial transport", () => {
  function fakePort(options: {
    /** Replies printed as soon as a command arrives, in chunks. */
    reply?: (line: string) => string | null;
    splitEvery?: number;
  } = {}): RecoverySerialPort & { written: string[] } {
    const written: string[] = [];
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    const encoded = new TextEncoder();
    const port: RecoverySerialPort & { written: string[] } = {
      written,
      readable: new ReadableStream<Uint8Array>({
        start(c) {
          controller = c;
          // The ESP-IDF boot log shares the port and must be ignored.
          c.enqueue(encoded.encode("I (312) boot: ESP-IDF v5.3\r\n"));
        },
      }),
      writable: new WritableStream<Uint8Array>({
        write(chunk) {
          const line = new TextDecoder().decode(chunk).trim();
          written.push(line);
          const reply = options.reply?.(line) ?? null;
          if (reply && controller) {
            const payload = `${reply}\n`;
            const step = options.splitEvery ?? payload.length;
            for (let i = 0; i < payload.length; i += step) {
              controller.enqueue(encoded.encode(payload.slice(i, i + step)));
            }
          }
        },
      }),
      async open() {},
      async close() {
        controller?.close();
      },
    };
    return port;
  }

  it("reports unsupported browsers with a plain-language reason", () => {
    const original = Object.getOwnPropertyDescriptor(window, "isSecureContext");
    Object.defineProperty(window, "isSecureContext", { value: false, configurable: true });
    expect(isRecoverySerialSupported()).toEqual({
      available: false,
      reason: "USB recovery needs HTTPS (or localhost during development).",
    });
    if (original) Object.defineProperty(window, "isSecureContext", original);
  });

  it("reads identity over serial while ignoring the boot log", async () => {
    const port = fakePort({
      reply: (line) =>
        line === "HC HELLO"
          ? JSON.stringify(HELLO)
          : line === "HC STATUS"
            ? JSON.stringify(STATUS)
            : null,
      splitEvery: 17,
    });
    const transport = createUsbRecoveryTransport({
      requestPort: async () => port,
      support: { available: true, reason: null },
    });
    const { hello, status } = await transport.connect();
    expect(port.written).toEqual(["HC HELLO", "HC STATUS"]);
    expect(hello.recoverySupported).toBe(true);
    expect(status.wifiConnected).toBe(true);
  });

  it("reports a busy port without pretending the board is missing", async () => {
    const transport = createUsbRecoveryTransport({
      requestPort: async () => ({
        open: async () => {
          throw new Error("Failed to open serial port");
        },
        close: async () => {},
      }),
      support: { available: true, reason: null },
    });
    await expect(transport.connect()).rejects.toMatchObject({ code: "usb_open_failed" });
    await expect(transport.connect()).rejects.toThrow(/serial monitor/i);
  });

  it("refuses to write before the port is open", async () => {
    const transport = createUsbRecoveryTransport({
      requestPort: async () => fakePort(),
      support: { available: true, reason: null },
    });
    await expect(transport.request("HC STATUS")).rejects.toBeInstanceOf(RecoveryTransportError);
  });

  it("explains that no board answered (recovery mode not open)", async () => {
    const transport = createUsbRecoveryTransport({
      requestPort: async () => fakePort(),
      support: { available: true, reason: null },
    });
    vi.useFakeTimers();
    try {
      const result = expect(transport.connect()).rejects.toMatchObject({
        code: "usb_no_answer",
        message: expect.stringMatching(/BOOT/i),
      });
      await vi.advanceTimersByTimeAsync(15_001);
      await result;
      await transport.release();
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes the port on release even when the cable is already gone", async () => {
    const close = vi.fn(async () => {});
    const port = fakePort({
      reply: (line) =>
        line === "HC HELLO" ? JSON.stringify(HELLO) : line === "HC STATUS" ? JSON.stringify(STATUS) : null,
    });
    port.close = close;
    const transport = createUsbRecoveryTransport({
      requestPort: async () => port,
      support: { available: true, reason: null },
    });
    await transport.connect();
    await transport.release();
    expect(close).toHaveBeenCalled();
    expect(transport.connected).toBe(false);
  });
});
