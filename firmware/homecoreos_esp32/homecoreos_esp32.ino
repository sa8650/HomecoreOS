/**
 * HomecoreOS controller firmware.
 *
 * Target: ESP32-S3 N16R8 (16 MB flash, 8 MB octal PSRAM), dual-slot OTA layout.
 * The images are produced by .github/workflows/firmware.yml, which runs
 * scripts/firmware/hc_build.mjs first to compile the version, the API origin and
 * the two TLS trust anchors into the image. Ordering and slot layout come from
 * the built-in "app3M_fat9M_16MB" partition scheme: app0 at 0x10000, app1 at
 * 0x310000, 3 MB each, which is why an application image must stay under 3 MB.
 *
 * Data path:  Website → Cloudflare Pages Functions → EMQX → controller.
 * The controller only makes outbound TLS connections; no port forwarding exists.
 *
 * Lifecycle
 *   1. boot → rollback check → load identity and last known good configuration
 *   2. join Wi-Fi (non-blocking, backoff with jitter)
 *   3. redeem a six-digit pairing code if one was saved from the setup portal
 *   4. connect MQTT with the device's own credentials, then report availability
 *   5. loop: local safety sampling, commands, telemetry, presence, firmware check
 *
 * Safety guarantees
 *  - local safety rules and actuator control never depend on the network;
 *  - a command is ignored after its expiry and only acted on once;
 *  - a configuration update is validated first and applied atomically;
 *  - firmware is updated in the inactive slot, checksum-verified, and the
 *    previous image is restored when the new one fails its health check.
 */
#include <Arduino.h>
#include <ArduinoJson.h>
#include <Preferences.h>
#include <WiFi.h>
#include "esp_ota_ops.h"
#include "esp_system.h"
#include "esp_task_wdt.h"

#include "hc_cloud.h"
#include "hc_config.h"
#include "hc_digest.h"
#include "hc_gpio.h"
#include "hc_https.h"
#include "hc_lifecycle.h"
#include "hc_mqtt.h"
#include "hc_ota.h"
#include "hc_portal.h"
#include "hc_state.h"
#include "hc_time.h"
#include "hc_wifi.h"

