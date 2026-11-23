import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HOMECORE_BLE_CHAR_COMMAND_UUID,
  HOMECORE_BLE_CHAR_DEVICE_INFO_UUID,
  HOMECORE_BLE_CHAR_HANDSHAKE_UUID,
  HOMECORE_BLE_CHAR_STATUS_UUID,
  HOMECORE_BLE_DEFAULT_POP,
  HOMECORE_BLE_HS_AUTH_RESULT,
  HOMECORE_BLE_HS_CLIENT_HELLO,
  HOMECORE_BLE_HS_CLIENT_PROOF,
  HOMECORE_BLE_HS_DEVICE_HELLO,
  HOMECORE_BLE_SERVICE_UUID,
} from "@homecoreos/shared";
import {
  BleClientError,
  HomecoreBleClient,
  computeClientProof,
  computeDeviceProof,
  decryptBlePayload,
  deriveSecurity1SessionKey,
  encryptBlePayload,
  isWebBluetoothSupported,
  parseSetupSerialLine,
  verifyDeviceProof,
} from "./ble-provisioning";

function freshBytes(src: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(src.byteLength));
  out.set(src);
  return out;
}

/*
 * The simulated peripheral speaks the same GATT framing as
 * firmware/main/ble_protocol_logic.c, because that framing is what makes the
 * handshake work on a 23-byte ATT MTU. Modeling it here means the tests fail
 * if the page ever goes back to one oversized writeValue()/readValue().
 */
const FAKE_MTU_BUDGET = 20; // MTU 23 minus the 3-byte ATT header
const FAKE_READ_BUDGET = 21;

