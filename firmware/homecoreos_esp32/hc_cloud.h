#pragma once
/**
 * Backend client for the controller: pairing-code redemption, configuration
 * fetch, presence reporting and firmware update checks.
 *
 * A six-digit pairing code is a one-time bootstrap secret, never a device
 * credential: once redeemed the controller stores its own unique MQTT identity
 * and the code is useless. The controller also reports the *running* partition
 * version so the console never guesses what is installed.
 */
#include <Arduino.h>
#include <ArduinoJson.h>

#include "hc_config.h"
#include "hc_https.h"
#include "hc_image.h"
#include "hc_mqtt.h"
#include "hc_time.h"

namespace hc {

struct HardwareReport {
  String chipModel;
  String chipFamily;
  String chipRevision;
  String macAddress;
  String sdkVersion;
  String fwBuild;
  String hardwareConfig;
  int rssi = 0;
  uint32_t uptimeS = 0;
  uint32_t freeInternal = 0;
  uint32_t minFreeInternal = 0;
};

struct PairingOutcome {
  bool paired = false;
  bool retryable = false;
  int status = 0;
  String error;
  Identity identity;
  String configJson;
};

struct FirmwareOffer {
  bool available = false;
  String version;
  String url;
  String sha256;
  String notes;
  uint32_t size = 0;
  bool mandatory = false;
  String error;
};

class CloudClient {
 public:
  explicit CloudClient(HardwareReport &hardware) : hardware_(hardware) {}

  /** Redeem a six-digit code. The code is bound server-side to a home session. */
  PairingOutcome redeemCode(const String &code) {
    PairingOutcome out;
    if (!cloudConfigured()) { out.error = "This build has no cloud endpoint configured"; return out; }
    if (code.length() != 6) { out.error = "Enter all six digits"; return out; }
    if (!HttpsClient::apiTrusted()) { out.error = "This build has no API certificate configured"; return out; }

    JsonDocument doc;
    doc["code"] = code;
    doc["hardware"]["chip_model"] = hardware_.chipModel;
    doc["hardware"]["chip_family"] = hardware_.chipFamily;
    doc["hardware"]["chip_revision"] = hardware_.chipRevision;
    doc["hardware"]["mac_address"] = hardware_.macAddress;
    doc["hardware"]["sdk_version"] = hardware_.sdkVersion;
    doc["hardware"]["fw_build"] = hardware_.fwBuild;
    doc["hardware"]["firmware_version"] = kFirmwareVersion;
    doc["hardware"]["board_id"] = kBoardId;
    doc["hardware"]["hardware_config"] = hardware_.hardwareConfig;
    doc["hardware"]["rssi"] = hardware_.rssi;
    doc["hardware"]["uptime_seconds"] = hardware_.uptimeS;
    String body;
    serializeJson(doc, body);

    const HttpsClient::Result res = HttpsClient::post("/api/device/pair", body);
    out.status = res.status;
    if (res.status == 0) { out.error = res.error; out.retryable = true; return out; }
    if (!res.ok()) {
      JsonDocument err;
      if (!deserializeJson(err, res.body)) out.error = String(err["error"] | "");
      if (out.error.isEmpty()) out.error = res.status == 429 ? "Too many attempts. Wait and try again."
                                      : "The code was not accepted";
      out.retryable = res.status == 429 || res.status >= 500;
      return out;
    }
    JsonDocument d;
    if (deserializeJson(d, res.body)) { out.error = "The server response could not be read"; out.retryable = true; return out; }
    out.identity.deviceId = String(d["device_id"] | "");
    out.identity.tenantId = String(d["tenant_id"] | "");
    out.identity.clientId = String(d["mqtt"]["client_id"] | "");
    out.identity.username = String(d["mqtt"]["username"] | "");
    out.identity.password = String(d["mqtt"]["password"] | "");
    out.identity.broker = String(d["mqtt"]["host"] | "");
    out.identity.port = (uint16_t)(d["mqtt"]["port"] | HOMECOREOS_MQTT_PORT);
    if (!out.identity.complete()) { out.error = "The server response was incomplete"; out.retryable = true; return out; }
    if (d["config"].is<JsonObject>()) serializeJson(d["config"], out.configJson);
    out.paired = true;
    return out;
  }

  /** Fetch the current configuration using the device's own credentials. */
  bool fetchConfig(const Identity &id, const HardwareReport &hw, String &configJson, String &error) {
    JsonDocument doc;
    doc["client_id"] = id.clientId;
    doc["password"] = id.password;
    doc["firmware_version"] = kFirmwareVersion;
    doc["hardware"]["chip_model"] = hw.chipModel;
    doc["hardware"]["chip_revision"] = hw.chipRevision;
    doc["hardware"]["mac_address"] = hw.macAddress;
    doc["hardware"]["sdk_version"] = hw.sdkVersion;
    doc["hardware"]["fw_build"] = hw.fwBuild;
    doc["hardware"]["hardware_revision"] = hw.hardwareConfig;
    doc["hardware"]["rssi"] = hw.rssi;
    doc["hardware"]["uptime_seconds"] = hw.uptimeS;
    String body;
    serializeJson(doc, body);
    const HttpsClient::Result res = HttpsClient::post("/api/device/config", body);
    if (!res.ok()) { error = res.error.isEmpty() ? String("configuration request failed (") + res.status + ")" : res.error; return false; }
    JsonDocument d;
    if (deserializeJson(d, res.body)) { error = "configuration response was unreadable"; return false; }
    if (!d["config"].is<JsonObject>()) { error = "no configuration returned"; return false; }
    serializeJson(d["config"], configJson);
    return true;
  }

  /** Report presence and negotiate a firmware update. */
  FirmwareOffer checkFirmware(const Identity &id, const HardwareReport &hw, const char *runningVersion) {
    FirmwareOffer offer;
    JsonDocument doc;
    doc["client_id"] = id.clientId;
    doc["password"] = id.password;
    doc["firmware_version"] = runningVersion;
    doc["board_id"] = kBoardId;
    doc["hardware_config"] = kHardwareConfig;
    doc["uptime_seconds"] = hw.uptimeS;
    doc["rssi"] = hw.rssi;
    doc["memory"]["free_internal"] = hw.freeInternal;
    doc["memory"]["min_free_internal"] = hw.minFreeInternal;
    String body;
    serializeJson(doc, body);
    const HttpsClient::Result res = HttpsClient::post("/api/device/firmware-check", body);
    if (!res.ok()) { offer.error = res.error.isEmpty() ? String("update check failed (") + res.status + ")" : res.error; return offer; }
    JsonDocument d;
    if (deserializeJson(d, res.body)) { offer.error = "update response was unreadable"; return offer; }
    offer.available = d["update_available"] | false;
    offer.version = String(d["version"] | "");
    offer.url = String(d["url"] | "");
    offer.sha256 = String(d["sha256"] | "");
    offer.notes = String(d["notes"] | "");
    offer.size = d["size_bytes"] | 0u;
    offer.mandatory = d["mandatory"] | false;
    if (offer.available && (offer.sha256.length() != 64 || offer.url.isEmpty())) {
      offer.available = false;
      offer.error = "the server returned an incomplete release manifest";
    }
    return offer;
  }

 private:
  HardwareReport &hardware_;
};

}  // namespace hc