namespace {

using namespace hc;

Preferences nvs;
DeviceModel model;
Runtime runtime(model);
WifiLink wifi;
MqttLink mqtt;
OtaEngine ota;
SetupPortal portal;
ConfigStore configStore;
Identity identity;
HardwareReport hardware;
CloudClient cloud(hardware);

String pendingCode;
uint32_t pendingCodeAt = 0;
uint32_t pairingAttempts = 0;
uint16_t bootCount = 0;

enum class Phase : uint8_t { Booting, AwaitingProvisioning, Connecting, Online };
Phase phase = Phase::Booting;

uint32_t lastPresenceMs = 0;
uint32_t lastTelemetryMs = 0;
uint32_t lastConfigPollMs = 0;
uint32_t lastCommandAckMs = 0;
uint32_t lastStateReportMs = 0;
uint32_t lastFirmwareCheckMs = 0;
uint32_t lastRegistrationMs = 0;
// True once the platform has acknowledged this controller's registration in this
// connection. Reset on every (re)connect, so a lost acknowledgement is simply retried.
bool registrationAcked = false;
uint32_t healthySinceMs = 0;
// Connectivity recovery state. Pairing is never touched by these.
PinGuard pinGuard;
bool portalIsFallback = false;
uint32_t lastFallbackOpenMs = 0;
uint32_t noInternetSince = 0;
uint32_t commandIds[kCommandCacheSize];
size_t commandIdCount = 0;

void markStateDirty();
void publishConfigAck(uint32_t version, const char *status, const char *error = nullptr);
void startPortal(bool bypassPin = false, bool fallback = false);

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------
void loadIdentity() {
  identity.deviceId = nvs.getString(kNvsDeviceId, "");
  identity.tenantId = nvs.getString(kNvsTenantId, "");
  identity.clientId = nvs.getString(kNvsClientId, "");
  identity.username = nvs.getString(kNvsMqttUser, "");
  identity.password = nvs.getString(kNvsMqttPass, "");
  identity.broker = nvs.getString(kNvsBroker, "");
  identity.port = (uint16_t)nvs.getUShort(kNvsBrokerPort, HOMECOREOS_MQTT_PORT);
  identity.controllerId = nvs.getString(kNvsControllerId, "");
  identity.homeId = nvs.getString(kNvsHomeId, "");
  identity.pairingSessionId = nvs.getString(kNvsPairingSession, "");
}

void saveIdentity() {
  nvs.putString(kNvsDeviceId, identity.deviceId);
  nvs.putString(kNvsTenantId, identity.tenantId);
  nvs.putString(kNvsClientId, identity.clientId);
  nvs.putString(kNvsMqttUser, identity.username);
  nvs.putString(kNvsMqttPass, identity.password);
  nvs.putString(kNvsBroker, identity.broker);
  nvs.putUShort(kNvsBrokerPort, identity.port);
  nvs.putString(kNvsControllerId, identity.controllerId);
  nvs.putString(kNvsHomeId, identity.homeId);
  nvs.putString(kNvsPairingSession, identity.pairingSessionId);
}

void clearIdentity() {
  identity.clear();
  nvs.remove(kNvsDeviceId);
  nvs.remove(kNvsTenantId);
  nvs.remove(kNvsClientId);
  nvs.remove(kNvsMqttUser);
  nvs.remove(kNvsMqttPass);
  nvs.remove(kNvsBroker);
  nvs.remove(kNvsBrokerPort);
  nvs.remove(kNvsControllerId);
  nvs.remove(kNvsHomeId);
  nvs.remove(kNvsPairingSession);
}

void loadConfiguration() {
  JsonDocument doc;
  if (!configStore.load(nvs, doc)) return;
  String error;
  if (model.apply(doc, error)) {
    model.appliedVersion = nvs.getUInt(kNvsConfigVersion, model.configVersion);
    runtime.applyInitialStates();
    Serial.printf("[homecoreos] configuration v%u restored (%u devices, %u sensors)\n",
                  (unsigned)model.appliedVersion, (unsigned)model.actuatorCount, (unsigned)model.sensorCount);
  } else {
    Serial.printf("[homecoreos] stored configuration rejected: %s\n", error.c_str());
    configStore.clear(nvs);
  }
}

void applyConfigurationDocument(const String &raw, bool fromCloud) {
  JsonDocument doc;
  if (deserializeJson(doc, raw)) {
    publishConfigAck(0, "rejected", "unreadable document");
    return;
  }
  String error;
  if (!model.apply(doc, error)) {
    publishConfigAck(doc["config_version"] | 0u, "rejected", error.c_str());
    return;
  }
  runtime.applyInitialStates();
  if (fromCloud) configStore.save(nvs, raw);
  nvs.putUInt(kNvsConfigVersion, model.appliedVersion);
  publishConfigAck(model.appliedVersion, "applied");
  markStateDirty();
  Serial.printf("[homecoreos] configuration v%u applied\n", (unsigned)model.appliedVersion);
}

// ---------------------------------------------------------------------------
// Publishing helpers
// ---------------------------------------------------------------------------
JsonDocument outbound;
char publishBuffer[kMaxPayloadBytes];

void markStateDirty() { runtime.markDirty(); }

String publishDoc(TopicKind kind, JsonDocument &doc) {
  const size_t n = serializeJson(doc, publishBuffer, sizeof(publishBuffer));
  if (n == 0 || n >= sizeof(publishBuffer)) return "document too large";
  return mqtt.publish(kind, publishBuffer, 1);
}

/** What the console shows: link state and the reason for the last failure. No secrets. */
bool setupPinSet();

void addConnectivity(JsonDocument &d) {
  JsonObject c = d["connectivity"].to<JsonObject>();
  JsonObject w = c["wifi"].to<JsonObject>();
  w["state"] = wifi.phaseName();
  w["ssid"] = wifi.ssid();
  w["rssi"] = wifi.rssi();
  w["ip"] = wifi.online() ? WiFi.localIP().toString() : String();
  w["last_error"] = wifiFailureName(wifi.lastFailure());
  w["fallback_ap"] = portal.active() && portalIsFallback;
  JsonObject m = c["mqtt"].to<JsonObject>();
  m["state"] = mqtt.connected() ? "connected" : "disconnected";
  m["last_error"] = mqtt.authRefusals() >= kAuthRefusalLimit ? "credentials_refused" : "";
  if (mqtt.connected()) c["internet"] = true;
  JsonObject p = c["pairing"].to<JsonObject>();
  p["state"] = !identity.complete() ? "unpaired" : (identity.registrationComplete() ? "paired" : "pending");
  c["setup_pin_set"] = setupPinSet();
}

void publishAvailability(const char *status) {
  JsonDocument d;
  d["schema_version"] = 1;
  d["device_id"] = identity.deviceId;
  d["status"] = status;
  d["firmware_version"] = OtaEngine::runningVersion();
  d["timestamp"] = epochNow();
  addConnectivity(d);
  publishDoc(TopicKind::Availability, d);
}

/**
 * Registration report: says which accepted code this controller is, in which home.
 * Sent on the availability topic (the one this device may publish to). It is repeated
 * until the platform acknowledges it, and the platform treats repeats as harmless.
 * A controller paired before this release has no session to report; it must be paired again.
 */
void publishRegistration() {
  if (!identity.registrationComplete()) {
    Serial.println("[homecoreos] registration: this controller has no pairing session; pair it again");
    lastRegistrationMs = millis();
    return;
  }
  JsonDocument d;
  d["schema_version"] = 1;
  d["type"] = "registration";
  d["device_id"] = identity.deviceId;
  d["controller_id"] = identity.controllerId;
  d["home_id"] = identity.homeId;
  d["pairing_session_id"] = identity.pairingSessionId;
  d["firmware_version"] = OtaEngine::runningVersion();
  d["status"] = "online";
  d["timestamp"] = epochNow();
  publishDoc(TopicKind::Availability, d);
  lastRegistrationMs = millis();
}

void publishConfigAck(uint32_t version, const char *status, const char *error) {
  JsonDocument d;
  d["schema_version"] = 1;
  d["device_id"] = identity.deviceId;
  d["config_version"] = version;
  d["status"] = status;
  d["type"] = "config_ack";
  if (error) d["error"] = error;
  publishDoc(TopicKind::State, d);
}

void publishCommandAck(const char *commandId, const char *componentId, bool requested,
                       bool actual, const char *status, const char *error = nullptr) {
  JsonDocument d;
  d["schema_version"] = 1;
  d["command_id"] = commandId;
  d["component_id"] = componentId;
  d["requested_state"] = requested;
  d["actual_state"] = actual;
  d["status"] = status;
  if (error) d["error"] = error;
  publishDoc(TopicKind::State, d);
  lastCommandAckMs = millis();
}

void publishState() {
  runtime.writeState(outbound, wifi.online() ? "online" : "offline");
  publishDoc(TopicKind::State, outbound);
  lastStateReportMs = millis();
}

void publishTelemetry(bool force) {
  runtime.writeTelemetry(outbound, force);
  if (outbound["sensors"].as<JsonObject>().size() == 0) return;
  publishDoc(TopicKind::Telemetry, outbound);
  lastTelemetryMs = millis();
}

void publishOtaStatus(const char *status, uint8_t percent, const char *error = nullptr,
                      const String &version = String()) {
  JsonDocument d;
  d["schema_version"] = 1;
  d["device_id"] = identity.deviceId;
  d["type"] = "ota";
  d["status"] = status;
  d["progress"] = percent;
  if (!version.isEmpty()) d["version"] = version;
  if (ota.bytesDone()) d["bytes_done"] = ota.bytesDone();
  if (ota.bytesTotal()) d["bytes_total"] = ota.bytesTotal();
  if (error && error[0]) d["error"] = error;
  publishDoc(TopicKind::State, d);
}

// ---------------------------------------------------------------------------
// Command handling
// ---------------------------------------------------------------------------
bool commandSeen(uint32_t id) {
  for (size_t i = 0; i < commandIdCount; ++i) {
    if (commandIds[i] == id) return true;
  }
  return false;
}

void rememberCommand(uint32_t id) {
  if (commandIdCount < kCommandCacheSize) {
    commandIds[commandIdCount++] = id;
  } else {
    memmove(commandIds, commandIds + 1, sizeof(uint32_t) * (kCommandCacheSize - 1));
    commandIds[kCommandCacheSize - 1] = id;
  }
}

/** Stable 32-bit fingerprint of the command UUID, used for idempotency. */
uint32_t hashCommandId(const char *uuid) {
  uint32_t h = 2166136261u;
  for (const char *c = uuid; c && *c; ++c) {
    h ^= (uint8_t)*c;
    h *= 16777619u;
  }
  return h ? h : 1u;
}

// ---------------------------------------------------------------------------
// Board-level actions (open_setup, reset_wifi, unpair, factory_reset, set_setup_pin)
// ---------------------------------------------------------------------------
/**
 * Acknowledges a board action. A destructive action sends its confirmation and waits
 * for the broker's PUBACK before it erases anything: the platform must hear the ack
 * while this identity still exists. Returns false if the ack was not delivered.
 */
bool sendBoardAck(const char *commandId, bool confirmed, const char *error, bool waitForBroker) {
  JsonDocument d;
  d["schema_version"] = 1;
  d["type"] = "command_ack";
  d["device_id"] = identity.deviceId;
  d["command_id"] = commandId;
  d["status"] = confirmed ? "confirmed" : "failed";
  if (error && error[0]) d["error"] = error;
  const size_t n = serializeJson(d, publishBuffer, sizeof(publishBuffer));
  if (n == 0 || n >= sizeof(publishBuffer)) return false;
  if (waitForBroker) return mqtt.publishConfirmed(TopicKind::State, publishBuffer, kAckWaitMs);
  return publishDoc(TopicKind::State, d).isEmpty();
}

bool setupPinSet() {
  return nvs.isKey(kNvsPinSalt) && nvs.isKey(kNvsPinHash);
}

/** SHA-256 of a text, as lower-case hex. */
String sha256Hex(const String &text) {
  hc::Sha256 sha;
  sha.update((const uint8_t *)text.c_str(), text.length());
  hc::Digest out;
  if (!sha.finish(out)) return String();
  return hc::Sha256::hex(out);
}

/** Digest the console computes for a PIN: SHA-256 of "<device id>:<PIN>". */
String pinDigestFor(const String &pin) { return sha256Hex(identity.deviceId + ":" + pin); }

/** Stored form: SHA-256 of "<salt>:<pin digest>". The PIN and its digest are never stored. */
String storedPinFor(const String &salt, const String &pinDigest) { return sha256Hex(salt + ":" + pinDigest); }

void persistPinLock() {
  // A lock survives a reboot: the count is persisted as the threshold while locked.
  const uint32_t value = pinGuard.locked(millis()) ? hc::kPinMaxFailures : pinGuard.failures;
  nvs.putUInt(kNvsPinFails, value);
}

/** Portal hook: checks the PIN typed on the local portal. Wrong tries are counted and persisted. */
hc::PinResult checkSetupPin(const String &pin) {
  if (!setupPinSet()) return hc::PinResult::Rejected;
  const String salt = nvs.getString(kNvsPinSalt, "");
  const String stored = nvs.getString(kNvsPinHash, "");
  const String candidate = storedPinFor(salt, pinDigestFor(pin));
  const bool matches = candidate.length() == stored.length() &&
                       hc::sameDigest(candidate.c_str(), stored.c_str(), stored.length());
  const hc::PinResult result = pinGuard.attempt(millis(), matches);
  persistPinLock();
  return result;
}

void setSetupPin(const String &pinHash) {
  uint8_t raw[16];
  esp_fill_random(raw, sizeof(raw));
  char salt[sizeof(raw) * 2 + 1];
  for (size_t i = 0; i < sizeof(raw); ++i) snprintf(salt + i * 2, 3, "%02x", raw[i]);
  nvs.putString(kNvsPinSalt, salt);
  nvs.putString(kNvsPinHash, storedPinFor(salt, pinHash));
  pinGuard = hc::PinGuard();
  persistPinLock();
}

void clearSetupPin() {
  nvs.remove(kNvsPinSalt);
  nvs.remove(kNvsPinHash);
  nvs.remove(kNvsPinFails);
  pinGuard = hc::PinGuard();
}

/** Forgets the saved Wi-Fi network. Pairing is kept. */
void clearWifiCredentials() {
  nvs.remove(kNvsWifiSsid);
  nvs.remove(kNvsWifiPass);
  wifi.forget();
}

/** Factory reset: pairing, Wi-Fi, configuration, PIN and any pending code. */
void clearEverything() {
  clearIdentity();
  configStore.clear(nvs);
  nvs.remove(kNvsPendingCode);
  nvs.remove(kNvsPendingCodeAt);
  clearWifiCredentials();
  clearSetupPin();
  pendingCode = "";
  pendingCodeAt = 0;
}

void handleBoardAction(const char *action, const char *commandId, JsonDocument &d) {
  if (strcmp(action, "open_setup") == 0) {
    // The portal opens over the live connection (AP+STA). Confirmed once it is up.
    startPortal(false, false);
    sendBoardAck(commandId, portal.active(), portal.active() ? nullptr : "the setup network could not start", false);
    return;
  }
  if (strcmp(action, "reset_wifi") == 0) {
    if (!sendBoardAck(commandId, true, nullptr, true)) {
      Serial.println("[homecoreos] reset_wifi: the platform did not receive the confirmation; nothing changed");
      return;
    }
    clearWifiCredentials();
    startPortal(false, false);  // paired: the setup PIN is required to save new Wi-Fi details
    return;
  }
  if (strcmp(action, "unpair") == 0) {
    if (!sendBoardAck(commandId, true, nullptr, true)) {
      Serial.println("[homecoreos] unpair: the platform did not receive the confirmation; still paired");
      return;
    }
    clearIdentity();
    configStore.clear(nvs);
    esp_restart();  // boots into pairing mode, keeping the Wi-Fi network
    return;
  }
  if (strcmp(action, "factory_reset") == 0) {
    if (!sendBoardAck(commandId, true, nullptr, true)) {
      Serial.println("[homecoreos] factory_reset: the platform did not receive the confirmation; nothing changed");
      return;
    }
    clearEverything();
    esp_restart();
    return;
  }
  if (strcmp(action, "set_setup_pin") == 0) {
    const char *hash = d["pin_hash"] | "";
    const String digest = String(hash);
    if (digest.length() != 64) {
      sendBoardAck(commandId, false, "the setup PIN is missing or malformed", false);
      return;
    }
    setSetupPin(digest);
    sendBoardAck(commandId, true, nullptr, false);
    publishAvailability("online");  // report setup_pin_set straight away
    return;
  }
}

void handleCommand(const char *payload) {
  JsonDocument d;
  if (deserializeJson(d, payload)) return;
  const char *action = d["action"] | "";
  const char *commandId = d["command_id"] | "";
  const char *componentId = d["component_id"] | "";
  if (!commandId[0]) return;
  const uint32_t id = hashCommandId(commandId);
  if (commandSeen(id)) return;

  const uint32_t expiresAt = d["expires_at"] | 0u;
  const uint32_t now = epochNow();
  if (expiresAt && now && now > expiresAt) {
    publishCommandAck(commandId, componentId, false, false, "rejected", "the command had already expired");
    return;
  }
  rememberCommand(id);

  if (strcmp(action, "update_firmware") == 0) {
    OtaRequest request;
    request.url = String(d["url"] | "");
    request.sha256 = String(d["sha256"] | "");
    request.version = String(d["version"] | "");
    request.size = d["size_bytes"] | 0u;
    String error;
    if (!ota.queue(request, error)) {
      publishOtaStatus("failed", 0, error.c_str(), request.version);
      publishCommandAck(commandId, "board", false, false, "rejected", error.c_str());
      return;
    }
    publishOtaStatus("downloading", 0, nullptr, request.version);
    publishCommandAck(commandId, "board", true, true, "confirmed");
    return;
  }
  if (strcmp(action, "reboot") == 0) {
    publishCommandAck(commandId, componentId, true, true, "confirmed");
    delay(150);
    esp_restart();
    return;
  }
  if (strcmp(action, "get_state") == 0) {
    publishState();
    publishCommandAck(commandId, componentId, false, true, "confirmed");
    return;
  }
  if (strcmp(action, "open_setup") == 0 || strcmp(action, "reset_wifi") == 0 || strcmp(action, "unpair") == 0 ||
      strcmp(action, "factory_reset") == 0 || strcmp(action, "set_setup_pin") == 0) {
    handleBoardAction(action, commandId, d);
    return;
  }
  if (strcmp(action, "set_state") != 0 && strcmp(action, "pulse") != 0) return;

  const bool requested = d["value"] | false;
  bool known = false;
  if (!runtime.setActuator(componentId, requested, known)) {
    publishCommandAck(commandId, componentId, requested, false, "failed", "unknown component");
    return;
  }
  publishCommandAck(commandId, componentId, requested, runtime.actuatorState(componentId),
                    known ? "confirmed" : "failed", known ? nullptr : "the pin could not be driven");
  publishState();
  if (strcmp(action, "pulse") == 0) {
    const uint16_t pulse = d["pulse_ms"] | 500;
    delay(pulse);
    bool stillKnown = false;
    runtime.setActuator(componentId, false, stillKnown);
    publishState();
  }
}

/** The platform's answer to a registration report. It is never applied as configuration. */
void handleRegistrationAck(const char *payload) {
  JsonDocument d;
  if (deserializeJson(d, payload)) return;
  const char *type = d["type"] | "";
  if (strcmp(type, "registration_ack") != 0) return;
  const String controller = String(d["controller_id"] | "");
  const String session = String(d["pairing_session_id"] | "");
  if (controller != identity.controllerId || session != identity.pairingSessionId) return;
  if (!registrationAcked) Serial.println("[homecoreos] registration acknowledged by the platform");
  registrationAcked = true;
}

void onMqttMessage(const char *topic, const char *payload, size_t length) {
  (void)length;
  if (!topic || !payload) return;
  if (strcmp(topic, mqtt.topicFor(TopicKind::Config)) == 0) {
    // Exact JSON token the platform writes for an acknowledgement. The handler below
    // still checks the controller and session identifiers before it accepts one.
    if (strstr(payload, "\"type\":\"registration_ack\"")) {
      handleRegistrationAck(payload);
      return;
    }
    applyConfigurationDocument(String(payload), true);
    return;
  }
  if (strcmp(topic, mqtt.topicFor(TopicKind::Command)) == 0) {
    handleCommand(payload);
  }
}

// ---------------------------------------------------------------------------
// Pairing
// ---------------------------------------------------------------------------
void rejectPairingCode(const char *reason, bool keep) {
  Serial.printf("[homecoreos] pairing: %s\n", reason);
  if (!keep) {
    pendingCode = "";
    pendingCodeAt = 0;
    nvs.remove(kNvsPendingCode);
    nvs.remove(kNvsPendingCodeAt);
  }
}

void attemptPairing() {
  if (identity.complete()) return;
  if (!pendingCode.length()) return;
  if (!wifi.online()) return;
  if (pairingAttempts >= kPairingAttempts) {
    rejectPairingCode("too many attempts on this code", false);
    return;
  }
  ++pairingAttempts;
  hardware.rssi = wifi.rssi();
  hardware.uptimeS = (uint32_t)(millis() / 1000UL);
  const PairingOutcome outcome = cloud.redeemCode(pendingCode);
  if (outcome.paired) {
    identity = outcome.identity;
    saveIdentity();
    nvs.remove(kNvsPendingCode);
    nvs.remove(kNvsPendingCodeAt);
    pendingCode = "";
    pairingAttempts = 0;
    registrationAcked = false;
    lastRegistrationMs = 0;
    Serial.printf("[homecoreos] paired as %s\n", identity.deviceId.c_str());
    if (!outcome.configJson.isEmpty()) applyConfigurationDocument(outcome.configJson, true);
    if (!mqtt.start(identity)) {
      Serial.println("[homecoreos] MQTT could not start with the new identity");
    }
    return;
  }
  Serial.printf("[homecoreos] pairing rejected (%d): %s\n", outcome.status, outcome.error.c_str());
  if (outcome.status == 400 || outcome.status == 401 || outcome.status == 404 || outcome.status == 409 || outcome.status == 410) {
    rejectPairingCode(outcome.error.c_str(), false);
  } else if (outcome.status == 429) {
    rejectPairingCode("rate limited — will retry later", true);
    pairingAttempts = 0;
  }
}

// ---------------------------------------------------------------------------
// Firmware
// ---------------------------------------------------------------------------
void onFirmwareInstalled() {
  nvs.putUChar(kNvsOtaState, (uint8_t)OtaState::Applied);
  nvs.putString(kNvsOtaVersion, ota.version());
  publishOtaStatus("installed", 100, nullptr, ota.version());
  for (int i = 0; i < 12 && !mqtt.connected(); ++i) {
    delay(250);
  }
  publishOtaStatus("installed", 100, nullptr, ota.version());
  delay(300);
  esp_restart();
}

void confirmFirmwareHealth() {
  if (!OtaEngine::pendingVerification()) return;
  if (!mqtt.connected()) return;
  if (!healthySinceMs) {
    healthySinceMs = millis();
    return;
  }
  if (millis() - healthySinceMs < kOtaHealthConfirmMs) return;
  if (OtaEngine::markHealthy()) {
    nvs.putUChar(kNvsOtaState, (uint8_t)OtaState::Confirmed);
    nvs.putString(kNvsOtaVersion, OtaEngine::runningVersion());
    publishOtaStatus("success", 100, nullptr, OtaEngine::runningVersion());
    Serial.println("[homecoreos] firmware confirmed healthy after update");
  }
}

void checkForFirmware() {
  if (!mqtt.connected() || !wifi.online() || !identity.complete()) return;
  if (ota.busy()) return;
  if (millis() - lastFirmwareCheckMs < 6UL * 60UL * 1000UL && lastFirmwareCheckMs) return;
  lastFirmwareCheckMs = millis();
  hardware.uptimeS = (uint32_t)(millis() / 1000UL);
  hardware.rssi = wifi.rssi();
  const MemInfo mem = memory();
  hardware.freeInternal = mem.freeInternal;
  hardware.minFreeInternal = mem.minFreeInternal;
  const FirmwareOffer offer = cloud.checkFirmware(identity, hardware, OtaEngine::runningVersion().c_str());
  if (!offer.available || offer.version.isEmpty()) return;
  if (offer.version == OtaEngine::runningVersion()) return;
  OtaRequest request;
  request.url = offer.url;
  request.sha256 = offer.sha256;
  request.version = offer.version;
  request.size = offer.size;
  String error;
  if (!ota.queue(request, error)) {
    publishOtaStatus("failed", 0, error.c_str(), request.version);
    return;
  }
  publishOtaStatus("downloading", 0, nullptr, request.version);
}

// ---------------------------------------------------------------------------
// Presence
// ---------------------------------------------------------------------------
void reportPresence() {
  if (!mqtt.connected()) return;
  const MemInfo mem = memory();
  JsonDocument d;
  d["schema_version"] = 1;
  d["device_id"] = identity.deviceId;
  d["timestamp"] = epochNow();
  d["uptime_s"] = (uint32_t)(millis() / 1000UL);
  d["rssi"] = wifi.rssi();
  d["ip"] = WiFi.localIP().toString();
  d["firmware_version"] = OtaEngine::runningVersion();
  d["config_version"] = model.appliedVersion;
  d["mem"]["free_internal"] = mem.freeInternal;
  d["mem"]["min_free_internal"] = mem.minFreeInternal;
  d["mem"]["free_psram"] = mem.freePsram;
  d["wifi_state"] = wifi.phaseName();
  addConnectivity(d);
  d["boot_count"] = bootCount;
  d["unsupported_sensors"] = (uint32_t)model.unsupportedCount;
  publishDoc(TopicKind::Availability, d);
  lastPresenceMs = millis();
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------
String apSuffixFromMac() {
  const uint64_t mac = ESP.getEfuseMac();
  char buffer[16];
  snprintf(buffer, sizeof(buffer), "%04X", (uint16_t)(mac & 0xFFFF));
  return String(buffer);
}

void fillHardware() {
  hardware.chipModel = ESP.getChipModel();
  hardware.chipFamily = "ESP32-S3";
  hardware.chipRevision = String(ESP.getChipRevision());
  hardware.macAddress = WiFi.macAddress();
  hardware.sdkVersion = ESP.getSdkVersion();
  hardware.fwBuild = ESP.getSketchMD5();
  hardware.hardwareConfig = kHardwareConfig;
  hardware.rssi = wifi.rssi();
  hardware.uptimeS = (uint32_t)(millis() / 1000UL);
}

void startPortal(bool bypassPin, bool fallback) {
  if (portal.active()) portal.stop();
  portal.source.firmwareVersion = OtaEngine::runningVersion();
  portal.source.deviceId = identity.deviceId;
  portal.source.wifiState = wifi.phaseName();
  portal.source.mac = WiFi.macAddress();
  portal.source.hasWifi = wifi.hasCredentials();
  portal.source.paired = identity.complete();
  // A paired controller changes Wi-Fi only with the setup PIN (or the BOOT button).
  portal.source.pinRequired = identity.complete();
  portal.begin(apSuffixFromMac(), bypassPin);
  portalIsFallback = fallback;
  if (fallback) lastFallbackOpenMs = millis();
  phase = Phase::AwaitingProvisioning;
}

/** Opens or closes the temporary fallback AP, and ends owner sessions that were left idle. */
void updateConnectivityPolicy() {
  const uint32_t now = millis();
  if (wifi.online() && !mqtt.connected()) {
    if (!noInternetSince) noInternetSince = now;
  } else {
    noInternetSince = 0;
  }
  if (portal.active() && !portalIsFallback && now - portal.lastActivityMs() > kOwnerPortalIdleMs) {
    Serial.println("[homecoreos][portal] setup page idle; closing it");
    portal.stop();
  }
  hc::FallbackInputs in;
  in.nowMs = now;
  in.paired = identity.complete();
  in.hasWifiCreds = wifi.hasCredentials();
  in.wifiOnline = wifi.online();
  in.mqttUp = mqtt.connected();
  in.consecutiveWifiFailures = wifi.consecutiveFailures();
  in.lastFailure = wifi.lastFailure();
  in.noInternetMs = noInternetSince ? now - noInternetSince : 0;
  in.portalOpen = portal.active();
  in.portalIsFallback = portalIsFallback;
  in.lastFallbackOpenMs = lastFallbackOpenMs;
  switch (hc::decideFallback(in)) {
    case hc::FallbackAction::Open:
      Serial.printf("[homecoreos] Wi-Fi recovery: %s; opening the temporary setup network\n",
                    wifiFailureName(wifi.lastFailure()));
      startPortal(false, true);
      break;
    case hc::FallbackAction::Close:
      Serial.println("[homecoreos] cloud link restored; closing the temporary setup network");
      portal.stop();
      portalIsFallback = false;
      break;
    default:
      break;
  }
}

/** Physical recovery: hold BOOT for 3 s (Wi-Fi reset) or 10 s (factory reset), act on release. */
void serviceBootButton() {
  static bool down = false;
  static uint32_t downAt = 0;
  const bool pressed = digitalRead(kBootButtonPin) == LOW;
  if (pressed && !down) {
    down = true;
    downAt = millis();
    return;
  }
  if (pressed || !down) return;
  down = false;
  switch (hc::buttonActionOnRelease(millis() - downAt)) {
    case hc::ButtonAction::WifiReset:
      Serial.println("[homecoreos] BOOT held: resetting Wi-Fi; setup network opened without the PIN for this session");
      clearWifiCredentials();
      startPortal(true, false);
      break;
    case hc::ButtonAction::FactoryReset:
      Serial.println("[homecoreos] BOOT held: factory reset");
      clearEverything();
      esp_restart();
      break;
    default:
      break;
  }
}

void servicePortal() {
  portal.tick();
  if (!portal.submitted()) return;
  const SetupPortal::SavedCredentials saved = portal.takeSaved();
  nvs.putString(kNvsWifiSsid, saved.ssid);
  nvs.putString(kNvsWifiPass, saved.password);
  if (saved.code.length() == 6 && !identity.complete()) {
    pendingCode = saved.code;
    pendingCodeAt = seconds();
    nvs.putString(kNvsPendingCode, pendingCode);
    nvs.putUInt(kNvsPendingCodeAt, pendingCodeAt);
    pairingAttempts = 0;
  }
  portal.stop();
  wifi.begin(saved.ssid, saved.password);
  phase = Phase::Connecting;
}

void setupWatchdog() {
  esp_task_wdt_config_t config = {};
  config.timeout_ms = 30000;
  config.idle_core_mask = 0;
  config.trigger_panic = true;
  if (esp_task_wdt_init(&config) != ESP_OK) {
    esp_task_wdt_reconfigure(&config);
  }
  esp_task_wdt_add(nullptr);
}

void beginFirmwareState() {
  const OtaState previous = (OtaState)nvs.getUChar(kNvsOtaState, (uint8_t)OtaState::None);
  const String previousVersion = nvs.getString(kNvsOtaVersion, "");
  if (OtaEngine::pendingVerification()) {
    Serial.println("[homecoreos] this image is on trial; it must reconnect to be kept");
    return;
  }
  if (previous == OtaState::Applied) {
    // The image booted but never confirmed: fail closed back to the old slot.
    nvs.putUChar(kNvsOtaState, (uint8_t)OtaState::RolledBack);
    Serial.println("[homecoreos] previous attempt did not confirm; rolling back");
    OtaEngine::rollBackAndRestart();
    delay(800);
    esp_restart();
  }
  if (previous == OtaState::RolledBack || previous == OtaState::Failed) {
    Serial.printf("[homecoreos] last update (%s) did not succeed\n", previousVersion.c_str());
  }
  nvs.putUChar(kNvsOtaState, (uint8_t)OtaState::None);
}

}  // namespace

void setup() {
  Serial.begin(115200);
  delay(120);
  Serial.printf("\n[homecoreos] boot: %s (%s)\n", kVersionBanner, kHardwareConfig);

  nvs.begin(kNvsNamespace, false);
  bootCount = nvs.getUShort(kNvsBootOk, 0) + 1;
  nvs.putUShort(kNvsBootOk, bootCount > 1000 ? 1 : bootCount);

  beginFirmwareState();
  setupWatchdog();

  const String ssid = nvs.getString(kNvsWifiSsid, "");
  const String pass = nvs.getString(kNvsWifiPass, "");
  wifi.seed((uint32_t)ESP.getEfuseMac(), 0);
  // The ESP32 has no real-time clock. Without SNTP the wall clock stays at 1970, so TLS
  // certificate validity checks fail for both the API and the broker. The SNTP client
  // runs in the background and syncs once Wi-Fi is up; hc::clockSynced() reports it.
  configTime(0, 0, "pool.ntp.org", "time.google.com");
  wifi.begin(ssid, pass);
  pinMode(kBootButtonPin, INPUT_PULLUP);
  pinGuard.restore(nvs.getUInt(kNvsPinFails, 0), millis());
  portal.setPinCheck(&checkSetupPin);

  loadIdentity();
  runtime.setIdentity(identity.deviceId);
  loadConfiguration();
  fillHardware();

  pendingCode = nvs.getString(kNvsPendingCode, "");
  pendingCodeAt = nvs.getUInt(kNvsPendingCodeAt, 0);
  if (pendingCode.length() == 6 && pendingCodeAt && seconds() - pendingCodeAt > 300) {
    pendingCode = "";
    nvs.remove(kNvsPendingCode);
    nvs.remove(kNvsPendingCodeAt);
  }

  if (identity.complete()) {
    if (!mqtt.start(identity)) Serial.println("[homecoreos] MQTT failed to start");
    phase = Phase::Connecting;
  } else {
    // Not paired: pairing mode. The saved Wi-Fi (if any) keeps connecting underneath.
    startPortal();
  }

  Serial.printf("[homecoreos] free internal heap: %u bytes\n", (unsigned)memory().freeInternal);
}

void loop() {
  esp_task_wdt_reset();

  // 1. Connectivity state machines (never block).
  wifi.tick();
  updateConnectivityPolicy();
  serviceBootButton();

  if (portal.active()) {
    servicePortal();
  } else if (!wifi.hasCredentials()) {
    startPortal();
  }

  if (wifi.online() && !identity.complete() && pendingCode.length()) {
    attemptPairing();
  }

  // 2. Local behaviour: sampling, safety interlocks, actuator output.
  runtime.tickSafety();
  if (runtime.takeDirty()) publishState();

  // 3. OTA progress in small slices so safety logic keeps running.
  if (ota.busy()) {
    static uint8_t lastReported = 0;
    ota.step(6144);
    if (ota.percent() >= lastReported + 10) {
      lastReported = ota.percent();
      publishOtaStatus("downloading", ota.percent(), nullptr, ota.version());
    }
    if (ota.phase() == OtaPhase::Installed) {
      lastReported = 0;
      onFirmwareInstalled();
    } else if (ota.phase() == OtaPhase::Failed) {
      lastReported = 0;
      publishOtaStatus("failed", ota.percent(), ota.error().c_str(), ota.version());
      ota.reset();
    }
  }

  // 4. Cloud link.
  if (identity.complete() && mqtt.authRefusals() >= kAuthRefusalLimit && wifi.online()) {
    // The platform refuses this identity every time: it was disconnected from the
    // account. Return to pairing mode and keep the Wi-Fi network.
    Serial.println("[homecoreos] the platform refused this controller's identity; returning to pairing mode");
    clearIdentity();
    configStore.clear(nvs);
    esp_restart();
  }
  if (wifi.online() && identity.complete()) {
    if (!mqtt.connected()) {
      phase = Phase::Connecting;
      if (millis() - lastPresenceMs > 30000UL) {
        publishAvailability("offline");
        lastPresenceMs = millis();
      }
    } else {
      if (phase != Phase::Online) {
        phase = Phase::Online;
        registrationAcked = false;
        publishAvailability("online");
        publishRegistration();
        publishState();
        publishTelemetry(true);
        lastPresenceMs = 0;
        lastConfigPollMs = 0;
      }
      if (!registrationAcked && millis() - lastRegistrationMs > kRegistrationRetryMs) publishRegistration();
      if (millis() - lastPresenceMs > kPresenceReportMs) reportPresence();
      if (millis() - lastTelemetryMs > 15000UL) publishTelemetry(false);
      if (millis() - lastStateReportMs > 60000UL) publishState();
      if (millis() - lastConfigPollMs > kConfigPollMs) {
        lastConfigPollMs = millis();
        String configJson, error;
        hardware.uptimeS = (uint32_t)(millis() / 1000UL);
        hardware.rssi = wifi.rssi();
        if (cloud.fetchConfig(identity, hardware, configJson, error)) {
          applyConfigurationDocument(configJson, true);
        } else {
          Serial.printf("[homecoreos] configuration poll: %s\n", error.c_str());
        }
      }
      checkForFirmware();
      confirmFirmwareHealth();
    }
  }

  delay(5);
}
