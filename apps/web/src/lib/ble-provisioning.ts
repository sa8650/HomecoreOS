import {
  HOMECORE_BLE_CHAR_COMMAND_UUID,
  HOMECORE_BLE_CHAR_DEVICE_INFO_UUID,
  HOMECORE_BLE_CHAR_HANDSHAKE_UUID,
  HOMECORE_BLE_CHAR_STATUS_UUID,
  HOMECORE_BLE_DEFAULT_POP,
  HOMECORE_BLE_DEVICE_NAME_PREFIX,
  HOMECORE_BLE_HS_AUTH_RESULT,
  HOMECORE_BLE_HS_CLIENT_HELLO,
  HOMECORE_BLE_HS_CLIENT_PROOF,
  HOMECORE_BLE_HS_DEVICE_HELLO,
  HOMECORE_BLE_S1_CLI_PROOF_LABEL,
  HOMECORE_BLE_S1_DEV_PROOF_LABEL,
  HOMECORE_BLE_S1_KDF_LABEL,
  HOMECORE_BLE_SERVICE_UUID,
  bleFragmentBudget,
  buildBleFragmentedWrite,
  createBleNoteReassembler,
  createBleReadWindowReader,
  validateBleProvisioningInputs,
  type BleCommandPayload,
  type BleDeviceInfoPayload,
  type BleStatusPayload,
} from "@homecoreos/shared";

interface WebBluetoothCharacteristic {
  value?: DataView;
  readValue(): Promise<DataView>;
  writeValueWithResponse(value: BufferSource): Promise<void>;
  writeValueWithoutResponse?(value: BufferSource): Promise<void>;
  startNotifications(): Promise<WebBluetoothCharacteristic>;
  stopNotifications(): Promise<WebBluetoothCharacteristic>;
  /**
   * Chrome exposes these on desktop/Android; Firefox and Safari do not, which
   * is why every GATT operation is framed against the *reported* budget and
   * falls back to the 20-byte default when it is missing.
   */
  getDescriptor?(uuid: string): Promise<{ readValue(): Promise<DataView> }>;
  addEventListener(type: "characteristicvaluechanged", listener: (ev: Event) => void): void;
  removeEventListener(type: "characteristicvaluechanged", listener: (ev: Event) => void): void;
}

interface WebBluetoothService {
  getCharacteristic(uuid: string): Promise<WebBluetoothCharacteristic>;
}

interface WebBluetoothGattServer {
  connected: boolean;
  connect(): Promise<WebBluetoothGattServer>;
  disconnect(): void;
  getPrimaryService(uuid: string): Promise<WebBluetoothService>;
}

interface WebBluetoothDevice {
  id: string;
  name?: string;
  gatt?: WebBluetoothGattServer;
  addEventListener(type: "gattserverdisconnected", listener: () => void): void;
  removeEventListener(type: "gattserverdisconnected", listener: () => void): void;
}

interface WebBluetoothNavigator {
  bluetooth?: {
    requestDevice(options: {
      filters?: Array<{ services?: string[]; namePrefix?: string }>;
      optionalServices?: string[];
      acceptAllDevices?: boolean;
    }): Promise<WebBluetoothDevice>;
  };
}

export type BleProvisioningStage =
  | "idle"
  | "scanning"
  | "connecting"
  | "authenticating"
  | "sending_credentials"
  | "applying_wifi"
  | "pairing"
  | "completed"
  | "error";

export type BleClientErrorCode =
  | "UNSUPPORTED"
  | "HTTPS_REQUIRED"
  | "CANCELLED"
  | "PERMISSION_DENIED"
  | "DISCONNECTED"
  | "NO_BLE_SERVICE"
  | "AUTH_FAILED"
  | "GATT_FAILED"
  | "TIMEOUT"
  | "UNKNOWN";

export class BleClientError extends Error {
  public readonly code: BleClientErrorCode;

  constructor(code: BleClientErrorCode, message: string) {
    super(message);
    this.name = "BleClientError";
    this.code = code;
  }
}

export interface ParsedSerialSetupInfo {
  setupPin?: string;
  bleName?: string;
  apSsid?: string;
  apPass?: string;
  boardSlug?: string;
}

