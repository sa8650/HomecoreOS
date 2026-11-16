import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SEEED_XIAO_OFFICIAL_BOARDS,
  WAVESHARE_ESP_OFFICIAL_BOARDS,
} from "@homecoreos/shared";
import { WireDiagramModal, type WireDiagramTarget } from "./WireDiagramModal";
import type { HardwareContext } from "@/lib/board-pin-helpers";
import type {
  BoardProfileItem,
  ControllerItem,
  DeviceItem,
  SensorItem,
  SwitchItem,
} from "@/features/types";
import { resetApiCache } from "@/lib/api";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetApiCache();
});

function buildRelay6Board(overrides: Partial<BoardProfileItem> = {}): BoardProfileItem {
  const seed = WAVESHARE_ESP_OFFICIAL_BOARDS.find(
    (b) => b.seed.slug === "waveshare-esp32-s3-relay-6ch"
  )!.seed as unknown as BoardProfileItem;
  return {
    ...seed,
    id: "board-relay-6ch",
    is_available: true,
    ...overrides,
  };
}

function makeController(board: BoardProfileItem): ControllerItem {
  return {
    id: "ctrl-1",
    account_id: "acc-1",
    home_id: "home-1",
    board_catalog_id: board.id,
    custom_board_id: null,
    name: "Panel Controller",
    hardware_uid: "AA:BB:CC:DD:EE:01",
    board_model: board.model,
    chip_variant: board.chip_variant,
    flash_size_mb: board.flash_size_mb,
    psram_size_mb: board.psram_size_mb,
    firmware_version: "1.4.0",
    status: "online",
    mqtt_connected: true,
    wifi_ssid: "LabWiFi",
    wifi_rssi: -52,
    local_ip: "192.168.1.50",
    last_heartbeat_at: null,
    last_communication_at: null,
    paired_at: null,
    connection_history: [],
  };
}

const dimmer: DeviceItem = {
  id: "dev-1",
  account_id: "acc-1",
  home_id: "home-1",
  room_id: "room-1",
  controller_id: "ctrl-1",
  name: "Porch Dimmer",
  device_type: "dimmer_pwm",
  gpio_pin: 4,
  state: "off",
  is_online: true,
};

const dht22: SensorItem = {
  id: "sen-1",
  account_id: "acc-1",
  home_id: "home-1",
  room_id: "room-1",
  controller_id: "ctrl-1",
  name: "Greenhouse Temp",
  sensor_type: "temperature_dht22",
  gpio_pin: 5,
  unit: "°C",
  last_value: 22.4,
  last_raw_payload: null,
  is_online: true,
  last_reading_at: null,
};

const relaySwitch: SwitchItem = {
  id: "sw-1",
  account_id: "acc-1",
  home_id: "home-1",
  room_id: "room-1",
  controller_id: "ctrl-1",
  name: "Onboard Pump",
  gpio_pin: 1,
  is_on: false,
  inverted: false,
  is_online: true,
  last_changed_at: null,
};

function buildXiaoC3Board(overrides: Partial<BoardProfileItem> = {}): BoardProfileItem {
  const seed = SEEED_XIAO_OFFICIAL_BOARDS.find(
    (b) => b.seed.slug === "seeed-xiao-esp32c3"
  )!.seed as unknown as BoardProfileItem;
  return {
    ...seed,
    id: "board-xiao-c3",
    is_available: true,
    ...overrides,
  };
}

const reedSensor: SensorItem = {
  id: "sen-2",
  account_id: "acc-1",
  home_id: "home-1",
  room_id: "room-1",
  controller_id: "ctrl-1",
  name: "Front Door Reed",
  sensor_type: "contact_reed",
  gpio_pin: 3,
  unit: "",
  last_value: null,
  last_raw_payload: null,
  is_online: true,
  last_reading_at: null,
};

function makeCtx(board: BoardProfileItem): HardwareContext {
  return {
    controllers: [makeController(board)],
    rooms: [
      {
        id: "room-1",
        account_id: "acc-1",
        home_id: "home-1",
        name: "Utility Room",
        icon: "wrench",
        floor_order: 1,
        grid_col_span: 1,
        room_type: "utility",
        floor_x: 0,
        floor_y: 0,
        floor_w: 360,
        floor_h: 280,
        layout_config: { floorStyle: "wood" },
      },
    ],
    boardsById: new Map([[board.id, board]]),
    usedPinsByController: new Map(),
  };
}

