// @vitest-environment node
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createBroker, type AuthenticateError } from "aedes";
import type { Client, Subscription } from "aedes";
import { WebSocketServer, createWebSocketStream } from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMqttTransport } from "./transport";
import type { RealtimeTransportParams } from "./transport";

interface BrokerHarness {
  url: string;
  publish: (topic: string, payload: string) => void;
  close: () => Promise<void>;
}

/**
 * Boots a real MQTT broker with a WebSocket listener so the browser transport
 * is exercised end-to-end (CONNECT → SUBSCRIBE → PUBLISH → callback) instead of
 * only against a stub. Broker-side ACL enforcement mirrors EMQX: publishing to
 * the state topic is allowed for the Worker, subscribing is allowed for the
 * browser identity only on its own account tree.
 */
async function startBroker(): Promise<BrokerHarness> {
  const aedes = createBroker();

  aedes.authenticate = (
    _client: Client | null,
    username: string | undefined,
    password: Buffer | undefined,
    done: (error: AuthenticateError | null, success: boolean | null) => void
  ) => {
    const ok = username === "hcweb-test" && password?.toString() === "derived-secret";
    done(null, ok);
  };
  aedes.authorizeSubscribe = (
    _client: Client | null,
    subscription: Subscription,
    done: (error: Error | null, subscription: Subscription | null) => void
  ) => {
    if (!subscription.topic.startsWith("homecore/acct-e2e/realtime/")) {
      const error = new Error("subscribe denied") as Error & { returnCode: number };
      error.returnCode = 4;
      return done(error, null);
    }
    done(null, subscription);
  };
  aedes.authorizePublish = (
    _client: Client | null,
    packet: { topic: string },
    done: (error?: Error | null) => void
  ) => {
    if (packet.topic === "homecore/acct-e2e/realtime/events") return done(null);
    done(new Error("publish denied"));
  };

  const httpServer = createServer();
  const wsServer = new WebSocketServer({ server: httpServer });
  wsServer.on("connection", (socket) => {
    aedes.handle(createWebSocketStream(socket));
  });
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const port = (httpServer.address() as AddressInfo).port;

  return {
    url: `ws://127.0.0.1:${port}/mqtt`,
    publish: (topic, payload) => {
      aedes.publish(
        {
          cmd: "publish",
          topic,
          payload: Buffer.from(payload),
          qos: 0,
          retain: false,
          dup: false,
        },
        () => {}
      );
    },
    close: async () => {
      wsServer.close();
      await new Promise<void>((resolve) => aedes.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

describe("MQTT-over-WebSocket transport (real broker)", () => {
  let broker: BrokerHarness;
  let transport: ReturnType<typeof createMqttTransport> | null = null;

  beforeAll(async () => {
    broker = await startBroker();
  }, 20_000);

  afterAll(async () => {
    transport?.close();
    await broker.close();
  });

  it("connects with the derived credential, subscribes to the account channel and receives envelopes", async () => {
    const messages: string[] = [];
    let connected = false;

    const params: RealtimeTransportParams = {
      brokerUrl: broker.url,
      username: "hcweb-test",
      password: "derived-secret",
      clientId: "hcweb-e2e",
      topic: "homecore/acct-e2e/realtime/#",
      onConnected: () => {
        connected = true;
      },
      onDisconnected: () => {},
      onError: (message) => {
        throw new Error(message);
      },
      onMessage: (payload) => messages.push(payload),
    };

    transport = createMqttTransport(params);
    await new Promise<void>((resolve, reject) => {
      const started = Date.now();
      const timer = setInterval(() => {
        if (connected) {
          clearInterval(timer);
          resolve();
        } else if (Date.now() - started > 8_000) {
          clearInterval(timer);
          reject(new Error("transport never connected"));
        }
      }, 25);
    });

    const envelope = JSON.stringify({
      v: 1,
      accountId: "acct-e2e",
      sentAt: new Date().toISOString(),
      events: [
        {
          entity: "switch",
          action: "state",
          id: "sw-e2e",
          ts: new Date().toISOString(),
          phase: "confirmed",
          patch: { isOn: true },
        },
      ],
    });

    broker.publish("homecore/acct-e2e/realtime/events", envelope);

    await new Promise<void>((resolve, reject) => {
      const started = Date.now();
      const timer = setInterval(() => {
        if (messages.length > 0) {
          clearInterval(timer);
          resolve();
        } else if (Date.now() - started > 8_000) {
          clearInterval(timer);
          reject(new Error("no message received"));
        }
      }, 25);
    });

    expect(JSON.parse(messages[0]!)).toMatchObject({
      v: 1,
      accountId: "acct-e2e",
      events: [{ entity: "switch", id: "sw-e2e", phase: "confirmed" }],
    });
  }, 20_000);
});
