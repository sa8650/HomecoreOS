/**
 * Minimal MQTT 3.1.1 client over WebSocket, written for Cloudflare Durable
 * Objects (Web APIs only — no Node net/tls, no mqtt.js dependency).
 *
 * Why this exists: EMQX Cloud Serverless does not support HTTP authentication
 * hooks, and its Deployment API does not expose a general message webhook on
 * every plan. A Durable Object can hold ONE long-lived outbound WSS connection
 * as a platform-side ingestion bridge. Device-originated messages are then
 * forwarded to the same `handleIngress` used by the local broker, which derives
 * the tenant from the database — never from the JSON payload.
 *
 * The bridge uses a dedicated, ACL-restricted platform credential. Devices and
 * browsers never receive it. `MqttProvider.publish` still uses the Deployment
 * REST API for commands/config, so the bridge only needs subscribe permission.
 */

export interface BridgeOptions {
  url: string;               // wss://<broker>:8084/mqtt
  clientId: string;
  username: string;
  password: string;
  topics: string[];
  keepAliveSeconds?: number;
  onPublish: (topic: string, payload: Uint8Array) => Promise<void>;
  onState?: (state: 'connecting' | 'connected' | 'disconnected', detail?: string) => void;
}

function utf8(s: string): Uint8Array { return new TextEncoder().encode(s); }
function u16(n: number): Uint8Array { return new Uint8Array([(n >> 8) & 0xff, n & 0xff]); }
function encodeLength(n: number): Uint8Array {
  const out: number[] = [];
  do { let d = n % 128; n = Math.floor(n / 128); if (n > 0) d |= 0x80; out.push(d); } while (n > 0);
  return new Uint8Array(out);
}
function packet(type: number, flags: number, body: Uint8Array): Uint8Array {
  const head = new Uint8Array([((type << 4) | flags) & 0xff]);
  const len = encodeLength(body.length);
  const out = new Uint8Array(head.length + len.length + body.length);
  out.set(head, 0); out.set(len, head.length); out.set(body, head.length + len.length);
  return out;
}
function field(s: string): Uint8Array {
  const b = utf8(s), out = new Uint8Array(2 + b.length);
  out.set(u16(b.length), 0); out.set(b, 2);
  return out;
}
function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export class MqttWsBridge {
  private ws: WebSocket | null = null;
  private buffer = new Uint8Array(0);
  private packetId = 1;
  private closed = false;
  constructor(private opts: BridgeOptions) {}

  get connected() { return this.ws?.readyState === WebSocket.OPEN; }

  connect() {
    if (this.closed) return;
    this.opts.onState?.('connecting');
    const ws = new WebSocket(this.opts.url, 'mqtt');
    (ws as any).binaryType = 'arraybuffer';
    this.ws = ws;
    ws.addEventListener('open', () => {
      const keep = this.opts.keepAliveSeconds ?? 60;
      const body = concat(
        field('MQTT'), new Uint8Array([4]), new Uint8Array([0xc2]), u16(keep),
        field(this.opts.clientId), field(this.opts.username), field(this.opts.password),
      );
      ws.send(packet(1, 0, body));
    });
    ws.addEventListener('message', (ev: MessageEvent) => {
      const data = ev.data instanceof ArrayBuffer ? new Uint8Array(ev.data) : new Uint8Array(utf8(String(ev.data)));
      this.onData(data);
    });
    ws.addEventListener('close', () => {
      this.opts.onState?.('disconnected', 'WebSocket closed');
      if (!this.closed) setTimeout(() => this.connect(), 3000);
    });
    ws.addEventListener('error', () => this.opts.onState?.('disconnected', 'WebSocket error'));
  }

  /** Called by the Durable Object alarm. */
  tick() {
    if (this.closed) return;
    if (!this.connected) { this.connect(); return; }
    this.ws!.send(packet(12, 0, new Uint8Array(0))); // PINGREQ
  }

  stop() {
    this.closed = true;
    try { this.ws?.send(packet(14, 0, new Uint8Array(0))); } catch { /* already gone */ }
    try { this.ws?.close(); } catch { /* already gone */ }
    this.ws = null;
  }

  private subscribe() {
    const id = u16(this.packetId++);
    const payload = concat(...this.opts.topics.map((t) => concat(field(t), new Uint8Array([1]))));
    this.ws!.send(packet(8, 0x02, concat(id, payload)));
  }

  private onData(chunk: Uint8Array) {
    const merged = new Uint8Array(this.buffer.length + chunk.length);
    merged.set(this.buffer, 0); merged.set(chunk, this.buffer.length);
    let b = merged;
    while (b.length >= 2) {
      let multiplier = 1, len = 0, i = 1;
      do {
        if (i >= b.length) { this.buffer = b; return; }
        len += (b[i]! & 0x7f) * multiplier;
        multiplier *= 128;
      } while ((b[i++]! & 0x80) !== 0);
      if (b.length < i + len) { this.buffer = b; return; }
      const type = (b[0]! >> 4) & 0x0f;
      const flags = b[0]! & 0x0f;
      const body = b.slice(i, i + len);
      b = b.slice(i + len);
      this.handlePacket(type, flags, body);
    }
    this.buffer = b;
  }

  private handlePacket(type: number, flags: number, body: Uint8Array) {
    if (type === 2) { // CONNACK
      if ((body[1] ?? 1) === 0) { this.opts.onState?.('connected'); this.subscribe(); }
      else this.opts.onState?.('disconnected', `CONNACK code ${body[1]}`);
      return;
    }
    if (type === 9) return; // SUBACK
    if (type === 13) return; // PINGRESP
    if (type === 3) { // PUBLISH
      if (body.length < 2) return;
      const topicLen = (body[0]! << 8) | body[1]!;
      const topic = new TextDecoder().decode(body.slice(2, 2 + topicLen));
      const qos = (flags >> 1) & 0x03;
      const offset = 2 + topicLen + (qos > 0 ? 2 : 0);
      const payload = body.slice(offset);
      void this.opts.onPublish(topic, payload);
    }
  }
}
