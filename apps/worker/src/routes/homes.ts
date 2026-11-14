import { Hono } from "hono";
import { z } from "zod";
import {
  ROOM_TYPES,
  inferRoomTypeFromName,
  isDeviceStateActive,
  isValidIanaTimezone,
  resolveEffectiveTimezone,
  type RoomType,
} from "@homecoreos/shared";
import { recordActivity } from "../lib/audit";
import { requireStaffRole, requireUserSession } from "../middleware/auth";
import type { AppEnv } from "../types/context";

const homeSchema = z.object({
  name: z.string().trim().min(1).max(120),
  timezone: z.string().trim().min(1).max(64).optional(),
});

const openingSchema = z.object({
  id: z.string().trim().min(1).max(64),
  wall: z.enum(["top", "right", "bottom", "left"]),
  offset: z.number().min(0.05).max(0.95),
  width: z.number().min(20).max(200).optional(),
  hinge: z.enum(["start", "end"]).optional(),
  swing: z.enum(["in", "out"]).optional(),
});

const layoutConfigSchema = z.object({
  floorStyle: z.enum(["wood", "tile", "stone", "carpet"]).optional(),
  doors: z.array(openingSchema).max(12).optional(),
  windows: z.array(openingSchema).max(12).optional(),
  rotation: z.number().int().min(0).max(270).optional(),
});

const roomSchema = z.object({
  homeId: z.string().uuid(),
  name: z.string().trim().min(1).max(120),
  icon: z.string().trim().min(1).max(64).default("RiHomeLine"),
  floorOrder: z.number().int().min(0).max(500).default(0),
  gridColSpan: z.number().int().min(1).max(3).default(1),
  roomType: z.enum(ROOM_TYPES).optional(),
  floorX: z.number().int().min(-2000).max(4000).optional(),
  floorY: z.number().int().min(-2000).max(4000).optional(),
  floorW: z.number().int().min(120).max(1200).optional(),
  floorH: z.number().int().min(120).max(1200).optional(),
  layoutConfig: layoutConfigSchema.optional(),
});

const roomUpdateSchema = z.object({
  homeId: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(120).optional(),
  icon: z.string().trim().min(1).max(64).optional(),
  floorOrder: z.number().int().min(0).max(500).optional(),
  gridColSpan: z.number().int().min(1).max(3).optional(),
  roomType: z.enum(ROOM_TYPES).optional(),
  floorX: z.number().int().min(-2000).max(4000).optional(),
  floorY: z.number().int().min(-2000).max(4000).optional(),
  floorW: z.number().int().min(120).max(1200).optional(),
  floorH: z.number().int().min(120).max(1200).optional(),
  layoutConfig: layoutConfigSchema.optional(),
});

function defaultDimensionsForType(
  roomType: RoomType,
  gridColSpan: number
): { w: number; h: number; floorStyle: "wood" | "tile" | "stone" | "carpet" } {
  const spanBoost = gridColSpan >= 2 ? 120 : 0;
  switch (roomType) {
    case "living_room":
      return { w: 360 + spanBoost, h: 280, floorStyle: "wood" };
    case "bedroom":
      return { w: 300 + spanBoost, h: 260, floorStyle: "wood" };
    case "kitchen":
      return { w: 320 + spanBoost, h: 240, floorStyle: "wood" };
    case "dining":
      return { w: 300 + spanBoost, h: 240, floorStyle: "wood" };
    case "bathroom":
      return { w: 220 + spanBoost, h: 220, floorStyle: "tile" };
    case "toilet":
      return { w: 160, h: 160, floorStyle: "tile" };
    case "hallway":
      return { w: 340 + spanBoost, h: 140, floorStyle: "tile" };
    case "patio":
      return { w: 220, h: 260, floorStyle: "stone" };
    case "office":
      return { w: 260 + spanBoost, h: 220, floorStyle: "wood" };
    case "garage":
      return { w: 360, h: 300, floorStyle: "stone" };
    default:
      return { w: 280 + spanBoost, h: 220, floorStyle: "wood" };
  }
}

