import {
  bindingBlocker,
  canAssignNodeToController,
  getBoardCapabilities,
  normalizeBindingGeneration,
  normalizeBoardRole,
  roleChangeBlocker,
  type BoardRole,
} from "@homecoreos/shared";
import type { WorkerBindings } from "../config/env";
import { recordActivity } from "./audit";
import { captureBoardLog, type BoardLogCollector } from "./board-log";
import { syncControllerConfigSnapshot } from "./controller-config";
import type { CustomFetch, DbClient } from "./db";
import { resolveControllerBoardSpec } from "./board-helpers";

export interface AttachedNodeRow {
  id: string;
  name: string;
  status: string;
  comm_mode: string | null;
  node_link_state: string | null;
  binding_generation?: number | string | null;
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
    .select("id,name,status,comm_mode,node_link_state,binding_generation")
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
    /** Collects the real-time events so they travel with the action's envelope. */
    collector?: BoardLogCollector;
  }
): Promise<RoleChangeResult> {
  const { data: row } = await db
    .from("board_instances")
    .select(
      "id,name,home_id,board_profile_id,custom_board_profile_id,board_role,assigned_controller_id,status,binding_generation"
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
    binding_generation?: number | string | null;
  };

  const currentRole = normalizeBoardRole(device.board_role);
  const attachedNodes = await listAttachedNodes(db, params.accountId, device.id);

  const board = await resolveControllerBoardSpec(db, {
    board_profile_id: device.board_profile_id,
    custom_board_profile_id: device.custom_board_profile_id,
  });
  // The canonical capability profile is authoritative. Legacy profiles with
  // no registry entry keep the former behaviour instead of losing a board.
  const capabilityBlocker = board
    ? bindingBlocker(board.slug, params.targetRole)
    : null;
  if (capabilityBlocker) {
    return {
      ok: false,
      status: 400,
      code: "board_unsupported",
      error: capabilityBlocker,
    };
  }
  const registryCapability = board ? getBoardCapabilities(board.slug) : null;
  const boardSupported = registryCapability
    ? registryCapability.roles.supported.includes(params.targetRole)
    : true;

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
    // A role change revokes any binding owned by the old role and bumps the
    // generation, so stale peers cannot be re-accepted after the change.
    binding_id: null,
    binding_state: "revoked",
    binding_generation: normalizeBindingGeneration(device.binding_generation) + 1,
    binding_verified_at: null,
    cloud_route: params.targetRole === "node" ? "direct_node_mqtt" : null,
    route_generation: normalizeBindingGeneration(device.binding_generation) + 1,
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
    for (const node of attachedNodes) {
      const revokedGeneration = normalizeBindingGeneration(node.binding_generation) + 1;
      await db
        .from("board_instances")
        .update({
          assigned_controller_id: null,
          comm_mode: "wifi_mqtt",
          node_link_state: "unassigned",
          binding_id: null,
          binding_state: "revoked",
          binding_generation: revokedGeneration,
          binding_verified_at: null,
          cloud_route: "direct_node_mqtt",
          route_generation: revokedGeneration,
          updated_at: now,
        })
        .eq("account_id", params.accountId)
        .eq("id", node.id);
    }
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

  await captureBoardLog(
    { db, env, deps, collector: params.collector },
    {
      accountId: params.accountId,
      boardInstanceId: device.id,
      category: "binding",
      severity: "info",
      status: "role_changed",
      method: "user",
      source: params.actorUserId,
      destination: device.id,
      message:
        params.targetRole === "controller"
          ? `Role changed: Node promoted to Controller.`
          : `Role changed: Controller changed to Node.`,
      dedupeKey: `role:${device.id}:${params.targetRole}:${normalizeBindingGeneration(device.binding_generation) + 1}`,
      metadata: {
        from: currentRole,
        to: params.targetRole,
        releasedNodes: attachedNodes.length,
      },
    }
  );

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
    /** Collects the real-time events so they travel with the action's envelope. */
    collector?: BoardLogCollector;
  }
): Promise<AssignResult> {
  const { data: nodeRow } = await db
    .from("board_instances")
    .select("id,name,home_id,board_role,assigned_controller_id,status,board_profile_id,custom_board_profile_id,binding_generation")
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
    board_profile_id?: string | null;
    custom_board_profile_id?: string | null;
    binding_generation?: number | string | null;
  };
  if (normalizeBoardRole(node.board_role) !== "node") {
    return {
      ok: false,
      status: 409,
      error: "Only a device operating as a Node can be assigned to a Controller.",
    };
  }

  const nodeBoard = await resolveControllerBoardSpec(db, {
    board_profile_id: node.board_profile_id ?? null,
    custom_board_profile_id: node.custom_board_profile_id ?? null,
  });
  if (nodeBoard) {
    const nodeCapabilityBlocker = bindingBlocker(nodeBoard.slug, "node");
    if (nodeCapabilityBlocker) {
      return { ok: false, status: 400, error: nodeCapabilityBlocker };
    }
  }

  const prevControllerId = node.assigned_controller_id ?? null;
  const now = new Date().toISOString();
  const nextGeneration = normalizeBindingGeneration(node.binding_generation) + 1;

  if (!params.boardInstanceId) {
    const unassignUpdates = {
      assigned_controller_id: null,
      comm_mode: node.status === "online" ? "wifi_mqtt" : "offline",
      node_link_state: "unassigned",
      espnow_telemetry: null,
      binding_id: null,
      binding_state: "revoked",
      binding_generation: nextGeneration,
      binding_verified_at: null,
      cloud_route: node.status === "online" ? "direct_node_mqtt" : "unavailable",
      route_generation: nextGeneration,
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
    await captureBoardLog(
      { db, env, deps },
      {
        accountId: params.accountId,
        boardInstanceId: node.id,
        category: "binding",
        severity: "warning",
        status: "revoked",
        method: "user",
        source: params.actorUserId,
        destination: prevControllerId,
        message: "Controller assignment cleared; the binding was revoked.",
        dedupeKey: `unassign:${node.id}:${nextGeneration}`,
        metadata: {
          previousControllerId: prevControllerId,
          generation: nextGeneration,
        },
      }
    );
    if (prevControllerId) {
      await captureBoardLog(
        { db, env, deps, collector: params.collector },
        {
          accountId: params.accountId,
          boardInstanceId: prevControllerId,
          category: "binding",
          severity: "warning",
          status: "revoked",
          method: "user",
          source: params.actorUserId,
          destination: node.id,
          message: `Node "${node.name}" was unassigned from this Controller.`,
          dedupeKey: `unassign:${prevControllerId}:${node.id}:${nextGeneration}`,
          metadata: { nodeId: node.id, generation: nextGeneration },
        }
      );
    }
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
    .select("id,name,home_id,board_role,status,hardware_uid,mqtt_connected,espnow_channel,board_profile_id,custom_board_profile_id")
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
    board_profile_id?: string | null;
    custom_board_profile_id?: string | null;
  };

  const controllerBoard = await resolveControllerBoardSpec(db, {
    board_profile_id: controller.board_profile_id ?? null,
    custom_board_profile_id: controller.custom_board_profile_id ?? null,
  });
  if (controllerBoard) {
    const controllerCapabilityBlocker = bindingBlocker(controllerBoard.slug, "controller");
    if (controllerCapabilityBlocker) {
      return { ok: false, status: 400, error: controllerCapabilityBlocker };
    }
  }

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
    /* MQTT stays up while searching. The Worker changes this only after a
     * verified Controller relay has been confirmed. */
    comm_mode: node.status === "online" ? "wifi_mqtt" : "offline",
    node_link_state: "reconnecting",
    espnow_telemetry: null,
    binding_id: crypto.randomUUID(),
    binding_state: "assigned",
    binding_generation: nextGeneration,
    binding_verified_at: null,
    cloud_route: node.status === "online" ? "connecting" : "unavailable",
    route_generation: nextGeneration,
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

  // The assignment is a binding event on the Node's own log. The Controller
  // records the Node only as the peer of this binding.
  await captureBoardLog(
    { db, env, deps, collector: params.collector },
    {
      accountId: params.accountId,
      boardInstanceId: node.id,
      category: "binding",
      severity: "info",
      status: "assigned",
      method: "user",
      source: params.actorUserId,
      destination: controller.id,
      message: `Assigned to Controller "${controller.name}".`,
      dedupeKey: `assign:${node.id}:${controller.id}:${nextGeneration}`,
      metadata: {
        controllerId: controller.id,
        generation: nextGeneration,
        bindingId: assignUpdates.binding_id,
        previousControllerId: prevControllerId,
      },
    }
  );
  await captureBoardLog(
    { db, env, deps, collector: params.collector },
    {
      accountId: params.accountId,
      boardInstanceId: controller.id,
      category: "binding",
      severity: "info",
      status: "assigned",
      method: "user",
      source: params.actorUserId,
      destination: node.id,
      message: `Node "${node.name}" was assigned to this Controller.`,
      dedupeKey: `assign:${controller.id}:${node.id}:${nextGeneration}`,
      metadata: { nodeId: node.id, generation: nextGeneration },
    }
  );

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

export interface BindingVerificationInput {
  nodeId: string;
  controllerId: string;
  generation?: unknown;
  bindingId?: string | null;
  /** Bidirectional ACK reported by the Node. */
  espnowLinked: boolean;
  /** Controller heartbeat lists the Node in its roster. */
  rosterConfirmed: boolean;
  controllerMqttHealthy: boolean;
  /** Challenge echoed by both devices from the Worker command. */
  challengeId?: string | null;
  challengeNonce?: string | null;
  /** Optional realtime plumbing so the verification reaches the console live. */
  env?: WorkerBindings;
  deps?: { emqxFetch?: CustomFetch };
  /** Collects the real-time events so they travel with the action's envelope. */
  collector?: BoardLogCollector;
}

/**
 * Only the Worker may mark a binding verified. Radio send success, an
 * assignment row or a device self-report is never sufficient: both sides must
 * report the same generation and the Controller cloud path must be healthy.
 */
export async function verifyNodeBinding(
  db: DbClient,
  accountId: string,
  params: BindingVerificationInput
): Promise<{ verified: boolean; generation: number }> {
  const { data: row } = await db
    .from("board_instances")
    .select("id,board_role,assigned_controller_id,binding_generation,binding_state,binding_id")
    .eq("id", params.nodeId)
    .eq("account_id", accountId)
    .is("deleted_at", null)
    .maybeSingle();
  const node = row as {
    id: string;
    board_role?: string | null;
    assigned_controller_id?: string | null;
    binding_generation?: number | string | null;
    binding_state?: string | null;
    binding_id?: string | null;
  } | null;
  const storedGeneration = normalizeBindingGeneration(node?.binding_generation);
  const reportedGeneration = normalizeBindingGeneration(params.generation);
  if (
    !node ||
    normalizeBoardRole(node.board_role) !== "node" ||
    node.assigned_controller_id !== params.controllerId ||
    node.binding_state === "revoked" ||
    node.binding_state === "unpaired" ||
    (params.bindingId && node.binding_id && params.bindingId !== node.binding_id)
  ) {
    return { verified: false, generation: storedGeneration };
  }
  /* Higher generations are authoritative even while the board was offline. */
  const generation = Math.max(storedGeneration, reportedGeneration);
  if (
    !params.espnowLinked ||
    !params.rosterConfirmed ||
    !params.controllerMqttHealthy ||
    generation === 0
  ) {
    return { verified: false, generation };
  }

  /* When a challenge is pending, verification must carry the exact Worker ID
   * and nonce from the device telemetry. A radio-only claim cannot satisfy
   * it. Legacy assignments without a pending challenge remain supported. */
  const { data: pending } = await db
    .from("board_binding_challenges")
    .select("id,nonce,generation")
    .eq("account_id", accountId)
    .eq("node_id", params.nodeId)
    .eq("controller_id", params.controllerId)
    .is("consumed_at", null)
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (pending) {
    if (
      params.challengeId !== pending.id ||
      (params.challengeNonce && params.challengeNonce !== pending.nonce) ||
      normalizeBindingGeneration(pending.generation) !== generation
    ) {
      return { verified: false, generation };
    }
    const { data: challenge } = await db
      .from("board_binding_challenges")
      .update({ consumed_at: new Date().toISOString() })
      .eq("id", pending.id)
      .is("consumed_at", null)
      .select("id")
      .maybeSingle();
    if (!challenge) return { verified: false, generation };
  } else if (params.challengeId) {
    /* An explicitly supplied stale/unknown challenge is never accepted. */
    return { verified: false, generation };
  }

  const now = new Date().toISOString();
  await db
    .from("board_instances")
    .update({
      binding_generation: generation,
      binding_state: "verified",
      binding_verified_at: now,
      cloud_route: "controller_mqtt",
      route_generation: generation,
      updated_at: now,
    })
    .eq("id", node.id)
    .eq("account_id", accountId);
  await recordActivity(db, {
    accountId,
    actorUserId: null,
    boardInstanceId: node.id,
    category: "controller",
    action: "controller.node_binding_verified",
    summary: `Verified binding generation ${generation} over ESP-NOW and Controller cloud`,
  });
  await captureBoardLog(
    { db, env: params.env ?? undefined, deps: params.deps, collector: params.collector },
    {
      accountId,
      boardInstanceId: node.id,
      category: "binding",
      severity: "success",
      status: "verified",
      method: "espnow",
      source: params.controllerId,
      destination: node.id,
      message: `Binding generation ${generation} verified over ESP-NOW and a healthy Controller cloud session.`,
      dedupeKey: `binding:verified:${node.id}:${generation}`,
      metadata: { controllerId: params.controllerId, generation },
    }
  );
  await captureBoardLog(
    { db, env: params.env ?? undefined, deps: params.deps, collector: params.collector },
    {
      accountId,
      boardInstanceId: params.controllerId,
      category: "communication",
      severity: "success",
      status: "verified",
      method: "espnow",
      source: params.controllerId,
      destination: node.id,
      message: `Binding with Node ${node.id} verified at generation ${generation}.`,
      dedupeKey: `binding:verified:${params.controllerId}:${node.id}:${generation}`,
      metadata: { nodeId: node.id, generation },
    }
  );
  return { verified: true, generation };
}

/** Issues a short-lived, single-use Worker binding challenge. */
export async function issueBindingChallenge(
  db: DbClient,
  params: {
    accountId: string;
    nodeId: string;
    controllerId: string;
  }
): Promise<
  | { ok: true; challengeId: string; nonce: string; generation: number; expiresAt: string }
  | { ok: false; status: number; error: string }
> {
  const { data: nodeRow } = await db
    .from("board_instances")
    .select("id,home_id,board_role,assigned_controller_id,binding_generation")
    .eq("id", params.nodeId)
    .eq("account_id", params.accountId)
    .is("deleted_at", null)
    .maybeSingle();
  const { data: ctrlRow } = await db
    .from("board_instances")
    .select("id,home_id,board_role,status")
    .eq("id", params.controllerId)
    .eq("account_id", params.accountId)
    .is("deleted_at", null)
    .maybeSingle();
  const node = nodeRow as {
    id: string;
    home_id: string;
    board_role?: string | null;
    assigned_controller_id?: string | null;
    binding_generation?: number | string | null;
  } | null;
  const controller = ctrlRow as {
    id: string;
    home_id: string;
    board_role?: string | null;
    status: string;
  } | null;
  if (!node || !controller) return { ok: false, status: 404, error: "Device not found." };
  if (normalizeBoardRole(node.board_role) !== "node" || node.assigned_controller_id !== controller.id) {
    return { ok: false, status: 409, error: "Board is not a Node assigned to this Controller." };
  }
  if (controller.home_id !== node.home_id || controller.status !== "online") {
    return { ok: false, status: 409, error: "Controller must be online in the same home." };
  }
  const generation = normalizeBindingGeneration(node.binding_generation) + 1;
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const nonce = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
  const { data, error } = await db
    .from("board_binding_challenges")
    .insert({
      account_id: params.accountId,
      node_id: params.nodeId,
      controller_id: params.controllerId,
      nonce,
      generation,
      expires_at: expiresAt,
    })
    .select("id")
    .maybeSingle();
  if (error || !data) {
    return { ok: false, status: 500, error: "Could not issue a binding challenge." };
  }
  return {
    ok: true,
    challengeId: String(data.id),
    nonce,
    generation,
    expiresAt,
  };
}
