#pragma once
/**
 * Wi-Fi lifecycle: non-blocking connect, exponential backoff with jitter.
 *
 * The saved network is never erased by a transient outage: only an explicit
 * action (Reset Wi-Fi, factory reset, or the portal saving new details) forgets
 * credentials. Retries continue indefinitely, at a capped interval. Whether a
 * fallback access point should open is decided in hc_lifecycle.h; this class
 * only reports what it observed.
 *
 * The radio is kept in AP+STA while the setup portal is open, so the connection
 * keeps retrying and the cloud link stays up during setup.
 */
#include <Arduino.h>
#include <WiFi.h>

#include "hc_config.h"
#include "hc_lifecycle.h"
#include "hc_time.h"

namespace hc {

enum class WifiPhase : uint8_t { Idle, Connecting, Connected, Waiting, NoCredentials };

class WifiLink {
 public:
  void begin(const String &ssid, const String &pass) {
    ssid_ = ssid;
    pass_ = pass;
    phase_ = ssid_.isEmpty() ? WifiPhase::NoCredentials : WifiPhase::Idle;
    nextAttemptMs_ = 0;
    attempts_ = 0;
    failures_ = 0;
    lastFailure_ = WifiFailure::None;
    if (!instance_) {
      instance_ = this;
      WiFi.onEvent(&WifiLink::onStaEvent, ARDUINO_EVENT_WIFI_STA_DISCONNECTED);
    }
  }

  /** Explicit action only: forgets the saved network and drops the link. */
  void forget() {
    ssid_ = "";
    pass_ = "";
    WiFi.disconnect(false, true);
    phase_ = WifiPhase::NoCredentials;
    failures_ = 0;
    lastFailure_ = WifiFailure::None;
  }

  /** Drives the state machine; returns quickly in every branch. */
  void tick() {
    const uint32_t now = millis();
    switch (phase_) {
      case WifiPhase::NoCredentials:
        return;
      case WifiPhase::Connected:
        if (WiFi.status() != WL_CONNECTED) {
          phase_ = WifiPhase::Waiting;
          attempts_ = 0;
          nextAttemptMs_ = now + 500;
          connectedSinceMs_ = 0;
        }
        return;
      case WifiPhase::Connecting:
        if (WiFi.status() == WL_CONNECTED) {
          phase_ = WifiPhase::Connected;
          connectedSinceMs_ = now;
          attempts_ = 0;
          failures_ = 0;  // a success ends the failure streak
          lastFailure_ = WifiFailure::None;
          rssi_ = WiFi.RSSI();
          return;
        }
        if (now - startedMs_ > kAttemptWindowMs) {
          WiFi.disconnect(false, false);
          ++failures_;
          attempts_ = failures_;
          phase_ = WifiPhase::Waiting;
          nextAttemptMs_ = now + retryDelayMs(failures_, mac_ + failures_);
        }
        return;
      case WifiPhase::Waiting:
      case WifiPhase::Idle:
        if (now < nextAttemptMs_) return;
        start();
        return;
    }
  }

  bool online() const { return phase_ == WifiPhase::Connected && WiFi.status() == WL_CONNECTED; }
  bool hasCredentials() const { return !ssid_.isEmpty(); }
  WifiPhase phase() const { return phase_; }
  const String &ssid() const { return ssid_; }
  int rssi() const { return online() ? WiFi.RSSI() : rssi_; }
  uint32_t uptimeOnlineS() const {
    return online() && connectedSinceMs_ ? (millis() - connectedSinceMs_) / 1000UL : 0;
  }
  uint32_t consecutiveFailures() const { return failures_; }
  uint32_t attempts() const { return attempts_; }
  WifiFailure lastFailure() const { return lastFailure_; }

  const char *phaseName() const {
    switch (phase_) {
      case WifiPhase::Connecting: return "connecting";
      case WifiPhase::Connected: return "connected";
      case WifiPhase::Waiting: return "reconnecting";
      case WifiPhase::NoCredentials: return "no_credentials";
      default: return "idle";
    }
  }

  /** Called once after NVS is loaded so the MAC can seed backoff jitter. */
  void seed(uint32_t macLow, int storedRssi) {
    mac_ = macLow;
    rssi_ = storedRssi;
  }

 private:
  static constexpr uint32_t kAttemptWindowMs = 12000;

  /** Records why the last attempt failed. Runs in the Wi-Fi event task: no I/O here. */
  static void onStaEvent(arduino_event_id_t, arduino_event_info_t info) {
    if (!instance_) return;
    if (instance_->phase_ != WifiPhase::Connecting) return;
    instance_->lastFailure_ = classifyWifiReason(info.wifi_sta_disconnected.reason);
  }

  void start() {
    phase_ = WifiPhase::Connecting;
    startedMs_ = millis();
    WiFi.persistent(false);
    WiFi.setSleep(false);
    // Keep the access point if the portal is open. Switching to STA alone would
    // tear the portal down and cut the owner off in the middle of a Wi-Fi change.
    const bool apActive = (static_cast<int>(WiFi.getMode()) & static_cast<int>(WIFI_MODE_AP)) != 0;
    WiFi.mode(apActive ? WIFI_AP_STA : WIFI_STA);
    WiFi.setAutoReconnect(false);
    WiFi.begin(ssid_.c_str(), pass_.c_str());
  }

  static WifiLink *instance_;
  String ssid_, pass_;
  WifiPhase phase_ = WifiPhase::Idle;
  WifiFailure lastFailure_ = WifiFailure::None;
  uint32_t startedMs_ = 0, nextAttemptMs_ = 0, attempts_ = 0, failures_ = 0;
  uint32_t connectedSinceMs_ = 0, mac_ = 1;
  int rssi_ = 0;
};

inline WifiLink *WifiLink::instance_ = nullptr;

}  // namespace hc
