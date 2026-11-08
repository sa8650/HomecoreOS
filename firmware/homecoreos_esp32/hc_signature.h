#pragma once
/**
 * Firmware authenticity verification.
 *
 * The backend signs each release's SHA-256 digest. The controller verifies that
 * signature with a public key injected at build time, so a compromised storage
 * bucket or a stolen signed download URL cannot deliver a modified image.
 *
 * The release package signs the lowercase-hex SHA-256 digest of the application
 * image, so the same 64-character digest is both the transport checksum and the
 * signed value. Two algorithms are supported:
 *
 *   ed25519            verified by hc_ed25519.h (no mbedtls curve support needed)
 *   ecdsa-p256-sha256  verified by mbedtls_pk, the default of earlier releases
 *
 * The ESP32 mbedtls build has no Ed25519, so releases are signed with Ed25519 and
 * checked by the small portable verifier instead. When no key is configured,
 * `signingConfigured()` is false and callers must treat the image as
 * unauthenticated rather than assuming it is valid.
 */
#include <Arduino.h>

#include "hc_base64.h"
#include "hc_config.h"
#include "hc_ed25519.h"
#include "mbedtls/md.h"
#include "mbedtls/pk.h"

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

/** Ed25519: the key is the raw 32-byte public key, base64 encoded. */
inline bool verifyEd25519Digest(const char *digestHex, const char *signatureB64) {
  uint8_t key[32];
  size_t keyLen = 0;
  if (!b64Decode(kSigningPublicKey, strlen(kSigningPublicKey), key, sizeof(key), &keyLen)) return false;
  if (keyLen != sizeof(key)) return false;
  uint8_t sig[64];
  size_t sigLen = 0;
  if (!b64Decode(signatureB64, strlen(signatureB64), sig, sizeof(sig), &sigLen)) return false;
  if (sigLen != sizeof(sig)) return false;
  // The signed message is the digest text exactly as it travels in the manifest.
  return ed25519::verify(sig, key, reinterpret_cast<const uint8_t *>(digestHex), strlen(digestHex));
}

/** ECDSA P-256: the key is a DER SubjectPublicKeyInfo, base64 encoded. */
inline bool verifyEcdsaDigest(const char *digestHex, const char *signatureB64) {
  uint8_t keyBytes[128];
  size_t keyLen = 0;
  if (!b64Decode(kSigningPublicKey, strlen(kSigningPublicKey), keyBytes, sizeof(keyBytes), &keyLen)) return false;
  uint8_t sig[96];
  size_t sigLen = 0;
  if (!b64Decode(signatureB64, strlen(signatureB64), sig, sizeof(sig), &sigLen)) return false;

  mbedtls_pk_context pk;
  mbedtls_pk_init(&pk);
  bool ok = false;
  if (mbedtls_pk_parse_public_key(&pk, keyBytes, keyLen) == 0) {
    uint8_t hash[32];
    size_t hashLen = 0;
    if (hexToBytes(digestHex, hash, sizeof(hash), &hashLen) && hashLen == 32) {
      ok = mbedtls_pk_verify(&pk, MBEDTLS_MD_SHA256, hash, sizeof(hash), sig, sigLen) == 0;
    }
  }
  mbedtls_pk_free(&pk);
  return ok;
}

/** Verify a release signature over the lowercase-hex SHA-256 digest string. */
inline bool verifyDigestSignature(const char *digestHex, const char *signatureB64) {
  if (!signingConfigured()) return false;
  if (!digestHex || strlen(digestHex) != 64) return false;
  if (!signatureB64 || !signatureB64[0]) return false;
  if (strcmp(kSigningAlg, "ed25519") == 0) return verifyEd25519Digest(digestHex, signatureB64);
  if (strcmp(kSigningAlg, "ecdsa-p256-sha256") == 0) return verifyEcdsaDigest(digestHex, signatureB64);
  return false;
}

}  // namespace hc
