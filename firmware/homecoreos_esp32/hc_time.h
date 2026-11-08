#pragma once
/** Time helpers shared by pairing, OTA expiry checks and telemetry timestamps. */
#include <Arduino.h>
#include <time.h>

namespace hc {

constexpr uint32_t kMinValidEpoch = 1700000000u;  // 2023-11-14

inline bool clockSynced() { return (uint32_t)time(nullptr) >= kMinValidEpoch; }

/** Wall-clock seconds, or 0 when NTP has not answered yet. Never fabricated. */
inline uint32_t epochNow() {
  time_t t = time(nullptr);
  return (uint32_t)t >= kMinValidEpoch ? (uint32_t)t : 0u;
}

/** Monotonic seconds used for all local scheduling (survives cloud outages). */
inline uint32_t seconds() { return (uint32_t)(millis() / 1000UL); }

inline uint32_t backoffMs(uint32_t attempt, uint32_t baseMs, uint32_t capMs, uint32_t salt) {
  if (attempt == 0) attempt = 1;
  uint32_t shift = attempt > 6 ? 6 : attempt - 1;
  uint64_t value = (uint64_t)baseMs << shift;
  if (value > capMs) value = capMs;
  uint32_t jitter = (esp_random() + salt * 2654435761u) % (value / 4 + 1);
  return (uint32_t)value + jitter;
}

}  // namespace hc
