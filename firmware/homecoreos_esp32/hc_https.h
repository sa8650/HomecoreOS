#pragma once
/**
 * HTTPS client with strict certificate verification.
 *
 * Two trust anchors are used and they are not interchangeable:
 *  - the HomecoreOS API origin (Cloudflare Pages, currently Let's Encrypt)
 *  - the EMQX deployment (DigiCert)
 * Both are supplied at build time. Nothing here disables verification and there
 * is no insecure fallback: without an injected CA the request is refused.
 */
#include <Arduino.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>

#include "hc_config.h"
#include "hc_time.h"

namespace hc {

class HttpsClient {
 public:
  struct Result {
    int status = 0;
    String body;
    String error;
    bool ok() const { return status >= 200 && status < 300 && error.isEmpty(); }
  };

  static bool apiTrusted() { return kCaApi[0] != '\0'; }
  static bool mqttTrusted() { return kCaMqtt[0] != '\0'; }

  /** POST a JSON body to the HomecoreOS API and return the verified response. */
  static Result post(const String &path, const String &json, uint32_t timeoutMs = kHttpTimeoutMs) {
    Result out;
    if (!cloudConfigured()) { out.error = "API endpoint is not configured in this build"; return out; }
    if (!apiTrusted()) { out.error = "API certificate is not configured in this build"; return out; }
    String url = String(kApiBase) + path;
    WiFiClientSecure client;
    client.setCACert(kCaApi);
    client.setTimeout(timeoutMs / 1000);
    HTTPClient http;
    http.setConnectTimeout(timeoutMs);
    http.setTimeout(timeoutMs);
    http.setReuse(false);
    http.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);
    if (!http.begin(client, url)) { out.error = "Could not open a TLS connection to the API"; return out; }
    http.addHeader("Content-Type", "application/json");
    http.addHeader("Accept", "application/json");
    out.status = http.POST(json);
    if (out.status > 0) out.body = http.getString();
    else out.error = String("TLS/HTTP error ") + HTTPClient::errorToString(out.status);
    http.end();
    return out;
  }

  /** Same transport, kept separate so MQTT trust can never be used for the API. */
  static bool mqttAnchored(WiFiClientSecure &client) {
    if (!mqttTrusted()) return false;
    client.setCACert(kCaMqtt);
    return true;
  }
};

}  // namespace hc
