import { parseRecoveryDeviceMessage } from "@homecoreos/shared";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ControllerItem } from "@/features/types";
import { UnifiedRecoveryPanel } from "./controllers/UnifiedRecoveryPanel";
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
const board = { id: "b1", name: "Hall controller", hardware_uid: "AA:BB:CC:DD:EE:12", board_model: "S3", wifi_ssid: "Home" } as ControllerItem;
const hello = { proto: 1, boardSlug: "esp32-s3-devkitc-1-n16r8", chip: "esp32s3", firmwareVersion: "1.5.0", mode: "recovery", paired: true, hasWifi: true, hasBle: true, recoverySupported: true, uidSuffix: "EE12" };
const message = parseRecoveryDeviceMessage(JSON.stringify({ hc: "status", mode: "recovery", paired: true, wifi_connected: false, ip: null, mqtt_connected: false, backend_ok: false, wifi_error: "wrong_password" }));
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
    const { unmount } = render(<UnifiedRecoveryPanel kind={kind} target={board} controllers={[board]} canManage onFlash={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: /Connect & identify/i }));
    await user.click(await screen.findByRole("checkbox", { name: /physical controller/i }));
    await user.click(screen.getByRole("button", { name: /Run diagnostics/i }));
    expect(await screen.findByText("Proposed recovery plan")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Apply plan & verify/i })).toBeInTheDocument();
    expect(transport.request).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Wi-Fi SSID")).toHaveValue("Home");
    unmount();
    await waitFor(() => expect(transport.release).toHaveBeenCalled());
  });

  it("requires explicit controller selection instead of silently choosing the first board", () => {
    render(<UnifiedRecoveryPanel kind="usb" controllers={[board]} canManage onFlash={vi.fn()} />);
    expect(screen.getByLabelText("Controller to repair")).toHaveValue("");
    expect(screen.queryByRole("button", { name: /Connect & identify/i })).not.toBeInTheDocument();
  });

  it("blocks a different physical board before diagnostics or repair", async () => {
    const release = vi.fn(async () => {});
    vi.mocked(createWifiRecoveryTransport).mockReturnValue({ kind: "wifi", connected: true, connect: async () => ({ hello: { ...hello, uidSuffix: "FFFF" }, status }), release } as unknown as ReturnType<typeof createWifiRecoveryTransport>);
    render(<UnifiedRecoveryPanel kind="wifi" controllers={[board]} target={board} canManage onFlash={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /Connect & identify/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/does not match/);
    expect(screen.queryByRole("button", { name: /Run diagnostics/i })).not.toBeInTheDocument();
    expect(release).toHaveBeenCalled();
  });
});
