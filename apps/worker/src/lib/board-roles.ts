import {
  boardSupportsControllerRole,
  canAssignNodeToController,
  normalizeBoardRole,
  roleChangeBlocker,
  type BoardRole,
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
  releasedNodeIds?: string[];
  device?: Record<string, unknown>;
}

async function updateBoardInstanceSafe(
  db: DbClient,
  accountId: string,
  matchCol: "id" | "assigned_controller_id",
  matchVal: string,
  updates: Record<string, unknown>
): Promise<void> {
  const { error } = await db
    .from("board_instances")
    .update(updates)
    .eq("account_id", accountId)
    .eq(matchCol, matchVal);
  if (error && "espnow_telemetry" in updates) {
    const errMsg = error.message ?? "";
    const errCode = error.code ?? "";
    if (
      errCode === "PGRST204" ||
      errCode === "42703" ||
      /espnow_telemetry/i.test(errMsg)
    ) {
      const fallback = { ...updates };
      delete fallback.espnow_telemetry;
      await db
        .from("board_instances")
        .update(fallback)
        .eq("account_id", accountId)
        .eq(matchCol, matchVal);
    }
  }
}

/** Nodes currently hosted by a Controller (soft-deleted rows excluded). */
export async function listAttachedNodes(
  db: DbClient,
  accountId: string,
  boardInstanceId: string
): Promise<AttachedNodeRow[]> {
  const { data } = await db
    .from("board_instances")
    .select("id,name,status,comm_mode,node_link_state")
    .eq("account_id", accountId)
    .eq("assigned_controller_id", boardInstanceId)
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
export async function changeBoardRole(
  db: DbClient,
  env: WorkerBindings,
  deps: { emqxFetch?: CustomFetch },
  params: {
    accountId: string;
    actorUserId: string | null;
    deviceId: string;
    targetRole: BoardRole;
    acknowledgeAttachedNodes?: boolean;
  }
): Promise<RoleChangeResult> {
  const { data: row } = await db
    .from("board_instances")
    .select(
      "id,name,home_id,board_profile_id,custom_board_profile_id,board_role,assigned_controller_id,status"
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
    board_profile_id: string | null;
    custom_board_profile_id: string | null;
    board_role?: string | null;
    assigned_controller_id?: string | null;
    status: string;
  };

  const currentRole = normalizeBoardRole(device.board_role);
  const attachedNodes = await listAttachedNodes(db, params.accountId, device.id);

  const board = await resolveControllerBoardSpec(db, {
    board_profile_id: device.board_profile_id,
    custom_board_profile_id: device.custom_board_profile_id,
  });
  // Same capability gate the console and firmware use. An unknown board profile
  // is not treated as unsupported (we only block what we can prove cannot work).
  const boardSupported =
    !board ||
    boardSupportsControllerRole({
      chip_family: board.chip_family,
      supports_wifi: board.supports_wifi,
    });

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
    return { ok: true, status: 200, device: { ...device, board_role: currentRole } };
  }

  const now = new Date().toISOString();
  const updates: Record<string, unknown> = {
    board_role: params.targetRole,
    role_changed_at: now,
    // A freshly promoted Controller is not yet hosting anything; a new Node has
    // no uplink until one is chosen. `comm_mode`/`node_link_state` describe a
    // Node's uplink only, so they are cleared for the Controller role instead of
    // leaving a stale "wifi_mqtt" value on a Controller row.
    assigned_controller_id: null,
    comm_mode: params.targetRole === "node" ? "offline" : null,
    node_link_state: params.targetRole === "node" ? "unassigned" : null,
    updated_at: now,
  };

  await db
    .from("board_instances")
    .update(updates)
    .eq("id", device.id)
    .eq("account_id", params.accountId);

  // Detaching hosted Nodes is explicit: they stay Nodes and will open their
  // Wi-Fi/MQTT fallback so they remain reachable.
  if (params.targetRole === "node" && attachedNodes.length > 0) {
    await db
      .from("board_instances")
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
    boardInstanceId: device.id,
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
    boardInstanceId: device.id,
    reason: "config_change",
    forcePublish: true,
  }).catch(() => undefined);
  for (const node of attachedNodes) {
    await syncControllerConfigSnapshot(db, env, deps, {
      accountId: params.accountId,
      boardInstanceId: node.id,
      reason: "config_change",
      forcePublish: true,
    }).catch(() => undefined);
  }

  return {
    ok: true,
    status: 200,
    releasedNodeIds: attachedNodes.map((n) => n.id),
    device: { ...device, ...updates },
  };
}

