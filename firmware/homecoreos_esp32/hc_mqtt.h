#pragma once
/**
 * MQTT transport for the controller.
 *
 * The ESP-IDF MQTT client is used instead of a hand-rolled reconnect loop because
 * it already provides: TLS with certificate verification, keepalive handling,
 * automatic reconnection with backoff, and a bounded outbox. This module only
 * adds HomecoreOS semantics on top: subscribe once per TCP session (so topics
 * are never duplicated), publish availability, and route inbound topic events.
 *
 * No MQTT event callback ever performs network I/O: it copies the message and
 * hands it to the main loop, so a slow handler cannot stall the client task.
 */
#include <Arduino.h>
#include <ArduinoJson.h>

#include "mqtt_client.h"

#include "hc_config.h"
#include "hc_time.h"

namespace hc {

enum class TopicKind : uint8_t { Command, Config, State, Telemetry, Availability };

struct Identity {
  String deviceId;
  String tenantId;
  String clientId;
  String username;
  String password;
  String broker;
  uint16_t port = HOMECOREOS_MQTT_PORT;
  bool complete() const {
    return deviceId.length() && tenantId.length() && clientId.length() &&
           username.length() && password.length() && broker.length();
  }
  void clear() {
    deviceId = tenantId = clientId = username = password = broker = "";
    port = HOMECOREOS_MQTT_PORT;
  }
};

struct InboundMessage {
  char topic[64] = {0};
  char *payload = nullptr;
  size_t length = 0;
};

class MqttLink {
 public:
  using MessageHandler = void (*)(const char *topic, const char *payload, size_t length);
  using LinkHandler = void (*)();

  ~MqttLink() { stop(); }

  void onMessage(MessageHandler handler) { messageHandler_ = handler; }
  void onConnected(LinkHandler handler) { connectedHandler_ = handler; }

  bool start(const Identity &identity) {
    stop();
    identity_ = identity;
    if (!identity_.complete()) return false;
    if (kCaMqtt[0] == '\0') {
      Serial.println("[homecoreos][mqtt] no broker certificate configured; refusing to connect");
      return false;
    }
    snprintf(commandTopic_, sizeof(commandTopic_), "v1/tenants/%s/devices/%s/command",
             identity_.tenantId.c_str(), identity_.deviceId.c_str());
    snprintf(configTopic_, sizeof(configTopic_), "v1/tenants/%s/devices/%s/config",
             identity_.tenantId.c_str(), identity_.deviceId.c_str());
    snprintf(stateTopic_, sizeof(stateTopic_), "v1/tenants/%s/devices/%s/state",
             identity_.tenantId.c_str(), identity_.deviceId.c_str());
    snprintf(telemetryTopic_, sizeof(telemetryTopic_), "v1/tenants/%s/devices/%s/telemetry",
             identity_.tenantId.c_str(), identity_.deviceId.c_str());
    snprintf(availabilityTopic_, sizeof(availabilityTopic_), "v1/tenants/%s/devices/%s/availability",
             identity_.tenantId.c_str(), identity_.deviceId.c_str());

    static char will[160];
    snprintf(will, sizeof(will), "{\"schema_version\":1,\"device_id\":\"%s\",\"status\":\"offline\"}",
             identity_.deviceId.c_str());

    esp_mqtt_client_config_t cfg = {};
    snprintf(brokerUrl_, sizeof(brokerUrl_), "mqtts://%s:%u", identity_.broker.c_str(),
             (unsigned)identity_.port);
    cfg.broker.address.uri = brokerUrl_;
    cfg.credentials.client_id = identity_.clientId.c_str();
    cfg.credentials.username = identity_.username.c_str();
    cfg.credentials.authentication.password = identity_.password.c_str();
    cfg.session.keepalive = 60;
    cfg.session.disable_clean_session = false;
    cfg.session.last_will.topic = availabilityTopic_;
    cfg.session.last_will.msg = will;
    cfg.session.last_will.msg_len = (int)strlen(will);
    cfg.session.last_will.qos = 1;
    cfg.session.last_will.retain = 0;
    cfg.network.reconnect_timeout_ms = 5000;
    cfg.network.disable_auto_reconnect = false;
    cfg.network.timeout_ms = 10000;
    cfg.buffer.size = 4096;
    cfg.buffer.out_size = 2048;
    cfg.task.stack_size = 6144;
    cfg.task.priority = 5;
    cfg.credentials.authentication.certificate = kCaMqtt;

    client_ = esp_mqtt_client_init(&cfg);
    if (!client_) return false;
    esp_mqtt_client_register_event(client_, MQTT_EVENT_ANY, &MqttLink::eventBridge, this);
    return esp_mqtt_client_start(client_) == ESP_OK;
  }

