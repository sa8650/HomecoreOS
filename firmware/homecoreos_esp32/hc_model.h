#pragma once
/**
 * Device model.
 *
 * The website/database is the single source of truth for what is wired where.
 * This file turns a validated configuration document into a flat, fixed-size
 * runtime model so nothing is allocated per message and a failed update can
 * never leave half a configuration behind.
 */
#include <Arduino.h>
#include <ArduinoJson.h>
#include <Preferences.h>

#include "hc_config.h"

namespace hc {

enum class SensorKind : uint8_t { None, Analog, Digital };
enum class RuleOp : uint8_t { Gt, Gte, Lt, Lte, Eq };

struct Actuator {
  char id[33] = {0};
  int8_t gpio = -1;
  bool activeLow = false;
  bool initialOn = false;
  bool state = false;
  bool known = false;
  uint16_t pulseMs = 500;
  int8_t inputGpio = -1;
};

struct Sensor {
  char id[33] = {0};
  char unit[13] = {0};
  SensorKind kind = SensorKind::None;
  int8_t gpio = -1;
  bool activeLow = false;
  bool digitalPullup = true;
  uint16_t samplingS = 30;
  uint16_t reportingS = 60;
  float deltaThreshold = 0;
  float minValid = 0;
  float maxValid = 0;
  bool hasRange = false;
  float scale = 1.0f;
  float offset = 0.0f;
  float lastValue = 0;
  bool hasLast = false;
  uint32_t lastSampleMs = 0;
  uint32_t lastReportMs = 0;
};

struct LocalRule {
  char sensor[33] = {0};
  char actuator[33] = {0};
  RuleOp op = RuleOp::Gt;
  float threshold = 0;
  bool target = false;
  uint16_t cooldownS = 30;
  uint32_t lastFiredMs = 0;
  bool fired = false;
};

class DeviceModel {
 public:
  Actuator actuators[kMaxComponents];
  Sensor sensors[kMaxComponents];
  LocalRule rules[kMaxRules];
  size_t actuatorCount = 0;
  size_t sensorCount = 0;
  size_t ruleCount = 0;
  size_t unsupportedCount = 0;
  uint32_t configVersion = 0;
  uint32_t appliedVersion = 0;

  int findActuator(const char *id) const {
    for (size_t i = 0; i < actuatorCount; ++i) {
      if (strncmp(actuators[i].id, id, sizeof(actuators[i].id)) == 0) return (int)i;
    }
    return -1;
  }
  int findSensor(const char *id) const {
    for (size_t i = 0; i < sensorCount; ++i) {
      if (strncmp(sensors[i].id, id, sizeof(sensors[i].id)) == 0) return (int)i;
    }
    return -1;
  }

  /** Structural validation before anything is mutated. */
  static bool validate(JsonDocument &doc, String &error) {
    if ((doc["schema_version"] | 0) != 1) { error = "unsupported schema_version"; return false; }
    if (!doc["config_version"].is<uint32_t>()) { error = "config_version missing"; return false; }
    if (!doc["devices"].is<JsonArray>() || !doc["sensors"].is<JsonArray>() || !doc["buses"].is<JsonArray>()) {
      error = "devices, sensors and buses must be arrays";
      return false;
    }
    if (doc["devices"].as<JsonArray>().size() > kMaxComponents ||
        doc["sensors"].as<JsonArray>().size() > kMaxComponents) {
      error = "configuration exceeds the supported component count";
      return false;
    }
    for (JsonObject d : doc["devices"].as<JsonArray>()) {
      const int gpio = d["gpio"] | -1;
      if (!d["component_id"].is<const char *>() || gpio < 0 || gpio > 48) {
        error = "device entry needs a component_id and a valid GPIO";
        return false;
      }
    }
    for (JsonObject s : doc["sensors"].as<JsonArray>()) {
      if (!s["component_id"].is<const char *>()) { error = "sensor entry needs a component_id"; return false; }
    }
    return true;
  }

