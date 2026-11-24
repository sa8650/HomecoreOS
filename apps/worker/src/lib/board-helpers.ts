import {
  evaluateGpioPinChoice,
  getSensorDriverForMeasurement,
  isSupportedDeviceType,
  isSupportedSensorType,
  requiredPinCapabilityForDevice,
  requiredPinCapabilityForSensor,
  resolveBoardFirmwareCompatibility,
  type BoardProfileSpec,
  type GpioPinDefinition,
  type PinOperationRequirement,
} from "@homecoreos/shared";
import type { DbClient } from "./db";

export async function resolveControllerBoardSpec(
  db: DbClient,
  controller: {
    board_profile_id: string | null;
    custom_board_profile_id: string | null;
  }
): Promise<BoardProfileSpec | null> {
  if (controller.board_profile_id) {
    const { data: board } = await db
      .from("board_profiles")
      .select("*")
      .eq("id", controller.board_profile_id)
      .is("deleted_at", null)
      .maybeSingle();
    if (!board) return null;

    const { data: gpios } = await db
      .from("board_gpio_definitions")
      .select("pin,label,board_pin_name,header_side,header_position,board_note,capabilities,restrictions")
      .eq("board_profile_id", controller.board_profile_id)
      .order("pin", { ascending: true });

    const b = board as {
      id: string;
      slug: string;
      manufacturer: string;
      model: string;
      revision: string;
      chip_family: BoardProfileSpec["chip_family"];
      chip_variant: string;
      flash_size_mb: number;
      psram_size_mb: number;
      usb_vid?: string | null;
      usb_pid?: string | null;
      catalog_category?: BoardProfileSpec["catalog_category"];
      series?: string | null;
      image_url?: string | null;
      pinout_image_url?: string | null;
      docs_url?: string | null;
      datasheet_url?: string | null;
      source_url?: string | null;
      source_provider?: string | null;
      verification_status?: BoardProfileSpec["verification_status"];
      firmware_status?: BoardProfileSpec["firmware_status"];
      partition_scheme?: string | null;
      psram_mode?: string | null;
      flash_mode?: string | null;
      flash_freq?: string | null;
      bootloader_offset?: string | null;
      ota_app_offset?: string | null;
      boot_button_gpio?: number | null;
      usb_interface?: string | null;
      supports_wifi?: boolean | null;
      supports_ble?: boolean | null;
      supports_ble_wifi_provisioning?: boolean | null;
      supports_ota_rollback?: boolean | null;
      firmware_compat_key?: string | null;
      connectivity_note?: string | null;
      board_layout?: BoardProfileSpec["board_layout"];
      revision_notes?: string | null;
    };

    const compat = resolveBoardFirmwareCompatibility(b);
    return {
      id: b.id,
      slug: b.slug,
      manufacturer: b.manufacturer,
      model: b.model,
      revision: b.revision,
      chip_family: b.chip_family,
      chip_variant: b.chip_variant,
      flash_size_mb: b.flash_size_mb,
      psram_size_mb: b.psram_size_mb,
      usb_vid: b.usb_vid ?? undefined,
      usb_pid: b.usb_pid ?? undefined,
      catalog_category: b.catalog_category,
      series: b.series ?? null,
      image_url: b.image_url ?? null,
      pinout_image_url: b.pinout_image_url ?? null,
      docs_url: b.docs_url ?? null,
      datasheet_url: b.datasheet_url ?? null,
      source_url: b.source_url ?? null,
      source_provider: b.source_provider ?? null,
      verification_status: b.verification_status,
      firmware_status: b.firmware_status,
      ...compat,
      board_layout: b.board_layout ?? null,
      revision_notes: b.revision_notes ?? null,
      gpio_definitions: (gpios ?? []) as GpioPinDefinition[],
    };
  }

  if (controller.custom_board_profile_id) {
    const { data: board } = await db
      .from("custom_board_profiles")
      .select("*")
      .eq("id", controller.custom_board_profile_id)
      .is("deleted_at", null)
      .maybeSingle();
    if (!board) return null;

    const { data: gpios } = await db
      .from("board_gpio_definitions")
      .select("pin,label,board_pin_name,header_side,header_position,board_note,capabilities,restrictions")
      .eq("custom_board_profile_id", controller.custom_board_profile_id)
      .order("pin", { ascending: true });

    const b = board as {
      id: string;
      slug: string;
      manufacturer: string;
      model: string;
      revision: string;
      chip_family: BoardProfileSpec["chip_family"];
      chip_variant: string;
      flash_size_mb: number;
      psram_size_mb: number;
      partition_scheme?: string | null;
      psram_mode?: string | null;
      flash_mode?: string | null;
      flash_freq?: string | null;
      bootloader_offset?: string | null;
      ota_app_offset?: string | null;
      boot_button_gpio?: number | null;
      usb_interface?: string | null;
      supports_wifi?: boolean | null;
      supports_ble?: boolean | null;
      supports_ble_wifi_provisioning?: boolean | null;
      supports_ota_rollback?: boolean | null;
      firmware_compat_key?: string | null;
      connectivity_note?: string | null;
      image_url?: string | null;
      docs_url?: string | null;
      board_layout?: BoardProfileSpec["board_layout"];
    };

    const compat = resolveBoardFirmwareCompatibility(b);
    return {
      id: b.id,
      slug: b.slug,
      manufacturer: b.manufacturer,
      model: b.model,
      revision: b.revision,
      chip_family: b.chip_family,
      chip_variant: b.chip_variant,
      flash_size_mb: b.flash_size_mb,
      psram_size_mb: b.psram_size_mb,
      catalog_category: "custom",
      ...compat,
      image_url: b.image_url ?? null,
      docs_url: b.docs_url ?? null,
      board_layout: b.board_layout ?? null,
      gpio_definitions: (gpios ?? []) as GpioPinDefinition[],
    };
  }

  return null;
}

