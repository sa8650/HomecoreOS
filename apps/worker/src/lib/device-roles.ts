import {
  canAssignNodeToController,
  normalizeDeviceRole,
  roleChangeBlocker,
  type DeviceRole,
} from "@homecoreos/shared";
import type { WorkerBindings } from "../config/env";
import { recordActivity } from "./audit";
import { syncControllerConfigSnapshot } from "./controller-config";
import type { CustomFetch, DbClient } from "./db";
import { resolveControllerBoardSpec } from "./board-helpers";

export interface AttachedNodeRow {
  id: string;
  name: string;
  status: string;
  comm_mode: string | null;
  node_link_state: string | null;
}

export interface RoleChangeResult {
  ok: boolean;
  status: number;
  error?: string;
  code?:
    | "board_unsupported"
    | "attached_nodes"
    | "self_reference"
    | "unknown_controller"
    | "not_found"
    | "invalid";
  attachedNodeCount?: number;
  attachedNodes?: AttachedNodeRow[];
  device?: Record<string, unknown>;
}

/** Nodes currently hosted by a Controller (soft-deleted rows excluded). */
export async function listAttachedNodes(
  db: DbClient,
  accountId: string,
  controllerId: string
): Promise<AttachedNodeRow[]> {
  const { data } = await db
    .from("controllers")
    .select("id,name,status,comm_mode,node_link_state")
    .eq("account_id", accountId)
    .eq("assigned_controller_id", controllerId)
    .is("deleted_at", null)
    .is("permanently_deleted_at", null)
    .order("created_at", { ascending: true });
  return ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
    id: String(row.id),
    name: String(row.name ?? "Node"),
    status: String(row.status ?? "offline"),
    comm_mode: (row.comm_mode as string | null) ?? null,
    node_link_state: (row.node_link_state as string | null) ?? null,
  }));
}

/**
 * Promotes a Node to Controller, or demotes a Controller to Node.
 *
 * The device record, its identity, pairing, MQTT credentials and history are
 * preserved — only the role columns change, so the card moves between the two
 * tabs instead of becoming a new device.
 *
 * Demoting a Controller that still hosts Nodes is refused unless the caller
 * acknowledged it; when acknowledged the hosted Nodes are explicitly detached
 * (they fall back to Wi-Fi/MQTT as standalone Nodes) and every affected device is
 * re-synced. Nothing is ever silently orphaned.
 */
export async function changeDeviceRole(
  db: DbClient,
  env: WorkerBindings,
  deps: { emqxFetch?: CustomFetch },
  params: {
    accountId: string;
    actorUserId: string | null;
    deviceId: string;
    targetRole: DeviceRole;
    acknowledgeAttachedNodes?: boolean;
  }
): Promise<RoleChangeResult> {
  const { data: row } = await db
    .from("controllers")
    .select(
      "id,name,home_id,board_catalog_id,custom_board_id,device_role,assigned_controller_id,status"
    )
    .eq("id", params.deviceId)
    .eq("account_id", params.accountId)
    .is("deleted_at", null)
    .is("permanently_deleted_at", null)
    .maybeSingle();

  if (!row) {
    return { ok: false, status: 404, code: "not_found", error: "Device not found." };
  }

  const device = row as {
    id: string;
    name: string;
    home_id: string;
    board_catalog_id: string | null;
    custom_board_id: string | null;
    device_role?: string | null;
    assigned_controller_id?: string | null;
    status: string;
  };

  const currentRole = normalizeDeviceRole(device.device_role);
  const attachedNodes = await listAttachedNodes(db, params.accountId, device.id);

  const board = await resolveControllerBoardSpec(db, {
    board_catalog_id: device.board_catalog_id,
    custom_board_id: device.custom_board_id,
  });
  const boardSupported =
    board?.supports_wifi !== false &&
    !["esp8266", "esp32h2", "esp32h21"].includes(
      String(board?.chip_family ?? "").toLowerCase()
    );

  const blocker = roleChangeBlocker({
    targetRole: params.targetRole,
    currentRole,
    boardSupported,
    attachedNodeCount: attachedNodes.length,
    acknowledgeAttachedNodes: params.acknowledgeAttachedNodes,
  });

  if (blocker) {
    return {
      ok: false,
      status: blocker.code === "board_unsupported" ? 400 : 409,
      code: blocker.code,
      error: blocker.message,
      attachedNodeCount: blocker.code === "attached_nodes" ? attachedNodes.length : undefined,
      attachedNodes: blocker.code === "attached_nodes" ? attachedNodes : undefined,
    };
  }

  if (currentRole === params.targetRole) {
    return { ok: true, status: 200, device: { ...device, device_role: currentRole } };
  }

  const now = new Date().toISOString();
  const updates: Record<string, unknown> = {
    device_role: params.targetRole,
    role_changed_at: now,
    // A freshly promoted Controller is not yet hosting anything; a new Node has
    // no uplink until one is chosen.
    assigned_controller_id: null,
    comm_mode: params.targetRole === "node" ? "offline" : "wifi_mqtt",
    node_link_state: params.targetRole === "node" ? "unassigned" : null,
    updated_at: now,
  };

  await db
    .from("controllers")
    .update(updates)
    .eq("id", device.id)
    .eq("account_id", params.accountId);

  // Detaching hosted Nodes is explicit: they stay Nodes and will open their
  // Wi-Fi/MQTT fallback so they remain reachable.
  if (params.targetRole === "node" && attachedNodes.length > 0) {
    await db
      .from("controllers")
      .update({
        assigned_controller_id: null,
        comm_mode: "wifi_mqtt",
        node_link_state: "unassigned",
        updated_at: now,
      })
      .eq("account_id", params.accountId)
      .eq("assigned_controller_id", device.id);
  }

  await recordActivity(db, {
    accountId: params.accountId,
    actorUserId: params.actorUserId,
    controllerId: device.id,
    category: "controller",
    action: "controller.role_changed",
    summary:
      params.targetRole === "controller"
        ? `Promoted "${device.name}" from Node to Controller`
        : `Changed "${device.name}" from Controller to Node${
            attachedNodes.length > 0
              ? ` and released ${attachedNodes.length} Node${attachedNodes.length === 1 ? "" : "s"} to Wi-Fi/MQTT fallback`
              : ""
          }`,
  });

  // Re-publish the role configuration for the device and every detached Node.
  await syncControllerConfigSnapshot(db, env, deps, {
    accountId: params.accountId,
    controllerId: device.id,
    reason: "config_change",
    forcePublish: true,
  }).catch(() => undefined);
  for (const node of attachedNodes) {
    await syncControllerConfigSnapshot(db, env, deps, {
      accountId: params.accountId,
      controllerId: node.id,
      reason: "config_change",
      forcePublish: true,
    }).catch(() => undefined);
  }

  return {
    ok: true,
    status: 200,
    device: { ...device, ...updates },
  };
}