function toBytes(buf: BufferSource): Uint8Array {
  return buf instanceof ArrayBuffer
    ? new Uint8Array(buf)
    : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

/** Accumulates `[0x10][len:2][off:2]` fragments; calls `onValue` when whole. */
function makeFragmentSink(onValue: (value: Uint8Array) => Promise<void> | void) {
  let expected = 0;
  let received = 0;
  const parts: Uint8Array[] = [];
  return async (buf: BufferSource) => {
    const frame = toBytes(buf);
    if (frame[0] !== 0x10 || frame.byteLength < 5) {
      expected = 0;
      received = 0;
      parts.length = 0;
      await onValue(frame);
      return;
    }
    const total = frame[1] | (frame[2] << 8);
    const offset = frame[3] | (frame[4] << 8);
    if (offset === 0) {
      expected = total;
      received = 0;
      parts.length = 0;
    }
    expect(offset).toBe(received);
    parts.push(new Uint8Array(frame.subarray(5)));
    received += frame.byteLength - 5;
    if (received < expected) return;
    const whole = new Uint8Array(expected);
    let cursor = 0;
    for (const part of parts) {
      whole.set(part, cursor);
      cursor += part.byteLength;
    }
    expected = 0;
    received = 0;
    parts.length = 0;
    await onValue(whole);
  };
}

/** Serves a long value as `[0x20][len:2][off:2]` windows, like the firmware. */
function makeWindowedReader(getValue: () => Uint8Array) {
  let cursor = 0;
  return async () => {
    const value = getValue();
    if (value.byteLength <= FAKE_READ_BUDGET) {
      cursor = 0;
      return toDataView(value);
    }
    if (cursor >= value.byteLength) cursor = 0;
    const slice = value.subarray(
      cursor,
      Math.min(cursor + FAKE_READ_BUDGET - 5, value.byteLength)
    );
    const frame = new Uint8Array(5 + slice.byteLength);
    frame[0] = 0x20;
    frame[1] = value.byteLength & 0xff;
    frame[2] = (value.byteLength >> 8) & 0xff;
    frame[3] = cursor & 0xff;
    frame[4] = (cursor >> 8) & 0xff;
    frame.set(slice, 5);
    cursor += slice.byteLength;
    return toDataView(frame);
  };
}

/** Serves an encrypted notification as `[0x30][i][total:2]` fragments. */
function makeNotificationFragments(ciphertext: Uint8Array): Uint8Array[] {
  if (ciphertext.byteLength <= FAKE_MTU_BUDGET) return [ciphertext];
  const payload = FAKE_MTU_BUDGET - 4;
  const total = Math.ceil(ciphertext.byteLength / payload);
  const frames: Uint8Array[] = [];
  for (let i = 0; i < total; i++) {
    const slice = ciphertext.subarray(i * payload, Math.min((i + 1) * payload, ciphertext.byteLength));
    const frame = new Uint8Array(4 + slice.byteLength);
    frame[0] = 0x30;
    frame[1] = i;
    frame[2] = total & 0xff;
    frame[3] = (total >> 8) & 0xff;
    frame.set(slice, 4);
    frames.push(frame);
  }
  return frames;
}

function toDataView(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

describe("Security 1 BLE Provisioning Client & Crypto Protocol", () => {
  const originalBluetooth = (navigator as unknown as { bluetooth?: unknown }).bluetooth;

  afterEach(() => {
    Object.defineProperty(navigator, "bluetooth", {
      value: originalBluetooth,
      configurable: true,
    });
    vi.restoreAllMocks();
  });

  it("parses [HC_SETUP] banners from both NimBLE startup and WPA2 SoftAP startup", () => {
    const bleLine =
      "W (1842) hc_ble: [HC_SETUP] BOARD=esp32-s3-devkitc-1-n16r8 BLE_NAME=HomecoreOS-A1B2 POP=K7M9P2Q4 MODE=unprovisioned";
    expect(parseSetupSerialLine(bleLine)).toEqual({
      boardSlug: "esp32-s3-devkitc-1-n16r8",
      bleName: "HomecoreOS-A1B2",
      setupPin: "K7M9P2Q4",
      apSsid: undefined,
      apPass: undefined,
    });

    const apLine =
      "W (2104) hc_wifi_portal: [HC_SETUP] BOARD=esp32-s2-devkitc-1 AP_SSID=HomecoreOS-Setup-C3D4 AP_PASS=R8N4W5X9 URL=http://192.168.4.1";
    expect(parseSetupSerialLine(apLine)).toEqual({
      boardSlug: "esp32-s2-devkitc-1",
      bleName: undefined,
      setupPin: "R8N4W5X9",
      apSsid: "HomecoreOS-Setup-C3D4",
      apPass: "R8N4W5X9",
    });

    expect(parseSetupSerialLine("I (420) homecore_main: unrelated log")).toBeNull();
  });

  it("performs Security 1 ECDH P-256 + PoP key derivation, mutual HMAC proofs, and AES-256-GCM encryption", async () => {
    const clientKp = await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      true,
      ["deriveBits"]
    );
    const devKp = await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      true,
      ["deriveBits"]
    );
    const clientPub = new Uint8Array(await crypto.subtle.exportKey("raw", clientKp.publicKey));
    const devPub = new Uint8Array(await crypto.subtle.exportKey("raw", devKp.publicKey));

    const clientShared = new Uint8Array(
      await crypto.subtle.deriveBits(
        { name: "ECDH", public: devKp.publicKey },
        clientKp.privateKey,
        256
      )
    );
    const devShared = new Uint8Array(
      await crypto.subtle.deriveBits(
        { name: "ECDH", public: clientKp.publicKey },
        devKp.privateKey,
        256
      )
    );
    expect(clientShared).toEqual(devShared);

    const sessionNonce = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(16)));
    const devChallenge = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(16)));
    const setupPin = "H7K9P2M4";

    const clientKey = await deriveSecurity1SessionKey(clientShared, sessionNonce, setupPin);
    const devKey = await deriveSecurity1SessionKey(devShared, sessionNonce, setupPin);
    expect(clientKey).toEqual(devKey);

    // Device proof verified by client; wrong PIN fails immediately
    const devProof = await computeDeviceProof(devKey, clientPub, devPub, sessionNonce);
    expect(await verifyDeviceProof(clientKey, clientPub, devPub, sessionNonce, devProof)).toBe(
      true
    );

    const wrongKey = await deriveSecurity1SessionKey(clientShared, sessionNonce, "WRONGPIN");
    expect(await verifyDeviceProof(wrongKey, clientPub, devPub, sessionNonce, devProof)).toBe(
      false
    );

    // AES-256-GCM payload encryption/decryption and tampered tag rejection
    const packet = await encryptBlePayload(
      clientKey,
      JSON.stringify({ action: "provision_wifi", ssid: "MyHome24", pair_code: "482913" })
    );
    const decrypted = await decryptBlePayload(devKey, packet);
    expect(JSON.parse(decrypted)).toMatchObject({
      action: "provision_wifi",
      ssid: "MyHome24",
      pair_code: "482913",
    });

    const tampered = freshBytes(packet);
    tampered[tampered.length - 1] ^= 0xff;
    await expect(decryptBlePayload(devKey, tampered)).rejects.toThrow();

    const cliProof = await computeClientProof(clientKey, devPub, clientPub, devChallenge);
    const expectedCliProof = await computeClientProof(devKey, devPub, clientPub, devChallenge);
    expect(cliProof).toEqual(expectedCliProof);
  });

  it("executes full Web Bluetooth Security 1 GATT session end-to-end against simulated ESP32 peripheral", async () => {
    Object.defineProperty(window, "isSecureContext", {
      value: true,
      configurable: true,
    });

    const pin = "Q4W8E2R9";
    const devKp = await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      true,
      ["deriveBits"]
    );
    const devPub = new Uint8Array(await crypto.subtle.exportKey("raw", devKp.publicKey));
    const sessionNonce = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(16)));
    const devChallenge = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(16)));

    let devSessionKey: Uint8Array | null = null;
    let lastHsResp = new Uint8Array(new ArrayBuffer(0));
    let receivedCommandJson: Record<string, unknown> | null = null;
    const statusListeners: Array<(ev: Event) => void> = [];

    const toDataView = (bytes: Uint8Array) =>
      new DataView(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));

    const emitEncryptedStatus = async (payload: Record<string, unknown>) => {
      const enc = await encryptBlePayload(devSessionKey!, JSON.stringify(payload));
      // Serve it exactly as the firmware does: fragmented to the MTU budget.
      for (const frame of makeNotificationFragments(enc)) {
        const evt = { target: { value: toDataView(frame) } } as unknown as Event;
        for (const fn of statusListeners) fn(evt);
      }
    };

    const infoChar = {
      readValue: async () =>
        toDataView(
          new TextEncoder().encode(
            JSON.stringify({
              board: "esp32-s3-devkitc-1-n16r8",
              chip: "esp32s3",
              fw: "1.4.0",
              mode: "unprovisioned",
              wifi: true,
              ble_wifi: true,
              paired: false,
              mac_suffix: "A1B2",
              proto: 1,
            })
          )
        ),
    };

    const handshakeWrite = makeFragmentSink(async (bytes) => {
        if (bytes[0] === HOMECORE_BLE_HS_CLIENT_HELLO) {
          const clientPub = freshBytes(bytes.subarray(1, 66));
          const impCliPub = await crypto.subtle.importKey(
            "raw",
            clientPub,
            { name: "ECDH", namedCurve: "P-256" },
            false,
            []
          );
          const shared = new Uint8Array(
            await crypto.subtle.deriveBits(
              { name: "ECDH", public: impCliPub },
              devKp.privateKey,
              256
            )
          );
          devSessionKey = await deriveSecurity1SessionKey(shared, sessionNonce, pin);
          const devProof = await computeDeviceProof(devSessionKey, clientPub, devPub, sessionNonce);

          lastHsResp = new Uint8Array(new ArrayBuffer(1 + 65 + 16 + 16 + 32));
          lastHsResp[0] = HOMECORE_BLE_HS_DEVICE_HELLO;
          lastHsResp.set(devPub, 1);
          lastHsResp.set(sessionNonce, 66);
          lastHsResp.set(devChallenge, 82);
          lastHsResp.set(devProof, 98);
        } else if (bytes[0] === HOMECORE_BLE_HS_CLIENT_PROOF) {
          expect(bytes.subarray(1).byteLength).toBe(32);
          lastHsResp = new Uint8Array(new ArrayBuffer(3));
          lastHsResp.set([HOMECORE_BLE_HS_AUTH_RESULT, 0x01, 5]);
        }
    });

    const handshakeChar = {
      writeValueWithResponse: async (buf: BufferSource) => {
        // Each GATT write must fit one ATT packet; a bigger one is what Chrome
        // rejects with "GATT operation failed for unknown reason".
        expect(toBytes(buf).byteLength).toBeLessThanOrEqual(FAKE_MTU_BUDGET);
        await handshakeWrite(buf);
      },
      readValue: makeWindowedReader(() => lastHsResp),
    };

    const commandWrite = makeFragmentSink(async (bytes) => {
      const text = await decryptBlePayload(devSessionKey!, bytes);
      receivedCommandJson = JSON.parse(text) as Record<string, unknown>;
      await emitEncryptedStatus({
        state: "paired",
        wifi_connected: true,
        paired: true,
        mqtt_connected: true,
        ip: "192.168.1.44",
      });
    });

    const commandChar = {
      writeValueWithResponse: async (buf: BufferSource) => {
        expect(toBytes(buf).byteLength).toBeLessThanOrEqual(FAKE_MTU_BUDGET);
        await commandWrite(buf);
      },
    };

    const statusChar = {
      startNotifications: vi.fn(async () => statusChar),
      stopNotifications: vi.fn(async () => statusChar),
      addEventListener: (_type: string, fn: (ev: Event) => void) => statusListeners.push(fn),
      removeEventListener: vi.fn(),
      readValue: async () => toDataView(new Uint8Array(new ArrayBuffer(0))),
    };

    const fakeGatt = {
      connected: true,
      connect: async () => fakeGatt,
      disconnect: vi.fn(() => {
        fakeGatt.connected = false;
      }),
      getPrimaryService: async (uuid: string) => {
        expect(uuid).toBe(HOMECORE_BLE_SERVICE_UUID);
        return {
          getCharacteristic: async (charUuid: string) => {
            if (charUuid === HOMECORE_BLE_CHAR_DEVICE_INFO_UUID) return infoChar;
            if (charUuid === HOMECORE_BLE_CHAR_HANDSHAKE_UUID) return handshakeChar;
            if (charUuid === HOMECORE_BLE_CHAR_COMMAND_UUID) return commandChar;
            if (charUuid === HOMECORE_BLE_CHAR_STATUS_UUID) return statusChar;
            throw new Error(`Unexpected char ${charUuid}`);
          },
        };
      },
    };

    Object.defineProperty(navigator, "bluetooth", {
      value: {
        requestDevice: vi.fn(async () => ({
          id: "esp32-s3-ble",
          name: "HomecoreOS-A1B2",
          gatt: fakeGatt,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        })),
      },
      configurable: true,
    });

    expect(isWebBluetoothSupported().supported).toBe(true);

    const client = new HomecoreBleClient();
    const { deviceInfo } = await client.connectAndAuthenticate({ setupPin: pin });
    expect(deviceInfo.board).toBe("esp32-s3-devkitc-1-n16r8");

    const statuses: string[] = [];
    client.onStatusUpdate((st) => statuses.push(st.state));

    await client.sendEncryptedCommand({
      action: "provision_wifi",
      ssid: "Home24",
      password: "Password123",
      pair_code: "482913",
      backend_url: "https://homecore.example",
    });

    await new Promise((r) => setTimeout(r, 20));
    expect(receivedCommandJson).toMatchObject({
      action: "provision_wifi",
      ssid: "Home24",
      pair_code: "482913",
    });
    expect(statuses).toContain("paired");
    client.disconnect();
    expect(fakeGatt.disconnect).toHaveBeenCalledTimes(1);
    expect(client.isConnected).toBe(false);
  });

  it("authenticates automatically via HOMECORE-S1-POP-V1 when s1_mode is auto and maps Web Bluetooth errors cleanly", async () => {
    Object.defineProperty(window, "isSecureContext", {
      value: true,
      configurable: true,
    });

    const devKp = await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      true,
      ["deriveBits"]
    );
    const devPub = new Uint8Array(await crypto.subtle.exportKey("raw", devKp.publicKey));
    const sessionNonce = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(16)));
    const devChallenge = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(16)));

    let devSessionKey: Uint8Array | null = null;
    let lastHsResp = new Uint8Array(new ArrayBuffer(0));
    const toDataView = (bytes: Uint8Array) =>
      new DataView(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));

    const fakeGatt = {
      connected: true,
      connect: async () => fakeGatt,
      disconnect: vi.fn(() => {
        fakeGatt.connected = false;
      }),
      getPrimaryService: async () => ({
        getCharacteristic: async (charUuid: string) => {
          if (charUuid === HOMECORE_BLE_CHAR_DEVICE_INFO_UUID) {
            return {
              readValue: async () =>
                toDataView(
                  new TextEncoder().encode(
                    JSON.stringify({
                      board: "esp32-s3-devkitc-1-n16r8",
                      chip: "esp32s3",
                      fw: "1.5.0",
                      mode: "unprovisioned",
                      wifi: true,
                      ble_wifi: true,
                      paired: false,
                      mac_suffix: "99AA",
                      proto: 1,
                      s1_mode: "auto",
                    })
                  )
                ),
            };
          }
          if (charUuid === HOMECORE_BLE_CHAR_HANDSHAKE_UUID) {
            const sink = makeFragmentSink(async (bytes) => {
                if (bytes[0] === HOMECORE_BLE_HS_CLIENT_HELLO) {
                  const clientPub = freshBytes(bytes.subarray(1, 66));
                  const impCliPub = await crypto.subtle.importKey(
                    "raw",
                    clientPub,
                    { name: "ECDH", namedCurve: "P-256" },
                    false,
                    []
                  );
                  const shared = new Uint8Array(
                    await crypto.subtle.deriveBits(
                      { name: "ECDH", public: impCliPub },
                      devKp.privateKey,
                      256
                    )
                  );
                  devSessionKey = await deriveSecurity1SessionKey(
                    shared,
                    sessionNonce,
                    HOMECORE_BLE_DEFAULT_POP
                  );
                  const devProof = await computeDeviceProof(
                    devSessionKey,
                    clientPub,
                    devPub,
                    sessionNonce
                  );
                  lastHsResp = new Uint8Array(new ArrayBuffer(1 + 65 + 16 + 16 + 32));
                  lastHsResp[0] = HOMECORE_BLE_HS_DEVICE_HELLO;
                  lastHsResp.set(devPub, 1);
                  lastHsResp.set(sessionNonce, 66);
                  lastHsResp.set(devChallenge, 82);
                  lastHsResp.set(devProof, 98);
                } else if (bytes[0] === HOMECORE_BLE_HS_CLIENT_PROOF) {
                  lastHsResp = new Uint8Array(new ArrayBuffer(3));
                  lastHsResp.set([HOMECORE_BLE_HS_AUTH_RESULT, 0x01, 5]);
                }
            });
            return {
              writeValueWithResponse: async (buf: BufferSource) => {
                expect(toBytes(buf).byteLength).toBeLessThanOrEqual(FAKE_MTU_BUDGET);
                await sink(buf);
              },
              readValue: makeWindowedReader(() => lastHsResp),
            };
          }
          if (charUuid === HOMECORE_BLE_CHAR_COMMAND_UUID) {
            return { writeValueWithResponse: vi.fn() };
          }
          return {
            startNotifications: vi.fn(async () => undefined),
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
          };
        },
      }),
    };

    const reqDevice = vi.fn(async () => ({
      id: "esp32-auto",
      name: "HomecoreOS-99AA",
      gatt: fakeGatt,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    Object.defineProperty(navigator, "bluetooth", {
      value: { requestDevice: reqDevice },
      configurable: true,
    });

    // No setupPin needed at all when s1_mode === "auto"
    const client = new HomecoreBleClient();
    const { deviceInfo } = await client.connectAndAuthenticate();
    expect(deviceInfo.s1_mode).toBe("auto");
    expect(client.isConnected).toBe(true);
    expect(reqDevice).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: expect.arrayContaining([
          { services: [HOMECORE_BLE_SERVICE_UUID] },
          { namePrefix: "HomecoreOS-" },
        ]),
      })
    );
    client.disconnect();

    // Cancelled chooser -> BleClientError("CANCELLED")
    Object.defineProperty(navigator, "bluetooth", {
      value: {
        requestDevice: vi.fn(async () => {
          const err = new Error("User cancelled");
          err.name = "NotFoundError";
          throw err;
        }),
      },
      configurable: true,
    });
    await expect(new HomecoreBleClient().connectAndAuthenticate()).rejects.toMatchObject({
      name: "BleClientError",
      code: "CANCELLED",
    });

    // Permission denied -> BleClientError("PERMISSION_DENIED")
    Object.defineProperty(navigator, "bluetooth", {
      value: {
        requestDevice: vi.fn(async () => {
          const err = new Error("Permission denied");
          err.name = "NotAllowedError";
          throw err;
        }),
      },
      configurable: true,
    });
    await expect(new HomecoreBleClient().connectAndAuthenticate()).rejects.toBeInstanceOf(
      BleClientError
    );
    await expect(new HomecoreBleClient().connectAndAuthenticate()).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
  });
});

