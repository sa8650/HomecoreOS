import { Hono } from "hono";
import { z } from "zod";
import {
  SUPPORTED_DEVICE_TYPES,
  SUPPORTED_SENSOR_TYPES,
  isDeviceStateActive,
  isSupportedDeviceType,
  isSupportedSensorType,
  requiredPinCapabilityForDevice,
  requiredPinCapabilityForSensor,
  validateGpioAssignment,
} from "@homecoreos/shared";
import { recordActivity } from "../lib/audit";
import { evaluateAutomationsForEvent } from "../lib/automation-engine";
import {
  checkPinSelectionPolicy,
  getUsedPinsOnController,
  resolveControllerBoardSpec,
  verifyHomeRoomOwnership,
} from "../lib/board-helpers";
import { syncControllerConfigSnapshot } from "../lib/controller-config";
import { EmqxClient, isEmqxConfigured } from "../lib/emqx";
import { requireStaffRole, requireUserSession } from "../middleware/auth";
import type { AppEnv } from "../types/context";

const deviceSchema = z.object({
  controllerId: z.string().uuid(),
  homeId: z.string().uuid().optional().nullable(),
  roomId: z.string().uuid().optional().nullable(),
  name: z.string().trim().min(1).max(120),
  deviceType: z.enum(SUPPORTED_DEVICE_TYPES),
  gpioPin: z.number().int().min(0).max(54),
  state: z.string().trim().min(1).max(64).default("idle"),
  config: z.record(z.unknown()).default({}),
});

const deviceCommandSchema = z.object({
  state: z.string().trim().min(1).max(64),
});

const switchSchema = z.object({
  controllerId: z.string().uuid(),
  homeId: z.string().uuid().optional().nullable(),
  roomId: z.string().uuid().optional().nullable(),
  name: z.string().trim().min(1).max(120),
  gpioPin: z.number().int().min(0).max(54),
  invertedLogic: z.boolean().default(false),
});

const switchToggleSchema = z.object({
  isOn: z.boolean(),
});

async function fetchControllerOnlineStatus(
  db: AppEnv["Variables"]["db"],
  controllerId: string,
  accountId: string
): Promise<boolean> {
  const { data } = await db
    .from("controllers")
    .select("status")
    .eq("id", controllerId)
    .eq("account_id", accountId)
    .maybeSingle();
  return (data as { status?: string } | null)?.status === "online";
}

const sensorSchema = z.object({
  controllerId: z.string().uuid(),
  homeId: z.string().uuid().optional().nullable(),
  roomId: z.string().uuid().optional().nullable(),
  name: z.string().trim().min(1).max(120),
  sensorType: z.string().trim().min(1).max(64),
  gpioPin: z.number().int().min(0).max(54).optional().nullable(),
  i2cAddress: z.string().trim().max(16).optional().nullable(),
  unit: z.string().trim().min(1).max(24).default("unit"),
  config: z.record(z.unknown()).default({}),
});

const deviceUpdateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  roomId: z.string().uuid().nullable().optional(),
  controllerId: z.string().uuid().optional(),
  deviceType: z.enum(SUPPORTED_DEVICE_TYPES).optional(),
  gpioPin: z.number().int().min(0).max(54).optional(),
});

const switchUpdateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  roomId: z.string().uuid().nullable().optional(),
  controllerId: z.string().uuid().optional(),
  gpioPin: z.number().int().min(0).max(54).optional(),
  invertedLogic: z.boolean().optional(),
});

const sensorUpdateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  roomId: z.string().uuid().nullable().optional(),
  controllerId: z.string().uuid().optional(),
  sensorType: z.string().trim().min(1).max(64).optional(),
  gpioPin: z.number().int().min(0).max(54).nullable().optional(),
  i2cAddress: z.string().trim().max(16).nullable().optional(),
});

function defaultUnitForSensorType(st: string, fallback = "unit"): string {
  if (st.startsWith("temperature_")) return "°C";
  if (st.startsWith("humidity_")) return "%";
  if (st === "pressure_bme280") return "hPa";
  if (st === "light_bh1750") return "lx";
  if (st === "analog_voltage") return "V";
  return fallback;
}