  /**
   * Apply a validated document. Returns true only when the whole document was
   * accepted; the previous model stays active otherwise.
   */
  bool apply(JsonDocument &doc, String &error) {
    if (!validate(doc, error)) return false;
    const uint32_t incoming = doc["config_version"] | 0u;
    if (incoming < appliedVersion) { error = "stale config_version"; return false; }

    Actuator nextActuators[kMaxComponents];
    Sensor nextSensors[kMaxComponents];
    LocalRule nextRules[kMaxRules];
    size_t na = 0, ns = 0, nr = 0, unsupported = 0;

    for (JsonObject o : doc["devices"].as<JsonArray>()) {
      if (na >= kMaxComponents) break;
      Actuator &a = nextActuators[na];
      copyStr(a.id, sizeof(a.id), o["component_id"] | "");
      a.gpio = (int8_t)(o["gpio"] | -1);
      a.activeLow = o["active_low"] | false;
      const char *initial = o["initial_state"] | "off";
      a.initialOn = strcmp(initial, "on") == 0;
      a.pulseMs = (uint16_t)(o["pulse_ms"] | 500);
      a.inputGpio = (int8_t)(o["physical_input_gpio"] | -1);
      a.state = a.initialOn;
      a.known = true;
      ++na;
    }
    for (JsonObject o : doc["sensors"].as<JsonArray>()) {
      if (ns >= kMaxComponents) break;
      Sensor &s = nextSensors[ns];
      copyStr(s.id, sizeof(s.id), o["component_id"] | "");
      copyStr(s.unit, sizeof(s.unit), o["unit"] | "");
      const char *iface = o["interface"] | "";
      const int gpio = o["gpio"] | -1;
      s.gpio = (int8_t)gpio;
      if (gpio >= 0 && (!strcmp(iface, "analog") || !strcmp(iface, "adc"))) {
        s.kind = SensorKind::Analog;
      } else if (gpio >= 0 && (!strcmp(iface, "digital") || !strcmp(iface, "gpio") || iface[0] == 0)) {
        s.kind = SensorKind::Digital;
      } else {
        // Bus sensors (I2C/1-wire/UART) need a driver that is not part of this
        // image. They are counted and reported instead of being faked as valid.
        s.kind = SensorKind::None;
        ++unsupported;
      }
      s.samplingS = (uint16_t)(o["sampling_interval_s"] | 30);
      s.reportingS = (uint16_t)(o["reporting_interval_s"] | 60);
      s.deltaThreshold = o["delta_threshold"] | 0.0f;
      s.minValid = o["min_valid"] | 0.0f;
      s.maxValid = o["max_valid"] | 0.0f;
      s.hasRange = o["min_valid"].is<float>() || o["min_valid"].is<int>() ||
                   o["max_valid"].is<float>() || o["max_valid"].is<int>();
      JsonObject transform = o["transform"].as<JsonObject>();
      if (!transform.isNull()) {
        s.scale = transform["scale"] | 1.0f;
        s.offset = transform["offset"] | 0.0f;
      }
      if (s.samplingS == 0) s.samplingS = 30;
      if (s.reportingS == 0) s.reportingS = s.samplingS;
      ++ns;
    }
    JsonArray automations = doc["local_automations"].as<JsonArray>();
    for (JsonObject rule : automations) {
      if (nr >= kMaxRules) break;
      JsonArray actions = rule["then"].as<JsonArray>();
      JsonArray conditions = rule["if"].as<JsonArray>();
      if (conditions.isNull() || conditions.size() == 0) continue;  // time-only rules stay in the cloud
      JsonObject condition = conditions[0];
      LocalRule &r = nextRules[nr];
      copyStr(r.sensor, sizeof(r.sensor), condition["sensor_slug"] | condition["component_id"] | "");
      const char *op = condition["op"] | "gt";
      r.op = !strcmp(op, "lt") ? RuleOp::Lt : !strcmp(op, "gte") ? RuleOp::Gte
           : !strcmp(op, "lte") ? RuleOp::Lte : !strcmp(op, "eq") ? RuleOp::Eq : RuleOp::Gt;
      r.threshold = condition["value"] | 0.0f;
      r.cooldownS = (uint16_t)(rule["cooldown_s"] | 30);
      const char *targetId = actions[0]["component_id"] | "";
      copyStr(r.actuator, sizeof(r.actuator), targetId);
      r.target = actions[0]["value"] | false;
      if (r.sensor[0] && r.actuator[0]) ++nr;
    }

    memcpy(actuators, nextActuators, sizeof(Actuator) * na);
    memcpy(sensors, nextSensors, sizeof(Sensor) * ns);
    memcpy(rules, nextRules, sizeof(LocalRule) * nr);
    actuatorCount = na;
    sensorCount = ns;
    ruleCount = nr;
    unsupportedCount = unsupported;
    configVersion = incoming;
    appliedVersion = incoming;
    return true;
  }

  static void copyStr(char *dst, size_t cap, const char *src) {
    if (!src) { dst[0] = 0; return; }
    size_t i = 0;
    while (src[i] && i + 1 < cap) { dst[i] = src[i]; ++i; }
    dst[i] = 0;
  }
};

/** Durable configuration: last known good document survives power loss. */
class ConfigStore {
 public:
  bool load(Preferences &nvs, JsonDocument &doc) {
    const String raw = nvs.getString(kNvsConfig, "");
    if (raw.isEmpty()) return false;
    const DeserializationError err = deserializeJson(doc, raw);
    return !err;
  }

  bool save(Preferences &nvs, const String &raw) {
    return nvs.putString(kNvsConfig, raw) > 0;
  }

  void clear(Preferences &nvs) { nvs.remove(kNvsConfig); }
};

}  // namespace hc