export interface AssignResult {
  ok: boolean;
  status: number;
  error?: string;
  node?: Record<string, unknown>;
  controller?: Record<string, unknown>;
  previousControllerId?: string | null;
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
    boardInstanceId: string | null;
  }
): Promise<AssignResult> {
  const { data: nodeRow } = await db
    .from("board_instances")
    .select("id,name,home_id,board_role,assigned_controller_id,status")
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
    board_role?: string | null;
    assigned_controller_id?: string | null;
    status: string;
  };
  if (normalizeBoardRole(node.board_role) !== "node") {
    return {
      ok: false,
      status: 409,
      error: "Only a device operating as a Node can be assigned to a Controller.",
    };
  }

  const prevControllerId = node.assigned_controller_id ?? null;
  const now = new Date().toISOString();

  if (!params.boardInstanceId) {
    const unassignUpdates = {
      assigned_controller_id: null,
      comm_mode: node.status === "online" ? "wifi_mqtt" : "offline",
      node_link_state: "unassigned",
      espnow_telemetry: null,
      updated_at: now,
    };
    await updateBoardInstanceSafe(db, params.accountId, "id", node.id, unassignUpdates);

    await recordActivity(db, {
      accountId: params.accountId,
      actorUserId: params.actorUserId,
      boardInstanceId: node.id,
      category: "controller",
      action: "controller.node_unassigned",
      summary: `Cleared the Controller assignment for Node "${node.name}"`,
    });
    const toSync = [node.id, ...(prevControllerId ? [prevControllerId] : [])];
    for (const syncId of toSync) {
      await syncControllerConfigSnapshot(db, env, deps, {
        accountId: params.accountId,
        boardInstanceId: syncId,
        reason: "config_change",
        forcePublish: true,
      }).catch(() => undefined);
    }
    return {
      ok: true,
      status: 200,
      previousControllerId: prevControllerId,
      node: { ...node, ...unassignUpdates },
    };
  }

  const { data: ctrlRow } = await db
    .from("board_instances")
    .select("id,name,home_id,board_role,status,hardware_uid,mqtt_connected,espnow_channel")
    .eq("id", params.boardInstanceId)
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
    board_role?: string | null;
    status: string;
    hardware_uid?: string | null;
    mqtt_connected?: boolean;
    espnow_channel?: number | null;
  };

  const verdict = canAssignNodeToController({
    nodeId: node.id,
    boardInstanceId: controller.id,
    controllerRole: normalizeBoardRole(controller.board_role),
    controllerOnline: controller.status === "online",
    sameHome: controller.home_id === node.home_id,
  });
  if (!verdict.ok) {
    return { ok: false, status: 409, error: verdict.message };
  }

  const assignUpdates = {
    assigned_controller_id: controller.id,
    comm_mode: "espnow",
    node_link_state: "reconnecting",
    espnow_telemetry: null,
    updated_at: now,
  };
  await updateBoardInstanceSafe(db, params.accountId, "id", node.id, assignUpdates);

  await recordActivity(db, {
    accountId: params.accountId,
    actorUserId: params.actorUserId,
    boardInstanceId: node.id,
    category: "controller",
    action: "controller.node_assigned",
    summary: `Assigned Node "${node.name}" to Controller "${controller.name}"`,
  });

  const syncIds = [
    node.id,
    controller.id,
    ...(prevControllerId && prevControllerId !== controller.id ? [prevControllerId] : []),
  ];
  for (const id of syncIds) {
    await syncControllerConfigSnapshot(db, env, deps, {
      accountId: params.accountId,
      boardInstanceId: id,
      reason: "config_change",
      forcePublish: true,
    }).catch(() => undefined);
  }

  return {
    ok: true,
    status: 200,
    previousControllerId: prevControllerId,
    node: { ...node, ...assignUpdates },
    controller,
  };
}
