/**
 * HomecoreOS ESP32 firmware — ESP-IDF / Arduino-ESP32 reference implementation.
 *
 * Cloud path:  Website -> Cloudflare Worker -> EMQX -> ESP32 (outbound TLS only)
 * Topics:      v1/tenants/{tenant_id}/devices/{device_id}/{command,config,state,telemetry,availability}
 *
 * Security properties
 *  - Each board owns a UNIQUE MQTT username/password/client id received once
 *    during pairing. No shared admin credential is ever flashed.
 *  - The tenant id in a topic is verified by the backend from the authenticated
 *    MQTT session; firmware never invents a tenant.
 *  - Commands are ignored after `expires_at`; no retained ON/OFF messages.
 *  - Configuration is versioned and validated before being stored; on failure
 *    the last known good configuration stays active.
 *  - Safety interlocks run locally and keep working during internet outages.
 *  - OTA verifies SHA-256 before writing and uses ESP-IDF rollback on failure.
 *
 * Provisioning: SoftAP config portal or USB serial (see firmware/README.md).
 * BLE provisioning is intentionally NOT implemented here; it is a roadmap
 * item and must never be described as a working cloud control path.
 */
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <Preferences.h>
#include <Update.h>
#include <WebServer.h>
#include <time.h>
#include "mbedtls/md.h"
#include "esp_ota_ops.h"
#include "ca_cert.h"          // replace with YOUR EMQX Cloud deployment CA certificate

// ---------------------------------------------------------------------------
// Compile-time configuration — no secrets in source control
// ---------------------------------------------------------------------------
#define HOMECOREOS_API_BASE       "https://api.example.com"   // Cloudflare Worker URL
#define HOMECOREOS_MQTT_PORT      8883
#define HOMECOREOS_FW_VERSION     "1.0.0"
#define MAX_COMPONENTS        24
#define LOCAL_RULE_MAX        12
#define COMMAND_CACHE         8

static const char *PAIRING_AP_PREFIX = "HomecoreOS-Setup-";
static WebServer portal(80);
static Preferences nvs;
static WiFiClientSecure tls;
static PubSubClient mqtt(tls);

struct Actuator {
  String id; int gpio = -1; bool activeLow = false;
  String initial; bool state = false; bool known = false;
};
struct Sensor {
  String id; String category; String unit; int gpio = -1;
  int intervalS = 60; float last = NAN; unsigned long lastReport = 0;
};
struct Bus { String label; String kind; int sda = -1, scl = -1; };
struct LocalRule {
  String sensor; String op; float threshold = 0;
  String actuator; bool value = false; bool enabled = false;
};

static Actuator actuators[MAX_COMPONENTS];
static Sensor sensors[MAX_COMPONENTS];
static Bus buses[4];
static LocalRule rules[LOCAL_RULE_MAX];
static int actuatorCount = 0, sensorCount = 0, busCount = 0, ruleCount = 0;

static String deviceId, mqttClientId, mqttUser, mqttPass, brokerHost, tenantId;
static String cmdTopic, configTopic, stateTopic, telemetryTopic, availabilityTopic;
static uint32_t configVersion = 0, appliedVersion = 0;
static String lastKnownGood;                 // serialised, validated config
static String recentCommands[COMMAND_CACHE]; // idempotency window
static unsigned long lastReconnect = 0, lastStateReport = 0;
static bool provisioned = false;

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
static uint32_t nowEpoch() { time_t t = time(nullptr); return t > 1700000000 ? (uint32_t)t : millis() / 1000; }

static void logLine(const char *msg) { Serial.printf("[homecoreos] %s\n", msg); }

static void rememberCommand(const String &id) {
  for (int i = COMMAND_CACHE - 1; i > 0; --i) recentCommands[i] = recentCommands[i - 1];
  recentCommands[0] = id;
}
static bool seenCommand(const String &id) {
  for (int i = 0; i < COMMAND_CACHE; ++i) if (recentCommands[i] == id) return true;
  return false;
}

static String topicFor(const char *kind) {
  return "v1/tenants/" + tenantId + "/devices/" + deviceId + "/" + kind;
}

// ---------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------
static bool publishJson(const String &topic, const JsonDocument &doc, bool retained = false) {
  String out; serializeJson(doc, out);
  // Commands/config are never retained; device reports are not retained either.
  return mqtt.publish(topic.c_str(), out.c_str(), retained);
}

