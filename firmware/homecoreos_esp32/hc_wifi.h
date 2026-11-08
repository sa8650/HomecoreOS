#pragma once
/**
 * Wi-Fi lifecycle: non-blocking connect, exponential backoff with jitter and a
 * bounded failure budget. The saved network is never erased by a transient
 * outage: only an explicit portal action forgets credentials.
 */
#include <Arduino.h>
#include <WiFi.h>

#include "hc_config.h"
#include "hc_time.h"

namespace hc {

enum class WifiPhase : uint8_t { Idle, Connecting, Connected, Waiting, NoCredentials, Failed };

class WifiLink {
 public:
  void begin(const String &ssid, const String &pass) {
    ssid_ = ssid;
    pass_ = pass;
    phase_ = ssid_.isEmpty() ? WifiPhase::NoCredentials : WifiPhase::Idle;
    nextAttemptMs_ = 0;
    attempts_ = 0;
    failures_ = 0;
  }

  void forget() {
    ssid_ = "";
    pass_ = "";
    WiFi.disconnect(true, true);
    phase_ = WifiPhase::NoCredentials;
  }

  /** Drives the state machine; returns quickly in every branch. */
  void tick() {
    const uint32_t now = millis();
    switch (phase_) {
      case WifiPhase::NoCredentials:
      case WifiPhase::Failed:
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
          rssi_ = WiFi.RSSI();
          return;
        }
        if (now - startedMs_ > kAttemptWindowMs) {
          WiFi.disconnect(false, false);
          ++failures_;
          attempts_ = failures_;
          phase_ = WifiPhase::Waiting;
          nextAttemptMs_ = now + backoffMs(attempts_, 2000, 60000, mac_);
        }
        return;
      case WifiPhase::Waiting:
        if (now < nextAttemptMs_) return;
        start();
        return;
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

  const char *phaseName() const {
    switch (phase_) {
      case WifiPhase::Connecting: return "connecting";
      case WifiPhase::Connected: return "connected";
      case WifiPhase::Waiting: return "reconnecting";
      case WifiPhase::NoCredentials: return "no_credentials";
      case WifiPhase::Failed: return "failed";
      default: return "idle";
    }
  }

  /** Called once after NVS is loaded so the MAC can seed backoff jitter. */
  void seed(uint32_t macLow, int storedRssi) {
    mac_ = macLow;
    rssi_ = storedRssi;
  }

  /** Leave the radio quiet after repeated failures instead of a hot reconnect loop. */
  bool exhausted() const { return failures_ >= 12; }

 private:
  static constexpr uint32_t kAttemptWindowMs = 12000;

  void start() {
    phase_ = WifiPhase::Connecting;
    startedMs_ = millis();
    WiFi.persistent(false);
    WiFi.setSleep(false);
    WiFi.mode(WIFI_STA);
    WiFi.setAutoReconnect(false);
    WiFi.begin(ssid_.c_str(), pass_.c_str());
  }

  String ssid_, pass_;
  WifiPhase phase_ = WifiPhase::Idle;
  uint32_t startedMs_ = 0, nextAttemptMs_ = 0, attempts_ = 0, failures_ = 0;
  uint32_t connectedSinceMs_ = 0, mac_ = 1;
  int rssi_ = 0;
};

}  // namespace hc
