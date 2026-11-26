import { normalizeBoardRole } from "@homecoreos/shared";
import type { DbClient } from "./db";
import { commandIdentity, decideNodeRoute, type RouteAuthorityRow } from "./route-authority";

/**
 * Where a switch/device command for one board has to be published.
 *
 * Route authority is the connectivity state, not the role or the assignment
 * alone. A Node with a healthy MQTT session is always directly reachable; a
 * Controller relay is used only when fresh telemetry proves a verified,
 * generation-matched roster entry and a live Controller MQTT session.
 */
export interface DeviceCommandDelivery {
  topic: string;
  payload: Record<string, unknown>;
  /** Set when the command travels through a Controller over ESP-NOW. */
  relayedViaControllerId: string | null;
  route: string;
  commandId: string;
}

type CredentialRow = { topic_prefix: string; status?: string | null };

async function loadActiveCredential(
  db: DbClient,
  accountId: string,
  deviceId: string
): Promise<CredentialRow | null> {
  const { data } = await db
    .from("mqtt_credentials_metadata")
    .select("topic_prefix,status")
    .eq("board_instance_id", deviceId)
    .eq("account_id", accountId)
    .eq("status", "active")
    .maybeSingle();
  return (data as CredentialRow | null) ?? null;
}

export async function resolveDeviceCommandDelivery(
  db: DbClient,
  params: {
    accountId: string;
    /** Board that owns the switch/device (a Controller or a Node). */
    deviceId: string;
    kind: "switch" | "device";
    payload: Record<string, unknown>;
    /** Credential already loaded by the caller, to avoid a second query. */
    credential?: CredentialRow | null;
  }
): Promise<DeviceCommandDelivery | null> {
  const { data: row } = await db
    .from("board_instances")
    .select(
      "id,board_role,assigned_controller_id,mqtt_connected,status,binding_id,binding_state,binding_generation,cloud_route,last_heartbeat_at,last_communication_at,node_last_linked_at,espnow_telemetry"
    )
    .eq("id", params.deviceId)
    .eq("account_id", params.accountId)
    .is("deleted_at", null)
    .maybeSingle();

  const device = row as RouteAuthorityRow | null;
  const credential =
    params.credential ?? (await loadActiveCredential(db, params.accountId, params.deviceId));
  const commandId = commandIdentity(params.payload);
  const stablePayload = { ...params.payload, command_id: commandId, cid: commandId };

  const isNode = normalizeBoardRole(device?.board_role) === "node";
  if (!isNode) {
    if (!credential) return null;
    return {
      topic: `${credential.topic_prefix}/cmd/${params.kind}`,
      payload: stablePayload,
      relayedViaControllerId: null,
      route: "controller_mqtt",
      commandId,
    };
  }

  let controller: RouteAuthorityRow | null = null;
  if (device?.assigned_controller_id) {
    const { data: ctrlRow } = await db
      .from("board_instances")
      .select(
        "id,board_role,status,mqtt_connected,binding_state,binding_generation,cloud_route,last_heartbeat_at,last_communication_at,espnow_telemetry"
      )
      .eq("id", device.assigned_controller_id)
      .eq("account_id", params.accountId)
      .is("deleted_at", null)
      .maybeSingle();
    controller = (ctrlRow as RouteAuthorityRow | null) ?? null;
  }

  const decision = decideNodeRoute({
    node: device ?? { id: params.deviceId },
    controller,
    nodeId: params.deviceId,
    commandId,
  });

  if (decision.route === "direct_node_mqtt" && credential) {
    return {
      topic: `${credential.topic_prefix}/cmd/${params.kind}`,
      payload: { ...stablePayload, gen: decision.generation },
      relayedViaControllerId: null,
      route: decision.route,
      commandId,
    };
  }

  if (decision.route === "controller_mqtt" && controller) {
    const parentCredential = await loadActiveCredential(
      db,
      params.accountId,
      controller.id
    );
    if (!parentCredential) return null;
    return {
      topic: `${parentCredential.topic_prefix}/cmd/system`,
      payload: {
        action: "relay_to_node",
        node_id: params.deviceId,
        kind: params.kind,
        payload: stablePayload,
        cid: commandId,
        gen: decision.generation,
      },
      relayedViaControllerId: controller.id,
      route: decision.route,
      commandId,
    };
  }

  /* No healthy route: defer rather than publish into a black hole. Callers
   * report mqttDispatched:false and keep the command in their own history. */
  return null;
}