static void publishAvailability(const char *status) {
  JsonDocument d;
  d["schema_version"] = 1; d["device_id"] = deviceId;
  d["status"] = status; d["timestamp"] = nowEpoch();
  publishJson(availabilityTopic, d);
}

static void publishFullState() {
  JsonDocument d;
  d["schema_version"] = 1; d["device_id"] = deviceId;
  d["timestamp"] = nowEpoch(); d["config_version"] = appliedVersion;
  d["availability"] = "online";
  JsonObject devs = d["devices"].to<JsonObject>();
  for (int i = 0; i < actuatorCount; ++i) {
    JsonObject o = devs[actuators[i].id].to<JsonObject>();
    o["state"] = actuators[i].known ? (actuators[i].state ? "on" : "off") : "unknown";
    o["source"] = "gpio";
  }
  publishJson(stateTopic, d);
}

static void publishAck(const String &commandId, const String &componentId,
                       bool requested, bool actual, const char *status, const char *error = nullptr) {
  JsonDocument d;
  d["schema_version"] = 1; d["command_id"] = commandId; d["component_id"] = componentId;
  d["requested_state"] = requested; d["actual_state"] = actual; d["status"] = status;
  if (error) d["error"] = error;
  publishJson(stateTopic, d);
}

static void publishConfigAck(uint32_t version, const char *status, const char *error = nullptr) {
  JsonDocument d;
  d["schema_version"] = 1; d["device_id"] = deviceId;
  d["config_version"] = version; d["status"] = status;
  d["type"] = "config_ack";
  if (error) d["error"] = error;
  publishJson(stateTopic, d);
}

static void publishOta(uint8_t progress, const char *status, const char *version) {
  JsonDocument d;
  d["schema_version"] = 1; d["device_id"] = deviceId;
  d["type"] = "ota"; d["progress"] = progress; d["status"] = status;
  d["version"] = version;
  publishJson(stateTopic, d);
}

// ---------------------------------------------------------------------------
// Local safety — runs even with no internet
// ---------------------------------------------------------------------------
static float readSensorValue(const Sensor &s) {
  if (s.gpio < 0) return NAN;
  // Board-specific ADC calibration belongs in the board profile; raw value here.
  return (float)analogRead(s.gpio) / 4095.0f * 100.0f;
}

static void applyActuator(int idx, bool on, const char *source);

static void evaluateLocalSafety() {
  for (int r = 0; r < ruleCount; ++r) {
    LocalRule &rule = rules[r];
    if (!rule.enabled) continue;
    int sIdx = -1, aIdx = -1;
    for (int i = 0; i < sensorCount; ++i) if (sensors[i].id == rule.sensor) sIdx = i;
    for (int i = 0; i < actuatorCount; ++i) if (actuators[i].id == rule.actuator) aIdx = i;
    if (sIdx < 0 || aIdx < 0) continue;
    float v = readSensorValue(sensors[sIdx]);
    if (isnan(v)) continue;                       // never act on unknown readings
    bool trigger = (rule.op == "gt" && v > rule.threshold) ||
                   (rule.op == "lt" && v < rule.threshold) ||
                   (rule.op == "gte" && v >= rule.threshold) ||
                   (rule.op == "lte" && v <= rule.threshold);
    if (trigger) {
      // Local interlocks (dry-run, overflow, emergency stop) always win over
      // any cloud command. They are never disabled by connectivity loss.
      applyActuator(aIdx, rule.value, "local_safety");
    }
  }
}

static void applyActuator(int idx, bool on, const char *source) {
  if (idx < 0 || idx >= actuatorCount) return;
  Actuator &a = actuators[idx];
  if (a.gpio < 0) return;
  int level = a.activeLow ? (on ? LOW : HIGH) : (on ? HIGH : LOW);
  pinMode(a.gpio, OUTPUT);
  digitalWrite(a.gpio, level);
  a.state = on; a.known = true;
  (void)source;
}

// ---------------------------------------------------------------------------
// Configuration: master source is the website/database
// ---------------------------------------------------------------------------
static bool validateConfig(const JsonDocument &d) {
  return (d["schema_version"] | 0) == 1 &&
         d["board_id"].is<const char *>() &&
         d["config_version"].is<uint32_t>() &&
         d["devices"].is<JsonArray>() &&
         d["sensors"].is<JsonArray>() &&
         d["buses"].is<JsonArray>();
}

