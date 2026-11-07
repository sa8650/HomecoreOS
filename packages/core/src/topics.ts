/** Tenant-scoped MQTT topic contract. Server-side only helpers may sign ACLs. */

export const TOPIC_VERSION = 'v1';

export type TopicKind = 'command' | 'state' | 'telemetry' | 'config' | 'availability';

export function topic(tenantId: string, deviceId: string, kind: TopicKind): string {
  return `${TOPIC_VERSION}/tenants/${tenantId}/devices/${deviceId}/${kind}`;
}

export function deviceTopics(tenantId: string, deviceId: string): Record<TopicKind, string> {
  return {
    command: topic(tenantId, deviceId, 'command'),
    state: topic(tenantId, deviceId, 'state'),
    telemetry: topic(tenantId, deviceId, 'telemetry'),
    config: topic(tenantId, deviceId, 'config'),
    availability: topic(tenantId, deviceId, 'availability'),
  };
}

/** Publish/subscribe permissions are strictly separated for each device. */
export function deviceAclRules(tenantId: string, deviceId: string) {
  const t = deviceTopics(tenantId, deviceId);
  return {
    publish: [t.state, t.telemetry, t.availability],
    subscribe: [t.command, t.config],
    // wildcard deny-all is the provider default via no_match=deny
    deny: ['#'],
  };
}

const TOPIC_RE = /^v1\/tenants\/([0-9a-f-]{36})\/devices\/([A-Za-z0-9_-]{4,64})\/(command|state|telemetry|config|availability)$/;

export function parseTopic(input: string) {
  const m = TOPIC_RE.exec(input);
  if (!m) return null;
  return { tenantId: m[1]!, deviceId: m[2]!, kind: m[3] as TopicKind };
}

/** The bridge wildcard subscription: platform-side only, never for devices. */
export const PLATFORM_INGRESS_FILTER = 'v1/tenants/+/devices/+/+';

export function wildcardTopic(t: string): string {
  return t.replace(/^v1\/tenants\/[^/]+\/devices\/[^/]+/, 'v1/tenants/+/devices/+');
}
