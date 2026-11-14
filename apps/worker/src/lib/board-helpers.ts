import {
  resolveBoardFirmwareCompatibility,
  type BoardProfileSpec,
  type GpioPinDefinition,
} from "@homecoreos/shared";
import type { DbClient } from "./db";

export async function resolveControllerBoardSpec(
  db: DbClient,
  controller: {
    board_catalog_id: string | null;
    custom_board_id: string | null;
  }
): Promise<BoardProfileSpec | null> {
  if (controller.board_catalog_id) {
    const { data: board } = await db
      .from("board_catalog")
      .select("*")
      .eq("id", controller.board_catalog_id)
      .is("deleted_at", null)
      .maybeSingle();
    if (!board) return null;

    const { data: gpios } = await db
      .from("board_gpio_definitions")
      .select("pin,label,board_pin_name,header_side,header_position,board_note,capabilities,restrictions")
      .eq("board_catalog_id", controller.board_catalog_id)
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

  if (controller.custom_board_id) {
    const { data: board } = await db
      .from("custom_boards")
      .select("*")
      .eq("id", controller.custom_board_id)
      .is("deleted_at", null)
      .maybeSingle();
    if (!board) return null;

    const { data: gpios } = await db
      .from("board_gpio_definitions")
      .select("pin,label,board_pin_name,header_side,header_position,board_note,capabilities,restrictions")
      .eq("custom_board_id", controller.custom_board_id)
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
  controllerId: string,
  exclude?: { table: "devices" | "switches" | "sensors"; id: string }
): Promise<number[]> {
  const [devRes, swRes, sensRes] = await Promise.all([
    db
      .from("devices")
      .select("id,gpio_pin")
      .eq("account_id", accountId)
      .eq("controller_id", controllerId)
      .is("deleted_at", null),
    db
      .from("switches")
      .select("id,gpio_pin")
      .eq("account_id", accountId)
      .eq("controller_id", controllerId)
      .is("deleted_at", null),
    db
      .from("sensors")
      .select("id,gpio_pin")
      .eq("account_id", accountId)
      .eq("controller_id", controllerId)
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
  }>) {
    if (row.gpio_pin === null || row.gpio_pin === undefined) continue;
    if (exclude?.table === "sensors" && exclude.id === row.id) continue;
    used.push(row.gpio_pin);
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
