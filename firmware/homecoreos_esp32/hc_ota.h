#pragma once
/**
 * Over-the-air updates, stepped rather than blocking.
 *
 * The download is advanced in small slices from the main loop so that sensor
 * sampling, local safety rules and actuator commands keep running while an
 * image is being written. Invariants this implementation never breaks:
 *
 *  - the image is written to the *inactive* OTA slot; the running firmware is
 *    untouched until the new one is verified and selected;
 *  - the release SHA-256 is enforced while streaming, and when a signing key is
 *    configured the manifest signature must verify over that digest;
 *  - "installed" is published when the slot is verified and selected. "success"
 *    is published only after the new image boots and reconnects (see main);
 *  - any error aborts the update, keeps the running image and is reported.
 */
#include <Arduino.h>
#include <HTTPClient.h>
#include <Update.h>
#include <WiFiClientSecure.h>
#include <ArduinoJson.h>
#include "esp_ota_ops.h"

#include "hc_config.h"
#include "hc_https.h"
#include "hc_signature.h"

namespace hc {

struct OtaRequest {
  String url;
  String sha256;
  String signature;
  String version;
  uint32_t size = 0;
};

enum class OtaPhase : uint8_t { Idle, Opening, Streaming, Verifying, Installed, Failed };

class OtaEngine {
 public:
  OtaPhase phase() const { return phase_; }
  bool busy() const { return phase_ == OtaPhase::Opening || phase_ == OtaPhase::Streaming; }
  const String &error() const { return error_; }
  const String &version() const { return request_.version; }
  uint8_t percent() const { return percent_; }
  uint32_t bytesDone() const { return written_; }
  uint32_t bytesTotal() const { return request_.size ? request_.size : declared_; }

  /** Queue an update. Rejects untrustworthy manifests before any byte is written. */
  bool queue(const OtaRequest &req, String &error) {
    if (busy()) { error = "an update is already running"; return false; }
    if (req.url.isEmpty()) { error = "no download URL supplied"; return false; }
    if (!req.url.startsWith("https://")) { error = "refusing a non-HTTPS firmware URL"; return false; }
    if (req.sha256.length() != 64) { error = "the release digest is missing"; return false; }
    if (!HttpsClient::apiTrusted()) { error = "no certificate is configured for the download host"; return false; }
    if (signingConfigured() && !verifyDigestSignature(req.sha256.c_str(), req.signature.c_str())) {
      error = "the release signature is missing or invalid";
      return false;
    }
    const esp_partition_t *slot = esp_ota_get_next_update_partition(nullptr);
    if (!slot) { error = "no inactive OTA slot is available"; return false; }
    if (req.size && req.size > slot->size) { error = "the image does not fit in the OTA slot"; return false; }
    request_ = req;
    phase_ = OtaPhase::Opening;
    error_ = "";
    written_ = 0;
    percent_ = 0;
    declared_ = 0;
    startedMs_ = millis();
    return true;
  }

  /** Advance the update by at most `maxBytes`. Cheap when idle. */
  void step(size_t maxBytes = 8192) {
    if (phase_ == OtaPhase::Opening) openTransport();
    if (phase_ == OtaPhase::Streaming) pump(maxBytes);
  }

  void reset() {
    if (phase_ == OtaPhase::Failed || phase_ == OtaPhase::Installed) {
      phase_ = OtaPhase::Idle;
      error_ = "";
    }
  }

  /** Called after boot to know whether the running image still needs to prove itself. */
  static bool pendingVerification() {
    const esp_partition_t *running = esp_ota_get_running_partition();
    esp_ota_img_states_t state;
    if (!running || esp_ota_get_state_partition(running, &state) != ESP_OK) return false;
    return state == ESP_OTA_IMG_PENDING_VERIFY;
  }

  static bool markHealthy() { return esp_ota_mark_app_valid_cancel_rollback() == ESP_OK; }

  /** Hands the previous image back and reboots. The bootloader owns the retry. */
  static bool rollBackAndRestart() {
#if defined(ESP_IDF_VERSION_MAJOR) && ESP_IDF_VERSION_MAJOR >= 5
    return esp_ota_mark_app_invalid_rollback_and_reboot() == ESP_OK;
#else
    return esp_ota_mark_app_invalid_rollback_and_restart() == ESP_OK;
#endif
  }

  /**
   * Version of the running image. The ESP-IDF descriptor carries the build hash of
   * the precompiled Arduino core rather than the release version, so the compiled
   * version is reported instead; it is what the build stamped into this image.
   */
  static String runningVersion() { return String(kFirmwareVersion); }

