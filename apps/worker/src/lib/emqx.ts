import {
  inspectConfiguration,
  requireEmqxConfig,
  type WorkerBindings,
} from "../config/env";
import type { CustomFetch } from "./db";

export interface EmqxAclRule {
  permission: "allow" | "deny";
  action: "publish" | "subscribe" | "all";
  topic: string;
}

export interface EmqxClientInfo {
  clientid: string;
  username?: string;
  connected?: boolean;
  ip_address?: string;
  connected_at?: string;
  disconnected_at?: string;
  keepalive?: number;
  proto_ver?: number;
  subscriptions_cnt?: number;
  recv_msg?: number;
  send_msg?: number;
}

export class EmqxApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "EmqxApiError";
    this.status = status;
  }
}

export function buildControllerTopicPrefix(
  accountId: string,
  controllerId: string
): string {
  return `homecore/${accountId}/controllers/${controllerId}`;
}

export function buildControllerAclRules(
  accountId: string,
  controllerId: string
): EmqxAclRule[] {
  const prefix = buildControllerTopicPrefix(accountId, controllerId);
  return [
    {
      permission: "allow",
      action: "publish",
      topic: `${prefix}/telemetry/#`,
    },
    {
      permission: "allow",
      action: "publish",
      topic: `${prefix}/state/#`,
    },
    {
      permission: "allow",
      action: "publish",
      topic: `${prefix}/status/#`,
    },
    {
      permission: "allow",
      action: "publish",
      topic: `${prefix}/ota/progress`,
    },
    {
      permission: "allow",
      action: "publish",
      topic: `${prefix}/config/ack`,
    },
    {
      permission: "allow",
      action: "subscribe",
      topic: `${prefix}/cmd/#`,
    },
    {
      permission: "allow",
      action: "subscribe",
      topic: `${prefix}/config/#`,
    },
    {
      permission: "allow",
      action: "subscribe",
      topic: `${prefix}/ota/cmd`,
    },
    {
      permission: "deny",
      action: "all",
      topic: "#",
    },
  ];
}

export class EmqxClient {
  private readonly apiBase: string;
  private readonly authHeader: string;
  private readonly fetchImpl: CustomFetch;

  constructor(env: WorkerBindings, customFetch?: CustomFetch) {
    const cfg = requireEmqxConfig(env);
    this.apiBase = cfg.apiBase;
    this.authHeader = `Basic ${btoa(`${cfg.appId}:${cfg.appSecret}`)}`;
    this.fetchImpl = customFetch ?? ((...args) => globalThis.fetch(...args));
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<{ status: number; data: T }> {
    const timeoutSignal =
      typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
        ? AbortSignal.timeout(6000)
        : undefined;
    const res = await this.fetchImpl(`${this.apiBase}${path}`, {
      method,
      headers: {
        Authorization: this.authHeader,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      ...(timeoutSignal ? { signal: timeoutSignal } : {}),
    });

    const text = await res.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { message: text.slice(0, 300) };
      }
    }

    if (!res.ok) {
      const msg =
        parsed && typeof parsed === "object" && "message" in parsed
          ? String((parsed as { message: unknown }).message)
          : `EMQX API error (${res.status})`;
      throw new EmqxApiError(msg, res.status);
    }

    return { status: res.status, data: parsed as T };
  }

  async checkConnection(): Promise<{
    connected: boolean;
    activeClientsCount?: number;
    error?: string;
  }> {
    try {
      const res = await this.request<{
        data?: unknown[];
        meta?: { count?: number };
      }>("GET", "/clients?page=1&limit=1");
      return {
        connected: true,
        activeClientsCount: res.data?.meta?.count ?? res.data?.data?.length ?? 0,
      };
    } catch (err) {
      return {
        connected: false,
        error: err instanceof Error ? err.message : "EMQX API check failed",
      };
    }
  }