export async function getUsedPinsOnController(
  db: DbClient,
  accountId: string,
  boardInstanceId: string,
  exclude?: { table: "devices" | "switches" | "sensors"; id: string }
): Promise<number[]> {
  const [devRes, swRes, sensRes] = await Promise.all([
    db
      .from("devices")
      .select("id,gpio_pin")
      .eq("account_id", accountId)
      .eq("board_instance_id", boardInstanceId)
      .is("deleted_at", null),
    db
      .from("switches")
      .select("id,gpio_pin")
      .eq("account_id", accountId)
      .eq("board_instance_id", boardInstanceId)
      .is("deleted_at", null),
    db
      .from("sensors")
      .select("id,gpio_pin,last_raw_payload")
      .eq("account_id", accountId)
      .eq("board_instance_id", boardInstanceId)
      .is("deleted_at", null),
  ]);

  const used: number[] = [];

  for (const row of (devRes.data ?? []) as Array<{ id: string; gpio_pin: number }>) {
    if (exclude?.table === "devices" && exclude.id === row.id) continue;
    used.push(row.gpio_pin);
  }
  for (const row of (swRes.data ?? []) as Array<{ id: string; gpio_pin: number }>) {
    if (exclude?.table === "switches" && exclude.id === row.id) continue;
    used.push(row.gpio_pin);
  }
  for (const row of (sensRes.data ?? []) as Array<{
    id: string;
    gpio_pin: number | null;
    last_raw_payload?: Record<string, unknown> | null;
  }>) {
    if (exclude?.table === "sensors" && exclude.id === row.id) continue;
    const seenForSensor = new Set<number>();
    if (row.gpio_pin !== null && row.gpio_pin !== undefined) {
      used.push(row.gpio_pin);
      seenForSensor.add(row.gpio_pin);
    }
    const rawRes = row.last_raw_payload?.resources as
      | { pins?: Record<string, number | null | undefined> }
      | undefined;
    if (rawRes?.pins && typeof rawRes.pins === "object") {
      for (const pin of Object.values(rawRes.pins)) {
        if (typeof pin === "number" && Number.isInteger(pin) && !seenForSensor.has(pin)) {
          used.push(pin);
          seenForSensor.add(pin);
        }
      }
    }
  }

  return used;
}

export async function verifyHomeRoomOwnership(
  db: DbClient,
  accountId: string,
  input: {
    homeId?: string | null;
    roomId?: string | null;
  }
): Promise<{
  ok: boolean;
  homeId: string | null;
  roomId: string | null;
  error?: string;
}> {
  let homeId = input.homeId ?? null;
  const roomId = input.roomId ?? null;

  if (roomId) {
    const { data: room } = await db
      .from("rooms")
      .select("id,home_id")
      .eq("id", roomId)
      .eq("account_id", accountId)
      .is("deleted_at", null)
      .maybeSingle();
    if (!room) {
      return { ok: false, homeId: null, roomId: null, error: "Room not found in this account." };
    }
    const roomHomeId = (room as { home_id: string }).home_id;
    if (homeId && homeId !== roomHomeId) {
      return { ok: false, homeId: null, roomId: null, error: "Selected room does not belong to the selected home." };
    }
    homeId = roomHomeId;
  }

  if (homeId) {
    const { data: home } = await db
      .from("homes")
      .select("id")
      .eq("id", homeId)
      .eq("account_id", accountId)
      .is("deleted_at", null)
      .maybeSingle();
    if (!home) {
      return { ok: false, homeId: null, roomId: null, error: "Home not found in this account." };
    }
  }

  return { ok: true, homeId, roomId };
}

