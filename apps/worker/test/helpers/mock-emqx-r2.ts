import type { CustomFetch } from "../../src/lib/db";

export function createMockR2Bucket(): R2Bucket {
  const store = new Map<
    string,
    {
      bytes: Uint8Array;
      httpMetadata?: R2HTTPMetadata;
      customMetadata?: Record<string, string>;
    }
  >();

  return {
    async put(key: string, value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob, options?: R2PutOptions) {
      let bytes: Uint8Array;
      if (value instanceof Uint8Array) {
        bytes = new Uint8Array(value);
      } else if (value instanceof ArrayBuffer) {
        bytes = new Uint8Array(value);
      } else if (ArrayBuffer.isView(value)) {
        bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      } else if (typeof value === "string") {
        bytes = new TextEncoder().encode(value);
      } else {
        bytes = new Uint8Array(0);
      }
      store.set(key, {
        bytes,
        httpMetadata: options?.httpMetadata as R2HTTPMetadata | undefined,
        customMetadata: options?.customMetadata,
      });
      return {
        key,
        size: bytes.byteLength,
        etag: "mock-etag",
        httpEtag: '"mock-etag"',
        uploaded: new Date(),
        version: "1",
        checksums: {},
      } as unknown as R2Object;
    },
    async get(key: string) {
      const entry = store.get(key);
      if (!entry) return null;
      return {
        key,
        size: entry.bytes.byteLength,
        etag: "mock-etag",
        httpEtag: '"mock-etag"',
        uploaded: new Date(),
        version: "1",
        checksums: {},
        httpMetadata: entry.httpMetadata ?? {},
        customMetadata: entry.customMetadata ?? {},
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(entry.bytes);
            controller.close();
          },
        }),
        bodyUsed: false,
        async arrayBuffer() {
          return entry.bytes.buffer.slice(
            entry.bytes.byteOffset,
            entry.bytes.byteOffset + entry.bytes.byteLength
          );
        },
        async text() {
          return new TextDecoder().decode(entry.bytes);
        },
        async json() {
          return JSON.parse(new TextDecoder().decode(entry.bytes));
        },
        async blob() {
          return new Blob([entry.bytes]);
        },
      } as unknown as R2ObjectBody;
    },
    async delete(keys: string | string[]) {
      const list = Array.isArray(keys) ? keys : [keys];
      for (const k of list) store.delete(k);
    },
    async head(key: string) {
      const entry = store.get(key);
      if (!entry) return null;
      return {
        key,
        size: entry.bytes.byteLength,
        etag: "mock-etag",
      } as unknown as R2Object;
    },
    async list() {
      const objects = Array.from(store.entries()).map(([key, v]) => ({
        key,
        size: v.bytes.byteLength,
        etag: "mock-etag",
        uploaded: new Date(),
      }));
      return {
        objects,
        truncated: false,
        delimitedPrefixes: [],
      } as unknown as R2Objects;
    },
  } as unknown as R2Bucket;
}

export interface MockEmqxState {
  users: Map<string, { user_id: string; password: string; is_superuser: boolean }>;
  acls: Map<string, unknown[]>;
  published: Array<{ topic: string; payload: string; qos: number }>;
  kickedClients: string[];
  connectedClients: Set<string>;
}

export function createMockEmqxFetch(): {
  fetch: CustomFetch;
  state: MockEmqxState;
} {
  const state: MockEmqxState = {
    users: new Map(),
    acls: new Map(),
    published: [],
    kickedClients: [],
    connectedClients: new Set(),
  };

  const fetchImpl: CustomFetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const method = (init?.method ?? "GET").toUpperCase();
    const path = url.pathname.replace(/^\/api\/v5/, "");
    const rawBody = typeof init?.body === "string" ? init.body : undefined;
    const jsonBody = rawBody ? JSON.parse(rawBody) : null;

    const jsonRes = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json" },
      });

    if (path === "/clients" && method === "GET") {
      const list = Array.from(state.connectedClients).map((cid) => ({
        clientid: cid,
        connected: true,
      }));
      return jsonRes({ data: list, meta: { count: list.length } });
    }

    if (path.startsWith("/clients/") && method === "GET") {
      const cid = decodeURIComponent(path.slice("/clients/".length));
      if (!state.connectedClients.has(cid)) {
        return jsonRes({ message: "Not found" }, 404);
      }
      return jsonRes({ clientid: cid, connected: true });
    }

    if (path.startsWith("/clients/") && method === "DELETE") {
      const cid = decodeURIComponent(path.slice("/clients/".length));
      state.kickedClients.push(cid);
      state.connectedClients.delete(cid);
      return new Response(null, { status: 204 });
    }

    if (path === "/authentication/password_based:built_in_database/users" && method === "POST") {
      const uid = jsonBody.user_id as string;
      if (state.users.has(uid)) return jsonRes({ message: "Conflict" }, 409);
      state.users.set(uid, jsonBody);
      return jsonRes(jsonBody, 201);
    }

    if (path.startsWith("/authentication/password_based:built_in_database/users/") && method === "DELETE") {
      const uid = decodeURIComponent(path.split("/").pop()!);
      if (!state.users.has(uid)) return jsonRes({ message: "Not found" }, 404);
      state.users.delete(uid);
      return new Response(null, { status: 204 });
    }

    if (path === "/authorization/sources/built_in_database/rules/users" && method === "POST") {
      const arr = Array.isArray(jsonBody) ? jsonBody : [jsonBody];
      for (const item of arr) {
        state.acls.set(item.username, item.rules);
      }
      return jsonRes({ ok: true }, 201);
    }

    if (path.startsWith("/authorization/sources/built_in_database/rules/users/")) {
      const uid = decodeURIComponent(path.split("/").pop()!);
      if (method === "GET") {
        if (!state.acls.has(uid)) return jsonRes({ message: "Not found" }, 404);
        return jsonRes({ username: uid, rules: state.acls.get(uid) });
      }
      if (method === "PUT") {
        state.acls.set(uid, jsonBody.rules);
        return jsonRes({ username: uid, rules: jsonBody.rules });
      }
      if (method === "DELETE") {
        state.acls.delete(uid);
        return new Response(null, { status: 204 });
      }
    }

    if (path === "/publish" && method === "POST") {
      state.published.push({
        topic: jsonBody.topic,
        payload: jsonBody.payload,
        qos: jsonBody.qos ?? 1,
      });
      return jsonRes({ id: "msg-1", reason_code: 0 });
    }

    if (path === "/monitor_current" && method === "GET") {
      return jsonRes({
        connections: state.connectedClients.size,
        subscriptions: 0,
        topics: state.acls.size,
      });
    }

    return jsonRes({ message: `Unmocked EMQX endpoint: ${method} ${path}` }, 404);
  };

  return { fetch: fetchImpl, state };
}
