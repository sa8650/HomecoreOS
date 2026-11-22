/**
 * The three local transports of the Unified Repair & Recovery system.
 *
 * There is exactly one recovery flow (`recovery-engine.ts` / the shared engine)
 * and three thin adapters behind this interface. Each adapter can only do three
 * things: report whether it is usable in this environment, exchange one
 * protocol line with the board, and release the board when the flow ends.
 *
 *   Wi-Fi → fetch to the board's setup portal (`http://192.168.4.1/api/recovery`)
 *   BLE   → HomecoreBleClient, chunked status notifications
 *   USB   → Web Serial at 115200, one JSON line per response
 *
 * Design rules enforced here (and tested):
 *  - A transport never claims to be available when the browser/board cannot
 *    support it, and always explains why.
 *  - A transport never reports success on its own: it returns the board's
 *    answer, and the engine verifies from telemetry afterwards.
 *  - Every wait is bounded and a lost connection is surfaced as an error the
 *    flow can retry, never as a silently hung promise.
 */
import {
  createBleStatusReassembler,
  createSerialLineBuffer,
  parseRecoveryDeviceMessage,
  type RecoveryDeviceHello,
  type RecoveryDeviceStatus,
  type RecoveryTransportKind,
} from "@homecoreos/shared";

/** Where a transport gets its bytes from. */
export type RecoveryTransportMode = RecoveryTransportKind;

export interface RecoveryTransportAvailability {
  available: boolean;
  /** Plain-language reason when unavailable; never a silent "unsupported". */
  reason: string | null;
}

export interface RecoveryTransportConnectResult {
  hello: RecoveryDeviceHello;
  status: RecoveryDeviceStatus;
}

export interface RecoveryTransport {
  readonly kind: RecoveryTransportMode;
  /** True once the board has answered on this transport. */
  readonly connected: boolean;
  /** Connect and read discovery + diagnostics. Bounded by `timeoutMs`. */
  connect: (options?: { timeoutMs?: number; onProgress?: (message: string) => void }) => Promise<RecoveryTransportConnectResult>;
  /** Send one protocol line (`HC STATUS`, `HC REPAIR {…}`) and return the reply. */
  request: (line: string, options?: { timeoutMs?: number }) => Promise<string>;
  /** Ask the board for fresh diagnostics. */
  readStatus: () => Promise<RecoveryDeviceStatus>;
  /** Release the board and every OS-level resource (serial lock, GATT link). */
  release: () => Promise<void>;
}

export const RECOVERY_TRANSPORT_TIMEOUT_MS = 20_000;
export const RECOVERY_TRANSPORT_CONNECT_TIMEOUT_MS = 75_000;

