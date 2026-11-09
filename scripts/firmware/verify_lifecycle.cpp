// Host test for firmware/homecoreos_esp32/hc_lifecycle.h.
//
//   g++ -std=c++17 -Wall -Wextra -I firmware/homecoreos_esp32 scripts/firmware/verify_lifecycle.cpp -o /tmp/hc_lifecycle_test
//   /tmp/hc_lifecycle_test

#include <cstdio>

#include "hc_lifecycle.h"

using namespace hc;

static int failures = 0;

static void check(bool ok, const char *name) {
  std::printf("%s  %s\n", ok ? "PASS" : "FAIL", name);
  if (!ok) ++failures;
}

static FallbackInputs base() {
  FallbackInputs in;
  in.nowMs = 10000000;
  in.paired = true;
  in.hasWifiCreds = true;
  return in;
}

int main() {
  // --- failure classification -------------------------------------------
  check(classifyWifiReason(15) == WifiFailure::WrongPassword, "4-way handshake timeout reads as a wrong password");
  check(classifyWifiReason(202) == WifiFailure::WrongPassword, "AUTH_FAIL reads as a wrong password");
  check(classifyWifiReason(201) == WifiFailure::NetworkMissing, "NO_AP_FOUND reads as a missing network");
  check(classifyWifiReason(200) == WifiFailure::RouterUnreachable, "beacon timeout reads as an unreachable router");
  check(classifyWifiReason(99) == WifiFailure::Unknown, "an unlisted reason stays unknown");

  // --- retry schedule ---------------------------------------------------
  check(retryDelayMs(1, 0) >= 2000 && retryDelayMs(1, 0) < 2500, "first retry waits about 2 s");
  check(retryDelayMs(3, 7) >= 8000, "retries back off exponentially");
  check(retryDelayMs(40, 3) <= 300000 + 300000 / 5, "retries are capped near 5 minutes");
  check(retryDelayMs(5, 11) == retryDelayMs(5, 11), "jitter is deterministic for a seed");
  check(retryDelayMs(5, 11) >= 32000 && retryDelayMs(5, 11) <= 32000 + 32000 / 5, "jitter stays within 20% of the base");

  // --- fallback access point ----------------------------------------------
  {
    FallbackInputs in = base();
    in.lastFailure = WifiFailure::WrongPassword;
    in.consecutiveWifiFailures = 2;
    check(decideFallback(in) == FallbackAction::Keep, "wrong password: two failures keep trying silently");
    in.consecutiveWifiFailures = 3;
    check(decideFallback(in) == FallbackAction::Open, "wrong password: three failures open the fallback AP");
  }
  {
    FallbackInputs in = base();
    in.lastFailure = WifiFailure::NetworkMissing;
    in.consecutiveWifiFailures = 3;
    check(decideFallback(in) == FallbackAction::Open, "missing network opens the fallback after three failures");
  }
  {
    FallbackInputs in = base();
    in.lastFailure = WifiFailure::RouterUnreachable;
    in.consecutiveWifiFailures = 3;
    check(decideFallback(in) == FallbackAction::Keep, "unreachable router waits for six failures");
    in.consecutiveWifiFailures = 6;
    check(decideFallback(in) == FallbackAction::Open, "unreachable router opens the fallback after six failures");
  }
  {
    FallbackInputs in = base();
    in.wifiOnline = true;
    in.mqttUp = false;
    in.noInternetMs = 4UL * 60UL * 1000UL;
    check(decideFallback(in) == FallbackAction::Keep, "no internet: four minutes is not yet a fallback");
    in.noInternetMs = 5UL * 60UL * 1000UL;
    check(decideFallback(in) == FallbackAction::Open, "no internet: five minutes opens the fallback");
  }
  {
    FallbackInputs in = base();
    in.portalOpen = true;
    in.portalIsFallback = true;
    in.wifiOnline = true;
    in.mqttUp = true;
    check(decideFallback(in) == FallbackAction::Close, "fallback closes once the cloud link is back");
  }
  {
    FallbackInputs in = base();
    in.portalOpen = true;
    in.portalIsFallback = false;  // opened by the owner
    in.wifiOnline = true;
    in.mqttUp = true;
    check(decideFallback(in) == FallbackAction::Keep, "a portal the owner opened is not closed by recovery");
  }
  {
    FallbackInputs in = base();
    in.consecutiveWifiFailures = 9;
    in.lastFailure = WifiFailure::WrongPassword;
    in.lastFallbackOpenMs = in.nowMs - 10000;
    check(decideFallback(in) == FallbackAction::Keep, "fallback does not reopen within one minute of closing");
  }
  {
    FallbackInputs in = base();
    in.paired = false;
    in.consecutiveWifiFailures = 9;
    check(decideFallback(in) == FallbackAction::Keep, "unpaired controllers use the pairing mode, not this rule");
  }
  {
    FallbackInputs in = base();
    in.wifiOnline = true;
    in.mqttUp = true;
    in.noInternetMs = 0;
    check(decideFallback(in) == FallbackAction::Keep, "a healthy controller keeps its state");
  }

  // --- digest comparison ------------------------------------------------------
  {
    const char *a = "0123456789abcdef";
    const char *b = "0123456789abcdef";
    const char *c = "0123456789abcdee";
    check(sameDigest(a, b, 16), "identical digests match");
    check(!sameDigest(a, c, 16), "a digest differing in the last character does not match");
    check(!sameDigest(a, b, 15), "a shorter comparison does not match a longer digest");
  }

  // --- setup PIN lockout --------------------------------------------------
  {
    PinGuard g;
    uint32_t now = 1000;
    check(g.attempt(now, true) == PinResult::Accepted, "a correct PIN is accepted");
    for (int i = 0; i < 4; ++i) g.attempt(now, false);
    check(!g.locked(now), "four wrong PINs do not lock the portal");
    check(g.attempt(now, false) == PinResult::Rejected, "the fifth wrong PIN is still reported as rejected");
    check(g.locked(now), "five wrong PINs lock the portal");
    check(g.attempt(now, true) == PinResult::Locked, "a correct PIN is refused while locked");
    check(!g.locked(now + kPinLockMs), "the lock expires after ten minutes");
    check(g.attempt(now + kPinLockMs, true) == PinResult::Accepted, "a correct PIN works after the lock expires");
  }
  {
    // A reboot must not clear the lock: the failure count is persisted.
    PinGuard g;
    g.restore(kPinMaxFailures, 5000);
    check(g.locked(5000), "a persisted lock survives a reboot");
    PinGuard h;
    h.restore(2, 5000);
    check(!h.locked(5000), "a few persisted failures do not lock on boot");
  }

  // --- BOOT button -----------------------------------------------------------
  check(buttonActionOnRelease(500) == ButtonAction::None, "a tap does nothing");
  check(buttonActionOnRelease(3000) == ButtonAction::WifiReset, "three seconds resets Wi-Fi");
  check(buttonActionOnRelease(9999) == ButtonAction::WifiReset, "nine seconds still only resets Wi-Fi");
  check(buttonActionOnRelease(10000) == ButtonAction::FactoryReset, "ten seconds performs a factory reset");

  std::printf("\n%s (%d failure%s)\n", failures ? "FAILED" : "ALL PASSED", failures, failures == 1 ? "" : "s");
  return failures ? 1 : 0;
}
