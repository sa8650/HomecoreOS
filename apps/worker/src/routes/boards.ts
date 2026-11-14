import { Hono } from "hono";
import { z } from "zod";
import {
  SUPPORTED_CHIP_FAMILIES,
  evaluateReleaseCompatibilityForBoard,
  resolveBoardFirmwareCompatibility,
  validateBoardProfileSpec,
  type BoardProfileSpec,
} from "@homecoreos/shared";
import { recordActivity } from "../lib/audit";
import { generateSlugSuffix } from "../lib/crypto";
import { requireStaffRole, requireUserSession } from "../middleware/auth";
import type { AppEnv } from "../types/context";

const gpioPinSchema = z.object({
  pin: z.number().int().min(0).max(54),
  label: z.string().trim().min(1).max(64),
  board_pin_name: z.string().trim().max(48).nullable().optional(),
  header_side: z.enum(["left", "right"]).nullable().optional(),
  header_position: z.number().int().min(1).max(40).nullable().optional(),
  board_note: z.string().trim().max(160).nullable().optional(),
  capabilities: z.object({
    digital_in: z.boolean(),
    digital_out: z.boolean(),
    pwm: z.boolean(),
    adc: z.boolean(),
    i2c: z.boolean(),
    spi: z.boolean(),
    uart: z.boolean(),
    touch: z.boolean(),
    pull_up: z.boolean(),
    pull_down: z.boolean(),
  }),
  restrictions: z.object({
    input_only: z.boolean(),
    reserved: z.boolean(),
    reserved_reason: z.string().max(200).optional(),
    strapping_pin: z.boolean(),
    strapping_note: z.string().max(200).optional(),
    flash_psram_conflict: z.boolean(),
    usb_jtag_conflict: z.boolean(),
  }),
});

const customBoardSchema = z.object({
  manufacturer: z.string().trim().min(1).max(80),
  model: z.string().trim().min(1).max(120),
  revision: z.string().trim().min(1).max(32).default("v1.0"),
  chipFamily: z.enum(SUPPORTED_CHIP_FAMILIES),
  chipVariant: z.string().trim().min(1).max(80),
  flashSizeMb: z.number().int().min(2).max(64),
  psramSizeMb: z.number().int().min(0).max(32),
  imageUrl: z.string().max(500).nullable().optional(),
  docsUrl: z.string().max(500).nullable().optional(),
  boardLayout: z.record(z.unknown()).nullable().optional(),
  gpioDefinitions: z.array(gpioPinSchema).min(1).max(60),
});