/** A transport failure that carries a plain-language message for the UI. */
export class RecoveryTransportError extends Error {
  readonly code: string;
  /** True when retrying the same transport can plausibly help. */
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable = true) {
    super(message);
    this.name = "RecoveryTransportError";
    this.code = code;
    this.retryable = retryable;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, code: string, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new RecoveryTransportError(code, message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

function expectHelloAndStatus(responses: string[]): RecoveryTransportConnectResult {
  let hello: RecoveryDeviceHello | null = null;
  let status: RecoveryDeviceStatus | null = null;
  for (const raw of responses) {
    const msg = parseRecoveryDeviceMessage(raw);
    if (msg.kind === "hello") hello = msg.hello;
    if (msg.kind === "status") status = msg.status;
    if (msg.kind === "error") {
      throw new RecoveryTransportError(msg.error.code, msg.error.message);
    }
  }
  if (!hello) {
    throw new RecoveryTransportError(
      "no_answer",
      "The controller answered, but not with the HomecoreOS recovery protocol. Update its firmware from Firmware & Updates."
    );
  }
  if (!status) {
    throw new RecoveryTransportError(
      "no_status",
      "The controller answered discovery but did not report its diagnostics."
    );
  }
  return { hello, status };
}

// ---------------------------------------------------------------------------
// Wi-Fi setup portal
// ---------------------------------------------------------------------------

export const RECOVERY_PORTAL_ORIGIN = "http://192.168.4.1";

interface FetchLike {
  (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal; mode?: RequestMode; cache?: RequestCache }): Promise<{
    ok: boolean;
    status: number;
    text: () => Promise<string>;
  }>;
}

/**
 * Talks to the board's own setup portal. The browser is joined to
 * `HomecoreOS-Setup-XXXX`, so this is a plain same-origin-ish HTTP call to
 * 192.168.4.1 — no service worker, no proxy, nothing to configure.
 */
export function createWifiRecoveryTransport(options: {
  origin?: string;
  fetchImpl?: FetchLike;
} = {}): RecoveryTransport {
  const origin = (options.origin ?? RECOVERY_PORTAL_ORIGIN).replace(/\/+$/, "");
  const doFetch: FetchLike =
    options.fetchImpl ??
    ((input, init) => fetch(input, init as RequestInit) as unknown as ReturnType<FetchLike>);

  let connected = false;

  const post = async (command: string, timeoutMs: number): Promise<string> => {
    const res = await withTimeout(
      doFetch(`${origin}/api/recovery`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command }),
        cache: "no-store",
      }),
      timeoutMs,
      "portal_timeout",
      "The controller's setup page stopped responding. Stay on HomecoreOS-Setup-XXXX and retry."
    );
    const text = await res.text();
    if (!res.ok) {
      throw new RecoveryTransportError(
        "portal_error",
        `The controller's setup page returned ${res.status}. ${text.slice(0, 160)}`.trim()
      );
    }
    return text;
  };

  return {
    kind: "wifi",
    get connected() {
      return connected;
    },
    async connect({ timeoutMs = RECOVERY_TRANSPORT_CONNECT_TIMEOUT_MS, onProgress } = {}) {
      onProgress?.("Looking for the controller's setup page at http://192.168.4.1 …");
      let res;
      try {
        res = await withTimeout(
          doFetch(`${origin}/api/recovery`, { method: "GET", cache: "no-store" }),
          timeoutMs,
          "portal_unreachable",
          "Could not reach http://192.168.4.1. Join the HomecoreOS-Setup-XXXX network first."
        );
      } catch (err) {
        if (err instanceof RecoveryTransportError) throw err;
        throw new RecoveryTransportError(
          "portal_unreachable",
          "Could not reach http://192.168.4.1. Join the HomecoreOS-Setup-XXXX network first."
        );
      }
      if (!res.ok) {
        throw new RecoveryTransportError(
          "portal_unreachable",
          res.status === 404
            ? "This controller's firmware has no recovery page. Update the firmware from Firmware & Updates."
            : `The controller's setup page returned ${res.status}.`
        );
      }
      const body = await res.text();
      let parsed: { recovery?: unknown; status?: unknown } = {};
      try {
        parsed = JSON.parse(body) as { recovery?: unknown; status?: unknown };
      } catch {
        throw new RecoveryTransportError(
          "not_homecoreos",
          "That address answered, but it is not a HomecoreOS controller. Check that you are joined to HomecoreOS-Setup-XXXX."
        );
      }
      if (!parsed.recovery || !parsed.status) {
        throw new RecoveryTransportError(
          "no_recovery_payload",
          "The controller's setup page did not include recovery information. Update the firmware and retry."
        );
      }
      connected = true;
      onProgress?.("Controller found. Reading its diagnostics …");
      return expectHelloAndStatus([
        JSON.stringify(parsed.recovery),
        JSON.stringify(parsed.status),
      ]);
    },
    request: (line, { timeoutMs = RECOVERY_TRANSPORT_TIMEOUT_MS } = {}) => post(line, timeoutMs),
    async readStatus() {
      const res = await post("HC STATUS", RECOVERY_TRANSPORT_TIMEOUT_MS);
      const msg = parseRecoveryDeviceMessage(res);
      if (msg.kind !== "status") {
        throw new RecoveryTransportError("no_status", "The controller did not return its status.");
      }
      return msg.status;
    },
    async release() {
      connected = false;
    },
  };
}

// ---------------------------------------------------------------------------
// Bluetooth LE
// ---------------------------------------------------------------------------

/** The slice of `HomecoreBleClient` this adapter needs (easy to fake in tests). */
export interface RecoveryBleSession {
  connectAndAuthenticate: (params: {
    setupPin?: string;
    candidatePins?: string[];
    onStage?: (stage: string) => void;
    onLog?: (message: string) => void;
    onDisconnected?: () => void;
  }) => Promise<{ deviceInfo: { mac_suffix?: string; chip?: string; fw?: string } }>;
  sendEncryptedCommand: (payload: { action: string }, options?: { supportsWifi?: boolean }) => Promise<void>;
  onStatusUpdate: (
    callback: (status: unknown) => void,
    onError?: (err: Error) => void
  ) => void;
  disconnect: () => void;
  isConnected: boolean;
}