export function isWebBluetoothSupported(): {
  supported: boolean;
  reason?: string;
  code?: "HTTPS_REQUIRED" | "UNSUPPORTED";
} {
  if (typeof window === "undefined") {
    return {
      supported: false,
      code: "UNSUPPORTED",
      reason: "Browser environment required.",
    };
  }
  if (!window.isSecureContext) {
    return {
      supported: false,
      code: "HTTPS_REQUIRED",
      reason:
        "Web Bluetooth requires HTTPS. Use an HTTPS connection or switch to Wi-Fi setup.",
    };
  }
  const nav = navigator as Navigator & WebBluetoothNavigator;
  if (!nav.bluetooth || typeof nav.bluetooth.requestDevice !== "function") {
    return {
      supported: false,
      code: "UNSUPPORTED",
      reason:
        "Bluetooth setup isn't available in this browser. Try Chrome or Edge, or use Wi-Fi setup.",
    };
  }
  return { supported: true };
}

/**
 * Extracts per-device Setup PIN (PoP), BLE advertised name, and Setup AP credentials
 * printed over USB serial by HomecoreOS firmware (`[HC_SETUP] ...`).
 */
export function parseSetupSerialLine(line: string): ParsedSerialSetupInfo | null {
  if (!line.includes("[HC_SETUP]")) return null;
  const boardMatch = line.match(/\bBOARD=([^\s]+)/);
  const bleNameMatch = line.match(/\b(?:BLE_NAME|BLE)=([^\s]+)/);
  const pinMatch = line.match(/\b(?:PIN|POP)=([A-Za-z0-9]{6,32})/);
  const apSsidMatch = line.match(/\b(?:AP_SSID|AP)=([^\s]+)/);
  const apPassMatch = line.match(/\bAP_PASS=([A-Za-z0-9]{6,32})/);

  const setupPin = pinMatch?.[1] ?? apPassMatch?.[1];
  if (!setupPin && !bleNameMatch && !apSsidMatch) return null;
  return {
    setupPin,
    bleName: bleNameMatch?.[1],
    apSsid: apSsidMatch?.[1],
    apPass: apPassMatch?.[1],
    boardSlug: boardMatch?.[1],
  };
}

function concatBytes(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const total = parts.reduce((sum, p) => sum + p.byteLength, 0);
  const out = new Uint8Array(new ArrayBuffer(total));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
}

function toArrayBufferCopy(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  copy.set(bytes);
  return copy;
}

/**
 * Security 1 Key Derivation (matches firmware/main/ble_provisioning.c):
 *   pop_hash    = SHA-256(utf8(pop))
 *   session_key = SHA-256("HomecoreOS-BLE-S1" || shared_secret(32B) || session_nonce(16B) || pop_hash(32B))
 */
export async function deriveSecurity1SessionKey(
  sharedSecret: Uint8Array,
  sessionNonce: Uint8Array,
  setupPin: string
): Promise<Uint8Array<ArrayBuffer>> {
  const enc = new TextEncoder();
  const labelBytes = enc.encode(HOMECORE_BLE_S1_KDF_LABEL);
  const popHash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", enc.encode(setupPin.trim()))
  );
  const kdfInput = concatBytes(labelBytes, sharedSecret, sessionNonce, popHash);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", kdfInput));
}

