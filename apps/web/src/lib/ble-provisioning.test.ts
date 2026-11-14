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
      const evt = { target: { value: toDataView(enc) } } as unknown as Event;
      for (const fn of statusListeners) fn(evt);
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

    const handshakeChar = {
      writeValueWithResponse: async (buf: BufferSource) => {
        const bytes =
          buf instanceof ArrayBuffer
            ? new Uint8Array(buf)
            : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
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
      },
      readValue: async () => toDataView(lastHsResp),
    };

    const commandChar = {
      writeValueWithResponse: async (buf: BufferSource) => {
        const bytes =
          buf instanceof ArrayBuffer
            ? new Uint8Array(buf)
            : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
        const text = await decryptBlePayload(devSessionKey!, bytes);
        receivedCommandJson = JSON.parse(text) as Record<string, unknown>;
        await emitEncryptedStatus({
          state: "paired",
          wifi_connected: true,
          paired: true,
          mqtt_connected: true,
          ip: "192.168.1.44",
        });
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
            return {
              writeValueWithResponse: async (buf: BufferSource) => {
                const bytes =
                  buf instanceof ArrayBuffer
                    ? new Uint8Array(buf)
                    : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
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
              },
              readValue: async () => toDataView(lastHsResp),
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