export function createBleRecoveryTransport(options: {
  createClient: () => RecoveryBleSession;
  setupPin?: string;
  candidatePins?: string[];
  support?: { supported: boolean; reason?: string };
}): RecoveryTransport {
  const client = options.createClient();
  const reassembler = createBleStatusReassembler();
  let connected = false;
  let disposed = false;
  const waiters: Array<{ resolve: (value: string) => void; reject: (err: Error) => void; timer: number }> = [];
  let queue: string[] = [];

  const resolveNext = (raw: string) => {
    const waiter = waiters.shift();
    if (waiter) {
      window.clearTimeout(waiter.timer);
      waiter.resolve(raw);
    } else {
      queue.push(raw);
    }
  };

  const failAll = (err: Error) => {
    while (waiters.length > 0) {
      const waiter = waiters.shift()!;
      window.clearTimeout(waiter.timer);
      waiter.reject(err);
    }
    queue = [];
  };

  const nextResponse = (timeoutMs: number) => {
    if (queue.length > 0) return Promise.resolve(queue.shift()!);
    return new Promise<string>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        const idx = waiters.findIndex((w) => w.timer === timer);
        if (idx >= 0) waiters.splice(idx, 1);
        reject(
          new RecoveryTransportError(
            "ble_timeout",
            "The controller did not answer over Bluetooth. Keep it close to this device and retry."
          )
        );
      }, timeoutMs);
      waiters.push({ resolve, reject, timer });
    });
  };

  client.onStatusUpdate(
    (payload) => {
      // The firmware may split a response across notifications; a partial set
      // is dropped rather than guessed (the flow re-asks with HC STATUS).
      const completed = reassembler.push(payload);
      if (completed !== null) resolveNext(completed);
    },
    () => {
      // Undecryptable notification: ignore, the timeout surfaces the problem.
    }
  );

  return {
    kind: "ble",
    get connected() {
      return connected && client.isConnected;
    },
    async connect({ timeoutMs = RECOVERY_TRANSPORT_CONNECT_TIMEOUT_MS, onProgress } = {}) {
      const support = options.support;
      if (support && !support.supported) {
        throw new RecoveryTransportError(
          "ble_unsupported",
          support.reason ?? "Web Bluetooth is not available in this browser.",
          false
        );
      }
      onProgress?.("Choose your HomecoreOS controller in the Bluetooth prompt …");
      try {
        await withTimeout(
          client.connectAndAuthenticate({
            setupPin: options.setupPin,
            candidatePins: options.candidatePins,
            onLog: (msg) => onProgress?.(msg),
            onDisconnected: () => {
              connected = false;
              if (!disposed) {
                failAll(
                  new RecoveryTransportError(
                    "ble_disconnected",
                    "Bluetooth disconnected from the controller. Move closer and reconnect."
                  )
                );
              }
            },
          }),
          timeoutMs,
          "ble_timeout",
          "The Bluetooth connection timed out. Move closer to the controller and retry."
        );
      } catch (err) {
        if (err instanceof RecoveryTransportError) throw err;
        throw new RecoveryTransportError(
          "ble_failed",
          err instanceof Error ? err.message : "Could not connect over Bluetooth."
        );
      }
      connected = true;
      onProgress?.("Secure session established. Reading board information …");

      const helloRaw = await sendAndWait("HC HELLO");
      const statusRaw = await sendAndWait("HC STATUS");
      return expectHelloAndStatus([helloRaw, statusRaw]);

      async function sendAndWait(line: string) {
        const pending = nextResponse(RECOVERY_TRANSPORT_TIMEOUT_MS);
        void pending.catch(() => {});
        try {
          await client.sendEncryptedCommand({ action: `hc ${line}` }, { supportsWifi: true });
        } catch (err) {
          failAll(err instanceof Error ? err : new Error("Could not send the command over Bluetooth."));
          throw new RecoveryTransportError(
            "ble_write_failed",
            err instanceof Error ? err.message : "Could not send the command over Bluetooth."
          );
        }
        return pending;
      }
    },
    async request(line, { timeoutMs = RECOVERY_TRANSPORT_TIMEOUT_MS } = {}) {
      const pending = nextResponse(timeoutMs);
      void pending.catch(() => {});
      try {
        await client.sendEncryptedCommand({ action: `hc ${line}` }, { supportsWifi: true });
      } catch (err) {
        failAll(err instanceof Error ? err : new Error("Could not send the command over Bluetooth."));
        throw new RecoveryTransportError(
          "ble_write_failed",
          err instanceof Error ? err.message : "Could not send the command over Bluetooth."
        );
      }
      return pending;
    },
    async readStatus() {
      const raw = await this.request("HC STATUS");
      const msg = parseRecoveryDeviceMessage(raw);
      if (msg.kind !== "status") {
        throw new RecoveryTransportError("no_status", "The controller did not return its status.");
      }
      return msg.status;
    },
    async release() {
      disposed = true;
      connected = false;
      failAll(
        new RecoveryTransportError("released", "The Bluetooth session was released.", false)
      );
      reassembler.reset();
      try {
        client.disconnect();
      } catch {
        // Releasing must never throw.
      }
    },
  };
}