export async function computeDeviceProof(
  sessionKey: Uint8Array,
  clientPub: Uint8Array,
  devPub: Uint8Array,
  sessionNonce: Uint8Array
): Promise<Uint8Array<ArrayBuffer>> {
  const hmacKey = await crypto.subtle.importKey(
    "raw",
    toArrayBufferCopy(sessionKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
  const msg = concatBytes(
    new TextEncoder().encode(HOMECORE_BLE_S1_DEV_PROOF_LABEL),
    clientPub,
    devPub,
    sessionNonce
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", hmacKey, msg));
}

export async function verifyDeviceProof(
  sessionKey: Uint8Array,
  clientPub: Uint8Array,
  devPub: Uint8Array,
  sessionNonce: Uint8Array,
  proof: Uint8Array
): Promise<boolean> {
  const hmacKey = await crypto.subtle.importKey(
    "raw",
    toArrayBufferCopy(sessionKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );
  const msg = concatBytes(
    new TextEncoder().encode(HOMECORE_BLE_S1_DEV_PROOF_LABEL),
    clientPub,
    devPub,
    sessionNonce
  );
  return crypto.subtle.verify("HMAC", hmacKey, toArrayBufferCopy(proof), msg);
}

export async function computeClientProof(
  sessionKey: Uint8Array,
  devPub: Uint8Array,
  clientPub: Uint8Array,
  devChallenge: Uint8Array
): Promise<Uint8Array<ArrayBuffer>> {
  const hmacKey = await crypto.subtle.importKey(
    "raw",
    toArrayBufferCopy(sessionKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const msg = concatBytes(
    new TextEncoder().encode(HOMECORE_BLE_S1_CLI_PROOF_LABEL),
    devPub,
    clientPub,
    devChallenge
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", hmacKey, msg));
}

/**
 * Encrypts UTF-8 payload using AES-256-GCM:
 * Wire format: [12-byte random IV][ciphertext][16-byte auth tag]
 */
export async function encryptBlePayload(
  sessionKey: Uint8Array,
  plaintext: string
): Promise<Uint8Array<ArrayBuffer>> {
  const iv = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(12)));
  const aesKey = await crypto.subtle.importKey(
    "raw",
    toArrayBufferCopy(sessionKey),
    { name: "AES-GCM" },
    false,
    ["encrypt"]
  );
  const encoded = new TextEncoder().encode(plaintext);
  const ctWithTag = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv, tagLength: 128 }, aesKey, encoded)
  );
  return concatBytes(iv, ctWithTag);
}

export async function decryptBlePayload(
  sessionKey: Uint8Array,
  packet: Uint8Array
): Promise<string> {
  if (packet.byteLength < 12 + 16) {
    throw new Error("Encrypted BLE packet too short.");
  }
  const iv = toArrayBufferCopy(packet.subarray(0, 12));
  const ctWithTag = toArrayBufferCopy(packet.subarray(12));
  const aesKey = await crypto.subtle.importKey(
    "raw",
    toArrayBufferCopy(sessionKey),
    { name: "AES-GCM" },
    false,
    ["decrypt"]
  );
  const plainBuf = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv, tagLength: 128 },
    aesKey,
    ctWithTag
  );
  return new TextDecoder().decode(plainBuf);
}

function dataViewToBytes(dv: DataView): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(dv.byteLength));
  for (let i = 0; i < dv.byteLength; i++) {
    out[i] = dv.getUint8(i);
  }
  return out;
}

function classifyBluetoothSelectError(err: unknown): BleClientError {
  if (err instanceof BleClientError) return err;
  const domName =
    err && typeof err === "object" && "name" in err ? String((err as { name: unknown }).name) : "";
  const msg = err instanceof Error ? err.message : String(err ?? "");

  if (
    domName === "NotAllowedError" ||
    domName === "SecurityError" ||
    /permission|denied|bluetooth.*disabled|blocked/i.test(msg)
  ) {
    return new BleClientError(
      "PERMISSION_DENIED",
      "Bluetooth permission was denied. Allow Bluetooth access in your browser or switch to Wi-Fi setup."
    );
  }
  if (
    domName === "NotFoundError" ||
    domName === "AbortError" ||
    /cancel|no device selected|user cancelled/i.test(msg)
  ) {
    return new BleClientError(
      "CANCELLED",
      "Controller selection was canceled. Click Discover BLE Controller to try again."
    );
  }
  return new BleClientError(
    "UNKNOWN",
    msg || "Unable to open the Bluetooth device chooser."
  );
}

/** True for the opaque failures Web Bluetooth raises on a busy/long GATT op. */
function isTransientGattError(domName: string, msg: string): boolean {
  return (
    /gatt operation failed for unknown reason/i.test(msg) ||
    /gatt error unknown/i.test(msg) ||
    /gatt operation already in progress/i.test(msg) ||
    /operation in progress/i.test(msg) ||
    domName === "NotSupportedError"
  );
}

