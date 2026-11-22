import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ControllerItem } from "@/features/types";
import { WifiSetupFlow } from "./WifiSetupFlow";
import { WifiRecoveryFlow } from "./WifiRecoveryFlow";

const originalFetch = globalThis.fetch;

const boardOptions = [
  { id: "catalog:board-s3", board: { id: "board-s3", model: "ESP32-S3-DevKitC-1", supports_wifi: true }, label: "ESP32-S3" },
  { id: "catalog:board-h2", board: { id: "board-h2", model: "ESP32-H2-DevKitM-1", supports_wifi: false }, label: "ESP32-H2" },
];

function makeController(overrides: Partial<ControllerItem> = {}): ControllerItem {
  return {
    id: "ctrl-1",
    account_id: "acct-1",
    home_id: "home-1",
    board_profile_id: "board-s3",
    custom_board_profile_id: null,
    name: "Hall Controller",
    board_model: "ESP32-S3-DevKitC-1",
    chip_variant: "ESP32-S3",
    hardware_uid: "11:22:33:44:EE:12",
    flash_size_mb: 16,
    psram_size_mb: 8,
    status: "offline",
    pairing_status: "paired",
    wifi_connected: false,
    mqtt_connected: false,
    wifi_rssi: null,
    wifi_ssid: "Home24G",
    firmware_version: "1.5.0",
    paired_at: "2026-11-01T00:00:00.000Z",
    last_heartbeat_at: null,
    last_communication_at: null,
    deleted_at: null,
    connection_history: [],
    ble_setup_pin: "ABCDEFGH",
    provisioning_transport: "softap",
    ...overrides,
  } as ControllerItem;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("Setup with Wi-Fi panel", () => {
  it("explains the local page, offers the site URL to copy, and generates a pairing code", async () => {
    const user = userEvent.setup();
    const calls: Array<{ url: string; body?: unknown }> = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url === "/api/board-instances" && init?.method === "POST") {
        return json({ controller: makeController({ id: "ctrl-new", status: "pending", pairing_status: "pending" }), pairingCode: "135790" }, 201);
      }
      if (url === "/api/board-instances/pairing-status") {
        return json({ controller: makeController({ id: "ctrl-new", pairing_status: "paired", mqtt_connected: true }) });
      }
      return json({});
    }) as typeof fetch;

    const onSuccess = vi.fn();
    render(
      <WifiSetupFlow
        boardOptions={boardOptions}
        selectedBoardChoice="catalog:board-s3"
        onBoardChoiceChange={() => {}}
        boardName="Porch Hub"
        onBoardNameChange={() => {}}
        homes={[]}
        websiteUrl="https://homecore.local"
        canManage
        onSuccess={onSuccess}
        onClose={vi.fn()}
      />
    );

    // The temporary network and this site's URL are shown before anything is
    // created, so the operator can prepare the phone or laptop first.
    expect(screen.getAllByText(/HomecoreOS-Setup-XXXX/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/192\.168\.4\.1/).length).toBeGreaterThan(0);
    expect(screen.getByText("https://homecore.local")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Generate Pairing Code/i }));

    await waitFor(() => expect(screen.getByText("135790")).toBeInTheDocument());
    // The checklist then spells out every field the local page asks for.
    expect(screen.getByText(/On the board’s local page:/)).toBeInTheDocument();
    expect(screen.getAllByText("Wi-Fi SSID").length).toBeGreaterThan(0);
    expect(screen.getByText("Wi-Fi Password")).toBeInTheDocument();
    expect(screen.getByText("Website URL")).toBeInTheDocument();
    expect(screen.getByText("Pairing code")).toBeInTheDocument();
    expect(screen.getAllByText(/Save and Restart/).length).toBeGreaterThan(0);
    expect(screen.getByText(/this HomecoreOS address/)).toBeInTheDocument();

    expect(calls[0]).toEqual({
      url: "/api/board-instances",
      body: { name: "Porch Hub", boardProfileId: "board-s3" },
    });
    // Nothing is claimed until the board itself reports back.
    expect(await screen.findByText(/Your board is ready!/i)).toBeInTheDocument();
  });

  it("never creates a record for a board model that has no Wi-Fi radio", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    render(
      <WifiSetupFlow
        boardOptions={boardOptions}
        selectedBoardChoice="catalog:board-h2"
        onBoardChoiceChange={() => {}}
        boardName="H2"
        onBoardNameChange={() => {}}
        homes={[]}
        websiteUrl="https://homecore.local"
        canManage
        onClose={vi.fn()}
      />
    );
    expect(screen.getByRole("alert")).toHaveTextContent(/no integrated Wi-Fi radio/i);
    expect(screen.getByRole("button", { name: /Generate Pairing Code/i })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: /Generate Pairing Code/i }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps waiting — and says so — when the board never comes online", async () => {
    const user = userEvent.setup();
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/board-instances") {
        return json({ controller: makeController({ id: "ctrl-new" }), pairingCode: "246810" }, 201);
      }
      return json({ controller: makeController({ id: "ctrl-new", pairing_status: "pending", mqtt_connected: false }) });
    }) as typeof fetch;

    render(
      <WifiSetupFlow
        boardOptions={boardOptions}
        selectedBoardChoice="catalog:board-s3"
        onBoardChoiceChange={() => {}}
        boardName="Hall"
        onBoardNameChange={() => {}}
        homes={[]}
        websiteUrl="https://homecore.local"
        canManage
        onClose={vi.fn()}
      />
    );
    await user.click(screen.getByRole("button", { name: /Generate Pairing Code/i }));
    expect(await screen.findByText("246810")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(/Waiting for the board/i);
    expect(screen.queryByText(/Your board is ready!/i)).not.toBeInTheDocument();
  });
});

