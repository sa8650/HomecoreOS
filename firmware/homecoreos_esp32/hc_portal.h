#pragma once
/**
 * Local setup portal (captive-AP).
 *
 * Used only when the controller has no usable Wi-Fi or has not been paired yet.
 * The portal never sees a customer password for HomecoreOS and never stores the
 * six-digit code in plain text beyond the redemption window: the code lives in a
 * single NVS slot, is cleared as soon as it is redeemed or rejected for good.
 *
 * It stays local: no router port forwarding, no inbound cloud connection.
 */
#include <Arduino.h>
#include <DNSServer.h>
#include <WebServer.h>
#include <WiFi.h>

#include "hc_config.h"
#include "hc_image.h"
#include "hc_lifecycle.h"
#include "hc_time.h"

namespace hc {

class SetupPortal {
 public:
  /** Checks the PIN typed on the portal. Supplied by the sketch, which owns the lockout state. */
  using PinCheckFn = PinResult (*)(const String &pin);

  struct SavedCredentials {
    String ssid;
    String password;
    String code;
    bool valid = false;
  };

  void setPinCheck(PinCheckFn fn) { pinCheck_ = fn; }

  /**
   * Opens the portal. The station keeps its connection (AP+STA), so a Wi-Fi change
   * does not cut the cloud link before the new details are known to work.
   * bypassPin is set only when a person pressed the BOOT button on the controller.
   */
  void begin(const String &apSuffix, bool bypassPin = false) {
    WiFi.mode(WIFI_AP_STA);
    bypassPin_ = bypassPin;
    const String ssid = String("HomecoreOS-Setup-") + apSuffix;
    WiFi.softAP(ssid.c_str());
    dns_.start(53, "*", WiFi.softAPIP());
    server_.on("/", HTTP_GET, [this]() { sendPage(indexHtml()); });
    server_.on("/save", HTTP_POST, [this]() { handleSave(); });
    server_.on("/status", HTTP_GET, [this]() { handleStatus(); });
    server_.on("/recovery", HTTP_GET, [this]() { sendPage(recoveryHtml()); });
    server_.onNotFound([this]() { sendPage(indexHtml()); });
    server_.begin();
    started_ = true;
    lastActivityMs_ = millis();
    Serial.printf("[homecoreos][portal] soft AP %s ready\n", ssid.c_str());
  }

  void stop() {
    if (!started_) return;
    server_.stop();
    dns_.stop();
    WiFi.softAPdisconnect(true);
    started_ = false;
    bypassPin_ = false;
  }

  bool active() const { return started_; }
  bool pinBypassed() const { return bypassPin_; }
  uint32_t lastActivityMs() const { return lastActivityMs_; }

  void tick() {
    if (!started_) return;
    dns_.processNextRequest();
    server_.handleClient();
  }

  /** True once the customer submitted Wi-Fi details; the caller leaves the AP. */
  bool submitted() const { return saved_.valid; }
  SavedCredentials takeSaved() {
    SavedCredentials out = saved_;
    saved_ = SavedCredentials();
    return out;
  }

  /** Called by main with the live state so the page has no invented values. */
  struct StatusSource {
    String firmwareVersion;
    String deviceId;
    String wifiState;
    String mac;
    bool hasWifi = false;
    bool paired = false;
    bool pinRequired = false;
    uint32_t secondsLeftForCode = 0;
  };
  StatusSource source;

 private:
  void handleSave() {
    touch();
    String ssid = server_.arg("ssid");
    String password = server_.arg("password");
    String code = server_.arg("code");
    const String pin = server_.arg("pin");
    code.trim();
    ssid.trim();
    // A paired controller only changes Wi-Fi for someone who knows the setup PIN.
    // The BOOT-button session is local, physical access, and skips the check.
    if (source.pinRequired && !bypassPin_ && pinCheck_) {
      const PinResult r = pinCheck_(pin);
      if (r == PinResult::Locked) {
        sendPage(messagePage("Too many attempts", "Wait ten minutes, then try the setup PIN again."));
        return;
      }
      if (r == PinResult::Rejected) {
        sendPage(messagePage("Setup PIN not accepted", "The setup PIN did not match, or no PIN is set yet. A PIN is set from the HomecoreOS console; go back and try again."));
        return;
      }
    }
    if (ssid.length() == 0) {
      sendPage(messagePage("Wi-Fi network required", "Choose your home Wi-Fi network and try again."));
      return;
    }
    if (code.length() != 0 && code.length() != 6) {
      sendPage(messagePage("Check the pairing code", "The pairing code is exactly six digits. Leave it empty if you only want to change Wi-Fi."));
      return;
    }
    saved_.ssid = ssid;
    saved_.password = password;
    saved_.code = code;
    saved_.valid = true;
    sendPage(messagePage("Saved", "The controller is now joining your Wi-Fi. You can close this page."));
  }

