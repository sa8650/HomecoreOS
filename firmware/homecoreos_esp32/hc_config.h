#pragma once
/**
 * HomecoreOS controller configuration surface.
 *
 * Build-time values (cloud endpoint, trust anchors, signing key) are injected by
 * the firmware build workflow into a generated header. Nothing secret is ever
 * compiled into the image: only public certificates and a public signing key.
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
#ifndef HOMECOREOS_FW_SIGNING_PUBKEY
#  define HOMECOREOS_FW_SIGNING_PUBKEY ""
#endif
#ifndef HOMECOREOS_FW_SIGNING_ALG
#  define HOMECOREOS_FW_SIGNING_ALG "none"
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
constexpr const char *kSigningAlg = HOMECOREOS_FW_SIGNING_ALG;
constexpr const char *kSigningPublicKey = HOMECOREOS_FW_SIGNING_PUBKEY;
constexpr const char *kCaApi = HOMECOREOS_CA_API_PEM;
constexpr const char *kCaMqtt = HOMECOREOS_CA_MQTT_PEM;

/** Protocol + lifecycle limits shared with the backend. */
constexpr uint32_t kPairingAttempts = 6;          // per code, enforced server-side too
constexpr uint32_t kHttpTimeoutMs = 9000;
constexpr uint32_t kOtaIdleTimeoutMs = 20000;
constexpr uint32_t kConfigPollMs = 5 * 60 * 1000;
constexpr uint32_t kPresenceReportMs = 60 * 1000;
constexpr uint32_t kOtaHealthConfirmMs = 45 * 1000;
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
inline bool signingConfigured() {
  return kSigningPublicKey[0] != '\0' && strcmp(kSigningAlg, "none") != 0;
}

}  // namespace hc