function computeConnectedRoomSlot(
  existingRooms: Array<{ floor_x: number; floor_y: number; floor_w: number; floor_h: number }>,
  w: number,
  h: number
): { x: number; y: number } {
  if (existingRooms.length === 0) {
    return { x: 0, y: 0 };
  }
  const overlaps = (x: number, y: number) =>
    existingRooms.some(
      (r) =>
        x < r.floor_x + r.floor_w &&
        x + w > r.floor_x &&
        y < r.floor_y + r.floor_h &&
        y + h > r.floor_y
    );

  const candidates: Array<{ x: number; y: number; score: number }> = [];
  for (const r of existingRooms) {
    const spots = [
      { x: r.floor_x + r.floor_w, y: r.floor_y },
      { x: r.floor_x, y: r.floor_y + r.floor_h },
      { x: r.floor_x - w, y: r.floor_y },
      { x: r.floor_x, y: r.floor_y - h },
    ];
    for (const s of spots) {
      if (s.x < 0 || s.y < 0) continue;
      if (!overlaps(s.x, s.y)) {
        const dist = Math.hypot(s.x + w / 2, s.y + h / 2);
        candidates.push({ ...s, score: dist });
      }
    }
  }
  candidates.sort((a, b) => a.score - b.score);
  if (candidates[0]) {
    return { x: candidates[0].x, y: candidates[0].y };
  }
  const maxRight = Math.max(...existingRooms.map((r) => r.floor_x + r.floor_w));
  return { x: maxRight, y: 0 };
}

