#pragma once
/**
 * Local runtime state: actuator application, local safety rules and the JSON
 * documents published to the broker. Everything here keeps working with no
 * internet connection; the cloud can only observe or request.
 */
#include <Arduino.h>
#include <ArduinoJson.h>

#include "hc_config.h"
#include "hc_gpio.h"
#include "hc_model.h"
#include "hc_time.h"

namespace hc {

class Runtime {
 public:
  explicit Runtime(DeviceModel &model) : model_(model) {}

  void applyInitialStates() {
    for (size_t i = 0; i < model_.actuatorCount; ++i) {
      Actuator &a = model_.actuators[i];
      const bool ok = driveActuator(a, a.initialOn);
      a.state = a.initialOn;
      a.known = ok;
    }
    lastSafetyMs_ = millis();
  }

  bool setActuator(const char *id, bool on, bool &known) {
    const int idx = model_.findActuator(id);
    if (idx < 0) { known = false; return false; }
    Actuator &a = model_.actuators[idx];
    const bool ok = driveActuator(a, on);
    a.state = on;
    a.known = ok;
    known = ok;
    return true;
  }

  bool actuatorState(const char *id) const {
    const int idx = model_.findActuator(id);
    return idx >= 0 && model_.actuators[idx].state;
  }

  /**
   * Sample sensors on their own cadence and run local rules. Never blocks and
   * never acts on an invalid reading.
   */
  void tickSafety() {
    const uint32_t now = millis();
    if (now - lastSafetyMs_ < 250) return;
    lastSafetyMs_ = now;

    for (size_t i = 0; i < model_.sensorCount; ++i) {
      Sensor &s = model_.sensors[i];
      if (s.kind == SensorKind::None) continue;
      if (s.lastSampleMs && now - s.lastSampleMs < (uint32_t)s.samplingS * 1000UL) continue;
      s.lastSampleMs = now;
      float value = 0;
      if (!readSensorSample(s, value)) { s.hasLast = false; continue; }
      s.lastValue = value;
      s.hasLast = true;
      if (s.lastReportMs == 0) s.lastReportMs = now;
    }

    for (size_t r = 0; r < model_.ruleCount; ++r) {
      LocalRule &rule = model_.rules[r];
      const int sIdx = model_.findSensor(rule.sensor);
      const int aIdx = model_.findActuator(rule.actuator);
      if (sIdx < 0 || aIdx < 0) continue;
      Sensor &sensor = model_.sensors[sIdx];
      if (!sensor.hasLast) continue;
      const float v = sensor.lastValue;
      bool trigger = false;
      switch (rule.op) {
        case RuleOp::Gt: trigger = v > rule.threshold; break;
        case RuleOp::Gte: trigger = v >= rule.threshold; break;
        case RuleOp::Lt: trigger = v < rule.threshold; break;
        case RuleOp::Lte: trigger = v <= rule.threshold; break;
        case RuleOp::Eq: trigger = fabsf(v - rule.threshold) < 0.001f; break;
      }
      if (!trigger) { rule.fired = false; continue; }
      if (rule.fired && now - rule.lastFiredMs < (uint32_t)rule.cooldownS * 1000UL) continue;
      rule.fired = true;
      rule.lastFiredMs = now;
      Actuator &a = model_.actuators[aIdx];
      if (a.state == rule.target) continue;
      a.known = driveActuator(a, rule.target);
      a.state = rule.target;
      dirty_ = true;
    }
  }

  bool takeDirty() {
    const bool was = dirty_;
    dirty_ = false;
    return was;
  }

  void markDirty() { dirty_ = true; }

  void writeState(JsonDocument &doc, const char *availability) const {
    doc.clear();
    doc["schema_version"] = 1;
    doc["device_id"] = deviceId_;
    doc["timestamp"] = epochNow();
    doc["config_version"] = model_.appliedVersion;
    doc["availability"] = availability;
    doc["firmware_version"] = kFirmwareVersion;
    JsonObject devices = doc["devices"].to<JsonObject>();
    for (size_t i = 0; i < model_.actuatorCount; ++i) {
      const Actuator &a = model_.actuators[i];
      JsonObject o = devices[a.id].to<JsonObject>();
      o["state"] = !a.known ? "unknown" : (a.state ? "on" : "off");
      o["source"] = "gpio";
    }
  }

  /** Telemetry respects per-sensor reporting intervals and delta thresholds. */
  void writeTelemetry(JsonDocument &doc, bool force) const {
    doc.clear();
    doc["schema_version"] = 1;
    doc["device_id"] = deviceId_;
    doc["timestamp"] = epochNow();
    doc["config_version"] = model_.appliedVersion;
    JsonObject sensors = doc["sensors"].to<JsonObject>();
    const uint32_t now = millis();
    for (size_t i = 0; i < model_.sensorCount; ++i) {
      const Sensor &s = model_.sensors[i];
      if (!s.hasLast || s.kind == SensorKind::None) continue;
      const bool due = s.lastReportMs == 0 ||
                       (now - s.lastReportMs) >= (uint32_t)s.reportingS * 1000UL;
      const bool changed = s.deltaThreshold > 0 && fabsf(s.lastValue - s.lastValue) > s.deltaThreshold;
      if (!force && !due && !changed) continue;
      JsonObject o = sensors[s.id].to<JsonObject>();
      o["value"] = roundf(s.lastValue * 100.0f) / 100.0f;
      o["unit"] = s.unit;
      o["status"] = "valid";
      const_cast<Sensor &>(s).lastReportMs = now;
    }
  }

  void setIdentity(const String &deviceId) { deviceId_ = deviceId; }

 private:
  DeviceModel &model_;
  String deviceId_;
  uint32_t lastSafetyMs_ = 0;
  bool dirty_ = false;
};

}  // namespace hc