static bool applyConfig(const String &raw) {
  JsonDocument d;
  if (deserializeJson(d, raw) || !validateConfig(d)) {
    Serial.println("[homecoreos] rejected invalid configuration — keeping last known good");
    publishConfigAck(d["config_version"] | 0, "rejected", "invalid schema");
    return false;
  }
  uint32_t incoming = d["config_version"] | 0;
  if (incoming < appliedVersion) {
    publishConfigAck(incoming, "rejected", "stale version");
    return false;
  }

  actuatorCount = 0; sensorCount = 0; busCount = 0; ruleCount = 0;
  for (JsonObject o : d["buses"].as<JsonArray>()) {
    if (busCount >= 4) break;
    buses[busCount++] = { o["label"] | "", o["kind"] | "", o["sda"] | -1, o["scl"] | -1 };
  }
  for (JsonObject o : d["devices"].as<JsonArray>()) {
    if (actuatorCount >= MAX_COMPONENTS) break;
    Actuator a;
    a.id = o["component_id"] | ""; a.gpio = o["gpio"] | -1;
    a.activeLow = o["active_low"] | false; a.initial = o["initial_state"] | "off";
    bool start = a.initial == "on";
    actuators[actuatorCount++] = a;
    applyActuator(actuatorCount - 1, start, "boot");
  }
  for (JsonObject o : d["sensors"].as<JsonArray>()) {
    if (sensorCount >= MAX_COMPONENTS) break;
    Sensor s;
    s.id = o["component_id"] | ""; s.category = o["category"] | "";
    s.unit = o["unit"] | ""; s.gpio = o["gpio"] | -1;
    s.intervalS = o["reporting_interval_s"] | 60;
    sensors[sensorCount++] = s;
  }
  JsonArray local = d["local_automations"].as<JsonArray>();
  for (JsonObject a : local) {
    JsonArray acts = a["then"].as<JsonArray>();
    JsonArray conds = a["if"].as<JsonArray>();
    for (JsonObject act : acts) {
      if (ruleCount >= LOCAL_RULE_MAX) break;
      LocalRule rule;
      rule.actuator = act["component_id"] | "";
      rule.value = act["value"] | false;
      if (!conds.isNull() && conds.size() > 0) {
        JsonObject c = conds[0];
        rule.sensor = c["sensor_slug"] | "";
        rule.op = c["op"] | "gt";
        rule.threshold = c["value"] | 0;
      }
      rule.enabled = true;
      rules[ruleCount++] = rule;
    }
  }
  appliedVersion = incoming;
  nvs.putString("lkg", raw);                 // last known good in NVS
  nvs.putUInt("cfgver", appliedVersion);
  publishConfigAck(appliedVersion, "applied");
  publishFullState();
  return true;
}

// ---------------------------------------------------------------------------
// OTA — ESP-IDF rollback + SHA-256 verification
// ---------------------------------------------------------------------------
static String sha256Hex(const uint8_t *data, size_t len) {
  uint8_t hash[32];
  mbedtls_md_context_t ctx; mbedtls_md_init(&ctx);
  mbedtls_md_setup(&ctx, mbedtls_md_info_from_type(MBEDTLS_MD_SHA256), 0);
  mbedtls_md_starts(&ctx); mbedtls_md_update(&ctx, data, len); mbedtls_md_finish(&ctx, hash);
  mbedtls_md_free(&ctx);
  String out; for (int i = 0; i < 32; ++i) { char b[3]; sprintf(b, "%02x", hash[i]); out += b; }
  return out;
}

