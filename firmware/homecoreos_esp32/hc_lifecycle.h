#pragma once
/**
 * Connectivity and recovery rules for the controller, as pure functions.
 *
 * Nothing in this header touches the radio, NVS, MQTT or the clock. The sketch
 * feeds in the observed facts and acts on the decision, so every rule here can
 * be exercised on a host machine (scripts/firmware/verify_lifecycle.cpp).
 *
 *  - Wi-Fi outages never erase pairing. Only an explicit action does that.
 *  - The temporary fallback access point opens for a failure that a person can
 *    fix (wrong password, network missing, router unreachable, no internet),
 *    and closes once the cloud link is back.
 *  - A setup PIN guards Wi-Fi changes on a paired controller. Repeated wrong
 *    PINs lock the portal for a while.
 */
#include <cstdint>

namespace hc {

// ---------------------------------------------------------------------------
// Wi-Fi failure classification (ESP-IDF wifi_err_reason_t values)
// ---------------------------------------------------------------------------
enum class WifiFailure : uint8_t { None, WrongPassword, NetworkMissing, RouterUnreachable, Unknown };

inline WifiFailure classifyWifiReason(uint8_t reason) {
  switch (reason) {
    case 2:    // AUTH_EXPIRE
    case 15:   // 4WAY_HANDSHAKE_TIMEOUT: the usual symptom of a wrong passphrase
    case 202:  // AUTH_FAIL
    case 204:  // HANDSHAKE_TIMEOUT
      return WifiFailure::WrongPassword;
    case 201:  // NO_AP_FOUND: the named network is not in range
      return WifiFailure::NetworkMissing;
    case 200:  // BEACON_TIMEOUT: the access point was seen, then went silent
    case 203:  // ASSOC_FAIL
    case 1:    // UNSPECIFIED
      return WifiFailure::RouterUnreachable;
    default:
      return WifiFailure::Unknown;
  }
}

inline const char *wifiFailureName(WifiFailure f) {
  switch (f) {
    case WifiFailure::WrongPassword: return "wrong_password";
    case WifiFailure::NetworkMissing: return "network_not_found";
    case WifiFailure::RouterUnreachable: return "router_unreachable";
    case WifiFailure::Unknown: return "unknown";
    default: return "";
  }
}

// ---------------------------------------------------------------------------
// Retry schedule: exponential, capped, with a deterministic jitter.
// ---------------------------------------------------------------------------
inline uint32_t retryDelayMs(uint32_t failures, uint32_t jitterSeed) {
  // 2 s, 4 s, 8 s ... capped at 5 min. The radio is never left switched off:
  // the link keeps trying, just not in a hot loop.
  uint32_t base = 2000;
  for (uint32_t i = 1; i < failures && base < 300000; ++i) base *= 2;
  if (base > 300000) base = 300000;
  const uint32_t jitter = (jitterSeed * 2654435761u) % (base / 5 + 1);
  return base + jitter;
}

// ---------------------------------------------------------------------------
// Fallback access point decision
// ---------------------------------------------------------------------------
struct FallbackInputs {
  uint32_t nowMs = 0;
  bool paired = false;
  bool hasWifiCreds = false;
  bool wifiOnline = false;
  bool mqttUp = false;
  uint32_t consecutiveWifiFailures = 0;
  WifiFailure lastFailure = WifiFailure::None;
  // Milliseconds the radio has been connected while the cloud link is down.
  uint32_t noInternetMs = 0;
  bool portalOpen = false;
  bool portalIsFallback = false;
  // When the last fallback opened (0 = never). Stops the portal flapping.
  uint32_t lastFallbackOpenMs = 0;
};

enum class FallbackAction : uint8_t { Keep, Open, Close };

constexpr uint32_t kFallbackAfterFailuresFixable = 3;   // wrong password or missing network
constexpr uint32_t kFallbackAfterFailuresAny = 6;       // router unreachable, unknown
constexpr uint32_t kNoInternetFallbackMs = 5UL * 60UL * 1000UL;
constexpr uint32_t kFallbackMinGapMs = 60UL * 1000UL;

inline FallbackAction decideFallback(const FallbackInputs &in) {
  if (!in.paired || !in.hasWifiCreds) return FallbackAction::Keep;  // pairing mode is handled elsewhere

  if (in.portalOpen) {
    // The fallback is only temporary: it closes once the cloud link is back.
    // A portal the owner opened on purpose stays open until the owner leaves it.
    if (in.portalIsFallback && in.wifiOnline && in.mqttUp) return FallbackAction::Close;
    return FallbackAction::Keep;
  }

  if (in.lastFallbackOpenMs && in.nowMs - in.lastFallbackOpenMs < kFallbackMinGapMs) return FallbackAction::Keep;

  if (!in.wifiOnline) {
    const bool fixable = in.lastFailure == WifiFailure::WrongPassword ||
                         in.lastFailure == WifiFailure::NetworkMissing;
    if (fixable && in.consecutiveWifiFailures >= kFallbackAfterFailuresFixable) return FallbackAction::Open;
    if (in.consecutiveWifiFailures >= kFallbackAfterFailuresAny) return FallbackAction::Open;
    return FallbackAction::Keep;
  }

  // Wi-Fi is up but the cloud is not reachable: the router has no internet.
  if (!in.mqttUp && in.noInternetMs >= kNoInternetFallbackMs) return FallbackAction::Open;
  return FallbackAction::Keep;
}

/** Compares two digests without leaking where they differ. */
inline bool sameDigest(const char *a, const char *b, size_t n) {
  if (!a || !b) return false;
  unsigned diff = 0;
  for (size_t i = 0; i < n; ++i) diff |= (unsigned)(a[i] ^ b[i]);
  return diff == 0 && a[n] == '\0' && b[n] == '\0';
}

// ---------------------------------------------------------------------------
// Setup PIN lockout. The PIN itself is never held here: the caller compares
// digests and reports the result.
// ---------------------------------------------------------------------------
constexpr uint32_t kPinMaxFailures = 5;
constexpr uint32_t kPinLockMs = 10UL * 60UL * 1000UL;

enum class PinResult : uint8_t { Accepted, Rejected, Locked };

struct PinGuard {
  uint32_t failures = 0;
  uint32_t lockedUntilMs = 0;

