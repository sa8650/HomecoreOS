import mqtt from "mqtt";

export interface RealtimeTransportHandlers {
  onConnected: () => void;
  onDisconnected: (reason: string) => void;
  onError: (message: string) => void;
  onMessage: (payload: string) => void;
}

export interface RealtimeTransportParams extends RealtimeTransportHandlers {
  brokerUrl: string;
  username: string;
  password: string;
  clientId: string;
  topic: string;
}

export interface RealtimeTransport {
  close: () => void;
}

export type RealtimeTransportFactory = (params: RealtimeTransportParams) => RealtimeTransport;

/**
 * MQTT-over-WebSocket transport.
 *
 * Auto-reconnect is disabled here (`reconnectPeriod: 0`) on purpose: the sync
 * client owns the backoff schedule so it can reconcile a snapshot between
 * attempts instead of silently resubscribing and missing changes.
 *
 * The credential is subscribe-only and account-scoped; the password is derived
 * per login session by the Worker and never embedded in the bundle.
 */
export const createMqttTransport: RealtimeTransportFactory = (params) => {
  const client = mqtt.connect(params.brokerUrl, {
    clientId: params.clientId,
    username: params.username,
    password: params.password,
    protocolVersion: 4,
    clean: true,
    keepalive: 30,
    connectTimeout: 8_000,
    reconnectPeriod: 0,
    resubscribe: false,
  });

  let closed = false;

  client.on("connect", () => {
    if (closed) return;
    // QoS 1 permits acknowledged low-volume state events; a QoS 0 publish still
    // arrives (downgraded), so this never changes message volume.
    client.subscribe(params.topic, { qos: 1 }, (err) => {
      if (err) {
        params.onError(err.message || "Realtime subscription failed");
        return;
      }
      params.onConnected();
    });
  });

  client.on("message", (_topic, payload) => {
    if (closed) return;
    try {
      params.onMessage(payload.toString());
    } catch {
      // Malformed payloads are ignored; the snapshot repairs state.
    }
  });

  client.on("error", (err: Error) => {
    if (closed) return;
    params.onError(err?.message || "Realtime transport error");
  });

  client.on("close", () => {
    if (closed) return;
    params.onDisconnected("closed");
  });

  return {
    close: () => {
      closed = true;
      try {
        client.end(true);
      } catch {
        // ignore
      }
    },
  };
};