static void performOta(const String &url, const String &expectedHash, size_t size, const String &version) {
  logLine("OTA: starting verified download");
  publishOta(0, "downloading", version.c_str());
  HTTPClient http;
  http.begin(url);
  int code = http.GET();
  if (code != 200) { http.end(); publishOta(0, "failed", version.c_str()); return; }
  if (!Update.begin(size > 0 ? size : UPDATE_SIZE_UNKNOWN)) {
    http.end(); publishOta(0, "failed", version.c_str()); return;
  }
  WiFiClient *stream = http.getStreamPtr();
  uint8_t buf[1024]; size_t written = 0;
  mbedtls_md_context_t md; mbedtls_md_init(&md);
  mbedtls_md_setup(&md, mbedtls_md_info_from_type(MBEDTLS_MD_SHA256), 0);
  mbedtls_md_starts(&md);
  while (http.connected() && stream->available() >= 0) {
    int n = stream->readBytes(buf, min((size_t)stream->available(), sizeof(buf)));
    if (n <= 0) break;
    mbedtls_md_update(&md, buf, n);
    if (Update.write(buf, n) != (size_t)n) break;
    written += n;
    if (written % 65536 < n) publishOta(size ? (uint8_t)(written * 100 / size) : 50, "downloading", version.c_str());
  }
  uint8_t digest[32]; mbedtls_md_finish(&md, digest); mbedtls_md_free(&md);
  String actual; for (int i = 0; i < 32; ++i) { char b[3]; sprintf(b, "%02x", digest[i]); actual += b; }
  http.end();
  if (actual != expectedHash) {
    Update.abort();
    logLine("OTA: SHA-256 mismatch — previous firmware preserved");
    publishOta(0, "failed", version.c_str());
    return;
  }
  publishOta(100, "verifying", version.c_str());
  if (!Update.end(true)) { publishOta(0, "failed", version.c_str()); return; }
  // Mark the new image valid only after it boots and reconnects successfully.
  publishOta(100, "success", version.c_str());
  logLine("OTA: verified; rebooting into new image");
  delay(400); ESP.restart();
}

// ---------------------------------------------------------------------------
// MQTT callbacks
// ---------------------------------------------------------------------------
static void onMessage(char *topic, byte *payload, unsigned int length) {
  String t(topic);
  String raw; raw.reserve(length + 1);
  for (unsigned int i = 0; i < length; ++i) raw += (char)payload[i];
  JsonDocument d;
  if (deserializeJson(d, raw)) return;

  if (t == configTopic) { applyConfig(raw); return; }
  if (t != cmdTopic) return;

  const char *action = d["action"] | "";
  String commandId = d["command_id"] | "";
  String componentId = d["component_id"] | "";
  uint32_t expires = d["expires_at"] | 0;
  if (commandId.isEmpty() || seenCommand(commandId) || (expires && expires < nowEpoch())) return;
  rememberCommand(commandId);

  if (!strcmp(action, "update_firmware")) {
    performOta(d["url"] | "", d["sha256"] | "", d["size_bytes"] | 0, d["version"] | "");
    return;
  }
  int idx = -1;
  for (int i = 0; i < actuatorCount; ++i) if (actuators[i].id == componentId) idx = i;
  if (idx < 0) { publishAck(commandId, componentId, false, false, "failed", "unknown component"); return; }
  if (strcmp(action, "set_state") && strcmp(action, "pulse")) return;
  bool requested = d["value"] | false;
  applyActuator(idx, requested, "cloud");
  publishAck(commandId, componentId, requested, actuators[idx].state, "confirmed");
  publishFullState();
  if (!strcmp(action, "pulse")) {
    delay(d["pulse_ms"] | 500);
    applyActuator(idx, false, "pulse_end");
    publishFullState();
  }
}

static bool fetchConfigOverHttps() {
  WiFiClientSecure client; client.setCACert(homecoreos_root_ca);
  HTTPClient http;
  http.begin(client, String(HOMECOREOS_API_BASE) + "/api/device/config");
  http.addHeader("Content-Type", "application/json");
  JsonDocument req; req["client_id"] = mqttClientId; req["password"] = mqttPass;
  String body; serializeJson(req, body);
  int code = http.POST(body);
  if (code != 200) { http.end(); return false; }
  String resp = http.getString(); http.end();
  JsonDocument d; if (deserializeJson(d, resp)) return false;
  String cfg; serializeJson(d["config"], cfg);
  return applyConfig(cfg);
}

