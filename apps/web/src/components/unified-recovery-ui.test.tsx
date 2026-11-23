import { parseRecoveryDeviceMessage } from "@homecoreos/shared";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ControllerItem } from "@/features/types";
import { matchRecoveryBoard, UnifiedRecoveryPanel } from "./controllers/UnifiedRecoveryPanel";
import { recoveryServerApi } from "@/lib/recovery-api";
import { createBleRecoveryTransport, createUsbRecoveryTransport, createWifiRecoveryTransport } from "@/lib/recovery-transport";

vi.mock("@/lib/recovery-transport", async (original) => ({
  ...await original<typeof import("@/lib/recovery-transport")>(),
  createBleRecoveryTransport: vi.fn(), createUsbRecoveryTransport: vi.fn(), createWifiRecoveryTransport: vi.fn(),
}));
vi.mock("@/lib/ble-provisioning", () => ({ HomecoreBleClient: class {}, isWebBluetoothSupported: () => ({ supported: true }) }));
vi.mock("@/lib/recovery-api", () => ({ recoveryServerApi: {
  startSession: vi.fn(async () => { throw new Error("Worker unavailable"); }),
  abandon: vi.fn(),
} }));
const board = { id: "b1", name: "Hall controller", hardware_uid: "AA:BB:CC:DD:EE:12", board_model: "S3", wifi_ssid: "Home", ble_setup_pin: "111111" } as ControllerItem;
const hello = { proto: 1, boardSlug: "esp32-s3-devkitc-1-n16r8", chip: "esp32s3", firmwareVersion: "1.5.0", mode: "recovery", paired: true, hasWifi: true, hasBle: true, recoverySupported: true, uidSuffix: "EE12" };
const message = parseRecoveryDeviceMessage(JSON.stringify({ hc: "status", mode: "recovery", fw: "1.5.0", ota_supported: true, paired: true, wifi_connected: false, ip: null, mqtt_connected: false, backend_ok: false, wifi_error: "wrong_password" }));
if (message.kind !== "status") throw new Error("Invalid fixture");
const status = message.status;

afterEach(() => vi.clearAllMocks());