export function createHomeRoutes() {
  const app = new Hono<AppEnv>();
  app.use("*", requireUserSession());

  app.get("/overview", async (c) => {
    const auth = c.get("userAuth")!;
    const db = c.get("db");
    const accountId = auth.accountId;

    const [homesRes, roomsRes, controllersRes, devicesRes, switchesRes, sensorsRes, activityRes] =
      await Promise.all([
        db.from("homes").select("id,account_id,name,timezone").eq("account_id", accountId).is("deleted_at", null).order("created_at", { ascending: true }),
        db.from("rooms").select("id,account_id,home_id,name,icon,floor_order,grid_col_span,room_type,floor_x,floor_y,floor_w,floor_h,layout_config").eq("account_id", accountId).is("deleted_at", null).order("floor_order", { ascending: true }),
        db.from("controllers").select("id,account_id,home_id,board_catalog_id,custom_board_id,name,hardware_uid,board_model,chip_variant,flash_size_mb,psram_size_mb,firmware_version,status,pairing_status,wifi_connected,mqtt_connected,wifi_ssid,wifi_rssi,local_ip,last_heartbeat_at,last_communication_at,paired_at").eq("account_id", accountId).is("deleted_at", null).is("permanently_deleted_at", null).order("created_at", { ascending: false }),
        db.from("devices").select("id,account_id,home_id,room_id,controller_id,name,device_type,gpio_pin,state,is_online").eq("account_id", accountId).is("deleted_at", null).order("created_at", { ascending: false }),
        db.from("switches").select("id,account_id,home_id,room_id,controller_id,name,gpio_pin,inverted,is_on,is_online,last_changed_at").eq("account_id", accountId).is("deleted_at", null).order("created_at", { ascending: false }),
        db.from("sensors").select("id,account_id,home_id,room_id,controller_id,name,sensor_type,gpio_pin,unit,last_value,last_reading_at,is_online").eq("account_id", accountId).is("deleted_at", null).order("created_at", { ascending: false }),
        db.from("activity_logs").select("id,category,action,summary,created_at").eq("account_id", accountId).order("created_at", { ascending: false }).limit(20),
      ]);

    const controllers = (controllersRes.data ?? []) as Array<{ status: string }>;
    const onlineControllers = controllers.filter((x) => x.status === "online").length;
    const offlineControllers = controllers.length - onlineControllers;

    const devices = (devicesRes.data ?? []) as Array<{ is_online: boolean; state: string }>;
    const switches = (switchesRes.data ?? []) as Array<{ is_online: boolean; is_on: boolean }>;
    const sensors = sensorsRes.data ?? [];
    const rooms = roomsRes.data ?? [];

    return c.json({
      summary: {
        totalRooms: rooms.length,
        totalDevices: devices.length,
        activeDevices: devices.filter((d) => isDeviceStateActive(d.state)).length,
        totalSwitches: switches.length,
        activeSwitches: switches.filter((s) => s.is_on).length,
        totalSensors: sensors.length,
        totalControllers: controllers.length,
        onlineControllers,
        offlineControllers,
      },
      homes: homesRes.data ?? [],
      rooms,
      controllers,
      devices,
      switches,
      sensors,
      recentActivity: activityRes.data ?? [],
    });
  });

  app.get("/", async (c) => {
    const auth = c.get("userAuth")!;
    const db = c.get("db");
    const { data, error } = await db
      .from("homes")
      .select("*")
      .eq("account_id", auth.accountId)
      .is("deleted_at", null)
      .order("created_at", { ascending: true });
    if (error) return c.json({ error: error.message }, 400);
    return c.json({ homes: data ?? [] });
  });

  app.post("/", requireStaffRole("owner", "administrator"), async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = homeSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "Invalid home payload." }, 400);

    const auth = c.get("userAuth")!;
    if (parsed.data.timezone && !isValidIanaTimezone(parsed.data.timezone)) {
      return c.json({ error: "Invalid IANA timezone identifier." }, 400);
    }
    const db = c.get("db");
    let resolvedTimezone = parsed.data.timezone;
    if (!resolvedTimezone) {
      const { data: settings } = await db
        .from("platform_settings")
        .select("default_timezone")
        .eq("id", 1)
        .maybeSingle();
      resolvedTimezone = resolveEffectiveTimezone(
        auth.timezone,
        (settings as { default_timezone?: string } | null)?.default_timezone
      );
    }

    const { data, error } = await db
      .from("homes")
      .insert({
        account_id: auth.accountId,
        name: parsed.data.name,
        timezone: resolvedTimezone,
      })
      .select("*")
      .single();

    if (error) return c.json({ error: error.message }, 400);
    await recordActivity(db, {
      accountId: auth.accountId,
      actorUserId: auth.userId,
      category: "account",
      action: "home.created",
      summary: `Created home "${parsed.data.name}"`,
    });
    return c.json({ home: data }, 201);
  });

  // Rooms
  app.get("/rooms", async (c) => {
    const auth = c.get("userAuth")!;
    const db = c.get("db");
    const roomsRes = await db
      .from("rooms")
      .select("*")
      .eq("account_id", auth.accountId)
      .is("deleted_at", null)
      .order("floor_order", { ascending: true });
    return c.json({
      rooms: roomsRes.data ?? [],
    });
  });

  app.post("/rooms", requireStaffRole("owner", "administrator"), async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = roomSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "Invalid room payload." }, 400);

    const auth = c.get("userAuth")!;
    const db = c.get("db");
    const { data: home } = await db
      .from("homes")
      .select("id")
      .eq("id", parsed.data.homeId)
      .eq("account_id", auth.accountId)
      .is("deleted_at", null)
      .maybeSingle();

    if (!home) return c.json({ error: "Home not found in your account." }, 404);

    const roomType = parsed.data.roomType ?? inferRoomTypeFromName(parsed.data.name);
    const defaults = defaultDimensionsForType(roomType, parsed.data.gridColSpan);
    const floorW = parsed.data.floorW ?? defaults.w;
    const floorH = parsed.data.floorH ?? defaults.h;

    let floorX = parsed.data.floorX;
    let floorY = parsed.data.floorY;

    const { data: existingRooms } = await db
      .from("rooms")
      .select("floor_x,floor_y,floor_w,floor_h")
      .eq("home_id", parsed.data.homeId)
      .eq("account_id", auth.accountId)
      .is("deleted_at", null);

    const existingList = (existingRooms ?? []) as Array<{
      floor_x: number;
      floor_y: number;
      floor_w: number;
      floor_h: number;
    }>;

    if (floorX === undefined || floorY === undefined) {
      const slot = computeConnectedRoomSlot(existingList, floorW, floorH);
      floorX = floorX ?? slot.x;
      floorY = floorY ?? slot.y;
    }

    const layoutConfig = parsed.data.layoutConfig ?? {
      floorStyle: defaults.floorStyle,
      doors: [
        {
          id: "d1",
          wall: existingList.length === 0 ? "bottom" : "left",
          offset: 0.5,
          width: 56,
          hinge: "start",
          swing: "in",
        },
      ],
      windows:
        roomType === "toilet" || roomType === "hallway"
          ? []
          : [{ id: "w1", wall: "top", offset: 0.5, width: 84 }],
    };

    const { data, error } = await db
      .from("rooms")
      .insert({
        account_id: auth.accountId,
        home_id: parsed.data.homeId,
        name: parsed.data.name,
        icon: parsed.data.icon,
        floor_order: parsed.data.floorOrder || existingList.length,
        grid_col_span: parsed.data.gridColSpan,
        room_type: roomType,
        floor_x: floorX,
        floor_y: floorY,
        floor_w: floorW,
        floor_h: floorH,
        layout_config: layoutConfig,
      })
      .select("*")
      .single();

    if (error) return c.json({ error: error.message }, 400);
    await recordActivity(db, {
      accountId: auth.accountId,
      actorUserId: auth.userId,
      category: "account",
      action: "room.created",
      summary: `Created room "${parsed.data.name}"`,
    });
    return c.json({ room: data }, 201);
  });

  app.patch("/rooms/:id", requireStaffRole("owner", "administrator"), async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = roomUpdateSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "Invalid room update." }, 400);

    const auth = c.get("userAuth")!;
    const db = c.get("db");
    const updates: Record<string, unknown> = {};
    if (parsed.data.homeId !== undefined) {
      const { data: targetHome } = await db
        .from("homes")
        .select("id")
        .eq("id", parsed.data.homeId)
        .eq("account_id", auth.accountId)
        .is("deleted_at", null)
        .maybeSingle();
      if (!targetHome) return c.json({ error: "Home not found in your account." }, 404);
      updates.home_id = parsed.data.homeId;
    }
    if (parsed.data.name !== undefined) updates.name = parsed.data.name;
    if (parsed.data.icon !== undefined) updates.icon = parsed.data.icon;
    if (parsed.data.floorOrder !== undefined) updates.floor_order = parsed.data.floorOrder;
    if (parsed.data.gridColSpan !== undefined) updates.grid_col_span = parsed.data.gridColSpan;
    if (parsed.data.roomType !== undefined) updates.room_type = parsed.data.roomType;
    if (parsed.data.floorX !== undefined) updates.floor_x = parsed.data.floorX;
    if (parsed.data.floorY !== undefined) updates.floor_y = parsed.data.floorY;
    if (parsed.data.floorW !== undefined) updates.floor_w = parsed.data.floorW;
    if (parsed.data.floorH !== undefined) updates.floor_h = parsed.data.floorH;
    if (parsed.data.layoutConfig !== undefined) updates.layout_config = parsed.data.layoutConfig;

    if (Object.keys(updates).length === 0) {
      const { data: existingRoom } = await db
        .from("rooms")
        .select("*")
        .eq("id", c.req.param("id"))
        .eq("account_id", auth.accountId)
        .is("deleted_at", null)
        .maybeSingle();
      if (!existingRoom) return c.json({ error: "Room not found." }, 404);
      return c.json({ room: existingRoom });
    }

    const { data, error } = await db
      .from("rooms")
      .update(updates)
      .eq("id", c.req.param("id"))
      .eq("account_id", auth.accountId)
      .is("deleted_at", null)
      .select("*")
      .maybeSingle();

    if (error) return c.json({ error: error.message }, 400);
    if (!data) return c.json({ error: "Room not found." }, 404);
    return c.json({ room: data });
  });

  app.delete("/rooms/:id", requireStaffRole("owner", "administrator"), async (c) => {
    const auth = c.get("userAuth")!;
    const db = c.get("db");
    const roomId = c.req.param("id");
    const now = new Date().toISOString();

    const { data } = await db
      .from("rooms")
      .update({ deleted_at: now })
      .eq("id", roomId)
      .eq("account_id", auth.accountId)
      .is("deleted_at", null)
      .select("id,name")
      .maybeSingle();

    if (!data) return c.json({ error: "Room not found." }, 404);

    await db
      .from("devices")
      .update({ room_id: null })
      .eq("room_id", roomId)
      .eq("account_id", auth.accountId);
    await db
      .from("switches")
      .update({ room_id: null })
      .eq("room_id", roomId)
      .eq("account_id", auth.accountId);
    await db
      .from("sensors")
      .update({ room_id: null })
      .eq("room_id", roomId)
      .eq("account_id", auth.accountId);

    await recordActivity(db, {
      accountId: auth.accountId,
      actorUserId: auth.userId,
      category: "account",
      action: "room.deleted",
      summary: `Deleted room "${(data as { name: string }).name}"`,
    });

    return c.json({ ok: true });
  });

  return app;
}