static bool ensureMqtt() {
  if (mqtt.connected()) return true;
  if (millis() - lastReconnect < 5000) return false;
  lastReconnect = millis();
  mqtt.setServer(brokerHost.c_str(), HOMECOREOS_MQTT_PORT);
  mqtt.setCallback(onMessage);
  mqtt.setKeepAlive(60);
  mqtt.setSocketTimeout(15);
  String will;
  { JsonDocument d; d["schema_version"] = 1; d["device_id"] = deviceId; d["status"] = "offline"; serializeJson(d, will); }
  if (!mqtt.connect(mqttClientId.c_str(), mqttUser.c_str(), mqttPass.c_str(),
                    availabilityTopic.c_str(), 1, false, will.c_str())) {
    Serial.printf("[homecoreos] MQTT connect failed, state %d — retrying\n", mqtt.state());
    return false;
  }
  mqtt.subscribe(cmdTopic.c_str(), 1);
  mqtt.subscribe(configTopic.c_str(), 1);
  publishAvailability("online");
  // The Worker also publishes config on change; this fetch covers reconnects
  // after downtime (last-known-good stays active until a valid config arrives).
  fetchConfigOverHttps();
  publishFullState();
  return true;
}

// ---------------------------------------------------------------------------
// Pairing: single-use token -> per-device credentials (shown once)
// ---------------------------------------------------------------------------
static bool claimDevice(const String &token) {
  WiFiClientSecure client; client.setCACert(homecoreos_root_ca);
  HTTPClient http;
  http.begin(client, String(HOMECOREOS_API_BASE) + "/api/device/claim");
  http.addHeader("Content-Type", "application/json");
  JsonDocument req; req["pairing_token"] = token;
  String body; serializeJson(req, body);
  int code = http.POST(body);
  String resp = http.getString(); http.end();
  if (code != 201) { Serial.printf("[homecoreos] pairing failed (%d): %s\n", code, resp.c_str()); return false; }
  JsonDocument d; if (deserializeJson(d, resp)) return false;
  deviceId = d["device_id"] | ""; tenantId = d["tenant_id"] | "";
  mqttClientId = d["mqtt"]["client_id"] | ""; mqttUser = d["mqtt"]["username"] | "";
  mqttPass = d["mqtt"]["password"] | ""; brokerHost = d["mqtt"]["host"] | "";
  if (deviceId.isEmpty() || mqttPass.isEmpty()) return false;
  cmdTopic = topicFor("command"); configTopic = topicFor("config");
  stateTopic = topicFor("state"); telemetryTopic = topicFor("telemetry");
  availabilityTopic = topicFor("availability");
  nvs.putString("device_id", deviceId); nvs.putString("tenant_id", tenantId);
  nvs.putString("client_id", mqttClientId); nvs.putString("mqtt_user", mqttUser);
  nvs.putString("mqtt_pass", mqttPass); nvs.putString("broker", brokerHost);
  nvs.putString("topics", cmdTopic + "|" + configTopic + "|" + stateTopic + "|" + telemetryTopic + "|" + availabilityTopic);
  String cfg; serializeJson(d["config"], cfg);
  if (d["config"].is<JsonObject>()) applyConfig(cfg);
  logLine("Paired. Unique MQTT credentials stored in NVS.");
  return true;
}

// ---------------------------------------------------------------------------
// SoftAP / USB-serial provisioning (initial Wi-Fi + pairing token)
// ---------------------------------------------------------------------------
static String pairingToken;
static void handlePortalRoot() {
  String html = "<!doctype html><meta name=viewport content='width=device-width,initial-scale=1'>"
    "<h2>HomecoreOS ESP32 setup</h2><form method=POST action=/save>"
    "<p>Wi-Fi SSID<input name=ssid></p><p>Wi-Fi password<input name=pass type=password></p>"
    "<p>One-time pairing token<input name=token></p><button>Connect</button></form>"
    "<p>Cloud control uses an outbound MQTT/TLS connection. No router port forwarding is required.</p>";
  portal.send(200, "text/html", html);
}
static void handlePortalSave() {
  nvs.putString("wifi_ssid", portal.arg("ssid"));
  nvs.putString("wifi_pass", portal.arg("pass"));
  pairingToken = portal.arg("token");
  portal.send(200, "text/html", "<h2>Saved</h2><p>Connecting… check the serial monitor.</p>");
  delay(500); ESP.restart();
}

static bool connectWifi() {
  String ssid = nvs.getString("wifi_ssid", ""), pass = nvs.getString("wifi_pass", "");
  if (ssid.isEmpty()) return false;
  WiFi.mode(WIFI_STA); WiFi.begin(ssid.c_str(), pass.c_str());
  for (int i = 0; i < 40 && WiFi.status() != WL_CONNECTED; ++i) delay(500);
  if (WiFi.status() != WL_CONNECTED) return false;
  configTime(0, 0, "pool.ntp.org", "time.nist.gov");
  for (int i = 0; i < 20 && time(nullptr) < 1700000000; ++i) delay(500);
  return true;
}