// ---------------------------------------------------------------------------
// USB serial (Web Serial)
// ---------------------------------------------------------------------------

export interface RecoverySerialPort {
  open: (options: { baudRate: number }) => Promise<void>;
  close: () => Promise<void>;
  readable?: ReadableStream<Uint8Array> | null;
  writable?: WritableStream<Uint8Array> | null;
  getInfo?: () => { usbVendorId?: number; usbProductId?: number };
}

export interface RecoverySerialNavigator {
  requestPort?: (options?: { filters?: Array<{ usbVendorId?: number }> }) => Promise<RecoverySerialPort>;
}

export const RECOVERY_SERIAL_BAUD = 115200;

/** Web Serial support check — the same rules as the flasher, reported plainly. */
export function isRecoverySerialSupported(): RecoveryTransportAvailability {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return { available: false, reason: "A desktop browser is required for USB recovery." };
  }
  if (!window.isSecureContext) {
    return {
      available: false,
      reason: "USB recovery needs HTTPS (or localhost during development).",
    };
  }
  const nav = navigator as Navigator & { serial?: RecoverySerialNavigator };
  if (!nav.serial?.requestPort) {
    return {
      available: false,
      reason:
        "This browser has no Web Serial API. Use desktop Chrome, Edge or Chromium — Firefox and Safari do not support USB recovery.",
    };
  }
  return { available: true, reason: null };
}

/**
 * USB recovery over the controller's own recovery console.
 *
 * The board prints its normal ESP-IDF log on the same port, so responses are
 * recognised as JSON lines and everything else is kept as technical detail.
 * Firmware is never written here: this adapter only exchanges protocol lines.
 */
