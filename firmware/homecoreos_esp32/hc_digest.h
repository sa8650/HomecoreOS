#pragma once
/**
 * SHA-256 over a streamed image.
 *
 * The controller verifies the SHA-256 digest of every firmware image it
 * downloads, before the image is written to the inactive slot and before it is
 * booted into. That digest is the only integrity check an update relies on, so
 * this is the one place the hashing lives.
 */
#include <Arduino.h>

#include "hc_base64.h"
#include "mbedtls/md.h"

namespace hc {

struct Digest {
  uint8_t bytes[32];
  bool ready = false;
};

class Sha256 {
 public:
  Sha256() { reset(); }
  ~Sha256() { mbedtls_md_free(&ctx_); }
  void reset() {
    if (active_) mbedtls_md_free(&ctx_);
    mbedtls_md_init(&ctx_);
    if (mbedtls_md_setup(&ctx_, mbedtls_md_info_from_type(MBEDTLS_MD_SHA256), 0) != 0) {
      active_ = false;
      return;
    }
    mbedtls_md_starts(&ctx_);
    active_ = true;
    finished_ = false;
  }
  bool update(const uint8_t *data, size_t len) {
    if (!active_ || finished_) return false;
    return mbedtls_md_update(&ctx_, data, len) == 0;
  }
  bool finish(Digest &out) {
    if (!active_ || finished_) return false;
    finished_ = true;
    return mbedtls_md_finish(&ctx_, out.bytes) == 0 ? (out.ready = true) : false;
  }
  static String hex(const Digest &d) {
    String s;
    s.reserve(64);
    for (size_t i = 0; i < sizeof(d.bytes); ++i) {
      char b[3];
      snprintf(b, sizeof(b), "%02x", d.bytes[i]);
      s += b;
    }
    return s;
  }
  static bool fromHex(const String &hex, Digest &out) {
    size_t n = 0;
    if (!hexToBytes(hex.c_str(), out.bytes, sizeof(out.bytes), &n)) return false;
    if (n != sizeof(out.bytes)) return false;
    out.ready = true;
    return true;
  }
  static Digest of(const uint8_t *data, size_t len) {
    Digest d;
    Sha256 h;
    if (h.update(data, len)) h.finish(d);
    return d;
  }

 private:
  mbedtls_md_context_t ctx_{};
  bool active_ = false;
  bool finished_ = false;
};

}  // namespace hc
