#pragma once
/**
 * HomecoreOS controller configuration surface.
 *
 * Build-time values (cloud endpoint, trust anchors) are injected by the firmware
 * build workflow into a generated header. Nothing secret is ever compiled into
 * the image: only public TLS certificates and the public API origin.
 *
 * There is no firmware signing key. Update integrity is enforced with the
 * SHA-256 digest of the image, which the controller verifies itself.
 */
#include <Arduino.h>

#if defined(__has_include)
#  if __has_include("hc_build.h")
#    include "hc_build.h"
#  endif
#endif

#ifndef HOMECOREOS_FW_VERSION
#  define HOMECOREOS_FW_VERSION "0.0.0-dev"
#endif
#ifndef HOMECOREOS_BOARD_ID
#  define HOMECOREOS_BOARD_ID "espressif.esp32-s3-devkitc-1.v1.1"
#endif
#ifndef HOMECOREOS_HW_CONFIG
#  define HOMECOREOS_HW_CONFIG "ESP32-S3 / 16MB flash / 8MB OPI PSRAM"
#endif
#ifndef HOMECOREOS_API_BASE
#  define HOMECOREOS_API_BASE ""
#endif
#ifndef HOMECOREOS_CA_API_PEM
#  define HOMECOREOS_CA_API_PEM ""
#endif
#ifndef HOMECOREOS_CA_MQTT_PEM
#  define HOMECOREOS_CA_MQTT_PEM ""
#endif
#ifndef HOMECOREOS_MQTT_PORT
#  define HOMECOREOS_MQTT_PORT 8883
#endif

namespace hc {

constexpr const char *kFirmwareVersion = HOMECOREOS_FW_VERSION;
/**
 * "hcver:<version>" is printed at boot and therefore present in the image as a
 * plain string. The build script and the Pages API read the release version from
 * it: the ESP-IDF application descriptor of this core holds the precompiled
 * core's build hash, not the version, so it cannot be used for that.
 */
constexpr const char *kVersionBanner = "hcver:" HOMECOREOS_FW_VERSION;
constexpr const char *kApiBase = HOMECOREOS_API_BASE;
constexpr const char *kBoardId = HOMECOREOS_BOARD_ID;
constexpr const char *kHardwareConfig = HOMECOREOS_HW_CONFIG;
constexpr const char *kCaApi = HOMECOREOS_CA_API_PEM;
constexpr const char *kCaMqtt = HOMECOREOS_CA_MQTT_PEM;

/** Protocol + lifecycle limits shared with the backend. */
constexpr uint32_t kPairingAttempts = 6;          // per code, enforced server-side too
constexpr uint32_t kHttpTimeoutMs = 9000;
constexpr uint32_t kOtaIdleTimeoutMs = 20000;
constexpr uint32_t kConfigPollMs = 5 * 60 * 1000;
constexpr uint32_t kPresenceReportMs = 60 * 1000;
constexpr uint32_t kOtaHealthConfirmMs = 45 * 1000;
/** Registration is re-sent this often until the platform acknowledges it. */
constexpr uint32_t kRegistrationRetryMs = 10 * 1000;
constexpr size_t kMaxComponents = 24;
constexpr size_t kMaxRules = 12;
constexpr size_t kCommandCacheSize = 8;
constexpr size_t kMaxPayloadBytes = 4096;

/** NVS namespace + keys. Only durable identity and connectivity state live here. */
constexpr const char *kNvsNamespace = "homecoreos";
constexpr const char *kNvsWifiSsid = "wifi_ssid";
constexpr const char *kNvsWifiPass = "wifi_pass";
constexpr const char *kNvsDeviceId = "device_id";
constexpr const char *kNvsTenantId = "tenant_id";
constexpr const char *kNvsClientId = "client_id";
constexpr const char *kNvsMqttUser = "mqtt_user";
constexpr const char *kNvsMqttPass = "mqtt_pass";
constexpr const char *kNvsBroker = "broker";
constexpr const char *kNvsBrokerPort = "broker_port";
constexpr const char *kNvsConfig = "lkg_cfg";
constexpr const char *kNvsConfigVersion = "cfg_ver";
constexpr const char *kNvsPendingCode = "pend_code";
constexpr const char *kNvsPendingCodeAt = "pend_at";
constexpr const char *kNvsOtaState = "ota_state";
constexpr const char *kNvsOtaVersion = "ota_ver";
constexpr const char *kNvsBootOk = "boot_ok";
constexpr const char *kNvsControllerId = "controller_id";
constexpr const char *kNvsHomeId = "home_id";
constexpr const char *kNvsPairingSession = "pair_session";
// Setup PIN: a per-device salt and a salted digest. The PIN itself is never stored.
constexpr const char *kNvsPinSalt = "pin_salt";
constexpr const char *kNvsPinHash = "pin_hash";
constexpr const char *kNvsPinFails = "pin_fails";
constexpr uint32_t kAuthRefusalLimit = 5;     // refusals in a row before this identity is treated as revoked
constexpr uint32_t kOwnerPortalIdleMs = 15UL * 60UL * 1000UL;
constexpr uint32_t kAckWaitMs = 5000;        // how long an unpair/reset ack waits for the broker's PUBACK
constexpr uint8_t kBootButtonPin = 0;  // ESP32-S3 BOOT button (active low, internal pull-up)

/** Persisted view of the last OTA attempt so a reboot loop is detectable. */
enum class OtaState : uint8_t { None = 0, Downloading = 1, Applied = 2, Confirmed = 3, Failed = 4, RolledBack = 5 };

inline const char *otaStateName(OtaState s) {
  switch (s) {
    case OtaState::Downloading: return "downloading";
    case OtaState::Applied: return "installed";
    case OtaState::Confirmed: return "success";
    case OtaState::Failed: return "failed";
    case OtaState::RolledBack: return "rolled_back";
    default: return "none";
  }
}

inline bool cloudConfigured() { return kApiBase[0] != '\0'; }

}  // namespace hc