function classifyGattConnectError(err: unknown): BleClientError {
  if (err instanceof BleClientError) return err;
  const domName =
    err && typeof err === "object" && "name" in err ? String((err as { name: unknown }).name) : "";
  const msg = err instanceof Error ? err.message : String(err ?? "");

  if (domName === "NotFoundError" || /service.*not found|no services/i.test(msg)) {
    return new BleClientError(
      "NO_BLE_SERVICE",
      "This controller does not expose HomecoreOS BLE provisioning. It may need Wi-Fi setup or a firmware update."
    );
  }
  if (domName === "NetworkError" || /disconnect|connection failed/i.test(msg)) {
    return new BleClientError(
      "DISCONNECTED",
      "Lost Bluetooth connection to the controller. Keep it nearby and try again."
    );
  }
  if (isTransientGattError(domName, msg)) {
    return new BleClientError(
      "GATT_FAILED",
      "The Bluetooth link could not complete that operation. Move closer to the board, then click Discover BLE Board again. Wi-Fi setup works too."
    );
  }
  return new BleClientError(
    "UNKNOWN",
    msg || "Could not connect to the controller over Bluetooth."
  );
}

/**
 * A write that never exceeds the negotiated ATT payload budget.
 *
 * Chrome on Windows and several Android builds stay at the 23-byte default
 * MTU, where a bare `writeValue()` of the 66-byte Client Hello fails with
 * "GATT operation failed for unknown reason" and a transfer the browser turns
 * into a long write can fail the same way. Sending explicit fragments of at
 * most `budget - header` bytes keeps every write inside one ATT packet.
 *
 * A single retry absorbs the intermittent failures Chrome reports on a link
 * that is otherwise up; anything else is classified for the caller.
 */
async function writeFramed(
  characteristic: WebBluetoothCharacteristic,
  value: Uint8Array,
  budget: number,
  onProgress?: (sent: number, total: number) => void
): Promise<void> {
  const attempt = async (offset: number): Promise<void> => {
    const frame = buildBleFragmentedWrite(value, offset, budget);
    if (!frame) throw new BleClientError("GATT_FAILED", "Invalid Bluetooth write size.");
    await characteristic.writeValueWithResponse(toArrayBufferCopy(frame));
    const next = offset + (frame.byteLength - 5);
    onProgress?.(next, value.byteLength);
    if (next < value.byteLength) {
      // Yield between fragments so the phone's GATT queue can drain.
      await new Promise((resolve) => setTimeout(resolve, 12));
      await attempt(next);
    }
  };

  try {
    await attempt(0);
  } catch (err) {
    const first = classifyGattConnectError(err);
    // Only a transient failure is worth repeating; a lost link is not.
    if (first.code !== "GATT_FAILED") throw first;
    await new Promise((resolve) => setTimeout(resolve, 120));
    try {
      await attempt(0);
    } catch (retryErr) {
      throw classifyGattConnectError(retryErr);
    }
  }
}

/**
 * Reads a whole characteristic value even when the platform cannot return it
 * in one ATT packet.
 *
 * The firmware serves a long value as `[0x20][len:2][offset:2][slice]` windows.
 * A first read that fits returns the value unchanged; otherwise the header
 * carries the total length and this loop keeps reading until every byte has
 * been seen. Windows are addressed by their announced offset, so a platform
 * that repeats a read (Chrome does this now and then on a busy link) simply
 * delivers a window we already have instead of shifting the rest of the value.
 */
async function readFramed(
  characteristic: WebBluetoothCharacteristic,
  maxBytes = 4096
): Promise<Uint8Array<ArrayBuffer>> {
  const reader = createBleReadWindowReader(maxBytes);
  // A 1 KB value needs ~50 windows at the 23-byte default MTU; the bound is
  // generous enough for a small MTU and still finite if the board misbehaves.
  const maxReads = Math.max(32, Math.ceil(maxBytes / 4) + 16);
  let reads = 0;

  for (;;) {
    const frame = dataViewToBytes(await characteristic.readValue());
    const completed = reader.push(frame);
    if (completed) return toArrayBufferCopy(completed);

    reads++;
    if (reads >= maxReads) break;

    const total = reader.total();
    // One whole value (no window header) has already been returned above, so a
    // null here always means more windows are waiting.
    if (total === null) break;
    await new Promise((resolve) => setTimeout(resolve, 6));
  }

  throw new BleClientError(
    "GATT_FAILED",
    "The board's Bluetooth response arrived incomplete. Move closer to the board and retry."
  );
}