function renderModal(
  target: WireDiagramTarget,
  overrides: { board?: Partial<BoardProfileItem>; onEdit?: () => void; onOpenChange?: (open: boolean) => void } = {}
) {
  const board = buildRelay6Board(overrides.board);
  const ctx = makeCtx(board);
  const utils = render(
    <WireDiagramModal
      open
      onOpenChange={overrides.onOpenChange ?? (() => {})}
      target={target}
      ctx={ctx}
      onEdit={overrides.onEdit}
    />
  );
  return { board, ctx, ...utils };
}

describe("WireDiagramModal — Interactive Wire Diagram", () => {
  it("renders the diagram canvas with the board SVG, GPIO wires and module terminals", () => {
    renderModal({ kind: "device", data: dimmer });

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByTestId("wire-diagram-canvas")).toBeInTheDocument();

    // The real board vector SVG is rendered, never a generic illustration.
    const boardSvg = document.querySelector(
      'svg[aria-label*="vertical PCB diagram"]'
    );
    expect(boardSvg).not.toBeNull();
    expect(boardSvg!.getAttribute("aria-label")).toContain("ESP32-S3-Relay-6CH");

    // Wired header pin carries the connected marker.
    expect(
      document.querySelector('[data-header-key="Expansion:3"]')
    ).not.toBeNull();
    expect(
      document.querySelectorAll("[data-pin-connected]").length
    ).toBeGreaterThanOrEqual(2); // GP4 signal + documented GND reference

    // Module terminals from the driver/module class are shown.
    expect(screen.getAllByText("PWM").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("VCC").length).toBeGreaterThanOrEqual(1);

    // The logical-assignment disclaimer is always visible.
    expect(
      screen.getAllByText(/not a physical inspection/i).length
    ).toBeGreaterThan(0);
  });

  it("selects a connection from the inspector list and toggles it off", async () => {
    const user = userEvent.setup();
    renderModal({ kind: "device", data: dimmer });

    const scope = screen.getByRole("dialog");

    const wireButton = within(scope)
      .getAllByRole("button", { pressed: false })
      .find((b) => b.textContent?.includes("PWM output"))!;
    expect(wireButton).toBeDefined();

    await user.click(wireButton);
    expect(wireButton).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.getByText("Configured logical assignment", { exact: false })
    ).toBeInTheDocument();

    await user.click(wireButton);
    expect(wireButton).toHaveAttribute("aria-pressed", "false");
  });

  it("lists the configured pin assignments on the Connections tab without editing them", async () => {
    const user = userEvent.setup();
    renderModal({ kind: "device", data: dimmer });

    await user.click(screen.getByRole("tab", { name: /connections/i }));

    // Table renders the configured GPIO with its function capabilities.
    expect(screen.getByText(/GPIO & function/i)).toBeInTheDocument();
    expect(screen.getByText("GPIO4")).toBeInTheDocument();
    expect(screen.getAllByText("Configured · Logical").length).toBe(1);
    expect(screen.getByText("Reference rail")).toBeInTheDocument();
    expect(screen.getByText("Advisory only")).toBeInTheDocument();
    // Supply advisory row is never auto-wired.
    expect(screen.getByText(/Supply \(not auto-wired\)/i)).toBeInTheDocument();
    // Honest framing of the data.
    expect(
      screen.getByText(/configured logical assignments/i)
    ).toBeInTheDocument();
  });

  it("jumps back to the diagram tab from a connection row", async () => {
    const user = userEvent.setup();
    renderModal({ kind: "device", data: dimmer });

    await user.click(screen.getByRole("tab", { name: /connections/i }));
    const highlight = screen.getByRole("button", {
      name: /highlight pwm in diagram/i,
    });
    await user.click(highlight);

    expect(screen.getByRole("tab", { name: /diagram/i })).toHaveAttribute(
      "aria-selected",
      "true"
    );
  });

  it("shows device and board datasheet facts with official documentation links", async () => {
    const user = userEvent.setup();
    renderModal({ kind: "device", data: dimmer });

    await user.click(screen.getByRole("tab", { name: /datasheet/i }));

    // Device facts — manufacturer is never invented.
    expect(screen.getByText("Manufacturer")).toBeInTheDocument();
    expect(screen.getAllByText("Not documented").length).toBeGreaterThan(0);
    expect(screen.getByText("dimmer pwm", { exact: false })).toBeInTheDocument();

    // Terminal definitions are documented for the module class.
    expect(screen.getByText(/pin \/ terminal definitions/i)).toBeInTheDocument();

    // Board documentation links come from the Board Library profile only.
    const docs = screen.getByRole("link", { name: /official documentation/i });
    expect(docs).toHaveAttribute(
      "href",
      "https://www.waveshare.com/wiki/ESP32-S3-Relay-6CH"
    );
    expect(
      screen.getByRole("link", { name: /controller datasheet/i })
    ).toHaveAttribute(
      "href",
      "https://www.espressif.com/sites/default/files/documentation/esp32-s3_datasheet_en.pdf"
    );
  });

  it("renders an on-board relay channel without external wires", async () => {
    const user = userEvent.setup();
    renderModal({ kind: "switch", data: relaySwitch });

    expect(
      screen.getByText(/on-board peripheral/i)
    ).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: /connections/i }));
    expect(screen.getByText("On-board")).toBeInTheDocument();
    expect(screen.getByText("Relay CH1")).toBeInTheDocument();
    // No fabricated external GPIO rows for the control leg.
    expect(screen.queryByText(/Expansion · pin/i)).not.toBeInTheDocument();
  });

  it("renders a wired single-wire sensor (DHT22) with its data leg", () => {
    renderModal({ kind: "sensor", data: dht22 });

    expect(screen.getByTestId("wire-diagram-canvas")).toBeInTheDocument();
    expect(screen.getAllByText("DATA").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Single-wire data/i).length).toBeGreaterThan(0);
  });

  it("renders the compact XIAO vertical layout with a 2-wire reed sensor", () => {
    const board = buildXiaoC3Board();
    const ctx: HardwareContext = {
      controllers: [
        {
          ...makeController(board),
          id: "ctrl-1",
          board_catalog_id: board.id,
          board_model: board.model,
        },
      ],
      rooms: [],
      boardsById: new Map([[board.id, board]]),
      usedPinsByController: new Map(),
    };
    render(
      <WireDiagramModal
        open
        onOpenChange={() => {}}
        target={{ kind: "sensor", data: reedSensor }}
        ctx={ctx}
      />
    );

    expect(screen.getByTestId("wire-diagram-canvas")).toBeInTheDocument();
    const boardSvg = document.querySelector(
      'svg[aria-label*="PCB diagram"]'
    );
    expect(boardSvg).not.toBeNull();
    // A 2-wire reed contact has SIG + GND and no supply leg.
    expect(screen.queryByText("VCC")).not.toBeInTheDocument();
    expect(screen.getAllByText("SIG").length).toBeGreaterThan(0);
    expect(document.querySelectorAll("[data-header-key]").length).toBeGreaterThan(0);
  });

  it("refuses to draw wiring and states exact reasons when the catalog board is withdrawn", async () => {
    const user = userEvent.setup();
    renderModal(
      { kind: "device", data: dimmer },
      { board: { is_available: false } }
    );

    expect(
      screen.getAllByText(/Connection information unavailable/i).length
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByText(/withdrawn from the catalog/i).length
    ).toBeGreaterThan(0);

    await user.click(screen.getByRole("tab", { name: /connections/i }));
    expect(
      screen.getAllByText(/Connection information unavailable/i).length
    ).toBeGreaterThan(0);
    expect(screen.queryByText("Configured · Logical")).not.toBeInTheDocument();
  });

  it("invokes onEdit from the footer and closes via onOpenChange", async () => {
    const user = userEvent.setup();
    const onEdit = vi.fn();
    const onOpenChange = vi.fn();
    renderModal({ kind: "device", data: dimmer }, { onEdit, onOpenChange });

    await user.click(screen.getByRole("button", { name: /edit configuration/i }));
    expect(onEdit).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: /^close$/i }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe("WireDiagramModal — circuit intelligence", () => {
  it("a dimmer device shows the LOW-VOLTAGE DC safety class and the external PSU chain in the canvas", async () => {
    const user = userEvent.setup();
    renderModal({ kind: "device", data: dimmer });

    // Header safety badge
    expect(screen.getAllByText("LOW-VOLTAGE DC").length).toBeGreaterThanOrEqual(1);

    // Aux supply + load tiles are rendered with their illustrations
    expect(document.querySelector('[data-illustration="psu"]')).not.toBeNull();
    expect(document.querySelector('[data-illustration="led_strip"]')).not.toBeNull();
    // Module panel illustration banner
    expect(document.querySelector('[data-illustration="dimmer"]')).not.toBeNull();
    // Load-side terminal OUT is flagged with a Load chip
    expect(screen.getAllByText("Load").length).toBeGreaterThanOrEqual(1);

    // Datasheet tab: circuit design panel appears with components and reasoning
    await user.click(screen.getByRole("tab", { name: /datasheet/i }));
    expect(screen.getByText(/Circuit design/i)).toBeInTheDocument();
    expect(screen.getAllByText(/External supply required/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/Required components/i)).toBeInTheDocument();
    expect(screen.getByText(/Safety & compatibility checks/i)).toBeInTheDocument();
    expect(screen.getAllByText(/Logic-level|logic only/i).length).toBeGreaterThanOrEqual(1);

    // Connections tab: circuit wiring section lists the PSU chain
    await user.click(screen.getByRole("tab", { name: /connections/i }));
    expect(screen.getByText(/Circuit wiring/i)).toBeInTheDocument();
    expect(screen.getAllByText("V+ → VCC").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("strip − → OUT").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/Control side/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/Load side/i).length).toBeGreaterThanOrEqual(1);
  });

  it("an on-board relay switch shows MAINS AC, isolation facts and mains wiring — GPIO never on mains", async () => {
    const user = userEvent.setup();
    renderModal({ kind: "switch", data: relaySwitch });

    // Header safety badge
    expect(screen.getAllByText("MAINS AC").length).toBeGreaterThanOrEqual(1);

    // Aux tiles: AC mains source + the appliance (load), module shows on-board badge
    expect(document.querySelector('[data-illustration="ac_mains"]')).not.toBeNull();
    expect(document.querySelector('[data-illustration="appliance"]')).not.toBeNull();
    expect(screen.getByText(/On-board · no external module/i)).toBeInTheDocument();

    // Datasheet tab: circuit design panel
    await user.click(screen.getByRole("tab", { name: /datasheet/i }));
    expect(screen.getByText(/Circuit design/i)).toBeInTheDocument();
    expect(screen.getAllByText(/Isolated from load/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/Required components/i)).toBeInTheDocument();
    // Load ratings are explicitly unknown, never fabricated
    expect(screen.getAllByText(/Not documented/i).length).toBeGreaterThanOrEqual(1);

    // Connections tab: mains wiring appears with the load-side badge
    await user.click(screen.getByRole("tab", { name: /connections/i }));
    expect(screen.getByText(/Circuit wiring/i)).toBeInTheDocument();
    expect(screen.getAllByText("L → COM").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("NO → L").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/MAINS Live/i).length).toBeGreaterThanOrEqual(1);
  });

  it("a DHT22 shows the pull-up resistor and the sensor illustration", async () => {
    const user = userEvent.setup();
    renderModal({ kind: "sensor", data: dht22 });

    // Header safety badge — low voltage
    expect(screen.getAllByText("LOW-VOLTAGE DC").length).toBeGreaterThanOrEqual(1);
    // Sensor illustration in the banner
    expect(document.querySelector('[data-illustration="dht22"]')).not.toBeNull();

    await user.click(screen.getByRole("tab", { name: /datasheet/i }));
    expect(screen.getByText(/Circuit design/i)).toBeInTheDocument();
    expect(screen.getAllByText(/pull-up/i).length).toBeGreaterThanOrEqual(1);
  });
});
