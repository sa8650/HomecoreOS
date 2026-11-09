// Host test for the controller's MQTT topic handling (firmware/homecoreos_esp32/hc_topic.h).
//
// The inbound topic buffer used to hold 64 bytes. A real command or config topic is
// about 80 bytes, so the topic was truncated, the match failed, and commands and
// configuration were silently ignored. This test pins the behaviour that fixes it.
//
//   g++ -std=c++17 -I firmware/homecoreos_esp32 scripts/firmware/verify_mqtt_topics.cpp -o /tmp/hc_topics_test
//   /tmp/hc_topics_test

#include <cstdio>
#include <cstring>
#include <string>

#include "hc_topic.h"

static int failures = 0;

static void check(bool ok, const char *name) {
  std::printf("%s  %s\n", ok ? "PASS" : "FAIL", name);
  if (!ok) ++failures;
}

int main() {
  // A real home id (UUID) and a real controller device id ("hcd-" + 12 hex digits).
  const char *tenant = "fca41781-67f8-4d14-98d3-a00ad4565fab";
  const char *device = "hcd-d2bbd66a59a5";

  char command[hc::kInboundTopicBytes];
  check(hc::formatDeviceTopic(command, sizeof(command), tenant, device, "command"),
        "device command topic is formatted");
  check(std::strcmp(command, "v1/tenants/fca41781-67f8-4d14-98d3-a00ad4565fab/devices/hcd-d2bbd66a59a5/command") == 0,
        "device command topic has the contract shape");
  check(std::strlen(command) > 64, "a real command topic is longer than the old 64-byte buffer");

  hc::InboundTopic inbound;
  check(inbound.set(command, std::strlen(command)), "a real command topic is accepted whole");
  check(inbound.equals(command), "an accepted topic matches the expected topic exactly");

  char config[hc::kInboundTopicBytes];
  hc::formatDeviceTopic(config, sizeof(config), tenant, device, "config");
  check(!inbound.equals(config), "a different topic does not match");

  // The old 64-byte truncation produced a different string, so the match failed.
  char truncated[65];
  std::memcpy(truncated, command, 64);
  truncated[64] = 0;
  check(std::strcmp(truncated, command) != 0, "a 64-byte truncation no longer equals the real topic (old bug)");

  // Overlong topics are refused, never shortened.
  std::string huge(hc::kInboundTopicBytes, 'x');
  check(!inbound.set(huge.c_str(), huge.size()), "a topic at the buffer limit is refused");
  check(!inbound.valid() && !inbound.equals(command), "a refused topic leaves nothing to match");

  // A failed set after a good one must not leave the old topic usable.
  inbound.set(command, std::strlen(command));
  inbound.set(huge.c_str(), huge.size());
  check(!inbound.valid(), "an overlong topic invalidates the previous one");

  check(!inbound.set(nullptr, 5), "a null topic is refused");
  check(!inbound.set(command, 0), "an empty topic is refused");

  // Formatting refuses when the output would not fit.
  char tiny[32];
  check(!hc::formatDeviceTopic(tiny, sizeof(tiny), tenant, device, "command"),
        "formatting into a too-small buffer fails instead of truncating");
  check(!hc::formatDeviceTopic(nullptr, 10, tenant, device, "command"), "formatting into null fails");

  // The longest topic the platform could create still fits.
  char kind[] = "availability";
  char longest[hc::kInboundTopicBytes];
  check(hc::formatDeviceTopic(longest, sizeof(longest), tenant, device, kind),
        "the longest device topic fits in the inbound buffer");

  std::printf("\n%s\n", failures ? "FAILED" : "ALL PASSED");
  return failures ? 1 : 0;
}