  void handleStatus() {
    touch();
    JsonDocument doc;
    doc["firmware_version"] = source.firmwareVersion;
    doc["device_id"] = source.deviceId;
    doc["wifi"] = source.wifiState;
    doc["mac"] = source.mac;
    doc["has_wifi"] = source.hasWifi;
    doc["paired"] = source.paired;
    doc["pin_required"] = source.pinRequired && !bypassPin_;
    doc["code_seconds_left"] = source.secondsLeftForCode;
    String body;
    serializeJson(doc, body);
    server_.send(200, "application/json", body);
  }

  void sendPage(const String &html) {
    touch();
    server_.send(200, "text/html; charset=utf-8", html);
  }

  void touch() { lastActivityMs_ = millis(); }

  static String shell(const String &title, const String &body) {
    String html = F("<!doctype html><html lang=en><meta charset=utf-8>"
                    "<meta name=viewport content='width=device-width,initial-scale=1'>"
                    "<title>HomecoreOS setup</title><style>"
                    ":root{color-scheme:light dark}"
                    "body{margin:0;padding:24px;font:15px/1.55 system-ui,-apple-system,'Segoe UI',sans-serif;"
                    "background:#0d1117;color:#e6edf3}"
                    ".card{max-width:460px;margin:0 auto;background:#161b22;border:1px solid #30363d;"
                    "border-radius:14px;padding:22px}"
                    "h1{font-size:19px;margin:0 0 6px}h2{font-size:15px;margin:22px 0 8px}"
                    "p{margin:0 0 14px;color:#9da7b3;font-size:13.5px}"
                    "label{display:block;font-size:12.5px;margin:14px 0 6px;color:#9da7b3}"
                    "input{width:100%;box-sizing:border-box;padding:11px 12px;border-radius:9px;"
                    "border:1px solid #30363d;background:#0d1117;color:#e6edf3;font-size:15px}"
                    "input:focus{outline:2px solid #4c8dff;outline-offset:1px}"
                    ".code{letter-spacing:.5em;font-size:22px;text-align:center;font-variant-numeric:tabular-nums}"
                    "button{width:100%;margin-top:18px;padding:12px;border:0;border-radius:9px;"
                    "background:#2f81f7;color:#fff;font-size:15px;font-weight:600}"
                    ".muted{color:#6e7681;font-size:12px;margin-top:14px}"
                    "a{color:#58a6ff}</style>");
    html += "<div class=card><h1>";
    html += title;
    html += "</h1>";
    html += body;
    html += "</div></html>";
    return html;
  }

  static String messagePage(const String &title, const String &text) {
    return shell(title, "<p>" + text + "</p><p class=muted>HomecoreOS controller</p>");
  }

  String indexHtml() const {
    String body;
    body += F("<p>Connect the controller to your home Wi-Fi, then enter the six-digit code from the HomecoreOS website.</p>");
    body += F("<form method=POST action=/save>");
    body += F("<label for=ssid>Home Wi-Fi network</label><input id=ssid name=ssid maxlength=32 required autocomplete=off>");
    body += F("<label for=password>Wi-Fi password</label><input id=password name=password type=password maxlength=64 autocomplete=off>");
    if (source.pinRequired && !bypassPin_) {
      body += F("<label for=pin>Setup PIN</label><input id=pin name=pin type=password inputmode=numeric "
               "maxlength=12 autocomplete=off>");
    }
    if (!source.paired) {
      body += F("<label for=code>Six-digit pairing code</label><input id=code name=code class=code inputmode=numeric "
               "pattern='[0-9]{6}' maxlength=6 placeholder='000000' autocomplete=one-time-code>");
    }
    body += F("<button type=submit>Save and connect</button></form>");
    body += F("<p class=muted>Firmware ");
    body += source.firmwareVersion;
    body += F(" &middot; ");
    body += source.wifiState;
    if (source.deviceId.length()) {
      body += F(" &middot; ");
      body += source.deviceId;
    }
    body += F("</p>");
    return shell("Set up this controller", body);
  }

  static String recoveryHtml() {
    return shell("Recovery", "<p>If the controller will not join Wi-Fi, enter its network details again here. "
                             "Your devices and home stay paired; only the network settings change.</p>"
                             "<p><a href=/>Back to setup</a></p>");
  }

  WebServer server_{80};
  DNSServer dns_;
  bool started_ = false;
  bool bypassPin_ = false;
  uint32_t lastActivityMs_ = 0;
  PinCheckFn pinCheck_ = nullptr;
  SavedCredentials saved_;
};

}  // namespace hc