 private:
  void fail(const String &message) {
    if (http_.connected()) http_.end();
    if (phase_ == OtaPhase::Streaming || phase_ == OtaPhase::Verifying) Update.abort();
    phase_ = OtaPhase::Failed;
    error_ = message;
    Serial.printf("[homecoreos][ota] %s\n", message.c_str());
  }

  void openTransport() {
    if (!HttpsClient::apiTrusted()) { fail("no certificate is configured"); return; }
    client_.setCACert(kCaApi);
    client_.setTimeout(kOtaIdleTimeoutMs / 1000);
    http_.setConnectTimeout(kOtaIdleTimeoutMs);
    http_.setTimeout(kOtaIdleTimeoutMs);
    http_.setReuse(false);
    http_.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);
    if (!http_.begin(client_, request_.url)) { fail("could not open a TLS connection to the download host"); return; }
    const int code = http_.GET();
    if (code != 200) { fail(String("download failed with HTTP ") + code); return; }
    const int size = http_.getSize();
    declared_ = size > 0 ? (uint32_t)size : 0;
    if (request_.size && declared_ && declared_ != request_.size) {
      fail("the download size does not match the release manifest");
      return;
    }
    const size_t total = request_.size ? request_.size : (declared_ ? declared_ : UPDATE_SIZE_UNKNOWN);
    if (!Update.begin(total, U_FLASH)) { fail(String("could not open the OTA slot: ") + Update.errorString()); return; }
    hasher_.reset();
    stream_ = http_.getStreamPtr();
    phase_ = OtaPhase::Streaming;
    lastDataMs_ = millis();
  }

  void pump(size_t maxBytes) {
    if (!stream_) { fail("the download stream was lost"); return; }
    uint8_t buffer[1024];
    size_t consumed = 0;
    while (consumed < maxBytes) {
      const size_t available = stream_->available();
      if (available == 0) {
        if (!http_.connected() && stream_->available() == 0) break;
        if (request_.size && written_ >= request_.size) break;
        if (declared_ && written_ >= declared_) break;
        if (millis() - lastDataMs_ > kOtaIdleTimeoutMs) { fail("the download stalled"); return; }
        break;
      }
      const size_t want = available < sizeof(buffer) ? available : sizeof(buffer);
      const int read = stream_->readBytes(buffer, want);
      if (read <= 0) break;
      lastDataMs_ = millis();
      if (!hasher_.update(buffer, (size_t)read)) { fail("the checksum engine failed"); return; }
      if (Update.write(buffer, (size_t)read) != (size_t)read) {
        fail(String("flash write failed: ") + Update.errorString());
        return;
      }
      written_ += (uint32_t)read;
      consumed += (size_t)read;
      const uint32_t total = bytesTotal();
      if (total) {
        const uint8_t p = (uint8_t)((uint64_t)written_ * 100ULL / total);
        if (p > percent_) percent_ = p;
      }
      if (total && written_ >= total) break;
    }
    const uint32_t total = bytesTotal();
    if (total && written_ >= total) finish();
  }

  void finish() {
    phase_ = OtaPhase::Verifying;
    http_.end();
    Digest digest;
    if (!hasher_.finish(digest)) { fail("could not finish the checksum"); return; }
    const String actual = Sha256::hex(digest);
    if (!actual.equalsIgnoreCase(request_.sha256)) {
      fail("the downloaded image does not match the release checksum");
      return;
    }
    if (signingConfigured() && !verifyDigestSignature(actual.c_str(), request_.signature.c_str())) {
      fail("the downloaded image is not signed for this controller");
      return;
    }
    if (!Update.end(true)) { fail(String("could not finalise the update: ") + Update.errorString()); return; }
    const esp_partition_t *next = esp_ota_get_next_update_partition(nullptr);
    if (!next || esp_ota_set_boot_partition(next) != ESP_OK) {
      fail("the new image could not be selected for boot");
      return;
    }
    percent_ = 100;
    phase_ = OtaPhase::Installed;
  }

  OtaPhase phase_ = OtaPhase::Idle;
  OtaRequest request_;
  String error_;
  Sha256 hasher_;
  WiFiClientSecure client_;
  HTTPClient http_;
  WiFiClient *stream_ = nullptr;
  uint32_t written_ = 0;
  uint32_t declared_ = 0;
  uint32_t startedMs_ = 0;
  uint32_t lastDataMs_ = 0;
  uint8_t percent_ = 0;
};

}  // namespace hc