export function createBoardRoutes() {
  const app = new Hono<AppEnv>();
  app.use("*", requireUserSession());

  app.get("/catalog", async (c) => {
    const db = c.get("db");
    const search = (c.req.query("search") ?? "").trim().toLowerCase();
    const chip = (c.req.query("chip") ?? "").trim().toLowerCase();
    const category = (c.req.query("category") ?? "").trim().toLowerCase();
    const firmwareStatusFilter = (c.req.query("firmwareStatus") ?? "").trim().toLowerCase();
    const includeGpio = c.req.query("includeGpio") !== "false";

    const [settingsRes, boardsRes, releasesRes, gpiosRes] = await Promise.all([
      db
        .from("platform_settings")
        .select("board_catalog_enabled")
        .eq("id", 1)
        .maybeSingle(),
      db
        .from("board_catalog")
        .select("*")
        .eq("is_available", true)
        .eq("verification_status", "verified")
        .is("deleted_at", null)
        .order("manufacturer", { ascending: true }),
      db
        .from("firmware_releases")
        .select(
          "id,name,version,channel,chip_family,target_board_slug,partition_scheme,psram_mode,flash_size_mb,compatible_board_ids,compatible_board_slugs"
        )
        .eq("status", "published")
        .is("deleted_at", null),
      includeGpio
        ? db
            .from("board_gpio_definitions")
            .select("board_catalog_id,pin,label,board_pin_name,header_side,header_position,board_note,capabilities,restrictions")
            .not("board_catalog_id", "is", null)
            .order("pin", { ascending: true })
        : Promise.resolve({ data: null }),
    ]);

    const settings = settingsRes.data;
    if (settings && (settings as { board_catalog_enabled: boolean }).board_catalog_enabled === false) {
      return c.json({ boards: [], catalogDisabled: true });
    }

    const boards = boardsRes.data;
    const releases = releasesRes.data;

    const list = ((boards ?? []) as Array<{
      id: string;
      slug: string;
      manufacturer: string;
      model: string;
      revision: string;
      chip_family: string;
      chip_variant: string;
      flash_size_mb: number;
      psram_size_mb: number;
      usb_vid: string | null;
      usb_pid: string | null;
      description: string | null;
      catalog_category?: string;
      series?: string | null;
      image_url?: string | null;
      pinout_image_url?: string | null;
      docs_url?: string | null;
      datasheet_url?: string | null;
      source_url?: string | null;
      source_provider?: string | null;
      verification_status?: string;
      firmware_status?: string;
      board_layout?: Record<string, unknown> | null;
      revision_notes?: string | null;
    }>)
      .filter((b) => {
        if (chip && b.chip_family.toLowerCase() !== chip) return false;
        if (category && (b.catalog_category ?? "official_espressif").toLowerCase() !== category) {
          return false;
        }
        if (
          firmwareStatusFilter &&
          (b.firmware_status ?? "catalog_only").toLowerCase() !== firmwareStatusFilter
        ) {
          return false;
        }
        if (search) {
          const hay = `${b.manufacturer} ${b.model} ${b.chip_variant} ${b.slug} ${b.series ?? ""}`.toLowerCase();
          if (!hay.includes(search)) return false;
        }
        return true;
      })
      .sort((a, b) => {
        const score = (x: typeof a) =>
          (x.firmware_status === "firmware_supported" ? 0 : 10) +
          (x.catalog_category === "official_espressif" ? 0 : x.catalog_category === "partner" ? 1 : 2);
        const diff = score(a) - score(b);
        if (diff !== 0) return diff;
        return a.model.localeCompare(b.model);
      });

    const gpioByBoard = new Map<string, unknown[]>();
    if (includeGpio && gpiosRes.data) {
      for (const g of gpiosRes.data as Array<{ board_catalog_id: string }>) {
        const arr = gpioByBoard.get(g.board_catalog_id) ?? [];
        arr.push(g);
        gpioByBoard.set(g.board_catalog_id, arr);
      }
    }

    const enriched = list.map((b) => {
      const compat = resolveBoardFirmwareCompatibility(b as unknown as BoardProfileSpec);
      const boardWithCompat = {
        ...b,
        ...compat,
        board_layout: (b.board_layout ?? null) as BoardProfileSpec["board_layout"],
      };
      const compatReleases = ((releases ?? []) as Array<{
        id: string;
        name: string;
        version: string;
        channel: string;
        chip_family: string;
        target_board_slug?: string | null;
        partition_scheme?: string | null;
        psram_mode?: string | null;
        flash_size_mb?: number | null;
        compatible_board_ids: string[];
        compatible_board_slugs?: string[];
      }>).filter((r) => {
        const hasExplicitBoards =
          (r.compatible_board_ids?.length ?? 0) > 0 ||
          (r.compatible_board_slugs?.length ?? 0) > 0;
        if (!hasExplicitBoards && b.firmware_status !== "firmware_supported") {
          return false;
        }
        return evaluateReleaseCompatibilityForBoard({
          release: r,
          board: boardWithCompat,
        }).compatible;
      });
      return {
        ...boardWithCompat,
        gpio_definitions: gpioByBoard.get(b.id) ?? [],
        compatible_firmware_count: compatReleases.length,
        latest_firmware: compatReleases[0] ?? null,
      };
    });

    return c.json({ boards: enriched });
  });

  app.get("/my-boards", async (c) => {
    const auth = c.get("userAuth")!;
    const db = c.get("db");

    const [savedRes, ctrlRes, customRes] = await Promise.all([
      db
        .from("account_saved_boards")
        .select("board_catalog_id")
        .eq("account_id", auth.accountId),
      db
        .from("controllers")
        .select("board_catalog_id")
        .eq("account_id", auth.accountId)
        .is("deleted_at", null),
      db
        .from("custom_boards")
        .select("*")
        .eq("account_id", auth.accountId)
        .is("deleted_at", null)
        .order("created_at", { ascending: false }),
    ]);

    const catalogIdSet = new Set<string>();
    for (const s of (savedRes.data ?? []) as Array<{ board_catalog_id: string }>) {
      catalogIdSet.add(s.board_catalog_id);
    }
    for (const ct of (ctrlRes.data ?? []) as Array<{ board_catalog_id: string | null }>) {
      if (ct.board_catalog_id) catalogIdSet.add(ct.board_catalog_id);
    }

    let catalogBoards: Array<Record<string, unknown>> = [];
    const catalogIds = Array.from(catalogIdSet);
    if (catalogIds.length > 0) {
      const [bRes, gRes] = await Promise.all([
        db
          .from("board_catalog")
          .select("*")
          .in("id", catalogIds)
          .is("deleted_at", null),
        db
          .from("board_gpio_definitions")
          .select("board_catalog_id,pin,label,board_pin_name,header_side,header_position,board_note,capabilities,restrictions")
          .in("board_catalog_id", catalogIds)
          .order("pin", { ascending: true }),
      ]);

      const gpioMap = new Map<string, unknown[]>();
      for (const g of (gRes.data ?? []) as Array<{ board_catalog_id: string }>) {
        const arr = gpioMap.get(g.board_catalog_id) ?? [];
        arr.push(g);
        gpioMap.set(g.board_catalog_id, arr);
      }

      catalogBoards = ((bRes.data ?? []) as Array<Record<string, unknown>>).map(
        (b) => ({
          ...b,
          source: "catalog",
          gpio_definitions: gpioMap.get(String(b.id)) ?? [],
        })
      );
    }

    const customBoardsRaw = (customRes.data ?? []) as Array<Record<string, unknown>>;
    const customIds = customBoardsRaw.map((b) => String(b.id));
    let customBoards = customBoardsRaw;
    if (customIds.length > 0) {
      const { data: cg } = await db
        .from("board_gpio_definitions")
        .select("custom_board_id,pin,label,capabilities,restrictions")
        .in("custom_board_id", customIds)
        .order("pin", { ascending: true });
      const cgMap = new Map<string, unknown[]>();
      for (const g of (cg ?? []) as Array<{ custom_board_id: string }>) {
        const arr = cgMap.get(g.custom_board_id) ?? [];
        arr.push(g);
        cgMap.set(g.custom_board_id, arr);
      }
      customBoards = customBoardsRaw.map((b) => ({
        ...b,
        source: "custom",
        gpio_definitions: cgMap.get(String(b.id)) ?? [],
      }));
    }

    return c.json({
      catalogBoards,
      customBoards,
    });
  });

  app.post(
    "/my-boards/:catalogId",
    requireStaffRole("owner", "administrator"),
    async (c) => {
      const auth = c.get("userAuth")!;
      const db = c.get("db");
      const catalogId = c.req.param("catalogId");

      const { data: exists } = await db
        .from("board_catalog")
        .select("id")
        .eq("id", catalogId)
        .eq("is_available", true)
        .is("deleted_at", null)
        .maybeSingle();

      if (!exists) return c.json({ error: "Board catalog entry not found." }, 404);

      await db.from("account_saved_boards").upsert(
        {
          account_id: auth.accountId,
          board_catalog_id: catalogId,
        },
        { onConflict: "account_id,board_catalog_id" }
      );

      return c.json({ ok: true }, 201);
    }
  );

  app.delete(
    "/my-boards/:catalogId",
    requireStaffRole("owner", "administrator"),
    async (c) => {
      const auth = c.get("userAuth")!;
      const db = c.get("db");
      await db
        .from("account_saved_boards")
        .delete()
        .eq("account_id", auth.accountId)
        .eq("board_catalog_id", c.req.param("catalogId"));
      return c.json({ ok: true });
    }
  );

  // Custom Boards
  app.get("/custom", async (c) => {
    const auth = c.get("userAuth")!;
    const db = c.get("db");
    const { data } = await db
      .from("custom_boards")
      .select("*")
      .eq("account_id", auth.accountId)
      .is("deleted_at", null)
      .order("created_at", { ascending: false });

    const boards = (data ?? []) as Array<Record<string, unknown>>;
    const ids = boards.map((b) => String(b.id));
    if (ids.length === 0) return c.json({ boards: [] });

    const { data: gpios } = await db
      .from("board_gpio_definitions")
      .select("custom_board_id,pin,label,capabilities,restrictions")
      .in("custom_board_id", ids)
      .order("pin", { ascending: true });

    const map = new Map<string, unknown[]>();
    for (const g of (gpios ?? []) as Array<{ custom_board_id: string }>) {
      const arr = map.get(g.custom_board_id) ?? [];
      arr.push(g);
      map.set(g.custom_board_id, arr);
    }

    return c.json({
      boards: boards.map((b) => ({
        ...b,
        gpio_definitions: map.get(String(b.id)) ?? [],
      })),
    });
  });

  app.post(
    "/custom",
    requireStaffRole("owner", "administrator"),
    async (c) => {
      const body = await c.req.json().catch(() => null);
      const parsed = customBoardSchema.safeParse(body);
      if (!parsed.success) {
        return c.json(
          { error: "Invalid custom board fields.", details: parsed.error.flatten() },
          400
        );
      }

      const auth = c.get("userAuth")!;
      const slug = `${parsed.data.manufacturer}-${parsed.data.model}-${generateSlugSuffix(4)}`
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");

      const spec: BoardProfileSpec = {
        slug,
        manufacturer: parsed.data.manufacturer,
        model: parsed.data.model,
        revision: parsed.data.revision,
        chip_family: parsed.data.chipFamily,
        chip_variant: parsed.data.chipVariant,
        flash_size_mb: parsed.data.flashSizeMb,
        psram_size_mb: parsed.data.psramSizeMb,
        gpio_definitions: parsed.data.gpioDefinitions,
      };

      const validation = validateBoardProfileSpec(spec);
      if (!validation.valid) {
        return c.json(
          { error: "Board profile validation failed.", details: validation.errors },
          400
        );
      }

      const db = c.get("db");
      const compat = resolveBoardFirmwareCompatibility(spec);
      const { data: board, error } = await db
        .from("custom_boards")
        .insert({
          account_id: auth.accountId,
          slug,
          manufacturer: spec.manufacturer,
          model: spec.model,
          revision: spec.revision,
          chip_family: spec.chip_family,
          chip_variant: spec.chip_variant,
          flash_size_mb: spec.flash_size_mb,
          psram_size_mb: spec.psram_size_mb,
          catalog_category: "custom",
          partition_scheme: compat.partition_scheme,
          psram_mode: compat.psram_mode,
          flash_mode: compat.flash_mode,
          flash_freq: compat.flash_freq,
          bootloader_offset: compat.bootloader_offset,
          ota_app_offset: compat.ota_app_offset,
          boot_button_gpio: compat.boot_button_gpio,
          usb_interface: compat.usb_interface,
          supports_wifi: compat.supports_wifi,
          supports_ble: compat.supports_ble,
          supports_ble_wifi_provisioning: compat.supports_ble_wifi_provisioning,
          supports_ota_rollback: compat.supports_ota_rollback,
          firmware_compat_key: compat.firmware_compat_key,
          connectivity_note: compat.connectivity_note,
          image_url: parsed.data.imageUrl ?? null,
          docs_url: parsed.data.docsUrl ?? null,
          board_layout: parsed.data.boardLayout ?? {},
          is_validated: true,
          created_by: auth.userId,
        })
        .select("*")
        .single();

      if (error || !board) {
        return c.json({ error: error?.message ?? "Failed to create custom board." }, 400);
      }

      const boardId = (board as { id: string }).id;
      await db.from("board_gpio_definitions").insert(
        spec.gpio_definitions.map((g) => ({
          custom_board_id: boardId,
          pin: g.pin,
          label: g.label,
          board_pin_name: g.board_pin_name ?? null,
          header_side: g.header_side ?? null,
          header_position: g.header_position ?? null,
          board_note: g.board_note ?? null,
          capabilities: g.capabilities,
          restrictions: g.restrictions,
        }))
      );

      await recordActivity(db, {
        accountId: auth.accountId,
        actorUserId: auth.userId,
        category: "account",
        action: "custom_board.created",
        summary: `Created validated custom board "${spec.manufacturer} ${spec.model}"`,
      });

      return c.json(
        {
          board: {
            ...(board as Record<string, unknown>),
            gpio_definitions: spec.gpio_definitions,
          },
        },
        201
      );
    }
  );

  app.patch(
    "/custom/:id",
    requireStaffRole("owner", "administrator"),
    async (c) => {
      const body = await c.req.json().catch(() => null);
      const parsed = customBoardSchema.safeParse(body);
      if (!parsed.success) {
        return c.json({ error: "Invalid custom board payload." }, 400);
      }

      const auth = c.get("userAuth")!;
      const db = c.get("db");
      const boardId = c.req.param("id");

      const { data: existing } = await db
        .from("custom_boards")
        .select("id,slug")
        .eq("id", boardId)
        .eq("account_id", auth.accountId)
        .is("deleted_at", null)
        .maybeSingle();

      if (!existing) return c.json({ error: "Custom board not found." }, 404);

      const spec: BoardProfileSpec = {
        slug: (existing as { slug: string }).slug,
        manufacturer: parsed.data.manufacturer,
        model: parsed.data.model,
        revision: parsed.data.revision,
        chip_family: parsed.data.chipFamily,
        chip_variant: parsed.data.chipVariant,
        flash_size_mb: parsed.data.flashSizeMb,
        psram_size_mb: parsed.data.psramSizeMb,
        gpio_definitions: parsed.data.gpioDefinitions,
      };

      const validation = validateBoardProfileSpec(spec);
      if (!validation.valid) {
        return c.json(
          { error: "Board profile validation failed.", details: validation.errors },
          400
        );
      }

      const compat = resolveBoardFirmwareCompatibility(spec);
      const { data: updated, error } = await db
        .from("custom_boards")
        .update({
          manufacturer: spec.manufacturer,
          model: spec.model,
          revision: spec.revision,
          chip_family: spec.chip_family,
          chip_variant: spec.chip_variant,
          flash_size_mb: spec.flash_size_mb,
          psram_size_mb: spec.psram_size_mb,
          partition_scheme: compat.partition_scheme,
          psram_mode: compat.psram_mode,
          flash_mode: compat.flash_mode,
          flash_freq: compat.flash_freq,
          bootloader_offset: compat.bootloader_offset,
          ota_app_offset: compat.ota_app_offset,
          boot_button_gpio: compat.boot_button_gpio,
          usb_interface: compat.usb_interface,
          supports_wifi: compat.supports_wifi,
          supports_ble: compat.supports_ble,
          supports_ble_wifi_provisioning: compat.supports_ble_wifi_provisioning,
          supports_ota_rollback: compat.supports_ota_rollback,
          firmware_compat_key: compat.firmware_compat_key,
          connectivity_note: compat.connectivity_note,
          ...(parsed.data.imageUrl !== undefined ? { image_url: parsed.data.imageUrl } : {}),
          ...(parsed.data.docsUrl !== undefined ? { docs_url: parsed.data.docsUrl } : {}),
          ...(parsed.data.boardLayout !== undefined
            ? { board_layout: parsed.data.boardLayout ?? {} }
            : {}),
          is_validated: true,
        })
        .eq("id", boardId)
        .eq("account_id", auth.accountId)
        .select("*")
        .single();

      if (error) return c.json({ error: error.message }, 400);

      await db
        .from("board_gpio_definitions")
        .delete()
        .eq("custom_board_id", boardId);
      await db.from("board_gpio_definitions").insert(
        spec.gpio_definitions.map((g) => ({
          custom_board_id: boardId,
          pin: g.pin,
          label: g.label,
          board_pin_name: g.board_pin_name ?? null,
          header_side: g.header_side ?? null,
          header_position: g.header_position ?? null,
          board_note: g.board_note ?? null,
          capabilities: g.capabilities,
          restrictions: g.restrictions,
        }))
      );

      return c.json({
        board: {
          ...(updated as Record<string, unknown>),
          gpio_definitions: spec.gpio_definitions,
        },
      });
    }
  );

  app.delete(
    "/custom/:id",
    requireStaffRole("owner", "administrator"),
    async (c) => {
      const auth = c.get("userAuth")!;
      const db = c.get("db");
      const boardId = c.req.param("id");

      const { count } = await db
        .from("controllers")
        .select("id", { count: "exact", head: true })
        .eq("account_id", auth.accountId)
        .eq("custom_board_id", boardId)
        .is("deleted_at", null);

      if ((count ?? 0) > 0) {
        return c.json(
          { error: "Cannot delete a custom board currently assigned to an active controller." },
          409
        );
      }

      const { data } = await db
        .from("custom_boards")
        .update({ deleted_at: new Date().toISOString() })
        .eq("id", boardId)
        .eq("account_id", auth.accountId)
        .is("deleted_at", null)
        .select("id")
        .maybeSingle();

      if (!data) return c.json({ error: "Custom board not found." }, 404);
      return c.json({ ok: true });
    }
  );

  return app;
}