  async provisionControllerCredentials(params: {
    accountId: string;
    controllerId: string;
    username: string;
    password: string;
  }): Promise<void> {
    const encodedUser = encodeURIComponent(params.username);
    // Create or update built-in DB MQTT user
    try {
      await this.request(
        "POST",
        "/authentication/password_based:built_in_database/users",
        {
          user_id: params.username,
          password: params.password,
          is_superuser: false,
        }
      );
    } catch (err) {
      if (err instanceof EmqxApiError && err.status === 409) {
        await this.request(
          "PUT",
          `/authentication/password_based:built_in_database/users/${encodedUser}`,
          {
            password: params.password,
            is_superuser: false,
          }
        );
      } else {
        throw err;
      }
    }

    // Set strict account + controller scoped topic ACL
    const rules = buildControllerAclRules(params.accountId, params.controllerId);
    const aclPayload = {
      username: params.username,
      rules,
    };

    try {
      await this.request(
        "GET",
        `/authorization/sources/built_in_database/rules/users/${encodedUser}`
      );
      await this.request(
        "PUT",
        `/authorization/sources/built_in_database/rules/users/${encodedUser}`,
        aclPayload
      );
    } catch (err) {
      if (err instanceof EmqxApiError && err.status === 404) {
        await this.request(
          "POST",
          "/authorization/sources/built_in_database/rules/users",
          [aclPayload]
        );
      } else {
        throw err;
      }
    }
  }

  async revokeControllerCredentials(
    username: string,
    clientId?: string
  ): Promise<void> {
    const encodedUser = encodeURIComponent(username);
    if (clientId) {
      try {
        await this.request("DELETE", `/clients/${encodeURIComponent(clientId)}`);
      } catch (err) {
        if (!(err instanceof EmqxApiError && (err.status === 404 || err.status === 400))) {
          // Kick best-effort so ACL & user revocation always execute
        }
      }
    }

    try {
      await this.request(
        "DELETE",
        `/authorization/sources/built_in_database/rules/users/${encodedUser}`
      );
    } catch (err) {
      if (!(err instanceof EmqxApiError && err.status === 404)) throw err;
    }

    try {
      await this.request(
        "DELETE",
        `/authentication/password_based:built_in_database/users/${encodedUser}`
      );
    } catch (err) {
      if (!(err instanceof EmqxApiError && err.status === 404)) throw err;
    }
  }

  async kickClient(clientId: string): Promise<void> {
    try {
      await this.request("DELETE", `/clients/${encodeURIComponent(clientId)}`);
    } catch (err) {
      if (!(err instanceof EmqxApiError && err.status === 404)) throw err;
    }
  }

  async getClient(clientId: string): Promise<EmqxClientInfo | null> {
    try {
      const res = await this.request<EmqxClientInfo>(
        "GET",
        `/clients/${encodeURIComponent(clientId)}`
      );
      return res.data;
    } catch (err) {
      if (err instanceof EmqxApiError && err.status === 404) return null;
      throw err;
    }
  }

  async listClients(page = 1, limit = 50): Promise<{
    data: EmqxClientInfo[];
    meta?: { count?: number; page?: number; limit?: number; hasnext?: boolean };
  }> {
    const res = await this.request<{
      data?: EmqxClientInfo[];
      meta?: { count?: number; page?: number; limit?: number; hasnext?: boolean };
    }>("GET", `/clients?page=${page}&limit=${limit}`);
    return {
      data: res.data?.data ?? [],
      meta: res.data?.meta,
    };
  }

  async publish(params: {
    topic: string;
    payload: string | Record<string, unknown>;
    qos?: 0 | 1 | 2;
    retain?: boolean;
  }): Promise<{ id?: string; reason_code?: number; message?: string }> {
    const serialized =
      typeof params.payload === "string"
        ? params.payload
        : JSON.stringify(params.payload);
    const res = await this.request<{
      id?: string;
      reason_code?: number;
      message?: string;
    }>("POST", "/publish", {
      topic: params.topic,
      payload: serialized,
      payload_encoding: "plain",
      qos: params.qos ?? 1,
      retain: params.retain ?? false,
    });
    return res.data ?? {};
  }

  async getMetrics(): Promise<Record<string, unknown> | null> {
    try {
      const res = await this.request<Record<string, unknown>>(
        "GET",
        "/monitor_current"
      );
      return res.data;
    } catch (err) {
      if (err instanceof EmqxApiError && (err.status === 404 || err.status === 501)) {
        return null;
      }
      throw err;
    }
  }
}

export function isEmqxConfigured(env: WorkerBindings): boolean {
  return inspectConfiguration(env).emqxReady;
}