/**
 * The pin selection policy of the visual GPIO selector, enforced on the server.
 *
 * validateGpioAssignment() already refuses conflicts, reserved pins and pins
 * that lack the needed capability. This adds the pins the selector does not
 * offer either: boot-strapping pins, USB / JTAG pins, the BOOT button pin and
 * pins that are not broken out. It applies to new and changed assignments
 * only, so a device that already sits on such a pin keeps working and can
 * still be renamed or moved to another room.
 *
 * Returns the explanation to send back, or null when the pin is allowed.
 */
export function checkPinSelectionPolicy(params: {
  board: BoardProfileSpec;
  pin: number;
  requirement: PinOperationRequirement;
  usedPins: number[];
  /** The entity already holds this pin on this controller. */
  unchanged?: boolean;
}): string | null {
  if (params.unchanged) return null;
  const verdict = evaluateGpioPinChoice({
    board: params.board,
    pin: params.pin,
    requirement: params.requirement,
    usedPins: params.usedPins,
  });
  if (verdict.allowed) return null;
  return verdict.explanation ?? `GPIO ${params.pin} cannot be assigned on this board.`;
}

/**
 * Safely replaces all `board_gpio_definitions` rows for either a catalog board
 * or a custom board. Snapshots the previous rows first so that if the insert
 * fails, the original pin map is restored instead of leaving the board with 0 pins.
 */
export async function replaceBoardGpioDefinitions(
  db: DbClient,
  target: { boardProfileId: string } | { customBoardProfileId: string },
  gpios: GpioPinDefinition[]
): Promise<{ ok: true } | { ok: false; error: string }> {
  const fkCol = "boardProfileId" in target ? "board_profile_id" : "custom_board_profile_id";
  const fkVal = "boardProfileId" in target ? target.boardProfileId : target.customBoardProfileId;

  const { data: prevData, error: prevErr } = await db
    .from("board_gpio_definitions")
    .select(
      "pin,label,board_pin_name,header_side,header_position,board_note,capabilities,restrictions"
    )
    .eq(fkCol, fkVal);
  if (prevErr) {
    return { ok: false, error: `Failed to read existing GPIO definitions: ${prevErr.message}` };
  }

  const previousRows = ((prevData ?? []) as Array<Record<string, unknown>>).map((row) => ({
    [fkCol]: fkVal,
    pin: row.pin,
    label: row.label,
    board_pin_name: row.board_pin_name ?? null,
    header_side: row.header_side ?? null,
    header_position: row.header_position ?? null,
    board_note: row.board_note ?? null,
    capabilities: row.capabilities,
    restrictions: row.restrictions,
  }));

  const { error: delErr } = await db
    .from("board_gpio_definitions")
    .delete()
    .eq(fkCol, fkVal);
  if (delErr) {
    return { ok: false, error: `Failed to clear previous GPIO definitions: ${delErr.message}` };
  }

  if (gpios.length === 0) {
    return { ok: true };
  }

  const nextRows = gpios.map((g) => ({
    [fkCol]: fkVal,
    pin: g.pin,
    label: g.label,
    board_pin_name: g.board_pin_name ?? null,
    header_side: g.header_side ?? null,
    header_position: g.header_position ?? null,
    board_note: g.board_note ?? null,
    capabilities: g.capabilities,
    restrictions: g.restrictions,
  }));

  const { error: insErr } = await db.from("board_gpio_definitions").insert(nextRows);
  if (insErr) {
    if (previousRows.length > 0) {
      await db.from("board_gpio_definitions").insert(previousRows);
    }
    return { ok: false, error: `Failed to save GPIO definitions: ${insErr.message}` };
  }

  return { ok: true };
}

/**
 * Verifies that updating a catalog or custom board will not break devices,
 * switches, or sensors already assigned on active controllers using this board.
 */