describe("unified recovery panel", () => {
  it.each(["wifi", "ble", "usb"] as const)("uses the shared engine for %s with diagnosis before commands", async (kind) => {
    Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
    Object.defineProperty(navigator, "serial", { value: { requestPort: vi.fn() }, configurable: true });
    const transport = { kind, connected: true, connect: vi.fn(async () => ({ hello, status })), readStatus: vi.fn(async () => status), request: vi.fn(), release: vi.fn(async () => {}) };
    const factory = kind === "wifi" ? createWifiRecoveryTransport : kind === "ble" ? createBleRecoveryTransport : createUsbRecoveryTransport;
    vi.mocked(factory).mockReturnValue(transport as unknown as ReturnType<typeof createUsbRecoveryTransport>);
    const user = userEvent.setup();
    const { unmount, rerender } = render(<UnifiedRecoveryPanel kind={kind} controllers={[{ ...board, id: "other", hardware_uid: "AA:BB:CC:DD:99:99", ble_setup_pin: "999999" }, board]} canManage onFlash={vi.fn()} />);
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    if (kind === "usb") expect(screen.getByTestId("usb-flash-illustration")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Discover BLE Board|Connect USB Board|Connect to Board/i }));
    expect(await screen.findByRole("button", { name: /Save & Recover/i })).toBeInTheDocument();
    expect(screen.getByText("Hall controller")).toBeInTheDocument();
    expect(recoveryServerApi.startSession).toHaveBeenCalledWith(expect.objectContaining({ boardInstanceId: board.id, transport: kind }));
    expect(transport.request).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Wi-Fi Network Name (SSID)")).toHaveValue("Home");
    if (kind === "ble") {
      const options = vi.mocked(createBleRecoveryTransport).mock.calls.at(-1)![0];
      expect(options.setupPinForDevice?.({ mac_suffix: "EE12" })).toBe("111111");
    }
    await user.type(screen.getByLabelText("Wi-Fi Password"), "Secret123");
    rerender(<UnifiedRecoveryPanel kind={kind} controllers={[{ ...board, name: "Updated name" }]} canManage onFlash={vi.fn()} />);
    expect(screen.getByLabelText("Wi-Fi Password")).toHaveValue("Secret123");
    expect(transport.release).not.toHaveBeenCalled();
    unmount();
    await waitFor(() => expect(transport.release).toHaveBeenCalled());
  });

  it("starts with the USB flash illustration, not a board selector", () => {
    render(<UnifiedRecoveryPanel kind="usb" controllers={[board]} canManage onFlash={vi.fn()} />);
    expect(screen.getByTestId("usb-flash-illustration")).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect USB Board" })).toBeInTheDocument();
  });

  it("tells the user USB repair needs no BOOT press", () => {
    // The running firmware answers over USB; only a stuck board needs a press,
    // and asking for one here sent users after the wrong problem.
    render(<UnifiedRecoveryPanel kind="usb" controllers={[board]} canManage onFlash={vi.fn()} />);
    const copy = screen.getByText(/no button press is needed/i);
    expect(copy).toBeInTheDocument();
    expect(screen.queryByText(/then hold BOOT \/ Recovery for 3 seconds/i)).not.toBeInTheDocument();
  });

  it("still asks for the physical BOOT press on BLE and Wi-Fi recovery", () => {
    for (const kind of ["ble", "wifi"] as const) {
      const { unmount } = render(
        <UnifiedRecoveryPanel kind={kind} controllers={[board]} canManage onFlash={vi.fn()} />
      );
      expect(screen.getAllByText(/3 seconds/i).length).toBeGreaterThan(0);
      unmount();
    }
  });

  it("never guesses when an identity is unknown or ambiguous", () => {
    expect(() => matchRecoveryBoard([board], "FFFF")).toThrow(/could not be matched/);
    expect(() => matchRecoveryBoard([board, { ...board, id: "b2" }], "EE12")).toThrow(/More than one/);
    expect(() => matchRecoveryBoard([board], null)).toThrow(/verifiable identity/);
    expect(matchRecoveryBoard([board, { ...board, id: "b2" }], "EE12", board).id).toBe(board.id);
  });

  it("automatically checks and verifies an already healthy board after discovery", async () => {
    const healthyMessage = parseRecoveryDeviceMessage(JSON.stringify({ hc: "status", mode: "recovery", fw: "1.5.0", ota_supported: true, paired: true, wifi_connected: true, ssid: "Home", ip: "192.168.1.2", mqtt_connected: true, backend_ok: true, backend_url: window.location.origin, heartbeat_age_sec: 5 }));
    if (healthyMessage.kind !== "status") throw new Error("Invalid fixture");
    const transport = { kind: "wifi", connected: true, connect: vi.fn(async () => ({ hello, status: healthyMessage.status })), readStatus: vi.fn(async () => healthyMessage.status), request: vi.fn(), release: vi.fn(async () => {}) };
    vi.mocked(createWifiRecoveryTransport).mockReturnValue(transport as unknown as ReturnType<typeof createWifiRecoveryTransport>);
    render(<UnifiedRecoveryPanel kind="wifi" controllers={[board]} canManage onFlash={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Connect to Board" }));
    expect(await screen.findByRole("button", { name: "Check again" })).toBeInTheDocument();
    expect(transport.readStatus).toHaveBeenCalled();
    expect(transport.request).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /Run diagnostics|Apply plan/ })).not.toBeInTheDocument();
    expect(transport.release).toHaveBeenCalled();
  });

  it("blocks a different physical board before diagnostics or repair", async () => {
    const release = vi.fn(async () => {});
    vi.mocked(createWifiRecoveryTransport).mockReturnValue({ kind: "wifi", connected: true, connect: async () => ({ hello: { ...hello, uidSuffix: "FFFF" }, status }), release } as unknown as ReturnType<typeof createWifiRecoveryTransport>);
    render(<UnifiedRecoveryPanel kind="wifi" controllers={[board]} target={board} canManage onFlash={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /Connect to Board/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/not the controller/);
    expect(screen.queryByRole("button", { name: /Run diagnostics/i })).not.toBeInTheDocument();
    expect(release).toHaveBeenCalled();
  });
});