export interface AssignResult {
  ok: boolean;
  status: number;
  error?: string;
  node?: Record<string, unknown>;
  controller?: Record<string, unknown>;
}

/** Points a Node at a Controller (or clears the assignment with `null`). */
export async function assignNodeToController(
  db: DbClient,
  env: WorkerBindings,
  deps: { emqxFetch?: CustomFetch },
  params: {
    accountId: string;
    actorUserId: string | null;
    nodeId: string;
    controllerId: string | null;
  }
): Promise<AssignResult> {
  const { data: nodeRow } = await db
    .from("controllers")
    .select("id,name,home_id,device_role,status")
    .eq("id", params.nodeId)
    .eq("account_id", params.accountId)
    .is("deleted_at", null)
    .is("permanently_deleted_at", null)
    .maybeSingle();

  if (!nodeRow) {
    return { ok: false, status: 404, error: "Device not found." };
  }
  const node = nodeRow as {
    id: string;
    name: string;
    home_id: string;
    device_role?: string | null;
    status: string;
  };
  if (normalizeDeviceRole(node.device_role) !== "node") {
    return {
      ok: false,
      status: 409,
      error: "Only a device operating as a Node can be assigned to a Controller.",
    };
  }

  const now = new Date().toISOString();

  if (!params.controllerId) {
    await db
      .from("controllers")
      .update({
        assigned_controller_id: null,
        comm_mode: "wifi_mqtt",
        node_link_state: "unassigned",
        updated_at: now,
      })
      .eq("id", node.id)
      .eq("account_id", params.accountId);

    await recordActivity(db, {
      accountId: params.accountId,
      actorUserId: params.actorUserId,
      controllerId: node.id,
      category: "controller",
      action: "controller.node_unassigned",
      summary: `Cleared the Controller assignment for Node "${node.name}"`,
    });
    await syncControllerConfigSnapshot(db, env, deps, {
      accountId: params.accountId,
      controllerId: node.id,
      reason: "config_change",
      forcePublish: true,
    }).catch(() => undefined);
    return { ok: true, status: 200, node: { ...node, assigned_controller_id: null } };
  }

  const { data: ctrlRow } = await db
    .from("controllers")
    .select("id,name,home_id,device_role,status")
    .eq("id", params.controllerId)
    .eq("account_id", params.accountId)
    .is("deleted_at", null)
    .is("permanently_deleted_at", null)
    .maybeSingle();

  if (!ctrlRow) {
    return { ok: false, status: 404, error: "Controller not found." };
  }
  const controller = ctrlRow as {
    id: string;
    name: string;
    home_id: string;
    device_role?: string | null;
    status: string;
  };

  const verdict = canAssignNodeToController({
    nodeId: node.id,
    controllerId: controller.id,
    controllerRole: normalizeDeviceRole(controller.device_role),
    controllerOnline: controller.status === "online",
    sameHome: controller.home_id === node.home_id,
  });
  if (!verdict.ok) {
    return { ok: false, status: 409, error: verdict.message };
  }

  await db
    .from("controllers")
    .update({
      assigned_controller_id: controller.id,
      comm_mode: "espnow",
      node_link_state: "reconnecting",
      updated_at: now,
    })
    .eq("id", node.id)
    .eq("account_id", params.accountId);

  await recordActivity(db, {
    accountId: params.accountId,
    actorUserId: params.actorUserId,
    controllerId: node.id,
    category: "controller",
    action: "controller.node_assigned",
    summary: `Assigned Node "${node.name}" to Controller "${controller.name}"`,
  });

  for (const id of [node.id, controller.id]) {
    await syncControllerConfigSnapshot(db, env, deps, {
      accountId: params.accountId,
      controllerId: id,
      reason: "config_change",
      forcePublish: true,
    }).catch(() => undefined);
  }

  return {
    ok: true,
    status: 200,
    node: { ...node, assigned_controller_id: controller.id },
    controller,
  };
}