export async function validateBoardGpioUpdateAgainstControllers(
  db: DbClient,
  params: {
    target: { boardProfileId: string } | { customBoardProfileId: string };
    nextGpios: GpioPinDefinition[];
    chipFamilyChanged?: boolean;
  }
): Promise<{ ok: true } | { ok: false; error: string; conflicts: string[] }> {
  const fkCol = "boardProfileId" in params.target ? "board_profile_id" : "custom_board_profile_id";
  const fkVal = "boardProfileId" in params.target ? params.target.boardProfileId : params.target.customBoardProfileId;

  const { data: ctrlRows } = await db
    .from("board_instances")
    .select("id,name")
    .eq(fkCol, fkVal)
    .is("deleted_at", null);

  const controllers = (ctrlRows ?? []) as Array<{ id: string; name: string }>;
  if (controllers.length === 0) {
    return { ok: true };
  }

  if (params.chipFamilyChanged) {
    return {
      ok: false,
      error: `Cannot change chip family while ${controllers.length} active controller${controllers.length === 1 ? " uses" : "s use"} this board.`,
      conflicts: controllers.map((c) => c.name),
    };
  }

  const controllerIds = controllers.map((c) => c.id);
  const ctrlNameById = new Map(controllers.map((c) => [c.id, c.name]));

  const [devRes, swRes, senRes] = await Promise.all([
    db
      .from("devices")
      .select("id,name,board_instance_id,device_type,gpio_pin")
      .in("board_instance_id", controllerIds)
      .is("deleted_at", null),
    db
      .from("switches")
      .select("id,name,board_instance_id,gpio_pin")
      .in("board_instance_id", controllerIds)
      .is("deleted_at", null),
    db
      .from("sensors")
      .select("id,name,board_instance_id,sensor_type,gpio_pin")
      .in("board_instance_id", controllerIds)
      .is("deleted_at", null),
  ]);

  const pinByNum = new Map(params.nextGpios.map((g) => [g.pin, g]));
  const conflicts: string[] = [];

  const checkPin = (
    pin: number,
    requirement: PinOperationRequirement,
    entityDesc: string,
    requireBidirectional = false
  ) => {
    const def = pinByNum.get(pin);
    if (!def) {
      conflicts.push(`${entityDesc} uses GPIO${pin}, which would be removed.`);
      return;
    }
    if (def.restrictions.reserved || def.restrictions.flash_psram_conflict) {
      conflicts.push(`${entityDesc} uses GPIO${pin}, which would become reserved/blocked.`);
      return;
    }
    if (
      (requirement === "digital_out" || requirement === "pwm" || requireBidirectional) &&
      (def.restrictions.input_only || !def.capabilities.digital_out)
    ) {
      conflicts.push(`${entityDesc} uses GPIO${pin}, which would lose required output capability.`);
      return;
    }
    if (!def.capabilities[requirement]) {
      conflicts.push(
        `${entityDesc} uses GPIO${pin}, which would no longer support ${requirement.replace("_", " ")}.`
      );
    }
  };

  for (const dev of (devRes.data ?? []) as Array<{
    name: string;
    board_instance_id: string;
    device_type: string;
    gpio_pin: number;
  }>) {
    const req: PinOperationRequirement = isSupportedDeviceType(dev.device_type)
      ? requiredPinCapabilityForDevice(dev.device_type)
      : "digital_out";
    checkPin(
      dev.gpio_pin,
      req,
      `Device "${dev.name}" on ${ctrlNameById.get(dev.board_instance_id) ?? "controller"}`
    );
  }

  for (const sw of (swRes.data ?? []) as Array<{
    name: string;
    board_instance_id: string;
    gpio_pin: number;
  }>) {
    checkPin(
      sw.gpio_pin,
      "digital_out",
      `Switch "${sw.name}" on ${ctrlNameById.get(sw.board_instance_id) ?? "controller"}`
    );
  }

  for (const sen of (senRes.data ?? []) as Array<{
    name: string;
    board_instance_id: string;
    sensor_type: string;
    gpio_pin: number | null;
  }>) {
    if (sen.gpio_pin === null || sen.gpio_pin === undefined) continue;
    const req: PinOperationRequirement = isSupportedSensorType(sen.sensor_type)
      ? requiredPinCapabilityForSensor(sen.sensor_type)
      : "digital_in";
    const driver = getSensorDriverForMeasurement(sen.sensor_type);
    checkPin(
      sen.gpio_pin,
      req,
      `Sensor "${sen.name}" on ${ctrlNameById.get(sen.board_instance_id) ?? "controller"}`,
      Boolean(driver?.requiresBidirectionalGpio)
    );
  }

  if (conflicts.length > 0) {
    return {
      ok: false,
      error: `Board pin update conflicts with active hardware assignments: ${conflicts[0]}`,
      conflicts,
    };
  }

  return { ok: true };
}