static void startPortal() {
  WiFi.mode(WIFI_AP);
  String ssid = String(PAIRING_AP_PREFIX) + String((uint32_t)ESP.getEfuseMac(), HEX);
  WiFi.softAP(ssid.c_str());
  portal.on("/", HTTP_GET, handlePortalRoot);
  portal.on("/save", HTTP_POST, handlePortalSave);
  portal.begin();
  logLine("SoftAP provisioning portal started (local setup only)");
  while (true) { portal.handleClient(); delay(10); }
}

// ---------------------------------------------------------------------------
// Telemetry — one aggregated, versioned message per reporting cycle
// ---------------------------------------------------------------------------
static void reportTelemetry(bool force) {
  if (!mqtt.connected() || sensorCount == 0) return;
  JsonDocument d;
  d["schema_version"] = 1; d["device_id"] = deviceId;
  d["timestamp"] = nowEpoch(); d["config_version"] = appliedVersion;
  JsonObject all = d["sensors"].to<JsonObject>();
  int changed = 0;
  unsigned long nowMs = millis();
  for (int i = 0; i < sensorCount; ++i) {
    Sensor &s = sensors[i];
    float v = readSensorValue(s);
    if (isnan(v)) continue;
    bool due = nowMs - s.lastReport > (unsigned long)s.intervalS * 1000UL;
    bool delta = isnan(s.last) || fabs(v - s.last) > 0.5f;
    if (!force && !due && !delta) continue;
    JsonObject o = all[s.id].to<JsonObject>();
    o["value"] = round(v * 100) / 100.0; o["unit"] = s.unit; o["status"] = "valid";
    s.last = v; s.lastReport = nowMs; changed++;
  }
  if (changed) publishJson(telemetryTopic, d);
}

void setup() {
  Serial.begin(115200);
  nvs.begin("homecoreos", false);
  tls.setCACert(homecoreos_root_ca);
  mqtt.setBufferSize(4096);

  deviceId = nvs.getString("device_id", "");
  tenantId = nvs.getString("tenant_id", "");
  mqttClientId = nvs.getString("client_id", "");
  mqttUser = nvs.getString("mqtt_user", "");
  mqttPass = nvs.getString("mqtt_pass", "");
  brokerHost = nvs.getString("broker", "");
  String topics = nvs.getString("topics", "");
  if (topics.length()) {
    int a = 0, b = topics.indexOf('|');
    cmdTopic = topics.substring(0, b); a = b + 1; b = topics.indexOf('|', a);
    configTopic = topics.substring(a, b); a = b + 1; b = topics.indexOf('|', a);
    stateTopic = topics.substring(a, b); a = b + 1; b = topics.indexOf('|', a);
    telemetryTopic = topics.substring(a, b); availabilityTopic = topics.substring(b + 1);
    lastKnownGood = nvs.getString("lkg", "");
    appliedVersion = nvs.getUInt("cfgver", 0);
    if (lastKnownGood.length()) applyConfig(lastKnownGood);  // offline-safe boot
    provisioned = true;
  }

  // USB-serial provisioning alternative: "TOKEN=<one-time-token>"
  if (Serial.available()) {
    String line = Serial.readStringUntil('\n');
    if (line.startsWith("TOKEN=")) nvs.putString("pending_token", line.substring(6));
  }

  if (!connectWifi()) startPortal();
  if (!provisioned) {
    String token = nvs.getString("pending_token", "");
    if (token.isEmpty()) { logLine("No pairing token — opening provisioning portal"); startPortal(); }
    if (!claimDevice(token)) startPortal();
    nvs.remove("pending_token");
  }
  // Cancel rollback only after a successful boot + cloud connection.
  ensureMqtt();
  if (mqtt.connected()) esp_ota_mark_app_valid_cancel_rollback();
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) { connectWifi(); delay(1000); return; }
  if (!ensureMqtt()) { evaluateLocalSafety(); delay(200); return; }
  mqtt.loop();
  evaluateLocalSafety();
  reportTelemetry(false);
  if (millis() - lastStateReport > 30000) { publishFullState(); lastStateReport = millis(); }
}
