#pragma once
/**
 * GPIO safety layer.
 *
 * Every pin coming from the cloud config is re-checked on the device. A pin that
 * is used by flash/PSRAM, or that does not exist on this chip, is refused instead
 * of being driven. Fail-safe behaviour matters more than convenience here.
 */
#include <Arduino.h>
#include "esp_heap_caps.h"

#include "hc_model.h"

namespace hc {

enum class PinVerdict : uint8_t { Ok, Reserved, OutOfRange, InputOnly };

inline const char *verdictName(PinVerdict v) {
  switch (v) {
    case PinVerdict::Reserved: return "reserved by flash/PSRAM";
    case PinVerdict::OutOfRange: return "does not exist on this chip";
    case PinVerdict::InputOnly: return "input-only pin";
    default: return "ok";
  }
}

inline int maxGpioForChip() {
#if defined(CONFIG_IDF_TARGET_ESP32S3)
  return 48;
#elif defined(CONFIG_IDF_TARGET_ESP32S2)
  return 46;
#elif defined(CONFIG_IDF_TARGET_ESP32C3)
  return 21;
#elif defined(CONFIG_IDF_TARGET_ESP32C6)
  return 30;
#else
  return 39;
#endif
}

/** Pins consumed by the SPI flash (and OPI PSRAM on N16R8) are never available. */
inline bool gpioReservedByMemory(int gpio) {
#if defined(CONFIG_IDF_TARGET_ESP32S3)
  return gpio >= 26 && gpio <= 32;
#elif defined(CONFIG_IDF_TARGET_ESP32)
  return gpio >= 6 && gpio <= 11;
#elif defined(CONFIG_IDF_TARGET_ESP32S2)
  return gpio >= 26 && gpio <= 32;
#elif defined(CONFIG_IDF_TARGET_ESP32C3) || defined(CONFIG_IDF_TARGET_ESP32C6)
  return false;
#else
  return false;
#endif
}

inline PinVerdict checkOutputPin(int gpio) {
  if (gpio < 0 || gpio > maxGpioForChip()) return PinVerdict::OutOfRange;
  if (gpioReservedByMemory(gpio)) return PinVerdict::Reserved;
#if defined(CONFIG_IDF_TARGET_ESP32)
  if (gpio >= 34 && gpio <= 39) return PinVerdict::InputOnly;
#endif
  return PinVerdict::Ok;
}

inline PinVerdict checkInputPin(int gpio) {
  if (gpio < 0 || gpio > maxGpioForChip()) return PinVerdict::OutOfRange;
  if (gpioReservedByMemory(gpio)) return PinVerdict::Reserved;
  return PinVerdict::Ok;
}

/** Applies an actuator level. Returns false when the pin is unusable. */
inline bool driveActuator(const Actuator &a, bool on) {
  if (checkOutputPin(a.gpio) != PinVerdict::Ok) return false;
  pinMode(a.gpio, OUTPUT);
  const int level = a.activeLow ? (on ? LOW : HIGH) : (on ? HIGH : LOW);
  digitalWrite(a.gpio, level);
  return true;
}

/** Read one sensor sample. Returns false when the sample must not be reported. */
inline bool readSensorSample(Sensor &s, float &value) {
  if (s.kind == SensorKind::None) return false;
  if (checkInputPin(s.gpio) != PinVerdict::Ok) return false;
  if (s.kind == SensorKind::Analog) {
#if defined(CONFIG_IDF_TARGET_ESP32S3) || defined(CONFIG_IDF_TARGET_ESP32C3)
    const int raw = analogRead(s.gpio);
    value = (raw / 4095.0f) * 100.0f;
#else
    const int raw = analogRead(s.gpio);
    value = (raw / 4095.0f) * 100.0f;
#endif
  } else {
    pinMode(s.gpio, s.digitalPullup ? INPUT_PULLUP : INPUT);
    const int raw = digitalRead(s.gpio);
    const bool active = s.activeLow ? raw == LOW : raw == HIGH;
    value = active ? 1.0f : 0.0f;
  }
  value = value * s.scale + s.offset;
  if (s.hasRange && (value < s.minValid || value > s.maxValid)) return false;
  return true;
}

/** Free-heap diagnostics; PSRAM is reported separately and not counted as RAM. */
struct MemInfo {
  uint32_t freeInternal;
  uint32_t minFreeInternal;
  uint32_t freePsram;
  uint16_t largestBlock;
};

inline MemInfo memory() {
  MemInfo m{};
  m.freeInternal = (uint32_t)heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
  m.minFreeInternal = (uint32_t)heap_caps_get_minimum_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
  m.freePsram = (uint32_t)heap_caps_get_free_size(MALLOC_CAP_SPIRAM);
  m.largestBlock = (uint16_t)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
  return m;
}

}  // namespace hc
