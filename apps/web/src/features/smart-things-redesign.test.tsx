import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { VERIFIED_BOARD_CATALOG, WAVESHARE_ESP_OFFICIAL_BOARDS } from "@homecoreos/shared";
import { resetApiCache } from "@/lib/api";
import { TimezoneContext } from "@/lib/timezone";
import { ConsoleShell } from "@/components/layout/ConsoleShell";
import { Toaster } from "@/components/ui/sonner";
import { AdminBoardsPage } from "./admin/AdminAccountsAndBoardsPages";
import { AdminAuthPage } from "./auth/AdminAuthPage";
import { CustomerAuthPage } from "./auth/CustomerAuthPage";
import { AutomationsPage } from "./user/AutomationsPage";
import type { BoardProfileItem } from "./types";

const originalFetch = globalThis.fetch;

beforeEach(() => {
  resetApiCache();
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

describe("Smart Things branding, cleaned auth/sidebar, Admin Board Import/Update, and Automations Condition Cards", () => {
  it("renders Smart Things branding, ESP32 Native, and Powered by HomecoreOS on CustomerAuthPage without theme switcher or admin link", () => {
    render(<CustomerAuthPage onAuthenticated={vi.fn()} />);

    expect(screen.getAllByText("Smart Things").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Connect Everything\. Control Anything/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Powered by HomecoreOS/i).length).toBeGreaterThan(0);
    expect(screen.getByText("ESP32 Native")).toBeInTheDocument();

    // Removed items must NOT be present
    expect(screen.queryByText(/ESP32-S3 Native/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Platform Admin Console/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Switch to (dark|light) mode/i })).not.toBeInTheDocument();
  });

  it("renders Smart Things & Powered by HomecoreOS on AdminAuthPage without a theme switcher", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ needsBootstrap: false }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    ) as unknown as typeof fetch;

    render(<AdminAuthPage onAuthenticated={vi.fn()} onNavigate={vi.fn()} />);

    expect(
      await screen.findByRole("button", { name: /Sign In to Admin Console/i })
    ).toBeInTheDocument();
    expect(screen.getAllByText("Smart Things").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Powered by HomecoreOS/i).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: /Switch to (dark|light) mode/i })).not.toBeInTheDocument();
  });

  it("renders Powered by HomecoreOS in ConsoleShell sidebar without the sidebar timezone widget", () => {
    const { container } = render(
      <TimezoneContext.Provider value="Asia/Dhaka">
        <ConsoleShell
          consoleTitle="Main Console"
          navItems={[{ id: "rooms", label: "Rooms", icon: <span>R</span> }]}
          activeNav="rooms"
          onSelectNav={vi.fn()}
          userEmail="user@example.com"
          userName="Owner"
          onSignOut={vi.fn()}
          themeMode="light"
          onToggleTheme={vi.fn()}
        >
          <div>Body</div>
        </ConsoleShell>
      </TimezoneContext.Provider>
    );

    const aside = container.querySelector("aside")!;
    expect(within(aside).getByText("Smart Things")).toBeInTheDocument();
    expect(within(aside).getByText("Powered by HomecoreOS")).toBeInTheDocument();
    expect(within(aside).queryByText(/Asia\/Dhaka/i)).not.toBeInTheDocument();
    expect(within(aside).queryByText(/Time Zone/i)).not.toBeInTheDocument();
  });

  it("supports Import Board (including Waveshare ESP) and Update Board on AdminBoardsPage without manual add", async () => {
    const user = userEvent.setup();
    const s3Board = VERIFIED_BOARD_CATALOG.find((b) => b.slug === "esp32-s3-devkitc-1-n16r8")!;
    const boards: BoardProfileItem[] = [{ ...s3Board, id: "cat-s3", is_available: true }];

    const previewProviders: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/admin/boards" && (!init?.method || init.method === "GET")) {
        return new Response(JSON.stringify({ boards, syncRuns: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "/api/admin/boards/import/preview" && init?.method === "POST") {
        const body = JSON.parse(String(init.body ?? "{}")) as { provider?: string };
        previewProviders.push(body.provider ?? "unknown");
        const c6Seed = WAVESHARE_ESP_OFFICIAL_BOARDS.find(
          (b) => b.seed.slug === "waveshare-esp32-c6-zero"
        )!.seed;
        return new Response(
          JSON.stringify({
            preview: {
              provider: body.provider,
              providerLabel: body.provider === "waveshare" ? "Waveshare ESP Official Wiki" : "Seeed Studio XIAO",
              fetchedAt: "2026-11-15T00:00:00Z",
              sourcesReached: 1,
              sourcesTotal: 1,
              notes: ["Fetched Waveshare Wiki"],
              candidates:
                body.provider === "waveshare"
                  ? [
                      {
                        slug: c6Seed.slug,
                        provider: "waveshare",
                        name: `${c6Seed.manufacturer} ${c6Seed.model}`,
                        status: "new",
                        statusDetail: "Not in the Board Library yet.",
                        selectable: true,
                        verification: "verified",
                        verificationNote: "Verified against Waveshare Wiki",
                        existingBoardId: null,
                        board: { ...c6Seed, id: "preview-c6-zero", is_available: true },
                        highlights: ["Compact castellated ESP32-C6 module"],
                        sources: [
                          {
                            label: "Waveshare Wiki",
                            url: "https://www.waveshare.com/wiki/ESP32-C6-Zero",
                          },
                        ],
                        checks: [
                          {
                            key: "wiki",
                            label: "Waveshare Wiki",
                            status: "confirmed",
                            detail: "Pinout verified",
                          },
                        ],
                      },
                    ]
                  : [],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    render(
      <TimezoneContext.Provider value="UTC">
        <AdminBoardsPage />
        <Toaster />
      </TimezoneContext.Provider>
    );

    expect(
      await screen.findByText(`${s3Board.manufacturer} ${s3Board.model}`)
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Import Board$/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Update Board$/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Add Supported Board/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Sync Official Catalog/i })).not.toBeInTheDocument();

    // Open Import Board dialog and switch to Waveshare ESP32 provider
    await user.click(screen.getByRole("button", { name: /^Import Board$/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("radio", { name: /Seeed Studio XIAO/i })).toBeInTheDocument();
    expect(within(dialog).getByRole("radio", { name: /Espressif DevKits/i })).toBeInTheDocument();
    const waveshareRadio = within(dialog).getByRole("radio", { name: /Waveshare ESP32/i });
    await user.click(waveshareRadio);
    await user.click(within(dialog).getByRole("button", { name: /Preview boards/i }));

    expect(await within(dialog).findByText(/ESP32-C6-Zero/i)).toBeInTheDocument();
    expect(previewProviders).toContain("waveshare");
  });

  it("renders all 5 Choose Condition cards on AutomationsPage, disables Device State/Event without hardware, and creates Schedule, Sunset/Sunrise, and Scene rules", async () => {
    const user = userEvent.setup();
    const postedPayloads: Array<Record<string, unknown>> = [];

    const jsonRes = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });

    // First test empty hardware state: Device State & Event must be disabled with helper text
    const emptyFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/automations") return jsonRes({ automations: [] });
      if (url === "/api/sensors") return jsonRes({ sensors: [] });
      if (url === "/api/switches") return jsonRes({ switches: [] });
      if (url === "/api/devices") return jsonRes({ devices: [] });
      return jsonRes({ rooms: [], controllers: [] });
    });
    globalThis.fetch = emptyFetch as unknown as typeof fetch;

    const emptyView = render(
      <TimezoneContext.Provider value="UTC">
        <AutomationsPage canManage canOperate />
      </TimezoneContext.Provider>
    );

    expect(await screen.findByText("Create automations")).toBeInTheDocument();
    expect(
      screen.getByText("Automations let you set up actions that start when a certain trigger happens.")
    ).toBeInTheDocument();
    expect(screen.getByText("Choose Condition")).toBeInTheDocument();

    const grid = screen.getByTestId("automation-condition-grid");
    expect(within(grid).getByRole("button", { name: /Schedule/i })).toBeEnabled();
    expect(within(grid).getByRole("button", { name: /Sunset\/Sunrise/i })).toBeEnabled();
    expect(within(grid).getByRole("button", { name: /Scene/i })).toBeEnabled();
    expect(within(grid).getByRole("button", { name: /Device State/i })).toBeDisabled();
    expect(within(grid).getByRole("button", { name: /Event/i })).toBeDisabled();
    expect(within(grid).getAllByText(/Add a device to use this trigger\./i)).toHaveLength(2);
    emptyView.unmount();

    // Now test with hardware present: create Schedule, Sunset/Sunrise, Event, and Scene rules
    resetApiCache();
    const hwFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/automations" && init?.method === "POST") {
        postedPayloads.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return jsonRes({ automation: { id: `r-${postedPayloads.length}` } }, 201);
      }
      if (url === "/api/automations") return jsonRes({ automations: [] });
      if (url === "/api/sensors") {
        return jsonRes({
          sensors: [
            {
              id: "33333333-3333-4333-8333-333333333333",
              account_id: "a1",
              home_id: "h1",
              room_id: null,
              board_instance_id: "c1",
              name: "Living Temp",
              sensor_type: "temperature",
              unit: "C",
              last_value: 26,
              last_read_at: null,
            },
          ],
        });
      }
      if (url === "/api/switches") {
        return jsonRes({
          switches: [
            {
              id: "11111111-1111-4111-8111-111111111111",
              account_id: "a1",
              home_id: "h1",
              room_id: null,
              board_instance_id: "c1",
              name: "Porch Light",
              gpio_pin: 4,
              is_on: false,
              inverted: false,
              is_online: true,
              last_changed_at: null,
            },
          ],
        });
      }
      if (url === "/api/devices") return jsonRes({ devices: [] });
      return jsonRes({ rooms: [], controllers: [] });
    });
    globalThis.fetch = hwFetch as unknown as typeof fetch;

    render(
      <TimezoneContext.Provider value="Asia/Dhaka">
        <AutomationsPage canManage canOperate />
        <Toaster />
      </TimezoneContext.Provider>
    );

    const hwGrid = await screen.findByTestId("automation-condition-grid");
    expect(within(hwGrid).getByRole("button", { name: /Device State/i })).toBeEnabled();
    expect(within(hwGrid).getByRole("button", { name: /Event/i })).toBeEnabled();

    // 1. Create a Schedule rule
    await user.click(within(hwGrid).getByRole("button", { name: /Schedule/i }));
    await user.type(await screen.findByLabelText(/Automation Name/i), "Morning Porch");
    await user.click(screen.getByRole("button", { name: /Weekdays/i }));
    await user.click(screen.getByRole("button", { name: /Save Automation Rule/i }));

    await waitFor(() => expect(postedPayloads).toHaveLength(1));
    expect((postedPayloads[0]!.triggerConfig as { type: string; days?: string[] }).type).toBe("time");
    expect((postedPayloads[0]!.triggerConfig as { days?: string[] }).days).toEqual([
      "mon",
      "tue",
      "wed",
      "thu",
      "fri",
    ]);

    // 2. Create a Sunset/Sunrise rule
    await user.click(within(hwGrid).getByRole("button", { name: /Sunset\/Sunrise/i }));
    await user.type(await screen.findByLabelText(/Automation Name/i), "Dusk Lights");
    await user.click(screen.getByRole("button", { name: /\+15m/i }));
    await user.click(screen.getByRole("button", { name: /Save Automation Rule/i }));

    await waitFor(() => expect(postedPayloads).toHaveLength(2));
    expect(postedPayloads[1]!.triggerConfig).toMatchObject({
      type: "sun_event",
      sunEvent: "sunset",
      offsetMinutes: 15,
    });

    // 3. Create a Manual Scene rule
    await user.click(within(hwGrid).getByRole("button", { name: /Scene/i }));
    await user.type(await screen.findByLabelText(/Automation Name/i), "Welcome Home");
    await user.click(screen.getByRole("button", { name: /Save Automation Rule/i }));

    await waitFor(() => expect(postedPayloads).toHaveLength(3));
    expect(postedPayloads[2]!.triggerConfig).toMatchObject({ type: "manual" });
    expect((postedPayloads[2]!.actionsConfig as Array<{ type: string }>)[0]?.type).toBe("scene");
  });
});