/*
 * Regression: "Bluetooth Connection Issue — GATT operation failed for unknown
 * reason" during Setup with BLE.
 *
 * The handshake used to write the 66-byte Client Hello and read the 130-byte
 * Device Hello as single GATT operations. At the default ATT MTU of 23 (what
 * Chrome on Windows and many Android builds negotiate) neither fits in one
 * ATT packet, the platform refuses the long write/read, and Chrome surfaces it
 * as that opaque message. These tests run the whole handshake against a
 * peripheral that *rejects any oversized operation exactly like the platform
 * does*, so a regression to big writes fails here instead of on a user's desk.
 */
describe("BLE GATT MTU-23 framing", () => {
  const originalBluetooth = (navigator as unknown as { bluetooth?: unknown }).bluetooth;

  afterEach(() => {
    Object.defineProperty(navigator, "bluetooth", {
      value: originalBluetooth,
      configurable: true,
    });
    vi.restoreAllMocks();
  });

  /** A peripheral that enforces a 23-byte MTU the way Web Bluetooth does. */
  async function makeStrictPeripheral(options: { mtu?: number } = {}) {
    Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
    const perWrite = (options.mtu ?? 23) - 3;

    const devKp = await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      true,
      ["deriveBits"]
    );
    const devPub = new Uint8Array(await crypto.subtle.exportKey("raw", devKp.publicKey));
    const sessionNonce = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(16)));
    const devChallenge = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(16)));

    let devSessionKey: Uint8Array | null = null;
    let hsResp = new Uint8Array(new ArrayBuffer(0));
    let hsCursor = 0;
    const notifications: Array<(ev: Event) => void> = [];
    const commandWrites: number[] = [];

    // Rejects an operation the way the platform does at this MTU.
    const enforce = (size: number, kind: "write" | "read") => {
      if (size > perWrite) {
        const err = new Error("GATT operation failed for unknown reason.");
        err.name = "NotSupportedError";
        throw err;
      }
      void kind;
    };

    const handshakeSink = makeFragmentSink(async (value) => {
      if (value[0] === HOMECORE_BLE_HS_CLIENT_HELLO) {
        const clientPub = freshBytes(value.subarray(1, 66));
        const impCliPub = await crypto.subtle.importKey(
          "raw",
          clientPub,
          { name: "ECDH", namedCurve: "P-256" },
          false,
          []
        );
        const shared = new Uint8Array(
          await crypto.subtle.deriveBits({ name: "ECDH", public: impCliPub }, devKp.privateKey, 256)
        );
        devSessionKey = await deriveSecurity1SessionKey(shared, sessionNonce, HOMECORE_BLE_DEFAULT_POP);
        const devProof = await computeDeviceProof(devSessionKey, clientPub, devPub, sessionNonce);
        hsResp = new Uint8Array(new ArrayBuffer(1 + 65 + 16 + 16 + 32));
        hsResp[0] = HOMECORE_BLE_HS_DEVICE_HELLO;
        hsResp.set(devPub, 1);
        hsResp.set(sessionNonce, 66);
        hsResp.set(devChallenge, 82);
        hsResp.set(devProof, 98);
        hsCursor = 0;
      } else if (value[0] === HOMECORE_BLE_HS_CLIENT_PROOF) {
        hsResp = new Uint8Array(new ArrayBuffer(3));
        hsResp.set([HOMECORE_BLE_HS_AUTH_RESULT, 0x01, 5]);
        hsCursor = 0;
      }
    });

    const handshakeChar = {
      writeValueWithResponse: async (buf: BufferSource) => {
        enforce(toBytes(buf).byteLength, "write");
        await handshakeSink(buf);
      },
      readValue: async () => {
        // The firmware serves a value that does not fit as `[0x20][len][off]`
        // windows, which is what makes a 130-byte Device Hello readable at all.
        const slice = hsResp.subarray(hsCursor, Math.min(hsCursor + perWrite, hsResp.byteLength));
        hsCursor += slice.byteLength;
        const frame = new Uint8Array(5 + slice.byteLength);
        frame[0] = 0x20;
        frame[1] = hsResp.byteLength & 0xff;
        frame[2] = (hsResp.byteLength >> 8) & 0xff;
        frame[3] = (hsCursor - slice.byteLength) & 0xff;
        frame[4] = ((hsCursor - slice.byteLength) >> 8) & 0xff;
        frame.set(slice, 5);
        return toDataView(frame);
      },
    };

    const commandChar = {
      writeValueWithResponse: async (buf: BufferSource) => {
        enforce(toBytes(buf).byteLength, "write");
        commandWrites.push(toBytes(buf).byteLength);
      },
    };

    const infoChar = {
      readValue: async () =>
        toDataView(
          new TextEncoder().encode(
            JSON.stringify({
              board: "esp32-s3-devkitc-1-n16r8",
              chip: "esp32s3",
              fw: "1.5.0",
              mode: "unprovisioned",
              wifi: true,
              ble_wifi: true,
              paired: false,
              mac_suffix: "7C1D",
              proto: 1,
              s1_mode: "auto",
              att_mtu: options.mtu ?? 23,
            })
          )
        ),
    };

    const statusChar = {
      startNotifications: vi.fn(async () => statusChar),
      addEventListener: (_t: string, fn: (ev: Event) => void) => notifications.push(fn),
      removeEventListener: vi.fn(),
      readValue: async () => toDataView(new Uint8Array(new ArrayBuffer(0))),
    };

    const gatt = {
      connected: true,
      connect: async () => gatt,
      disconnect: vi.fn(() => {
        gatt.connected = false;
      }),
      getPrimaryService: async () => ({
        getCharacteristic: async (uuid: string) => {
          if (uuid === HOMECORE_BLE_CHAR_DEVICE_INFO_UUID) return infoChar;
          if (uuid === HOMECORE_BLE_CHAR_HANDSHAKE_UUID) return handshakeChar;
          if (uuid === HOMECORE_BLE_CHAR_COMMAND_UUID) return commandChar;
          if (uuid === HOMECORE_BLE_CHAR_STATUS_UUID) return statusChar;
          throw new Error(`Unexpected characteristic ${uuid}`);
        },
      }),
    };

    Object.defineProperty(navigator, "bluetooth", {
      value: {
        requestDevice: vi.fn(async () => ({
          id: "strict-ble",
          name: "HomecoreOS-7C1D",
          gatt,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        })),
      },
      configurable: true,
    });

    return { notifications, commandWrites, devSessionKey: () => devSessionKey };
  }

  it("completes the Security 1 handshake at the default 23-byte MTU", async () => {
    await makeStrictPeripheral({ mtu: 23 });
    const client = new HomecoreBleClient();
    const { deviceInfo } = await client.connectAndAuthenticate();

    expect(deviceInfo.mac_suffix).toBe("7C1D");
    expect(deviceInfo.att_mtu).toBe(23);
    expect(client.isConnected).toBe(true);
    client.disconnect();
  });

  it("sends an encrypted command without ever exceeding the MTU budget", async () => {
    const peripheral = await makeStrictPeripheral({ mtu: 23 });
    const client = new HomecoreBleClient();
    await client.connectAndAuthenticate();

    await client.sendEncryptedCommand({
      action: "provision_wifi",
      ssid: "Home 24G",
      password: "correct horse battery",
      pair_code: "482913",
      backend_url: "https://homecore.example",
    });

    expect(peripheral.commandWrites.length).toBeGreaterThan(1);
    for (const size of peripheral.commandWrites) {
      expect(size).toBeLessThanOrEqual(20);
    }
    client.disconnect();
  });

  it("joins fragmented status notifications before decrypting them", async () => {
    const peripheral = await makeStrictPeripheral({ mtu: 23 });
    const client = new HomecoreBleClient();
    await client.connectAndAuthenticate();

    // A status far larger than one notification: the firmware fragments it.
    const payload = {
      state: "wifi_connected" as const,
      wifi_connected: true,
      paired: true,
      mqtt_connected: false,
      ip: "192.168.1.44",
      partition: "ota_0",
      board: "esp32-s3-devkitc-1-n16r8",
      chip: "esp32s3",
      fw: "1.5.0",
      backend_url: "https://homecoreos.example.com",
      error: "x".repeat(180),
    };
    const seen: string[] = [];
    client.onStatusUpdate((status) => seen.push(status.state));

    // Encrypt with the device-side copy of the session key, then fragment it the
    // way the firmware does for a notification that exceeds the MTU.
    const frames = makeNotificationFragments(
      await encryptBlePayload(peripheral.devSessionKey()!, JSON.stringify(payload))
    );
    expect(frames.length).toBeGreaterThan(1);
    for (const frame of frames) {
      const evt = { target: { value: toDataView(frame) } } as unknown as Event;
      for (const fn of peripheral.notifications) fn(evt);
    }

    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(seen).toEqual(["wifi_connected"]);
    client.disconnect();
  });

  it("classifies a refused GATT operation instead of leaking Chrome's message", async () => {
    Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
    const gatt = {
      connected: true,
      connect: async () => gatt,
      disconnect: vi.fn(),
      getPrimaryService: async () => ({
        getCharacteristic: async (uuid: string) => {
          if (uuid === HOMECORE_BLE_CHAR_DEVICE_INFO_UUID) {
            return {
              readValue: async () =>
                toDataView(
                  new TextEncoder().encode(
                    JSON.stringify({
                      chip: "esp32s3",
                      fw: "1.5.0",
                      mode: "unprovisioned",
                      wifi: true,
                      ble_wifi: true,
                      paired: false,
                      mac_suffix: "7C1D",
                      proto: 1,
                    })
                  )
                ),
            };
          }
          if (uuid === HOMECORE_BLE_CHAR_HANDSHAKE_UUID) {
            return {
              writeValueWithResponse: async () => {
                const err = new Error("GATT operation failed for unknown reason.");
                err.name = "NotSupportedError";
                throw err;
              },
              readValue: async () => toDataView(new Uint8Array(new ArrayBuffer(0))),
            };
          }
          return {
            startNotifications: vi.fn(async () => undefined),
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
          };
        },
      }),
    };
    Object.defineProperty(navigator, "bluetooth", {
      value: {
        requestDevice: vi.fn(async () => ({
          id: "refusing",
          name: "HomecoreOS-7C1D",
          gatt,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        })),
      },
      configurable: true,
    });

    await expect(new HomecoreBleClient().connectAndAuthenticate()).rejects.toMatchObject({
      name: "BleClientError",
      code: "GATT_FAILED",
    });
    // The raw platform string never reaches the operator.
    await expect(new HomecoreBleClient().connectAndAuthenticate()).rejects.not.toThrow(
      /GATT operation failed for unknown reason/
    );
  });
});