export function createDeviceRoutes() {
  const app = new Hono<AppEnv>();
  for (const prefix of [
    "/devices",
    "/devices/*",
    "/switches",
    "/switches/*",
    "/sensors",
    "/sensors/*",
    "/activity",
  ]) {
    app.use(prefix, requireUserSession());
  }

  // ---------------- DEVICES ----------------
  app.get("/devices", async (c) => {
    const auth = c.get("userAuth")!;
    const db = c.get("db");
    const { data } = await db
      .from("devices")
      .select("*")
      .eq("account_id", auth.accountId)
      .is("deleted_at", null)
      .order("created_at", { ascending: false });
    return c.json({ devices: data ?? [], supportedDeviceTypes: SUPPORTED_DEVICE_TYPES });
  });

  app.post(
    "/devices",
    requireStaffRole("owner", "administrator"),
    async (c) => {
      const body = await c.req.json().catch(() => null);
      const parsed = deviceSchema.safeParse(body);
      if (!parsed.success || !isSupportedDeviceType(parsed.data.deviceType)) {
        return c.json({ error: "Invalid device fields or unsupported device type." }, 400);
      }

      const auth = c.get("userAuth")!;
      const db = c.get("db");

      const [{ data: settings }, { count: devCount }] = await Promise.all([
        db.from("platform_settings").select("max_devices_per_account").eq("id", 1).maybeSingle(),
        db.from("devices").select("id", { count: "exact", head: true }).eq("account_id", auth.accountId).is("deleted_at", null),
      ]);
      const limit = (settings as { max_devices_per_account?: number } | null)?.max_devices_per_account ?? 100;
      if ((devCount ?? 0) >= limit) {
        return c.json({ error: "Maximum device count reached for this account." }, 403);
      }

      const { data: ctrl } = await db
        .from("controllers")
        .select("id,home_id,board_catalog_id,custom_board_id,status")
        .eq("id", parsed.data.controllerId)
        .eq("account_id", auth.accountId)
        .is("deleted_at", null)
        .maybeSingle();

      if (!ctrl) return c.json({ error: "Controller not found in your account." }, 404);
      const ctrlRow = ctrl as {
        id: string;
        home_id: string;
        board_catalog_id: string | null;
        custom_board_id: string | null;
      };

      const loc = await verifyHomeRoomOwnership(db, auth.accountId, {
        homeId: parsed.data.homeId ?? ctrlRow.home_id,
        roomId: parsed.data.roomId,
      });
      if (!loc.ok) return c.json({ error: loc.error }, 400);

      const board = await resolveControllerBoardSpec(db, ctrlRow);
      if (!board) return c.json({ error: "Controller board profile missing." }, 400);

      const usedPins = await getUsedPinsOnController(db, auth.accountId, ctrlRow.id);
      const requirement = requiredPinCapabilityForDevice(parsed.data.deviceType);
      const pinCheck = validateGpioAssignment({
        board,
        pin: parsed.data.gpioPin,
        requirement,
        usedPinsOnController: usedPins,
      });

      if (!pinCheck.valid) {
        return c.json({ error: pinCheck.errors.join(" "), warnings: pinCheck.warnings }, 400);
      }
      const devicePolicyError = checkPinSelectionPolicy({
        board,
        pin: parsed.data.gpioPin,
        requirement,
        usedPins,
      });
      if (devicePolicyError) {
        return c.json({ error: devicePolicyError, warnings: pinCheck.warnings }, 400);
      }

      const { data: device, error } = await db
        .from("devices")
        .insert({
          account_id: auth.accountId,
          home_id: loc.homeId ?? ctrlRow.home_id,
          room_id: loc.roomId,
          controller_id: ctrlRow.id,
          name: parsed.data.name,
          device_type: parsed.data.deviceType,
          gpio_pin: parsed.data.gpioPin,
          state: parsed.data.state,
          config: parsed.data.config,
          is_online: true,
        })
        .select("*")
        .single();

      if (error) return c.json({ error: error.message }, 400);

      await recordActivity(db, {
        accountId: auth.accountId,
        actorUserId: auth.userId,
        controllerId: ctrlRow.id,
        category: "device",
        action: "device.created",
        summary: `Added ${parsed.data.deviceType} "${parsed.data.name}" on GPIO${parsed.data.gpioPin}`,
      });

      const deps = c.get("deps") ?? {};
      const configSync = await syncControllerConfigSnapshot(db, c.env ?? {}, deps, {
        accountId: auth.accountId,
        controllerId: ctrlRow.id,
        reason: "config_change",
      }).catch(() => null);

      return c.json({ device, warnings: pinCheck.warnings, configSync: configSync ? { revision: configSync.revision, published: configSync.published, queuedForReconnect: configSync.queuedForReconnect } : undefined }, 201);
    }
  );

  app.post(
    "/devices/:id/command",
    requireStaffRole("owner", "administrator", "operator"),
    async (c) => {
      const body = await c.req.json().catch(() => null);
      const parsed = deviceCommandSchema.safeParse(body);
      if (!parsed.success) return c.json({ error: "Valid target state required." }, 400);

      const auth = c.get("userAuth")!;
      const db = c.get("db");
      const deps = c.get("deps") ?? {};
      const deviceId = c.req.param("id");
      const emqxReady = isEmqxConfigured(c.env ?? {});

      const [devRes, credRes, rulesRes] = await Promise.all([
        db
          .from("devices")
          .select("id,name,controller_id,gpio_pin,device_type")
          .eq("id", deviceId)
          .eq("account_id", auth.accountId)
          .is("deleted_at", null)
          .maybeSingle(),
        emqxReady
          ? db
              .from("mqtt_credentials_metadata")
              .select("controller_id,topic_prefix,status")
              .eq("account_id", auth.accountId)
              .eq("status", "active")
          : Promise.resolve({ data: null }),
        db
          .from("automation_rules")
          .select("*")
          .eq("account_id", auth.accountId)
          .eq("enabled", true)
          .is("deleted_at", null),
      ]);

      if (!devRes.data) return c.json({ error: "Device not found." }, 404);
      const dev = devRes.data as {
        id: string;
        name: string;
        controller_id: string;
        gpio_pin: number;
        device_type: string;
      };

      const cred = ((credRes.data ?? []) as Array<{
        controller_id: string;
        topic_prefix: string;
        status: string;
      }>).find((r) => r.controller_id === dev.controller_id);

      let mqttDispatched = false;
      if (emqxReady && cred) {
        try {
          const emqx = new EmqxClient(c.env!, deps.emqxFetch);
          await emqx.publish({
            topic: `${cred.topic_prefix}/cmd/device`,
            payload: {
              device_id: dev.id,
              device_type: dev.device_type,
              gpio_pin: dev.gpio_pin,
              state: parsed.data.state,
              active: isDeviceStateActive(parsed.data.state),
              actor_user_id: auth.userId,
            },
            qos: 1,
          });
          mqttDispatched = true;
        } catch (err) {
          const msg =
            err instanceof Error ? err.message : "Failed to dispatch MQTT command.";
          return c.json({ error: `Controller command failed: ${msg}` }, 502);
        }
      }

      const preloadedRules = (rulesRes.data ?? []) as NonNullable<
        Parameters<typeof evaluateAutomationsForEvent>[0]["preloadedRules"]
      >;

      const [updateRes, controllerOnline] = await Promise.all([
        db
          .from("devices")
          .update({
            state: parsed.data.state,
            last_state_at: new Date().toISOString(),
          })
          .eq("id", dev.id)
          .eq("account_id", auth.accountId)
          .select("*")
          .single(),
        fetchControllerOnlineStatus(db, dev.controller_id, auth.accountId),
        recordActivity(db, {
          accountId: auth.accountId,
          actorUserId: auth.userId,
          controllerId: dev.controller_id,
          category: "device",
          action: "device.command",
          summary: `Set device "${dev.name}" to ${parsed.data.state}`,
        }),
        preloadedRules.length > 0
          ? evaluateAutomationsForEvent({
              db,
              env: c.env ?? {},
              emqxFetch: deps.emqxFetch,
              accountId: auth.accountId,
              event: { kind: "device", deviceId: dev.id, state: parsed.data.state },
              preloadedRules,
            })
          : Promise.resolve(0),
      ]);

      return c.json({ device: updateRes.data, mqttDispatched, controllerOnline });
    }
  );

  app.patch(
    "/devices/:id",
    requireStaffRole("owner", "administrator"),
    async (c) => {
      const body = await c.req.json().catch(() => null);
      const parsed = deviceUpdateSchema.safeParse(body);
      if (!parsed.success) {
        return c.json({ error: "Invalid device update payload." }, 400);
      }

      const auth = c.get("userAuth")!;
      const db = c.get("db");
      const deviceId = c.req.param("id");
      const { data: existingData } = await db
        .from("devices")
        .select("id,home_id,room_id,controller_id,name,device_type,gpio_pin")
        .eq("id", deviceId)
        .eq("account_id", auth.accountId)
        .is("deleted_at", null)
        .maybeSingle();

      if (!existingData) return c.json({ error: "Device not found." }, 404);
      const existing = existingData as {
        id: string;
        home_id: string;
        room_id: string | null;
        controller_id: string;
        name: string;
        device_type: string;
        gpio_pin: number;
      };

      const targetControllerId = parsed.data.controllerId ?? existing.controller_id;
      const targetDeviceType = parsed.data.deviceType ?? existing.device_type;
      if (!isSupportedDeviceType(targetDeviceType)) {
        return c.json({ error: "Unsupported device type." }, 400);
      }
      const targetPin = parsed.data.gpioPin ?? existing.gpio_pin;

      const needsControllerLookup =
        parsed.data.controllerId !== undefined ||
        parsed.data.deviceType !== undefined ||
        parsed.data.gpioPin !== undefined ||
        parsed.data.roomId !== undefined;

      let ctrlRow: {
        id: string;
        home_id: string;
        board_catalog_id: string | null;
        custom_board_id: string | null;
      } = {
        id: existing.controller_id,
        home_id: existing.home_id,
        board_catalog_id: null,
        custom_board_id: null,
      };

      if (needsControllerLookup) {
        const { data: ctrl } = await db
          .from("controllers")
          .select("id,home_id,board_catalog_id,custom_board_id")
          .eq("id", targetControllerId)
          .eq("account_id", auth.accountId)
          .is("deleted_at", null)
          .maybeSingle();

        if (!ctrl) return c.json({ error: "Controller not found in your account." }, 404);
        ctrlRow = ctrl as typeof ctrlRow;
      }

      let warnings: string[] = [];
      if (
        parsed.data.controllerId !== undefined ||
        parsed.data.deviceType !== undefined ||
        parsed.data.gpioPin !== undefined
      ) {
        const [board, usedPins] = await Promise.all([
          resolveControllerBoardSpec(db, ctrlRow),
          getUsedPinsOnController(db, auth.accountId, ctrlRow.id, {
            table: "devices",
            id: existing.id,
          }),
        ]);
        if (!board) return c.json({ error: "Controller board profile missing." }, 400);
        const requirement = requiredPinCapabilityForDevice(targetDeviceType);
        const pinCheck = validateGpioAssignment({
          board,
          pin: targetPin,
          requirement,
          usedPinsOnController: usedPins,
        });
        if (!pinCheck.valid) {
          return c.json({ error: pinCheck.errors.join(" "), warnings: pinCheck.warnings }, 400);
        }
        const policyError = checkPinSelectionPolicy({
          board,
          pin: targetPin,
          requirement,
          usedPins,
          unchanged: targetPin === existing.gpio_pin && ctrlRow.id === existing.controller_id,
        });
        if (policyError) {
          return c.json({ error: policyError, warnings: pinCheck.warnings }, 400);
        }
        warnings = pinCheck.warnings;
      }

      const updates: Record<string, unknown> = {};
      if (parsed.data.name !== undefined) updates.name = parsed.data.name;
      if (parsed.data.controllerId !== undefined) updates.controller_id = ctrlRow.id;
      if (parsed.data.deviceType !== undefined) updates.device_type = targetDeviceType;
      if (parsed.data.gpioPin !== undefined) updates.gpio_pin = targetPin;

      if (parsed.data.roomId !== undefined) {
        const loc = await verifyHomeRoomOwnership(db, auth.accountId, {
          homeId: ctrlRow.home_id,
          roomId: parsed.data.roomId,
        });
        if (!loc.ok) return c.json({ error: loc.error }, 400);
        updates.room_id = loc.roomId;
        updates.home_id = loc.homeId ?? ctrlRow.home_id;
      } else if (parsed.data.controllerId !== undefined && ctrlRow.home_id !== existing.home_id) {
        updates.home_id = ctrlRow.home_id;
        updates.room_id = null;
      }

      if (Object.keys(updates).length === 0) {
        return c.json({ device: existing, warnings });
      }

      const { data, error } = await db
        .from("devices")
        .update(updates)
        .eq("id", deviceId)
        .eq("account_id", auth.accountId)
        .select("*")
        .single();
      if (error) return c.json({ error: error.message }, 400);

      const affectsConfigSnapshot =
        parsed.data.name !== undefined ||
        parsed.data.controllerId !== undefined ||
        parsed.data.deviceType !== undefined ||
        parsed.data.gpioPin !== undefined;

      const deps = c.get("deps") ?? {};
      await Promise.all([
        recordActivity(db, {
          accountId: auth.accountId,
          actorUserId: auth.userId,
          controllerId: ctrlRow.id,
          category: "device",
          action: "device.updated",
          summary: `Updated device "${(data as { name: string }).name}" on GPIO${targetPin}`,
        }),
        affectsConfigSnapshot && existing.controller_id !== ctrlRow.id
          ? syncControllerConfigSnapshot(db, c.env ?? {}, deps, {
              accountId: auth.accountId,
              controllerId: existing.controller_id,
              reason: "config_change",
            }).catch(() => null)
          : Promise.resolve(null),
        affectsConfigSnapshot
          ? syncControllerConfigSnapshot(db, c.env ?? {}, deps, {
              accountId: auth.accountId,
              controllerId: ctrlRow.id,
              reason: "config_change",
            }).catch(() => null)
          : Promise.resolve(null),
      ]);

      return c.json({ device: data, warnings });
    }
  );

  app.delete(
    "/devices/:id",
    requireStaffRole("owner", "administrator"),
    async (c) => {
      const auth = c.get("userAuth")!;
      const db = c.get("db");
      const deps = c.get("deps") ?? {};
      const { data } = await db
        .from("devices")
        .update({ deleted_at: new Date().toISOString() })
        .eq("id", c.req.param("id"))
        .eq("account_id", auth.accountId)
        .is("deleted_at", null)
        .select("id,name,controller_id")
        .maybeSingle();
      if (!data) return c.json({ error: "Device not found." }, 404);
      await syncControllerConfigSnapshot(db, c.env ?? {}, deps, {
        accountId: auth.accountId,
        controllerId: (data as { controller_id: string }).controller_id,
        reason: "config_change",
      }).catch(() => null);
      return c.json({ ok: true });
    }
  );

  // ---------------- SWITCHES ----------------
  app.get("/switches", async (c) => {
    const auth = c.get("userAuth")!;
    const db = c.get("db");
    const { data } = await db
      .from("switches")
      .select("*")
      .eq("account_id", auth.accountId)
      .is("deleted_at", null)
      .order("created_at", { ascending: false });
    return c.json({ switches: data ?? [] });
  });

  app.post(
    "/switches",
    requireStaffRole("owner", "administrator"),
    async (c) => {
      const body = await c.req.json().catch(() => null);
      const parsed = switchSchema.safeParse(body);
      if (!parsed.success) return c.json({ error: "Invalid switch payload." }, 400);

      const auth = c.get("userAuth")!;
      const db = c.get("db");

      const { data: ctrl } = await db
        .from("controllers")
        .select("id,home_id,board_catalog_id,custom_board_id")
        .eq("id", parsed.data.controllerId)
        .eq("account_id", auth.accountId)
        .is("deleted_at", null)
        .maybeSingle();

      if (!ctrl) return c.json({ error: "Controller not found." }, 404);
      const ctrlRow = ctrl as {
        id: string;
        home_id: string;
        board_catalog_id: string | null;
        custom_board_id: string | null;
      };

      const loc = await verifyHomeRoomOwnership(db, auth.accountId, {
        homeId: parsed.data.homeId ?? ctrlRow.home_id,
        roomId: parsed.data.roomId,
      });
      if (!loc.ok) return c.json({ error: loc.error }, 400);

      const board = await resolveControllerBoardSpec(db, ctrlRow);
      if (!board) return c.json({ error: "Controller board profile missing." }, 400);

      const usedPins = await getUsedPinsOnController(db, auth.accountId, ctrlRow.id);
      const pinCheck = validateGpioAssignment({
        board,
        pin: parsed.data.gpioPin,
        requirement: "digital_out",
        usedPinsOnController: usedPins,
      });
      if (!pinCheck.valid) {
        return c.json({ error: pinCheck.errors.join(" "), warnings: pinCheck.warnings }, 400);
      }
      const switchPolicyError = checkPinSelectionPolicy({
        board,
        pin: parsed.data.gpioPin,
        requirement: "digital_out",
        usedPins,
      });
      if (switchPolicyError) {
        return c.json({ error: switchPolicyError, warnings: pinCheck.warnings }, 400);
      }

      const { data: sw, error } = await db
        .from("switches")
        .insert({
          account_id: auth.accountId,
          home_id: loc.homeId ?? ctrlRow.home_id,
          room_id: loc.roomId,
          controller_id: ctrlRow.id,
          name: parsed.data.name,
          gpio_pin: parsed.data.gpioPin,
          inverted: parsed.data.invertedLogic,
          is_on: false,
          is_online: true,
        })
        .select("*")
        .single();

      if (error) return c.json({ error: error.message }, 400);

      await recordActivity(db, {
        accountId: auth.accountId,
        actorUserId: auth.userId,
        controllerId: ctrlRow.id,
        category: "switch",
        action: "switch.created",
        summary: `Added switch "${parsed.data.name}" on GPIO${parsed.data.gpioPin}`,
      });

      const deps = c.get("deps") ?? {};
      const configSync = await syncControllerConfigSnapshot(db, c.env ?? {}, deps, {
        accountId: auth.accountId,
        controllerId: ctrlRow.id,
        reason: "config_change",
      }).catch(() => null);

      return c.json({ switch: sw, warnings: pinCheck.warnings, configSync: configSync ? { revision: configSync.revision, published: configSync.published, queuedForReconnect: configSync.queuedForReconnect } : undefined }, 201);
    }
  );

  app.post(
    "/switches/:id/toggle",
    requireStaffRole("owner", "administrator", "operator"),
    async (c) => {
      const body = await c.req.json().catch(() => null);
      const parsed = switchToggleSchema.safeParse(body);
      if (!parsed.success) return c.json({ error: "Boolean isOn field required." }, 400);

      const auth = c.get("userAuth")!;
      const db = c.get("db");
      const deps = c.get("deps") ?? {};
      const switchId = c.req.param("id");
      const emqxReady = isEmqxConfigured(c.env ?? {});

      const [swRes, credRes, rulesRes] = await Promise.all([
        db
          .from("switches")
          .select("id,name,controller_id,gpio_pin,inverted")
          .eq("id", switchId)
          .eq("account_id", auth.accountId)
          .is("deleted_at", null)
          .maybeSingle(),
        emqxReady
          ? db
              .from("mqtt_credentials_metadata")
              .select("controller_id,topic_prefix,status")
              .eq("account_id", auth.accountId)
              .eq("status", "active")
          : Promise.resolve({ data: null }),
        db
          .from("automation_rules")
          .select("*")
          .eq("account_id", auth.accountId)
          .eq("enabled", true)
          .is("deleted_at", null),
      ]);

      if (!swRes.data) return c.json({ error: "Switch not found." }, 404);
      const sw = swRes.data as {
        id: string;
        name: string;
        controller_id: string;
        gpio_pin: number;
        inverted: boolean;
      };

      const cred = ((credRes.data ?? []) as Array<{
        controller_id: string;
        topic_prefix: string;
        status: string;
      }>).find((r) => r.controller_id === sw.controller_id);

      let mqttDispatched = false;
      if (emqxReady && cred) {
        try {
          const emqx = new EmqxClient(c.env!, deps.emqxFetch);
          await emqx.publish({
            topic: `${cred.topic_prefix}/cmd/switch`,
            payload: {
              switch_id: sw.id,
              gpio_pin: sw.gpio_pin,
              state: parsed.data.isOn ? "ON" : "OFF",
              inverted: sw.inverted,
              actor_user_id: auth.userId,
            },
            qos: 1,
          });
          mqttDispatched = true;
        } catch (err) {
          const msg =
            err instanceof Error ? err.message : "Failed to dispatch MQTT switch command.";
          return c.json({ error: `Controller command failed: ${msg}` }, 502);
        }
      }

      const preloadedRules = (rulesRes.data ?? []) as NonNullable<
        Parameters<typeof evaluateAutomationsForEvent>[0]["preloadedRules"]
      >;

      const [updateRes, controllerOnline] = await Promise.all([
        db
          .from("switches")
          .update({
            is_on: parsed.data.isOn,
            last_changed_at: new Date().toISOString(),
          })
          .eq("id", sw.id)
          .eq("account_id", auth.accountId)
          .select("*")
          .single(),
        fetchControllerOnlineStatus(db, sw.controller_id, auth.accountId),
        recordActivity(db, {
          accountId: auth.accountId,
          actorUserId: auth.userId,
          controllerId: sw.controller_id,
          category: "switch",
          action: parsed.data.isOn ? "switch.turned_on" : "switch.turned_off",
          summary: `Turned "${sw.name}" ${parsed.data.isOn ? "ON" : "OFF"}`,
          metadata: { mqttDispatched },
        }),
        preloadedRules.length > 0
          ? evaluateAutomationsForEvent({
              db,
              env: c.env ?? {},
              emqxFetch: deps.emqxFetch,
              accountId: auth.accountId,
              event: { kind: "switch", switchId: sw.id, isOn: parsed.data.isOn },
              preloadedRules,
            })
          : Promise.resolve(0),
      ]);

      return c.json({ switch: updateRes.data, mqttDispatched, controllerOnline });
    }
  );

  app.patch(
    "/switches/:id",
    requireStaffRole("owner", "administrator"),
    async (c) => {
      const body = await c.req.json().catch(() => null);
      const parsed = switchUpdateSchema.safeParse(body);
      if (!parsed.success) {
        return c.json({ error: "Invalid switch update payload." }, 400);
      }

      const auth = c.get("userAuth")!;
      const db = c.get("db");
      const switchId = c.req.param("id");
      const { data: existingData } = await db
        .from("switches")
        .select("id,home_id,room_id,controller_id,name,gpio_pin,inverted")
        .eq("id", switchId)
        .eq("account_id", auth.accountId)
        .is("deleted_at", null)
        .maybeSingle();

      if (!existingData) return c.json({ error: "Switch not found." }, 404);
      const existing = existingData as {
        id: string;
        home_id: string;
        room_id: string | null;
        controller_id: string;
        name: string;
        gpio_pin: number;
        inverted: boolean;
      };

      const targetControllerId = parsed.data.controllerId ?? existing.controller_id;
      const targetPin = parsed.data.gpioPin ?? existing.gpio_pin;

      const needsControllerLookup =
        parsed.data.controllerId !== undefined ||
        parsed.data.gpioPin !== undefined ||
        parsed.data.roomId !== undefined;

      let ctrlRow: {
        id: string;
        home_id: string;
        board_catalog_id: string | null;
        custom_board_id: string | null;
      } = {
        id: existing.controller_id,
        home_id: existing.home_id,
        board_catalog_id: null,
        custom_board_id: null,
      };

      if (needsControllerLookup) {
        const { data: ctrl } = await db
          .from("controllers")
          .select("id,home_id,board_catalog_id,custom_board_id")
          .eq("id", targetControllerId)
          .eq("account_id", auth.accountId)
          .is("deleted_at", null)
          .maybeSingle();

        if (!ctrl) return c.json({ error: "Controller not found in your account." }, 404);
        ctrlRow = ctrl as typeof ctrlRow;
      }

      let warnings: string[] = [];
      if (parsed.data.controllerId !== undefined || parsed.data.gpioPin !== undefined) {
        const [board, usedPins] = await Promise.all([
          resolveControllerBoardSpec(db, ctrlRow),
          getUsedPinsOnController(db, auth.accountId, ctrlRow.id, {
            table: "switches",
            id: existing.id,
          }),
        ]);
        if (!board) return c.json({ error: "Controller board profile missing." }, 400);
        const pinCheck = validateGpioAssignment({
          board,
          pin: targetPin,
          requirement: "digital_out",
          usedPinsOnController: usedPins,
        });
        if (!pinCheck.valid) {
          return c.json({ error: pinCheck.errors.join(" "), warnings: pinCheck.warnings }, 400);
        }
        const policyError = checkPinSelectionPolicy({
          board,
          pin: targetPin,
          requirement: "digital_out",
          usedPins,
          unchanged: targetPin === existing.gpio_pin && ctrlRow.id === existing.controller_id,
        });
        if (policyError) {
          return c.json({ error: policyError, warnings: pinCheck.warnings }, 400);
        }
        warnings = pinCheck.warnings;
      }

      const updates: Record<string, unknown> = {};
      if (parsed.data.name !== undefined) updates.name = parsed.data.name;
      if (parsed.data.controllerId !== undefined) updates.controller_id = ctrlRow.id;
      if (parsed.data.gpioPin !== undefined) updates.gpio_pin = targetPin;
      if (parsed.data.invertedLogic !== undefined) updates.inverted = parsed.data.invertedLogic;

      if (parsed.data.roomId !== undefined) {
        const loc = await verifyHomeRoomOwnership(db, auth.accountId, {
          homeId: ctrlRow.home_id,
          roomId: parsed.data.roomId,
        });
        if (!loc.ok) return c.json({ error: loc.error }, 400);
        updates.room_id = loc.roomId;
        updates.home_id = loc.homeId ?? ctrlRow.home_id;
      } else if (parsed.data.controllerId !== undefined && ctrlRow.home_id !== existing.home_id) {
        updates.home_id = ctrlRow.home_id;
        updates.room_id = null;
      }

      if (Object.keys(updates).length === 0) {
        return c.json({ switch: existing, warnings });
      }

      const { data, error } = await db
        .from("switches")
        .update(updates)
        .eq("id", switchId)
        .eq("account_id", auth.accountId)
        .select("*")
        .single();
      if (error) return c.json({ error: error.message }, 400);

      const affectsConfigSnapshot =
        parsed.data.name !== undefined ||
        parsed.data.controllerId !== undefined ||
        parsed.data.gpioPin !== undefined ||
        parsed.data.invertedLogic !== undefined;

      const deps = c.get("deps") ?? {};
      await Promise.all([
        recordActivity(db, {
          accountId: auth.accountId,
          actorUserId: auth.userId,
          controllerId: ctrlRow.id,
          category: "switch",
          action: "switch.updated",
          summary: `Updated switch "${(data as { name: string }).name}" on GPIO${targetPin}`,
        }),
        affectsConfigSnapshot && existing.controller_id !== ctrlRow.id
          ? syncControllerConfigSnapshot(db, c.env ?? {}, deps, {
              accountId: auth.accountId,
              controllerId: existing.controller_id,
              reason: "config_change",
            }).catch(() => null)
          : Promise.resolve(null),
        affectsConfigSnapshot
          ? syncControllerConfigSnapshot(db, c.env ?? {}, deps, {
              accountId: auth.accountId,
              controllerId: ctrlRow.id,
              reason: "config_change",
            }).catch(() => null)
          : Promise.resolve(null),
      ]);

      return c.json({ switch: data, warnings });
    }
  );

  app.delete(
    "/switches/:id",
    requireStaffRole("owner", "administrator"),
    async (c) => {
      const auth = c.get("userAuth")!;
      const db = c.get("db");
      const deps = c.get("deps") ?? {};
      const { data } = await db
        .from("switches")
        .update({ deleted_at: new Date().toISOString() })
        .eq("id", c.req.param("id"))
        .eq("account_id", auth.accountId)
        .is("deleted_at", null)
        .select("id,controller_id")
        .maybeSingle();
      if (!data) return c.json({ error: "Switch not found." }, 404);
      await syncControllerConfigSnapshot(db, c.env ?? {}, deps, {
        accountId: auth.accountId,
        controllerId: (data as { controller_id: string }).controller_id,
        reason: "config_change",
      }).catch(() => null);
      return c.json({ ok: true });
    }
  );

  // ---------------- SENSORS ----------------
  app.get("/sensors", async (c) => {
    const auth = c.get("userAuth")!;
    const db = c.get("db");
    const { data } = await db
      .from("sensors")
      .select("*")
      .eq("account_id", auth.accountId)
      .is("deleted_at", null)
      .order("created_at", { ascending: false });
    return c.json({ sensors: data ?? [], supportedSensorTypes: SUPPORTED_SENSOR_TYPES });
  });

  app.post(
    "/sensors",
    requireStaffRole("owner", "administrator"),
    async (c) => {
      const body = await c.req.json().catch(() => null);
      const parsed = sensorSchema.safeParse(body);
      if (!parsed.success) return c.json({ error: "Invalid sensor payload." }, 400);

      if (!isSupportedSensorType(parsed.data.sensorType)) {
        return c.json(
          {
            error: `Unsupported sensor type "${parsed.data.sensorType}". Allowed types: ${SUPPORTED_SENSOR_TYPES.join(", ")}`,
          },
          400
        );
      }

      const auth = c.get("userAuth")!;
      const db = c.get("db");

      const { data: ctrl } = await db
        .from("controllers")
        .select("id,home_id,board_catalog_id,custom_board_id")
        .eq("id", parsed.data.controllerId)
        .eq("account_id", auth.accountId)
        .is("deleted_at", null)
        .maybeSingle();

      if (!ctrl) return c.json({ error: "Controller not found." }, 404);
      const ctrlRow = ctrl as {
        id: string;
        home_id: string;
        board_catalog_id: string | null;
        custom_board_id: string | null;
      };

      const loc = await verifyHomeRoomOwnership(db, auth.accountId, {
        homeId: parsed.data.homeId ?? ctrlRow.home_id,
        roomId: parsed.data.roomId,
      });
      if (!loc.ok) return c.json({ error: loc.error }, 400);

      let warnings: string[] = [];
      if (parsed.data.gpioPin !== null && parsed.data.gpioPin !== undefined) {
        const board = await resolveControllerBoardSpec(db, ctrlRow);
        if (!board) return c.json({ error: "Controller board profile missing." }, 400);
        const usedPins = await getUsedPinsOnController(db, auth.accountId, ctrlRow.id);
        const requirement = requiredPinCapabilityForSensor(parsed.data.sensorType);
        const pinCheck = validateGpioAssignment({
          board,
          pin: parsed.data.gpioPin,
          requirement,
          usedPinsOnController: usedPins,
        });
        if (!pinCheck.valid) {
          return c.json({ error: pinCheck.errors.join(" "), warnings: pinCheck.warnings }, 400);
        }
        const policyError = checkPinSelectionPolicy({
          board,
          pin: parsed.data.gpioPin,
          requirement,
          usedPins,
        });
        if (policyError) {
          return c.json({ error: policyError, warnings: pinCheck.warnings }, 400);
        }
        warnings = pinCheck.warnings;
      }

      const defaultUnit = defaultUnitForSensorType(parsed.data.sensorType, parsed.data.unit);

      const { data: sensor, error } = await db
        .from("sensors")
        .insert({
          account_id: auth.accountId,
          home_id: loc.homeId ?? ctrlRow.home_id,
          room_id: loc.roomId,
          controller_id: ctrlRow.id,
          name: parsed.data.name,
          sensor_type: parsed.data.sensorType,
          gpio_pin: parsed.data.gpioPin ?? null,
          unit: defaultUnit,
          last_raw_payload: {
            ...(parsed.data.config ?? {}),
            ...(parsed.data.i2cAddress ? { i2c_address: parsed.data.i2cAddress } : {}),
          },
          is_online: true,
        })
        .select("*")
        .single();

      if (error) return c.json({ error: error.message }, 400);

      await recordActivity(db, {
        accountId: auth.accountId,
        actorUserId: auth.userId,
        controllerId: ctrlRow.id,
        category: "sensor",
        action: "sensor.created",
        summary: `Added ${parsed.data.sensorType} sensor "${parsed.data.name}"`,
      });

      const deps = c.get("deps") ?? {};
      const configSync = await syncControllerConfigSnapshot(db, c.env ?? {}, deps, {
        accountId: auth.accountId,
        controllerId: ctrlRow.id,
        reason: "config_change",
      }).catch(() => null);

      return c.json({ sensor, warnings, configSync: configSync ? { revision: configSync.revision, published: configSync.published, queuedForReconnect: configSync.queuedForReconnect } : undefined }, 201);
    }
  );

  app.patch(
    "/sensors/:id",
    requireStaffRole("owner", "administrator"),
    async (c) => {
      const body = await c.req.json().catch(() => null);
      const parsed = sensorUpdateSchema.safeParse(body);
      if (!parsed.success) {
        return c.json({ error: "Invalid sensor update payload." }, 400);
      }

      if (parsed.data.sensorType !== undefined && !isSupportedSensorType(parsed.data.sensorType)) {
        return c.json(
          {
            error: `Unsupported sensor type "${parsed.data.sensorType}". Allowed types: ${SUPPORTED_SENSOR_TYPES.join(", ")}`,
          },
          400
        );
      }

      const auth = c.get("userAuth")!;
      const db = c.get("db");
      const sensorId = c.req.param("id");
      const { data: existingData } = await db
        .from("sensors")
        .select("id,home_id,room_id,controller_id,name,sensor_type,gpio_pin,unit,last_raw_payload")
        .eq("id", sensorId)
        .eq("account_id", auth.accountId)
        .is("deleted_at", null)
        .maybeSingle();

      if (!existingData) return c.json({ error: "Sensor not found." }, 404);
      const existing = existingData as {
        id: string;
        home_id: string;
        room_id: string | null;
        controller_id: string;
        name: string;
        sensor_type: string;
        gpio_pin: number | null;
        unit: string;
        last_raw_payload: Record<string, unknown> | null;
      };

      const targetControllerId = parsed.data.controllerId ?? existing.controller_id;
      const targetSensorType = parsed.data.sensorType ?? existing.sensor_type;
      if (!isSupportedSensorType(targetSensorType)) {
        return c.json({ error: "Unsupported sensor type." }, 400);
      }
      const targetPin =
        parsed.data.gpioPin !== undefined ? parsed.data.gpioPin : existing.gpio_pin;

      const needsControllerLookup =
        parsed.data.controllerId !== undefined ||
        parsed.data.sensorType !== undefined ||
        parsed.data.gpioPin !== undefined ||
        parsed.data.roomId !== undefined;

      let ctrlRow: {
        id: string;
        home_id: string;
        board_catalog_id: string | null;
        custom_board_id: string | null;
      } = {
        id: existing.controller_id,
        home_id: existing.home_id,
        board_catalog_id: null,
        custom_board_id: null,
      };

      if (needsControllerLookup) {
        const { data: ctrl } = await db
          .from("controllers")
          .select("id,home_id,board_catalog_id,custom_board_id")
          .eq("id", targetControllerId)
          .eq("account_id", auth.accountId)
          .is("deleted_at", null)
          .maybeSingle();

        if (!ctrl) return c.json({ error: "Controller not found in your account." }, 404);
        ctrlRow = ctrl as typeof ctrlRow;
      }

      let warnings: string[] = [];
      if (
        (parsed.data.controllerId !== undefined ||
          parsed.data.sensorType !== undefined ||
          parsed.data.gpioPin !== undefined) &&
        targetPin !== null &&
        targetPin !== undefined
      ) {
        const [board, usedPins] = await Promise.all([
          resolveControllerBoardSpec(db, ctrlRow),
          getUsedPinsOnController(db, auth.accountId, ctrlRow.id, {
            table: "sensors",
            id: existing.id,
          }),
        ]);
        if (!board) return c.json({ error: "Controller board profile missing." }, 400);
        const requirement = requiredPinCapabilityForSensor(targetSensorType);
        const pinCheck = validateGpioAssignment({
          board,
          pin: targetPin,
          requirement,
          usedPinsOnController: usedPins,
        });
        if (!pinCheck.valid) {
          return c.json({ error: pinCheck.errors.join(" "), warnings: pinCheck.warnings }, 400);
        }
        const policyError = checkPinSelectionPolicy({
          board,
          pin: targetPin,
          requirement,
          usedPins,
          unchanged: targetPin === existing.gpio_pin && ctrlRow.id === existing.controller_id,
        });
        if (policyError) {
          return c.json({ error: policyError, warnings: pinCheck.warnings }, 400);
        }
        warnings = pinCheck.warnings;
      }

      const updates: Record<string, unknown> = {};
      if (parsed.data.name !== undefined) updates.name = parsed.data.name;
      if (parsed.data.controllerId !== undefined) updates.controller_id = ctrlRow.id;
      if (parsed.data.sensorType !== undefined) {
        updates.sensor_type = targetSensorType;
        updates.unit = defaultUnitForSensorType(targetSensorType, existing.unit);
      }
      if (parsed.data.gpioPin !== undefined) updates.gpio_pin = parsed.data.gpioPin;

      if (parsed.data.i2cAddress !== undefined) {
        const nextPayload = { ...(existing.last_raw_payload ?? {}) };
        if (parsed.data.i2cAddress) {
          nextPayload.i2c_address = parsed.data.i2cAddress;
        } else {
          delete nextPayload.i2c_address;
        }
        updates.last_raw_payload = nextPayload;
      }

      if (parsed.data.roomId !== undefined) {
        const loc = await verifyHomeRoomOwnership(db, auth.accountId, {
          homeId: ctrlRow.home_id,
          roomId: parsed.data.roomId,
        });
        if (!loc.ok) return c.json({ error: loc.error }, 400);
        updates.room_id = loc.roomId;
        updates.home_id = loc.homeId ?? ctrlRow.home_id;
      } else if (parsed.data.controllerId !== undefined && ctrlRow.home_id !== existing.home_id) {
        updates.home_id = ctrlRow.home_id;
        updates.room_id = null;
      }

      if (Object.keys(updates).length === 0) {
        return c.json({ sensor: existing, warnings });
      }

      const { data, error } = await db
        .from("sensors")
        .update(updates)
        .eq("id", sensorId)
        .eq("account_id", auth.accountId)
        .select("*")
        .single();
      if (error) return c.json({ error: error.message }, 400);

      const affectsConfigSnapshot =
        parsed.data.name !== undefined ||
        parsed.data.controllerId !== undefined ||
        parsed.data.sensorType !== undefined ||
        parsed.data.gpioPin !== undefined ||
        parsed.data.i2cAddress !== undefined;

      const deps = c.get("deps") ?? {};
      await Promise.all([
        recordActivity(db, {
          accountId: auth.accountId,
          actorUserId: auth.userId,
          controllerId: ctrlRow.id,
          category: "sensor",
          action: "sensor.updated",
          summary: `Updated ${targetSensorType} sensor "${(data as { name: string }).name}"`,
        }),
        affectsConfigSnapshot && existing.controller_id !== ctrlRow.id
          ? syncControllerConfigSnapshot(db, c.env ?? {}, deps, {
              accountId: auth.accountId,
              controllerId: existing.controller_id,
              reason: "config_change",
            }).catch(() => null)
          : Promise.resolve(null),
        affectsConfigSnapshot
          ? syncControllerConfigSnapshot(db, c.env ?? {}, deps, {
              accountId: auth.accountId,
              controllerId: ctrlRow.id,
              reason: "config_change",
            }).catch(() => null)
          : Promise.resolve(null),
      ]);

      return c.json({ sensor: data, warnings });
    }
  );

  app.delete(
    "/sensors/:id",
    requireStaffRole("owner", "administrator"),
    async (c) => {
      const auth = c.get("userAuth")!;
      const db = c.get("db");
      const deps = c.get("deps") ?? {};
      const { data } = await db
        .from("sensors")
        .update({ deleted_at: new Date().toISOString() })
        .eq("id", c.req.param("id"))
        .eq("account_id", auth.accountId)
        .is("deleted_at", null)
        .select("id,controller_id")
        .maybeSingle();
      if (!data) return c.json({ error: "Sensor not found." }, 404);
      await syncControllerConfigSnapshot(db, c.env ?? {}, deps, {
        accountId: auth.accountId,
        controllerId: (data as { controller_id: string }).controller_id,
        reason: "config_change",
      }).catch(() => null);
      return c.json({ ok: true });
    }
  );

  // ---------------- ACTIVITY LOGS ----------------
  app.get("/activity", async (c) => {
    const auth = c.get("userAuth")!;
    const db = c.get("db");
    const category = c.req.query("category");
    const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") ?? 50)));

    let query = db
      .from("activity_logs")
      .select("*")
      .eq("account_id", auth.accountId)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (category) {
      query = query.eq("category", category);
    }

    const { data } = await query;
    return c.json({ activity: data ?? [] });
  });

  return app;
}