  void stop() {
    if (!client_) return;
    esp_mqtt_client_stop(client_);
    esp_mqtt_client_destroy(client_);
    client_ = nullptr;
    connected_ = false;
    subscribed_ = false;
  }

  bool connected() const { return connected_; }

  String publish(TopicKind kind, const char *payload, int qos = 1) {
    if (!client_ || !connected_) return "mqtt offline";
    const char *topic = topicFor(kind);
    if (!topic[0]) return "no topic";
    const int id = esp_mqtt_client_publish(client_, topic, payload, (int)strlen(payload), qos, 0);
    if (id < 0) return "publish failed";
    lastPublishOk_ = millis();
    return "";
  }

  const char *topicFor(TopicKind kind) const {
    switch (kind) {
      case TopicKind::Command: return commandTopic_;
      case TopicKind::Config: return configTopic_;
      case TopicKind::State: return stateTopic_;
      case TopicKind::Telemetry: return telemetryTopic_;
      case TopicKind::Availability: return availabilityTopic_;
    }
    return "";
  }

  uint32_t connectedSinceMs() const { return connectedAtMs_; }

 private:
  static void eventBridge(void *args, esp_event_base_t base, int32_t id, void *data) {
    auto *self = static_cast<MqttLink *>(args);
    auto *event = static_cast<esp_mqtt_event_handle_t>(data);
    self->handle(base, id, event);
  }

  void handle(esp_event_base_t, int32_t id, esp_mqtt_event_handle_t event) {
    switch ((esp_mqtt_event_id_t)id) {
      case MQTT_EVENT_CONNECTED:
        connected_ = true;
        connectedAtMs_ = millis();
        if (!subscribed_) {
          esp_mqtt_client_subscribe(client_, commandTopic_, 1);
          esp_mqtt_client_subscribe(client_, configTopic_, 1);
          subscribed_ = true;
        }
        if (connectedHandler_) connectedHandler_();
        break;
      case MQTT_EVENT_DISCONNECTED:
        connected_ = false;
        subscribed_ = false;
        break;
      case MQTT_EVENT_DATA:
        handleData(event);
        break;
      case MQTT_EVENT_ERROR:
        lastError_ = millis();
        break;
      default:
        break;
    }
  }

  /** Reassembles messages that arrive in fragments without blocking the task. */
  void handleData(esp_mqtt_event_handle_t event) {
    const int total = event->total_data_len;
    const int offset = event->current_data_offset;
    if (!event->topic || !event->topic_len) return;
    if (total > (int)kMaxPayloadBytes) return;
    if (offset == 0) {
      scratchLen_ = 0;
      copyTopic(event->topic, event->topic_len);
    }
    if (scratchLen_ + (size_t)event->data_len >= sizeof(scratch_)) return;
    memcpy(scratch_ + scratchLen_, event->data, (size_t)event->data_len);
    scratchLen_ += (size_t)event->data_len;
    if ((int)scratchLen_ >= total || total <= event->data_len) {
      scratch_[scratchLen_] = 0;
      if (messageHandler_) messageHandler_(scratchTopic_, scratch_, scratchLen_);
      scratchLen_ = 0;
    }
  }

  void copyTopic(const char *topic, int length) {
    const size_t n = (size_t)length < sizeof(scratchTopic_) - 1 ? (size_t)length : sizeof(scratchTopic_) - 1;
    memcpy(scratchTopic_, topic, n);
    scratchTopic_[n] = 0;
  }

  esp_mqtt_client_handle_t client_ = nullptr;
  Identity identity_;
  bool connected_ = false;
  bool subscribed_ = false;
  uint32_t connectedAtMs_ = 0;
  uint32_t lastError_ = 0;
  uint32_t lastPublishOk_ = 0;
  MessageHandler messageHandler_ = nullptr;
  LinkHandler connectedHandler_ = nullptr;
  char brokerUrl_[160] = {0};
  char commandTopic_[96] = {0};
  char configTopic_[96] = {0};
  char stateTopic_[96] = {0};
  char telemetryTopic_[96] = {0};
  char availabilityTopic_[96] = {0};
  char scratch_[kMaxPayloadBytes] = {0};
  char scratchTopic_[64] = {0};
  size_t scratchLen_ = 0;
};

}  // namespace hc
