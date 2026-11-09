#pragma once
/**
 * MQTT topic helpers with no Arduino or ESP-IDF dependency, so they can be tested
 * on the host (scripts/firmware/verify_mqtt_topics.cpp).
 *
 * The device topics are v1/tenants/<36-char home id>/devices/<device id>/<kind>,
 * which is about 80 characters. The inbound buffer must hold the whole topic.
 * A topic that does not fit is rejected: truncating it would make a command or
 * config message fail to match and be silently ignored.
 */
#include <cstddef>
#include <cstdio>
#include <cstring>

namespace hc {

/** Longest inbound topic accepted. Covers the longest device topic with headroom. */
constexpr size_t kInboundTopicBytes = 128;

/** Formats v1/tenants/<tenant>/devices/<device>/<kind>. False if it does not fit. */
inline bool formatDeviceTopic(char *out, size_t capacity, const char *tenant, const char *device,
                              const char *kind) {
  if (!out || capacity == 0 || !tenant || !device || !kind) return false;
  const int written = snprintf(out, capacity, "v1/tenants/%s/devices/%s/%s", tenant, device, kind);
  return written > 0 && static_cast<size_t>(written) < capacity;
}

/** Holds one inbound topic. Overlong topics are refused, never shortened. */
class InboundTopic {
 public:
  /** Copies the topic. Returns false, and holds nothing, if it would not fit. */
  bool set(const char *topic, size_t length) {
    valid_ = false;
    if (!topic || length == 0 || length >= kInboundTopicBytes) return false;
    memcpy(buffer_, topic, length);
    buffer_[length] = 0;
    valid_ = true;
    return true;
  }
  bool valid() const { return valid_; }
  const char *c_str() const { return buffer_; }
  /** True if this inbound topic is exactly the given topic. */
  bool equals(const char *topic) const { return valid_ && topic && strcmp(buffer_, topic) == 0; }

 private:
  char buffer_[kInboundTopicBytes] = {0};
  bool valid_ = false;
};

}  // namespace hc
