# EMQX Cloud Serverless integration — verified facts and limitations

This document records what was actually verified against EMQX documentation before implementing per-device provisioning and the owner usage dashboard. It is deliberately explicit about what the provider API does **not** expose.

## 1. Verified capabilities

Source: EMQX Cloud documentation, EMQX v5 API docs, EMQX Cloud Serverless API notes and the `emqx-cloud-mcp-server` endpoint list.

| Capability | Status | Endpoint / note |
|---|---|---|
| Deployment API (v5 subset) | Supported | Base ends in `/api/v5`, basic auth with AppID / AppSecret created via "Create Application" |
| Built-in-database authentication | Supported | `POST /api/v5/authentication/password_based%3Abuilt_in_database/users` with `{user_id, password, is_superuser:false}` |
| Update / delete user | Supported | `PUT/DELETE /api/v5/authentication/password_based%3Abuilt_in_database/users/{user_id}` |
| Per-username authorization rules | Supported | `POST /api/v5/authorization/sources/built_in_database/rules/users` with `[{username, rules:[{topic,permission,action}]}]`; rules use `allow`/`deny`, `publish`/`subscribe`/`all` |
| Replace rule set for one user | Supported | `PUT .../rules/users/{username}` |
| Clear client authz cache | Supported | `DELETE /api/v5/clients/{clientid}/authorization/cache` |
| Kick a client | Supported | `DELETE /api/v5/clients/{clientid}` |
| Publish a message | Supported | `POST /api/v5/publish` with `{topic,payload,qos,retain}` |
| Live client list / metrics | Supported | `GET /api/v5/clients`, `GET /api/v5/metrics` |
| Subscription information | Supported | `GET /api/v5/subscriptions` |
| HTTP authentication hook | **Not supported on Serverless** | `docs.emqx.com/en/cloud/latest/deployments/http_auth.html` |
| Batch user import | Supported | multipart import, up to 1000 users (not used here) |

## 2. Consequences for Helios

Because HTTP auth is unavailable, the Worker **cannot** be an authentication webhook. Instead, at pairing:

1. The Worker creates a unique username/password/client id.
2. `EmqxCloudProvider.provisionDevice()` creates a built-in-database user via the Deployment API.
3. It writes a per-username allow-list: publish to this board's `state`, `telemetry`, `availability`; subscribe to its `command`, `config`; then `{topic:"#", action:"all", permission:"deny"}` as a fallback. Authorization is configured with `no_match = deny`.
4. On ACL failure the user is deleted immediately, so no half-provisioned device can connect.
5. The Worker stores only a PBKDF2 hash of the password in `mqtt_credentials_metadata`; the plaintext is returned to the firmware exactly once.
6. Revoke = delete ACL rules + user + kick client. Rotate = update password + kick.

There is **no shared admin credential on devices or browsers**. The only shared credential is a dedicated platform-side ingress bridge used by the Durable Object, with subscribe-only ACL — it never appears in frontend JavaScript or ESP32 firmware.

If a deployment lacks one of these endpoints, provisioning throws a clear 502 and no device row is created. The system never silently degrades to shared credentials. Documented fallback for such a deployment: move to a self-hosted EMQX (or a paid/dedicated EMQX tier) with the same v5 API, keeping the identical `MqttProvider` interface and firmware topic contract.

## 3. Usage metrics — what is and is not available

Verified Serverless free-tier quotas: **1,000,000 session minutes**, **1 GB traffic**, **1,000,000 rule actions** per month, **1,000** maximum connections, **1 MB** max message size. Usage statistics on the EMQX Cloud console are updated **hourly**; exceeding the free quota stops the deployment until the next month (spend limit controls overage).

| Metric requested | Deployment API | Helios behaviour |
|---|---|---|
| Monthly traffic / quota / remaining / utilisation | Not exposed (console only) | Shows "Unavailable" + reason; owner enters a console snapshot (`source=owner_manual`) |
| Inbound / outbound byte split | Not exposed | Unavailable unless the owner enters it |
| Packet traffic | Not exposed as a period series | Unavailable unless the owner enters it |
| Active client connections | `GET /api/v5/clients` (live) | Owner "Sync from EMQX" records the live count (`source=provider_api`) |
| Connection / session minutes | Not exposed | Unavailable unless the owner enters it |
| Message volume | Cumulative broker metrics only, not monthly quota | Unavailable unless the owner enters it; never relabelled as quota usage |
| Usage history / daily and monthly charts | Not exposed as a time series | Charts render only from recorded snapshots; otherwise an honest empty state |
| Last usage synchronization | Application-owned | `mqtt.last_sync_at` + `emqx_sync_runs` |
| Quota warnings at 50/75/90/100% | Application-owned | `usage.warning_thresholds`, configurable in Platform Settings; warning tones only apply to real recorded values |

`emqx_usage_snapshots.source` is always one of `provider_api`, `owner_manual`, `provider_dashboard`. Application-derived counters (`usage_counters`, `device_commands`, `sensor_readings`) are shown in a separate card labelled **"Application-side estimate"** and are never mixed into official totals. Null values are never rendered as zero.

## 4. Ingress (device → platform)

| Path | When | Identity source |
|---|---|---|
| Local development | `apps/broker` Aedes broker forwards `publish` events with the authenticated MQTT client id, HMAC-signed to `/internal/mqtt/event` | `rpc_board_from_client` |
| Cloudflare production | `MqttIngressDO` holds one outbound MQTT-over-WSS subscription; messages reach `handleIngress` | `rpc_board_from_device` (tenant + device from DB row matching topic) |
| EMQX rule/webhook (if your plan supports an HTTP action) | POST `/internal/mqtt/event` with `X-Helios-Signature` HMAC | `rpc_board_from_client` when client id provided |

`handleIngress` always: parses the topic, resolves the board from the database, verifies `tenant_id`/`device_id` match the authenticated identity, verifies the topic is an allowed publish topic, strips `tenant_id` from the payload, validates the versioned JSON schema, and inserts through tenant-safe RPCs. A `tenant_id` inside JSON is never trusted.

## 5. Topic contract

```
v1/tenants/{tenant_id}/devices/{device_id}/command       # subscribe only
v1/tenants/{tenant_id}/devices/{device_id}/config        # subscribe only
v1/tenants/{tenant_id}/devices/{device_id}/state         # publish only
v1/tenants/{tenant_id}/devices/{device_id}/telemetry     # publish only
v1/tenants/{tenant_id}/devices/{device_id}/availability  # publish only
```

Commands and configs are published with `retain:false` and a 30-second TTL. History lives in Postgres, not in retained MQTT messages.

## 6. Migration path

Implement a new class satisfying `MqttProvider` (`provisionDevice`, `revokeDevice`, `rotateDevice`, `publish`, `health`, `fetchUsage`), register it in `apps/api/src/providers/index.ts`, set `MQTT_PROVIDER`, and recreate device credentials/ACLs from `mqtt_credentials_metadata`. No tenant, device, GPIO, automation, UI or firmware logic changes.
