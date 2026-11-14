import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BleStatusPayload } from "@homecoreos/shared";
import { BleClientError, HomecoreBleClient } from "../lib/ble-provisioning";
import { TimezoneContext } from "../lib/timezone";
import { BleProvisioningModal, BleProvisioningPanel } from "./controllers/BleProvisioningModal";
import { ControllerSetupModal } from "./controllers/ControllerSetupModal";
import { ControllersPage } from "../features/user/ControllersPage";
import type { BoardProfileItem, ControllerItem, HomeItem } from "../features/types";

const originalFetch = globalThis.fetch;
const originalBluetooth = (navigator as unknown as { bluetooth?: unknown }).bluetooth;
const originalSecureContext = window.isSecureContext;

const sampleCatalogBoards: BoardProfileItem[] = [
  {
    id: "board-s3",
    slug: "esp32-s3-devkitc-1-n16r8",
    manufacturer: "Espressif",
    model: "ESP32-S3-DevKitC-1-N16R8",
    revision: "1.0",
    chip_family: "esp32s3",
    chip_variant: "ESP32-S3",
    flash_size_mb: 16,
    psram_size_mb: 8,
    supports_wifi: true,
    supports_ble: true,
    supports_ble_wifi_provisioning: true,
    boot_button_gpio: 0,
    usb_interface: "USB-OTG + UART",
    gpio_definitions: [],
  },
  {
    id: "board-h2",
    slug: "esp32-h2-devkitm-1",
    manufacturer: "Espressif",
    model: "ESP32-H2-DevKitM-1",
    revision: "1.0",
    chip_family: "esp32h2",
    chip_variant: "ESP32-H2",
    flash_size_mb: 4,
    psram_size_mb: 0,
    supports_wifi: false,
    supports_ble: true,
    supports_ble_wifi_provisioning: false,
    boot_button_gpio: 9,
    usb_interface: "USB-Serial-JTAG",
    gpio_definitions: [],
  },
];

const sampleHomes: HomeItem[] = [
  { id: "home-1", account_id: "acct-1", name: "Main Home", timezone: "UTC" },
];

function makeController(overrides: Partial<ControllerItem> = {}): ControllerItem {
  return {
    id: "ctrl-ble-1",
    account_id: "acct-1",
    home_id: "home-1",
    board_catalog_id: "board-s3",
    custom_board_id: null,
    name: "Studio S3 Hub",
    board_model: "ESP32-S3-DevKitC-1-N16R8",
    chip_variant: "ESP32-S3",
    hardware_uid: "11:22:33:44:55:66",
    flash_size_mb: 16,
    psram_size_mb: 8,
    status: "offline",
    pairing_status: "paired",
    wifi_connected: false,
    mqtt_connected: false,
    wifi_rssi: null,
    wifi_ssid: "Studio24G",
    local_ip: null,
    firmware_version: "1.5.0",
    paired_at: "2026-11-10T00:00:00.000Z",
    last_heartbeat_at: null,
    last_communication_at: null,
    deleted_at: null,
    connection_history: [],
    ble_setup_pin: "Z9X8C7V6",
    provisioning_transport: "ble",
    board_compat: {
      slug: "esp32-s3-devkitc-1-n16r8",
      model: "ESP32-S3-DevKitC-1-N16R8",
      chip_family: "esp32s3",
      partition_scheme: "dual_ota_16mb",
      boot_button_gpio: 0,
      usb_interface: "USB-OTG + UART",
      supports_wifi: true,
      supports_ble: true,
      supports_ble_wifi_provisioning: true,
      connectivity_note: null,
    },
    ...overrides,
  };
}