  /** Call on boot with the persisted failure count, so a reboot does not reset the lock. */
  void restore(uint32_t persistedFailures, uint32_t nowMs) {
    failures = persistedFailures;
    lockedUntilMs = failures >= kPinMaxFailures ? nowMs + kPinLockMs : 0;
  }

  bool locked(uint32_t nowMs) const { return lockedUntilMs && nowMs < lockedUntilMs; }

  PinResult attempt(uint32_t nowMs, bool matches) {
    if (locked(nowMs)) return PinResult::Locked;
    if (matches) {
      failures = 0;
      lockedUntilMs = 0;
      return PinResult::Accepted;
    }
    ++failures;
    if (failures >= kPinMaxFailures) {
      lockedUntilMs = nowMs + kPinLockMs;
      failures = 0;  // the next window starts fresh once it expires
    }
    return PinResult::Rejected;
  }
};

// ---------------------------------------------------------------------------
// Physical BOOT button (GPIO0). Acts when the button is released.
// ---------------------------------------------------------------------------
enum class ButtonAction : uint8_t { None, WifiReset, FactoryReset };

constexpr uint32_t kButtonWifiResetMs = 3000;
constexpr uint32_t kButtonFactoryResetMs = 10000;

inline ButtonAction buttonActionOnRelease(uint32_t heldMs) {
  if (heldMs >= kButtonFactoryResetMs) return ButtonAction::FactoryReset;
  if (heldMs >= kButtonWifiResetMs) return ButtonAction::WifiReset;
  return ButtonAction::None;
}

}  // namespace hc