export class HomecoreBleClient {
  private device: WebBluetoothDevice | null = null;
  private gatt: WebBluetoothGattServer | null = null;
  private handshakeChar: WebBluetoothCharacteristic | null = null;
  private commandChar: WebBluetoothCharacteristic | null = null;
  private statusChar: WebBluetoothCharacteristic | null = null;
  private sessionKey: Uint8Array<ArrayBuffer> | null = null;
  private statusListener: ((ev: Event) => void) | null = null;
  private disconnectListener: (() => void) | null = null;
  /**
   * Payload bytes per GATT write. Web Bluetooth has no MTU API, so this starts
   * at the 20 bytes the 23-byte default allows and is raised only if the board
   * reports a larger negotiated MTU in its device info.
   */
  private writeBudget = 20;
  private noteReassembler = createBleNoteReassembler();

  public get deviceName(): string | undefined {
    return this.device?.name;
  }

  public get isConnected(): boolean {
    return Boolean(this.gatt?.connected && this.sessionKey);
  }

  public async connectAndAuthenticate(params: {
    setupPin?: string;
    candidatePins?: string[];
    setupPinForDevice?: (info: { mac_suffix?: string }) => string | undefined;
    onStage?: (stage: BleProvisioningStage) => void;
    onLog?: (msg: string) => void;
    onDisconnected?: () => void;
  } = {}): Promise<{ deviceInfo: BleDeviceInfoPayload }> {
    const { setupPin, candidatePins, setupPinForDevice, onStage, onLog, onDisconnected } = params;
    const support = isWebBluetoothSupported();
    if (!support.supported) {
      throw new BleClientError(
        support.code ?? "UNSUPPORTED",
        support.reason ?? "Web Bluetooth is unavailable."
      );
    }

    const nav = navigator as Navigator & WebBluetoothNavigator;
    onStage?.("scanning");
    onLog?.("Opening Bluetooth device chooser for HomecoreOS controllers...");

    try {
      this.device = await nav.bluetooth!.requestDevice({
        filters: [
          { services: [HOMECORE_BLE_SERVICE_UUID] },
          { namePrefix: HOMECORE_BLE_DEVICE_NAME_PREFIX },
        ],
        optionalServices: [HOMECORE_BLE_SERVICE_UUID],
      });
    } catch (err) {
      throw classifyBluetoothSelectError(err);
    }

    if (onDisconnected) {
      this.disconnectListener = onDisconnected;
      this.device.addEventListener("gattserverdisconnected", this.disconnectListener);
    }

    onStage?.("connecting");
    onLog?.(`Connecting to ${this.device.name ?? "HomecoreOS Controller"}...`);

    let deviceInfo: BleDeviceInfoPayload;
    try {
      this.gatt = await this.device.gatt!.connect();
      const service = await this.gatt.getPrimaryService(HOMECORE_BLE_SERVICE_UUID);
      const infoChar = await service.getCharacteristic(HOMECORE_BLE_CHAR_DEVICE_INFO_UUID);
      this.handshakeChar = await service.getCharacteristic(HOMECORE_BLE_CHAR_HANDSHAKE_UUID);
      this.commandChar = await service.getCharacteristic(HOMECORE_BLE_CHAR_COMMAND_UUID);
      this.statusChar = await service.getCharacteristic(HOMECORE_BLE_CHAR_STATUS_UUID);

      // The info payload is small, but reading it through the same windowed
      // path means a board that reports more capability cannot break the read.
      const rawInfo = await readFramed(infoChar, 2048);
      deviceInfo = JSON.parse(new TextDecoder().decode(rawInfo)) as BleDeviceInfoPayload;
      if (typeof deviceInfo.att_mtu === "number") {
        this.writeBudget = bleFragmentBudget(deviceInfo.att_mtu);
      }

      // Only STATUS characteristic carries BLE_GATT_CHR_F_NOTIFY (HANDSHAKE uses write+read)
      await this.statusChar.startNotifications();
    } catch (err) {
      this.disconnect();
      throw classifyGattConnectError(err);
    }

    const discoveredPin = setupPinForDevice?.(deviceInfo) ?? setupPin;
    const cleanPin =
      discoveredPin && discoveredPin.trim().length >= 6
        ? discoveredPin.trim()
        : deviceInfo.s1_mode === "auto"
          ? HOMECORE_BLE_DEFAULT_POP
          : candidatePins?.find((p) => p && p.trim().length >= 6)?.trim() ||
            HOMECORE_BLE_DEFAULT_POP;

    onStage?.("authenticating");
    onLog?.("Establishing encrypted Security 1 BLE session...");

    const kp = await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      true,
      ["deriveBits"]
    );
    const clientPub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));

    // Step 1: Write Client Hello [0x01, clientPub(65)] and read Device Hello [0x02, ...]
    // Both directions are framed: 66 bytes out and 130 bytes in do not fit a
    // 23-byte ATT MTU, which is exactly where "GATT operation failed for
    // unknown reason" used to come from.
    try {
      await writeFramed(
        this.handshakeChar,
        concatBytes(new Uint8Array([HOMECORE_BLE_HS_CLIENT_HELLO]), clientPub),
        this.writeBudget
      );
    } catch (err) {
      this.disconnect();
      throw classifyGattConnectError(err);
    }

    let srvMsg: Uint8Array<ArrayBuffer>;
    try {
      srvMsg = await readFramed(this.handshakeChar, 1024);
    } catch (err) {
      this.disconnect();
      throw classifyGattConnectError(err);
    }

    if (srvMsg[0] === HOMECORE_BLE_HS_AUTH_RESULT && srvMsg[1] === 0x02) {
      throw new BleClientError(
        "AUTH_FAILED",
        "Controller temporarily locked BLE authentication after repeated attempts. Wait 60 seconds and retry."
      );
    }
    if (srvMsg[0] !== HOMECORE_BLE_HS_DEVICE_HELLO || srvMsg.byteLength < 130) {
      throw new BleClientError(
        "AUTH_FAILED",
        "Controller returned an unexpected security handshake packet."
      );
    }

    const devPub = srvMsg.subarray(1, 66);
    const sessionNonce = srvMsg.subarray(66, 82);
    const devChallenge = srvMsg.subarray(82, 98);
    const devProof = srvMsg.subarray(98, 130);

    const importedDevPub = await crypto.subtle.importKey(
      "raw",
      toArrayBufferCopy(devPub),
      { name: "ECDH", namedCurve: "P-256" },
      false,
      []
    );
    const sharedBits = new Uint8Array(
      await crypto.subtle.deriveBits(
        { name: "ECDH", public: importedDevPub },
        kp.privateKey,
        256
      )
    );

    const sessionKey = await deriveSecurity1SessionKey(sharedBits, sessionNonce, cleanPin);
    const devProofOk = await verifyDeviceProof(
      sessionKey,
      clientPub,
      devPub,
      sessionNonce,
      devProof
    );
    if (!devProofOk) {
      throw new BleClientError(
        "AUTH_FAILED",
        "Could not verify the controller's secure BLE handshake. Ensure the controller is running compatible HomecoreOS firmware or try Wi-Fi setup."
      );
    }

    // Step 2: Write Client Proof [0x03, clientProof(32)] and read Auth Result [0x04, ok, rem]
    const clientProof = await computeClientProof(
      sessionKey,
      devPub,
      clientPub,
      devChallenge
    );
    let authResMsg: Uint8Array<ArrayBuffer>;
    try {
      await writeFramed(
        this.handshakeChar,
        concatBytes(new Uint8Array([HOMECORE_BLE_HS_CLIENT_PROOF]), clientProof),
        this.writeBudget
      );
      authResMsg = await readFramed(this.handshakeChar, 64);
    } catch (err) {
      throw classifyGattConnectError(err);
    }

    if (authResMsg[0] !== HOMECORE_BLE_HS_AUTH_RESULT) {
      throw new BleClientError(
        "AUTH_FAILED",
        "Controller returned an unexpected authentication response."
      );
    }
    const okFlag = authResMsg[1] ?? 0x00;
    const attemptsLeft = authResMsg[2] ?? 0;
    if (okFlag === 0x02 || (okFlag === 0x00 && attemptsLeft === 0)) {
      throw new BleClientError(
        "AUTH_FAILED",
        "Controller temporarily locked BLE authentication. Wait 60 seconds and retry."
      );
    }
    if (okFlag !== 0x01) {
      throw new BleClientError(
        "AUTH_FAILED",
        "Controller rejected the secure BLE handshake. Restart the controller and try again."
      );
    }

    this.sessionKey = sessionKey;
    onLog?.("Secure BLE provisioning session established.");
    return { deviceInfo };
  }

  public onStatusUpdate(
    callback: (status: BleStatusPayload) => void,
    onError?: (err: Error) => void
  ): void {
    if (!this.statusChar || !this.sessionKey) return;
    if (this.statusListener) {
      this.statusChar.removeEventListener("characteristicvaluechanged", this.statusListener);
    }
    const key = this.sessionKey;
    const reassembler = this.noteReassembler;
    reassembler.reset();
    this.statusListener = (ev: Event) => {
      const target = ev.target as unknown as WebBluetoothCharacteristic | undefined;
      if (!target?.value) return;
      // A notification carries at most ATT_MTU - 3 bytes, so a status much
      // larger than that arrives as `{0x30, index, total}` fragments which must
      // be joined *before* AES-GCM sees them.
      const joined = reassembler.push(dataViewToBytes(target.value));
      if (!joined) return;
      const bytes = joined;
      void decryptBlePayload(key, bytes)
        .then((text) => {
          const parsed = JSON.parse(text) as BleStatusPayload;
          callback(parsed);
        })
        .catch((err) => {
          onError?.(err instanceof Error ? err : new Error("Failed to read controller status."));
        });
    };
    this.statusChar.addEventListener("characteristicvaluechanged", this.statusListener);
  }

  public async readStatus(): Promise<BleStatusPayload | null> {
    if (!this.statusChar || !this.sessionKey) return null;
    const raw = await readFramed(this.statusChar, 2048);
    if (raw.byteLength < 28) return null;
    const text = await decryptBlePayload(this.sessionKey, raw);
    return JSON.parse(text) as BleStatusPayload;
  }

  public async sendEncryptedCommand(
    payload: BleCommandPayload,
    options?: { supportsWifi?: boolean }
  ): Promise<void> {
    if (!this.commandChar || !this.sessionKey || (this.gatt && !this.gatt.connected)) {
      throw new BleClientError(
        "DISCONNECTED",
        "Bluetooth connection was lost before saving configuration."
      );
    }
    const check = validateBleProvisioningInputs({
      action: payload.action,
      ssid: payload.ssid,
      password: payload.password,
      backendUrl: payload.backend_url,
      pairCode: payload.pair_code,
      supportsWifi: options?.supportsWifi,
    });
    if (!check.valid) {
      throw new Error(check.error ?? "Invalid configuration inputs.");
    }

    const encrypted = await encryptBlePayload(this.sessionKey, JSON.stringify(payload));
    // A command is 28 bytes of IV/tag plus JSON: never one ATT packet at the
    // default MTU, so every write goes through the fragmenter.
    await writeFramed(this.commandChar, encrypted, this.writeBudget);
  }

  public disconnect(): void {
    if (this.statusChar && this.statusListener) {
      try {
        this.statusChar.removeEventListener("characteristicvaluechanged", this.statusListener);
      } catch {
        // ignore
      }
      this.statusListener = null;
    }
    if (this.device && this.disconnectListener) {
      try {
        this.device.removeEventListener("gattserverdisconnected", this.disconnectListener);
      } catch {
        // ignore
      }
      this.disconnectListener = null;
    }
    try {
      if (this.gatt?.connected) {
        this.gatt.disconnect();
      }
    } catch {
      // ignore disconnect errors
    }
    this.noteReassembler.reset();
    this.writeBudget = 20;
    this.device = null;
    this.gatt = null;
    this.handshakeChar = null;
    this.commandChar = null;
    this.statusChar = null;
    if (this.sessionKey) {
      this.sessionKey.fill(0);
    }
    this.sessionKey = null;
  }
}