describe("Simplified 4-Option Controller Setup & BLE Provisioning UI", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    Object.defineProperty(navigator, "bluetooth", {
      value: originalBluetooth,
      configurable: true,
    });
    Object.defineProperty(window, "isSecureContext", {
      value: originalSecureContext,
      configurable: true,
    });
    vi.restoreAllMocks();
  });

  it("renders simplified ESP32-S2 Wi-Fi fallback & hides Setup PIN / Wi-Fi on ESP32-H2 in BleProvisioningPanel", () => {
    const { rerender } = render(
      <BleProvisioningPanel
        controllerName="Hallway S2"
        supportsWifi={true}
        supportsBle={false}
        bootButtonGpio={0}
      />
    );

    expect(screen.getByText(/Bluetooth Not Available on This Board/i)).toBeInTheDocument();
    expect(screen.getByText(/HomecoreOS-Setup-XXXX/i)).toBeInTheDocument();
    expect(screen.getByText(/http:\/\/192\.168\.4\.1/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/BLE Setup PIN/i)).not.toBeInTheDocument();

    Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
    Object.defineProperty(navigator, "bluetooth", { value: undefined, configurable: true });

    rerender(
      <BleProvisioningModal
        open={true}
        onClose={() => {}}
        controllerName="Living Room S3"
        supportsWifi={true}
        supportsBle={true}
        bootButtonGpio={0}
      />
    );
    expect(screen.getByText(/Bluetooth Unavailable in This Browser/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Discover BLE Controller/i })).toBeDisabled();
    expect(screen.queryByLabelText(/BLE Setup PIN/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Pairing Code/i)).not.toBeInTheDocument();

    rerender(
      <BleProvisioningModal
        open={true}
        onClose={() => {}}
        controllerName="Thread Hub H2"
        supportsWifi={false}
        supportsBle={true}
        bootButtonGpio={9}
      />
    );
    expect(screen.getByText(/No Wi-Fi Radio on This Board/i)).toBeInTheDocument();
  });

  it("shows exactly 4 clear setup/recovery entry options with zero Setup PINs, codes, or forms", () => {
    render(
      <ControllerSetupModal
        open={true}
        onClose={() => {}}
        controllers={[]}
        homes={sampleHomes}
        catalogBoards={sampleCatalogBoards}
        customBoards={[]}
      />
    );

    expect(screen.getByText(/New Controller Setup/i)).toBeInTheDocument();
    expect(screen.getByText(/Controller Recovery/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Setup with BLE/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Setup with Wi-Fi/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Recover with BLE/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Recover with Wi-Fi/i })).toBeInTheDocument();

    expect(screen.queryByLabelText(/Setup PIN/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Pairing Code/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/AES-256-GCM/i)).not.toBeInTheDocument();
  });

  it("completes Setup with BLE across Screen A -> Screen B (SSID & Password only) -> Screen C 6-step progress and MQTT verification", async () => {
    const user = userEvent.setup();
    Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
    Object.defineProperty(navigator, "bluetooth", {
      value: { requestDevice: vi.fn() },
      configurable: true,
    });

    let statusCb: ((st: BleStatusPayload) => void) | null = null;
    let connected = false;

    vi.spyOn(HomecoreBleClient.prototype, "deviceName", "get").mockImplementation(
      () => "HomecoreOS-A1B2"
    );
    vi.spyOn(HomecoreBleClient.prototype, "isConnected", "get").mockImplementation(
      () => connected
    );
    vi.spyOn(HomecoreBleClient.prototype, "connectAndAuthenticate").mockImplementation(
      async () => {
        connected = true;
        return {
          deviceInfo: {
            board: "esp32-s3-devkitc-1-n16r8",
            chip: "esp32s3",
            fw: "1.5.0",
            mode: "unprovisioned",
            wifi: true,
            ble_wifi: true,
            paired: false,
            mac_suffix: "A1B2",
            proto: 1,
            s1_mode: "auto",
          },
        };
      }
    );
    vi.spyOn(HomecoreBleClient.prototype, "onStatusUpdate").mockImplementation((cb) => {
      statusCb = cb;
    });
    const sendCmdSpy = vi
      .spyOn(HomecoreBleClient.prototype, "sendEncryptedCommand")
      .mockImplementation(async () => {
        queueMicrotask(() => {
          statusCb?.({
            state: "connecting_wifi",
            wifi_connected: false,
            paired: false,
            mqtt_connected: false,
          });
          statusCb?.({
            state: "pairing",
            wifi_connected: true,
            paired: false,
            mqtt_connected: false,
            ip: "192.168.1.44",
          });
          statusCb?.({
            state: "paired",
            wifi_connected: true,
            paired: true,
            mqtt_connected: true,
            ip: "192.168.1.44",
          });
        });
      });
    vi.spyOn(HomecoreBleClient.prototype, "disconnect").mockImplementation(() => {
      connected = false;
    });

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/controllers" && init?.method === "POST") {
        return new Response(
          JSON.stringify({
            controller: makeController({
              id: "ctrl-new-1",
              status: "pending",
              pairing_status: "pending",
              mqtt_connected: false,
            }),
            pairingCode: "778899",
          }),
          { status: 201, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url === "/api/controllers/ctrl-new-1") {
        return new Response(
          JSON.stringify({
            controller: makeController({
              id: "ctrl-new-1",
              status: "online",
              pairing_status: "paired",
              wifi_connected: true,
              mqtt_connected: true,
            }),
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof fetch;

    const onSuccess = vi.fn();
    render(
      <ControllerSetupModal
        open={true}
        onClose={() => {}}
        controllers={[]}
        homes={sampleHomes}
        catalogBoards={sampleCatalogBoards}
        customBoards={[]}
        onSuccess={onSuccess}
      />
    );

    // Entry -> Setup with BLE (Screen A)
    await user.click(screen.getByRole("button", { name: /Setup with BLE/i }));
    expect(screen.getByText(/Discover HomecoreOS Controller/i)).toBeInTheDocument();
    expect(
      screen.getByText(/Turn on your HomecoreOS controller and keep it nearby/i)
    ).toBeInTheDocument();

    // Screen A -> Screen B
    await user.click(screen.getByRole("button", { name: /Discover BLE Controller/i }));
    await waitFor(() => {
      expect(screen.getByText("HomecoreOS-A1B2")).toBeInTheDocument();
    });

    // Screen B asks ONLY for Wi-Fi Network Name (SSID) and Wi-Fi Password
    const ssidInput = screen.getByLabelText(/Wi-Fi Network Name \(SSID\)/i);
    const passInput = screen.getByLabelText("Wi-Fi Password");
    expect(screen.queryByLabelText(/Setup PIN/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Pairing Code/i)).not.toBeInTheDocument();

    await user.type(ssidInput, "HomeNet24");
    await user.type(passInput, "SecretPass123");
    await user.click(screen.getByRole("button", { name: /Save & Connect/i }));

    // Screen C -> 6 clear progress steps & ready confirmation
    await waitFor(() => {
      expect(screen.getAllByText(/Your controller is ready!/i).length).toBeGreaterThan(0);
    });
    expect(screen.getByText(/1\. Securely connecting to controller/i)).toBeInTheDocument();
    expect(screen.getByText(/6\. Verifying controller connection/i)).toBeInTheDocument();

    expect(sendCmdSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "provision_wifi",
        ssid: "HomeNet24",
        password: "SecretPass123",
        pair_code: "778899",
      }),
      { supportsWifi: true }
    );
    expect(onSuccess).toHaveBeenCalledWith("HomecoreOS-A1B2 is connected and ready.");
  });

  it("escalates Recover with BLE from Case A (wifi_only) to Case B (recover) when MQTT fails after Wi-Fi connects", async () => {
    const user = userEvent.setup();
    Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
    Object.defineProperty(navigator, "bluetooth", {
      value: { requestDevice: vi.fn() },
      configurable: true,
    });

    const existingCtrl = makeController({
      id: "ctrl-rec-1",
      name: "Hallway S3",
      hardware_uid: "AA:BB:CC:DD:55:66",
      pairing_status: "paired",
      paired_at: "2026-11-01T00:00:00.000Z",
      wifi_ssid: "OldWiFi",
    });

    let statusCb: ((st: BleStatusPayload) => void) | null = null;
    let connected = false;
    const actionsSent: string[] = [];

    vi.spyOn(HomecoreBleClient.prototype, "deviceName", "get").mockImplementation(
      () => "HomecoreOS-5566"
    );
    vi.spyOn(HomecoreBleClient.prototype, "isConnected", "get").mockImplementation(
      () => connected
    );
    vi.spyOn(HomecoreBleClient.prototype, "connectAndAuthenticate").mockImplementation(
      async () => {
        connected = true;
        return {
          deviceInfo: {
            board: "esp32-s3-devkitc-1-n16r8",
            chip: "esp32s3",
            fw: "1.5.0",
            mode: "recovery",
            wifi: true,
            ble_wifi: true,
            paired: true,
            mac_suffix: "5566",
            proto: 1,
            s1_mode: "auto",
          },
        };
      }
    );
    vi.spyOn(HomecoreBleClient.prototype, "onStatusUpdate").mockImplementation((cb) => {
      statusCb = cb;
    });
    vi.spyOn(HomecoreBleClient.prototype, "sendEncryptedCommand").mockImplementation(
      async (cmd) => {
        actionsSent.push(cmd.action);
        queueMicrotask(() => {
          if (cmd.action === "wifi_only") {
            // Wi-Fi succeeds, but MQTT credentials were revoked -> emits error with wifi_connected: true
            statusCb?.({
              state: "wifi_connected",
              wifi_connected: true,
              paired: true,
              mqtt_connected: false,
              ip: "192.168.1.90",
            });
            statusCb?.({
              state: "error",
              wifi_connected: true,
              paired: true,
              mqtt_connected: false,
              ip: "192.168.1.90",
              error: "MQTT authentication or broker connection failed",
            });
          } else if (cmd.action === "recover") {
            statusCb?.({
              state: "pairing",
              wifi_connected: true,
              paired: false,
              mqtt_connected: false,
              ip: "192.168.1.90",
            });
            statusCb?.({
              state: "paired",
              wifi_connected: true,
              paired: true,
              mqtt_connected: true,
              ip: "192.168.1.90",
            });
          }
        });
      }
    );
    vi.spyOn(HomecoreBleClient.prototype, "disconnect").mockImplementation(() => {
      connected = false;
    });

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/controllers/recover" && init?.method === "POST") {
        return new Response(
          JSON.stringify({ controller: existingCtrl, pairingCode: "334455" }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url === "/api/controllers/ctrl-rec-1") {
        return new Response(
          JSON.stringify({
            controller: makeController({
              id: "ctrl-rec-1",
              status: "online",
              pairing_status: "paired",
              mqtt_connected: true,
            }),
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    render(
      <ControllerSetupModal
        open={true}
        initialView="recover_ble"
        targetController={existingCtrl}
        onClose={() => {}}
        controllers={[existingCtrl]}
        homes={sampleHomes}
        catalogBoards={sampleCatalogBoards}
        customBoards={[]}
      />
    );

    expect(screen.getByText(/Prepare Controller for Recovery/i)).toBeInTheDocument();
    expect(
      screen.getByText(/Hold the BOOT \/ Recovery button on your controller for 3 seconds/i)
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Discover BLE Controller/i }));
    await waitFor(() => {
      expect(screen.getByLabelText(/Wi-Fi Network Name \(SSID\)/i)).toHaveValue("OldWiFi");
    });

    await user.clear(screen.getByLabelText(/Wi-Fi Network Name \(SSID\)/i));
    await user.type(screen.getByLabelText(/Wi-Fi Network Name \(SSID\)/i), "NewHomeWiFi");
    await user.type(screen.getByLabelText("Wi-Fi Password"), "NewPass999");
    await user.click(screen.getByRole("button", { name: /Save & Recover/i }));

    await waitFor(() => {
      expect(screen.getAllByText(/Your controller is ready!/i).length).toBeGreaterThan(0);
    });

    expect(actionsSent).toEqual(["wifi_only", "recover"]);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/controllers/recover",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("handles ESP32-H2 rejection, Web Bluetooth permission fallback, MQTT failure at Step 5, and Wi-Fi portal setup", async () => {
    const user = userEvent.setup();
    Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
    Object.defineProperty(navigator, "bluetooth", {
      value: { requestDevice: vi.fn() },
      configurable: true,
    });

    // 1) ESP32-H2 rejection on Screen A
    const authSpy = vi
      .spyOn(HomecoreBleClient.prototype, "connectAndAuthenticate")
      .mockResolvedValueOnce({
        deviceInfo: {
          board: "esp32-h2-devkitm-1",
          chip: "esp32h2",
          fw: "1.5.0",
          mode: "unprovisioned",
          wifi: false,
          ble_wifi: false,
          paired: false,
          mac_suffix: "H200",
          proto: 1,
          s1_mode: "auto",
        },
      });

    render(
      <ControllerSetupModal
        open={true}
        initialView="setup_ble"
        onClose={() => {}}
        controllers={[]}
        homes={sampleHomes}
        catalogBoards={sampleCatalogBoards}
        customBoards={[]}
      />
    );

    await user.click(screen.getByRole("button", { name: /Discover BLE Controller/i }));
    await waitFor(() => {
      expect(
        screen.getByText(/ESP32-H2 board has no integrated Wi-Fi radio/i)
      ).toBeInTheDocument();
    });

    // 2) Permission denied -> offers "Setup with Wi-Fi" fallback button
    authSpy.mockRejectedValueOnce(
      new BleClientError(
        "PERMISSION_DENIED",
        "Bluetooth permission was denied. Allow Bluetooth access in your browser or switch to Wi-Fi setup."
      )
    );
    await user.click(screen.getByRole("button", { name: /Discover BLE Controller/i }));
    await waitFor(() => {
      expect(screen.getByText(/Bluetooth permission was denied/i)).toBeInTheDocument();
    });

    // Switch to Setup with Wi-Fi fallback cleanly and generate 6-digit pairing code
    await user.click(screen.getByRole("button", { name: /Setup with Wi-Fi/i }));
    expect(screen.getAllByText(/HomecoreOS-Setup-XXXX/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/http:\/\/192\.168\.4\.1/i)).toBeInTheDocument();
    expect(screen.queryByText(/Setup PIN/i)).not.toBeInTheDocument();

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/controllers" && init?.method === "POST") {
        return new Response(
          JSON.stringify({ controller: makeController({ id: "ctrl-wifi-1" }), pairingCode: "908070" }),
          { status: 201, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url === "/api/controllers/ctrl-wifi-1") {
        return new Response(
          JSON.stringify({
            controller: makeController({
              id: "ctrl-wifi-1",
              status: "online",
              pairing_status: "paired",
              mqtt_connected: true,
            }),
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof fetch;

    await user.type(screen.getByLabelText(/Controller Name/i), "Porch Sensor Hub");
    await user.click(screen.getByRole("button", { name: /Get 6-Digit Pairing Code/i }));
    await waitFor(() => {
      expect(screen.getByText("908070")).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByText(/Your controller is ready!/i)).toBeInTheDocument();
    });
  });

  it("handles unexpected BLE disconnect by clearing Wi-Fi password and offering reconnect", async () => {
    const user = userEvent.setup();
    Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
    Object.defineProperty(navigator, "bluetooth", {
      value: { requestDevice: vi.fn() },
      configurable: true,
    });

    let disconnectHandler: (() => void) | undefined;
    let connected = false;

    vi.spyOn(HomecoreBleClient.prototype, "isConnected", "get").mockImplementation(
      () => connected
    );
    vi.spyOn(HomecoreBleClient.prototype, "connectAndAuthenticate").mockImplementation(
      async (opts) => {
        disconnectHandler = opts?.onDisconnected;
        connected = true;
        return {
          deviceInfo: {
            board: "esp32-s3-devkitc-1-n16r8",
            chip: "esp32s3",
            fw: "1.5.0",
            mode: "unprovisioned",
            wifi: true,
            ble_wifi: true,
            paired: false,
            mac_suffix: "D1D1",
            proto: 1,
            s1_mode: "auto",
          },
        };
      }
    );
    vi.spyOn(HomecoreBleClient.prototype, "onStatusUpdate").mockImplementation(() => {});
    vi.spyOn(HomecoreBleClient.prototype, "sendEncryptedCommand").mockImplementation(
      async () => {
        connected = false;
        queueMicrotask(() => disconnectHandler?.());
      }
    );
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/controllers") {
        return new Response(
          JSON.stringify({ controller: makeController({ id: "ctrl-disc-1" }), pairingCode: "119988" }),
          { status: 201, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof fetch;

    render(
      <ControllerSetupModal
        open={true}
        initialView="setup_ble"
        onClose={() => {}}
        controllers={[]}
        homes={sampleHomes}
        catalogBoards={sampleCatalogBoards}
        customBoards={[]}
      />
    );

    await user.click(screen.getByRole("button", { name: /Discover BLE Controller/i }));
    await waitFor(() => {
      expect(screen.getByLabelText(/Wi-Fi Network Name \(SSID\)/i)).toBeInTheDocument();
    });
    await user.type(screen.getByLabelText(/Wi-Fi Network Name \(SSID\)/i), "DropNet");
    await user.type(screen.getByLabelText("Wi-Fi Password"), "TempSecret");
    await user.click(screen.getByRole("button", { name: /Save & Connect/i }));

    await waitFor(() => {
      expect(
        screen.getByText(/Bluetooth connection dropped during configuration/i)
      ).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: /Reconnect via Bluetooth/i })).toBeInTheDocument();

    // Returning to Screen A and reconnecting should NOT retain the wiped password
    await user.click(screen.getByRole("button", { name: /Reconnect via Bluetooth/i }));
    await user.click(screen.getByRole("button", { name: /Discover BLE Controller/i }));
    await waitFor(() => {
      expect(screen.getByLabelText("Wi-Fi Password")).toHaveValue("");
    });
  });

  it("shows Step 5 MQTT error cleanly and allows editing Wi-Fi to retry when BLE stays open", async () => {
    const user = userEvent.setup();
    Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
    Object.defineProperty(navigator, "bluetooth", {
      value: { requestDevice: vi.fn() },
      configurable: true,
    });

    let statusCb: ((st: BleStatusPayload) => void) | null = null;
    let connected = false;

    vi.spyOn(HomecoreBleClient.prototype, "isConnected", "get").mockImplementation(
      () => connected
    );
    vi.spyOn(HomecoreBleClient.prototype, "connectAndAuthenticate").mockImplementation(
      async () => {
        connected = true;
        return {
          deviceInfo: {
            board: "esp32-s3-devkitc-1-n16r8",
            chip: "esp32s3",
            fw: "1.5.0",
            mode: "unprovisioned",
            wifi: true,
            ble_wifi: true,
            paired: false,
            mac_suffix: "E5E5",
            proto: 1,
            s1_mode: "auto",
          },
        };
      }
    );
    vi.spyOn(HomecoreBleClient.prototype, "onStatusUpdate").mockImplementation((cb) => {
      statusCb = cb;
    });
    vi.spyOn(HomecoreBleClient.prototype, "sendEncryptedCommand").mockImplementation(
      async () => {
        queueMicrotask(() => {
          statusCb?.({
            state: "error",
            wifi_connected: true,
            paired: true,
            mqtt_connected: false,
            error: "MQTT authentication or broker connection failed",
          });
        });
      }
    );

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/controllers") {
        return new Response(
          JSON.stringify({ controller: makeController({ id: "ctrl-err-1" }), pairingCode: "112233" }),
          { status: 201, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof fetch;

    render(
      <ControllerSetupModal
        open={true}
        initialView="setup_ble"
        onClose={() => {}}
        controllers={[]}
        homes={sampleHomes}
        catalogBoards={sampleCatalogBoards}
        customBoards={[]}
      />
    );

    await user.click(screen.getByRole("button", { name: /Discover BLE Controller/i }));
    await waitFor(() => {
      expect(screen.getByLabelText(/Wi-Fi Network Name \(SSID\)/i)).toBeInTheDocument();
    });
    await user.type(screen.getByLabelText(/Wi-Fi Network Name \(SSID\)/i), "HomeWiFi");
    await user.type(screen.getByLabelText("Wi-Fi Password"), "Pass1234");
    await user.click(screen.getByRole("button", { name: /Save & Connect/i }));

    await waitFor(() => {
      expect(
        screen.getByText(/MQTT authentication or broker connection failed/i)
      ).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: /Edit Wi-Fi & Retry/i })).toBeInTheDocument();
  });

  it("opens ControllerSetupModal directly from ControllersPage Details modal without showing Setup PIN", async () => {
    const user = userEvent.setup();
    Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
    Object.defineProperty(navigator, "bluetooth", {
      value: { requestDevice: vi.fn() },
      configurable: true,
    });

    const mockControllers = [makeController()];

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/homes")) {
        return new Response(JSON.stringify({ homes: sampleHomes }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/api/controllers/trash")) {
        return new Response(JSON.stringify({ controllers: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/api/controllers")) {
        return new Response(JSON.stringify({ controllers: mockControllers }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/api/boards/catalog")) {
        return new Response(JSON.stringify({ boards: sampleCatalogBoards }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/api/boards/custom")) {
        return new Response(JSON.stringify({ boards: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof fetch;

    render(
      <TimezoneContext.Provider value="UTC">
        <ControllersPage canManage={true} canOperate={true} onNavigate={() => {}} />
      </TimezoneContext.Provider>
    );

    await waitFor(() => {
      expect(screen.getByText("Studio S3 Hub")).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /Details/i }));
    await waitFor(() => {
      expect(screen.getAllByText("11:22:33:44:55:66").length).toBeGreaterThan(1);
    });
    expect(screen.queryByText(/BLE \/ Setup AP PIN/i)).not.toBeInTheDocument();
    expect(screen.queryByText("Z9X8C7V6")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Recover with BLE/i }));
    await waitFor(() => {
      expect(screen.getByText(/Prepare Controller for Recovery/i)).toBeInTheDocument();
    });
    expect(
      screen.getByRole("button", { name: /Discover BLE Controller/i })
    ).toBeEnabled();
  });
});
