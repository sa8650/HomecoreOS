import { normalizeBoardRole } from "@homecoreos/shared";
import type { DbClient } from "./db";

/**
 * Where a switch/device command for one board has to be published.
 *
 * A Controller always has its own EMQX session, so commands go straight to its
 * `cmd/switch` or `cmd/device` topic. A Node that is linked to its Controller
 * over ESP-NOW deliberately keeps **no** EMQX session (see
 * `packages/shared/src/board-role.ts`), so an EMQX publish to its own topic
 * would be accepted by the broker but never delivered. For those Nodes the
 * command is wrapped as `action: "relay_to_node"` on the **Controller's**
 * `cmd/system` topic; the Controller forwards it over ESP-NOW.
 *
 * A standalone Node (Wi-Fi/MQTT fallback) has its own session again and is
 * addressed directly, so a forgotten role never turns into a lost command.
 */
export interface DeviceCommandDelivery {
  topic: string;
  payload: Record<string, unknown>;
  /** Set when the command travels through a Controller over ESP-NOW. */
  relayedViaControllerId: string | null;
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
    .select("id,board_role,assigned_controller_id,mqtt_connected")
    .eq("id", params.deviceId)
    .eq("account_id", params.accountId)
    .is("deleted_at", null)
    .maybeSingle();

  const device = row as {
    id: string;
    board_role?: string | null;
    assigned_controller_id?: string | null;
    mqtt_connected?: boolean | null;
  } | null;

  const credential =
    params.credential ?? (await loadActiveCredential(db, params.accountId, params.deviceId));

  const isNode = normalizeBoardRole(device?.board_role) === "node";
  const hasOwnSession =
    Boolean(credential) && (credential!.status ?? "active") === "active";

  if (!isNode || (hasOwnSession && device?.mqtt_connected)) {
    if (!hasOwnSession) return null;
    return {
      topic: `${credential!.topic_prefix}/cmd/${params.kind}`,
      payload: params.payload,
      relayedViaControllerId: null,
    };
  }

  // Linked Node: no session of its own — relay through its Controller.
  const parentId = device?.assigned_controller_id;
  if (!parentId) return null;
  const parentCredential = await loadActiveCredential(db, params.accountId, parentId);
  if (!parentCredential) return null;

  return {
    topic: `${parentCredential.topic_prefix}/cmd/system`,
    payload: {
      action: "relay_to_node",
      node_id: params.deviceId,
      kind: params.kind,
      payload: params.payload,
    },
    relayedViaControllerId: parentId,
  };
}