export function createUsbRecoveryTransport(options: {
  requestPort?: () => Promise<RecoverySerialPort>;
  support?: RecoveryTransportAvailability;
} = {}): RecoveryTransport {
  let port: RecoverySerialPort | null = null;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  let connected = false;
  const lines = createSerialLineBuffer();
  let queue: string[] = [];
  const waiters: Array<{ resolve: (v: string) => void; reject: (e: Error) => void; timer: number }> = [];
  const logs: string[] = [];

  const settle = (raw: string) => {
    const waiter = waiters.shift();
    if (waiter) {
      window.clearTimeout(waiter.timer);
      waiter.resolve(raw);
    } else {
      queue.push(raw);
    }
  };

  const failAll = (err: Error) => {
    while (waiters.length > 0) {
      const w = waiters.shift()!;
      window.clearTimeout(w.timer);
      w.reject(err);
    }
  };

  const nextResponse = (timeoutMs: number) => {
    if (queue.length > 0) return Promise.resolve(queue.shift()!);
    return new Promise<string>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        const idx = waiters.findIndex((w) => w.timer === timer);
        if (idx >= 0) waiters.splice(idx, 1);
        reject(
          new RecoveryTransportError(
            "usb_timeout",
            "The controller did not answer over USB. Check the cable and that it is in recovery mode, then retry."
          )
        );
      }, timeoutMs);
      waiters.push({ resolve, reject, timer });
    });
  };

  const pump = async () => {
    if (!port?.readable) return;
    const decoder = new TextDecoder();
    reader = port.readable.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value) continue;
        for (const line of lines.push(decoder.decode(value, { stream: true }))) {
          const msg = parseRecoveryDeviceMessage(line);
          if (msg.kind === "unknown") {
            if (logs.length < 200) logs.push(line);
            continue;
          }
          settle(line);
        }
      }
    } catch {
      // A yanked cable ends the stream; the disconnected state is reported by
      // the next request timing out with a specific message.
    } finally {
      connected = false;
      failAll(
        new RecoveryTransportError(
          "usb_disconnected",
          "The USB connection to the controller was lost. Reconnect the cable and retry."
        )
      );
      try {
        reader?.releaseLock();
      } catch {
        // ignore
      }
      reader = null;
    }
  };

  return {
    kind: "usb",
    get connected() {
      return connected;
    },
    async connect({ onProgress } = {}) {
      const support = options.support ?? isRecoverySerialSupported();
      if (!support.available) {
        throw new RecoveryTransportError(
          "usb_unsupported",
          support.reason ?? "Web Serial is not available in this browser.",
          false
        );
      }
      onProgress?.("Choose the controller's USB serial port …");
      try {
        const requestPort =
          options.requestPort ??
          (navigator as Navigator & { serial: RecoverySerialNavigator }).serial!.requestPort!;
        port = await requestPort();
      } catch (err) {
        throw new RecoveryTransportError(
          "usb_no_port",
          err instanceof Error && /No port selected|chooser/i.test(err.message)
            ? "No USB port was selected. Connect the controller with a data cable and retry."
            : "Could not open the USB serial port. Close any serial monitor using it and retry.",
          true
        );
      }
      try {
        await port.open({ baudRate: RECOVERY_SERIAL_BAUD });
      } catch {
        throw new RecoveryTransportError(
          "usb_open_failed",
          "The USB port is busy. Close any other serial monitor (Arduino, esptool, idf.py monitor) and retry."
        );
      }
      connected = true;
      onProgress?.("Connected over USB. Asking the controller to identify itself …");
      void pump();

      // The board may be busy booting or printing a banner; HC PING is retried
      // a few times with a short timeout instead of blocking for a minute.
      let helloRaw: string | null = null;
      for (let attempt = 0; attempt < 3 && !helloRaw; attempt++) {
        try {
          helloRaw = await this.request("HC HELLO", { timeoutMs: 5_000 });
        } catch {
          if (attempt === 2) {
            throw new RecoveryTransportError(
              "usb_no_answer",
              "The controller did not answer on USB. Hold BOOT for 3 seconds so it opens recovery mode, then retry."
            );
          }
        }
      }
      const statusRaw = await this.request("HC STATUS", { timeoutMs: 8_000 });
      return expectHelloAndStatus([helloRaw!, statusRaw]);
    },
    async request(line, { timeoutMs = RECOVERY_TRANSPORT_TIMEOUT_MS } = {}) {
      if (!port?.writable || !connected) {
        throw new RecoveryTransportError(
          "usb_disconnected",
          "The USB connection is not open. Reconnect the controller and retry."
        );
      }
      if (!writer) writer = port.writable.getWriter();
      const pending = nextResponse(timeoutMs);
      void pending.catch(() => {});
      const encoder = new TextEncoder();
      try {
        await writer.write(encoder.encode(`${line}\n`));
      } catch {
        throw new RecoveryTransportError(
          "usb_write_failed",
          "Could not write to the controller over USB. Reconnect the cable and retry."
        );
      }
      return pending;
    },
    async readStatus() {
      const raw = await this.request("HC STATUS");
      const msg = parseRecoveryDeviceMessage(raw);
      if (msg.kind !== "status") {
        throw new RecoveryTransportError("no_status", "The controller did not return its status.");
      }
      return msg.status;
    },
    async release() {
      connected = false;
      try {
        await reader?.cancel();
      } catch {
        // ignore
      }
      try {
        reader?.releaseLock();
      } catch {
        // ignore
      }
      try {
        writer?.releaseLock();
      } catch {
        // ignore
      }
      try {
        await port?.close();
      } catch {
        // Closing must never throw: the port may already be gone.
      }
      reader = null;
      writer = null;
      port = null;
      lines.reset();
      queue = [];
      failAll(new RecoveryTransportError("released", "The USB session was released.", false));
    },
  };
}

/** Technical lines the controller printed (ESP-IDF log), for the details panel. */
export function describeRecoveryTransport(kind: RecoveryTransportMode): string {
  if (kind === "wifi") return "Wi-Fi setup page at http://192.168.4.1";
  if (kind === "ble") return "Bluetooth LE encrypted session";
  return "USB serial console at 115200 baud";
}