describe("Repair / Recover with Wi-Fi panel", () => {
  it("issues a recovery code for the board that already exists, without creating a duplicate", async () => {
    const user = userEvent.setup();
    const calls: Array<{ url: string; method?: string }> = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      calls.push({ url, method: init?.method });
      if (url === "/api/board-instances/ctrl-1/regenerate-pairing-code") {
        return json({ pairingCode: "908070", purpose: "recovery", requiresPhysicalConfirmation: true });
      }
      if (url === "/api/board-instances/pairing-status") {
        return json({ controller: makeController({ id: "ctrl-1", pairing_status: "paired", mqtt_connected: true }) });
      }
      return json({});
    }) as typeof fetch;

    render(
      <WifiRecoveryFlow
        controllers={[makeController()]}
        boardOptions={boardOptions}
        selectedBoardChoice="catalog:board-s3"
        onBoardChoiceChange={() => {}}
        boardName=""
        onBoardNameChange={() => {}}
        targetController={makeController()}
        websiteUrl="https://homecore.local"
        canManage
      />
    );

    expect(screen.getByText(/Press the physical BOOT \/ Recovery button/i)).toBeInTheDocument();
    expect(screen.getAllByText(/HomecoreOS-Setup-XXXX/).length).toBeGreaterThan(0);
    expect(screen.getByText(/ever flashed during recovery/i)).toBeInTheDocument();
    expect(screen.getAllByText(/Save and Restart/).length).toBeGreaterThan(0);

    await user.click(screen.getByRole("button", { name: /Generate Recovery Code/i }));

    expect(await screen.findByText("908070")).toBeInTheDocument();
    // Once a code exists, the panel says exactly which fields the board asks for.
    expect(screen.getByText(/On the board’s local page:/)).toBeInTheDocument();
    expect(calls[0]).toEqual({
      url: "/api/board-instances/ctrl-1/regenerate-pairing-code",
      method: "POST",
    });
    // The existing board ID is used; nothing was created.
    expect(calls.some((call) => call.url === "/api/board-instances")).toBe(false);
    expect(await screen.findByText(/Recovery complete/i)).toBeInTheDocument();
    expect(screen.getByText(/unchanged/i)).toBeInTheDocument();
  });

  it("creates a fresh slot only when recovering a board that is no longer listed", async () => {
    const user = userEvent.setup();
    const calls: Array<{ url: string; body?: unknown }> = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url === "/api/board-instances/recover") {
        return json({ controller: makeController({ id: "ctrl-fresh", name: "Garage Hub" }), pairingCode: "112233" });
      }
      return json({ controller: makeController({ id: "ctrl-fresh", pairing_status: "pending" }) });
    }) as typeof fetch;

    render(
      <WifiRecoveryFlow
        controllers={[]}
        boardOptions={boardOptions}
        selectedBoardChoice="catalog:board-s3"
        onBoardChoiceChange={() => {}}
        boardName="Garage Hub"
        onBoardNameChange={() => {}}
        targetController={null}
        websiteUrl="https://homecore.local"
        canManage
      />
    );

    await user.click(screen.getByRole("button", { name: /Generate Recovery Code/i }));
    expect(await screen.findByText("112233")).toBeInTheDocument();
    expect(calls[0]).toEqual({
      url: "/api/board-instances/recover",
      body: { name: "Garage Hub", boardProfileId: "board-s3" },
    });
  });

  it("surfaces a Worker refusal instead of showing a code that cannot work", async () => {
    const user = userEvent.setup();
    globalThis.fetch = vi.fn(async () => json({ error: "Controller not found." }, 404)) as typeof fetch;
    render(
      <WifiRecoveryFlow
        controllers={[makeController()]}
        boardOptions={boardOptions}
        selectedBoardChoice="catalog:board-s3"
        onBoardChoiceChange={() => {}}
        boardName=""
        onBoardNameChange={() => {}}
        targetController={makeController()}
        websiteUrl="https://homecore.local"
        canManage
      />
    );
    await user.click(screen.getByRole("button", { name: /Generate Recovery Code/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Controller not found/i);
    // No code region is shown, so the operator cannot read out a code that the
    // Worker would refuse.
    expect(screen.queryByText(/6-Digit Recovery Code/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/On the board’s local page:/)).not.toBeInTheDocument();
  });
});
