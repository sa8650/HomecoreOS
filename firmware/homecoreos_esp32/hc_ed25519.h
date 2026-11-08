#pragma once
/**
 * Ed25519 signature verification (RFC 8032), verification only.
 *
 * arduino-esp32 3.3.x ships mbedtls without Ed25519, so the group arithmetic is
 * included here. It is a port of TweetNaCl by Daniel J. Bernstein, Bernard van
 * Gastel, Wesley Janssen, Tanja Lange and Sjaak Smetsers (public domain,
 * http://tweetnacl.cr.yp.to), cut down to signature checking and using the
 * device's own SHA-512 instead of carrying a second one.
 *
 * Only verification exists on purpose: the private key never reaches a
 * controller, so there is no secret here that could leak, and a malformed key or
 * signature returns false instead of being treated as valid.
 *
 * Keys and signatures use the raw RFC 8032 encoding: a 32-byte public key and a
 * 64-byte signature holding R followed by S. HomecoreOS signs the lowercase-hex
 * SHA-256 digest of the image, so callers pass that digest string as the message.
 */
#include <stdint.h>
#include <string.h>

#include "mbedtls/sha512.h"

namespace hc {
namespace ed25519 {

typedef int64_t gf[16];

namespace detail {

const gf kZero = {0};
const gf kOne = {1};
const gf kD = {0x78a3, 0x1359, 0x4dca, 0x75eb, 0xd8ab, 0x4141, 0x0a4d, 0x0070,
               0xe898, 0x7779, 0x4079, 0x8cc7, 0xfe73, 0x2b6f, 0x6cee, 0x5203};
const gf kD2 = {0xf159, 0x26b2, 0x9b94, 0xebd6, 0xb156, 0x8283, 0x149a, 0x00e0,
                0xd130, 0xeef3, 0x80f2, 0x198e, 0xfce7, 0x56df, 0xd9dc, 0x2406};
const gf kX = {0xd51a, 0x8f25, 0x2d60, 0xc956, 0xa7b2, 0x9525, 0xc760, 0x692c,
               0xdc5c, 0xfdd6, 0xe231, 0xc0a4, 0x53fe, 0xcd6e, 0x36d3, 0x2169};
const gf kY = {0x6658, 0x6666, 0x6666, 0x6666, 0x6666, 0x6666, 0x6666, 0x6666,
               0x6666, 0x6666, 0x6666, 0x6666, 0x6666, 0x6666, 0x6666, 0x6666};
const gf kI = {0xa0b0, 0x4a0e, 0x1b27, 0xc4ee, 0xe478, 0xad2f, 0x1806, 0x2f43,
               0xd7a7, 0x3dfb, 0x0099, 0x2b4d, 0xdf0b, 0x4fc1, 0x2480, 0x2b83};

/** Group order L = 2^252 + 27742317777372353535851937790883648493, little-endian bytes. */
const uint8_t kL[32] = {0xed, 0xd3, 0xf5, 0x5c, 0x1a, 0x63, 0x12, 0x58,
                        0xd6, 0x9c, 0xf7, 0xa2, 0xde, 0xf9, 0xde, 0x14,
                        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x10};

inline void set25519(gf r, const gf a) { for (int i = 0; i < 16; i++) r[i] = a[i]; }

inline void car25519(gf o) {
  for (int i = 0; i < 16; i++) {
    o[i] += (int64_t)1 << 16;
    const int64_t c = o[i] >> 16;
    if (i < 15) o[i + 1] += c - 1;
    else o[0] += 38 * (c - 1);
    o[i] -= c << 16;
  }
}

inline void sel25519(gf p, gf q, int b) {
  const int64_t c = ~(int64_t)(b - 1);
  for (int i = 0; i < 16; i++) {
    const int64_t t = c & (p[i] ^ q[i]);
    p[i] ^= t;
    q[i] ^= t;
  }
}

inline void pack25519(uint8_t *o, const gf n) {
  gf m, t;
  for (int i = 0; i < 16; i++) t[i] = n[i];
  car25519(t); car25519(t); car25519(t);
  for (int j = 0; j < 2; j++) {
    m[0] = t[0] - 0xffed;
    for (int i = 1; i < 15; i++) {
      m[i] = t[i] - 0xffff - ((m[i - 1] >> 16) & 1);
      m[i - 1] &= 0xffff;
    }
    m[15] = t[15] - 0x7fff - ((m[14] >> 16) & 1);
    const int b = (int)((m[15] >> 16) & 1);
    m[14] &= 0xffff;
    sel25519(t, m, 1 - b);
  }
  for (int i = 0; i < 16; i++) {
    o[2 * i] = (uint8_t)(t[i] & 0xff);
    o[2 * i + 1] = (uint8_t)(t[i] >> 8);
  }
}

inline int vn(const uint8_t *x, const uint8_t *y, int n) {
  uint32_t d = 0;
  for (int i = 0; i < n; i++) d |= (uint32_t)(x[i] ^ y[i]);
  return (1 & ((d - 1) >> 8)) - 1;
}

inline int neq25519(const gf a, const gf b) {
  uint8_t c[32], d[32];
  pack25519(c, a);
  pack25519(d, b);
  return vn(c, d, 32);
}

inline uint8_t par25519(const gf a) {
  uint8_t d[32];
  pack25519(d, a);
  return d[0] & 1;
}

inline void unpack25519(gf o, const uint8_t *n) {
  for (int i = 0; i < 16; i++) o[i] = n[2 * i] + ((int64_t)n[2 * i + 1] << 8);
  o[15] &= 0x7fff;
}

inline void A(gf o, const gf a, const gf b) { for (int i = 0; i < 16; i++) o[i] = a[i] + b[i]; }
inline void Z(gf o, const gf a, const gf b) { for (int i = 0; i < 16; i++) o[i] = a[i] - b[i]; }

inline void M(gf o, const gf a, const gf b) {
  int64_t t[31];
  for (int i = 0; i < 31; i++) t[i] = 0;
  for (int i = 0; i < 16; i++) for (int j = 0; j < 16; j++) t[i + j] += a[i] * b[j];
  for (int i = 0; i < 15; i++) t[i] += 38 * t[i + 16];
  for (int i = 0; i < 16; i++) o[i] = t[i];
  car25519(o);
  car25519(o);
}

inline void S(gf o, const gf a) { M(o, a, a); }

inline void inv25519(gf o, const gf i) {
  gf c;
  for (int a = 0; a < 16; a++) c[a] = i[a];
  for (int a = 253; a >= 0; a--) {
    S(c, c);
    if (a != 2 && a != 4) M(c, c, i);
  }
  for (int a = 0; a < 16; a++) o[a] = c[a];
}

inline void pow2523(gf o, const gf i) {
  gf c;
  for (int a = 0; a < 16; a++) c[a] = i[a];
  for (int a = 250; a >= 0; a--) {
    S(c, c);
    if (a != 1) M(c, c, i);
  }
  for (int a = 0; a < 16; a++) o[a] = c[a];
}

/** Extended coordinates: x, y, z, t. */
inline void addPoint(gf p[4], gf q[4]) {
  gf a, b, c, d, e, f, g, h, t;
  Z(a, p[1], p[0]);
  Z(t, q[1], q[0]);
  M(a, a, t);
  A(b, p[0], p[1]);
  A(t, q[0], q[1]);
  M(b, b, t);
  M(c, p[3], q[3]);
  M(c, c, kD2);
  M(d, p[2], q[2]);
  A(d, d, d);
  Z(e, b, a);
  Z(f, d, c);
  A(g, d, c);
  A(h, b, a);
  M(p[0], e, f);
  M(p[1], h, g);
  M(p[2], g, f);
  M(p[3], e, h);
}

inline void cswap(gf p[4], gf q[4], int b) {
  for (int i = 0; i < 4; i++) sel25519(p[i], q[i], b);
}

inline void pack(uint8_t *r, gf p[4]) {
  gf tx, ty, zi;
  inv25519(zi, p[2]);
  M(tx, p[0], zi);
  M(ty, p[1], zi);
  pack25519(r, ty);
  r[31] ^= par25519(tx) << 7;
}

inline void scalarmult(gf p[4], gf q[4], const uint8_t *s) {
  set25519(p[0], kZero);
  set25519(p[1], kOne);
  set25519(p[2], kOne);
  set25519(p[3], kZero);
  for (int i = 255; i >= 0; --i) {
    const int b = (s[i / 8] >> (i & 7)) & 1;
    cswap(p, q, b);
    addPoint(q, p);
    addPoint(p, p);
    cswap(p, q, b);
  }
}

inline void scalarbase(gf p[4], const uint8_t *s) {
  gf q[4];
  set25519(q[0], kX);
  set25519(q[1], kY);
  set25519(q[2], kOne);
  M(q[3], kX, kY);
  scalarmult(p, q, s);
}

inline int unpackneg(gf r[4], const uint8_t p[32]) {
  gf t, chk, num, den, den2, den4, den6;
  set25519(r[2], kOne);
  unpack25519(r[1], p);
  S(num, r[1]);
  M(den, num, kD);
  Z(num, num, r[2]);
  A(den, r[2], den);

  S(den2, den);
  S(den4, den2);
  M(den6, den4, den2);
  M(t, den6, num);
  M(t, t, den);

  pow2523(t, t);
  M(t, t, num);
  M(t, t, den);
  M(t, t, den);
  M(r[0], t, den);

  S(chk, r[0]);
  M(chk, chk, den);
  if (neq25519(chk, num)) M(r[0], r[0], kI);

  S(chk, r[0]);
  M(chk, chk, den);
  if (neq25519(chk, num)) return -1;

  if (par25519(r[0]) == (p[31] >> 7)) Z(r[0], kZero, r[0]);

  M(r[3], r[0], r[1]);
  return 0;
}

/**
 * Reduce a 64-byte little-endian value modulo L in place.
 *
 * This is TweetNaCl's modL with exact floor division. Javascript needed
 * Math.floor because its bitwise operators work on 32 bits; C division already
 * truncates towards zero, so the explicit floor is dropped here.
 */
inline void modL(uint8_t *r, int64_t x[64]) {
  int64_t carry;
  int i, j, k;
  for (i = 63; i >= 32; --i) {
    carry = 0;
    for (j = i - 32, k = i - 12; j < k; ++j) {
      x[j] += carry - 16 * x[i] * kL[j - (i - 32)];
      carry = (x[j] + 128) >> 8;
      x[j] -= carry * 256;
    }
    x[j] += carry;
    x[i] = 0;
  }
  carry = 0;
  for (j = 0; j < 32; j++) {
    x[j] += carry - (x[31] >> 4) * kL[j];
    carry = x[j] >> 8;
    x[j] &= 255;
  }
  for (j = 0; j < 32; j++) x[j] -= carry * kL[j];
  for (i = 0; i < 32; i++) {
    x[i + 1] += x[i] >> 8;
    r[i] = (uint8_t)(x[i] & 255);
  }
}

inline void reduce(uint8_t r[64]) {
  int64_t x[64];
  for (int i = 0; i < 64; i++) x[i] = (int64_t)r[i];
  for (int i = 0; i < 64; i++) r[i] = 0;
  modL(r, x);
}

}  // namespace detail

/** SHA-512 over a byte string, using the mbedtls build already linked in. */
inline void sha512(uint8_t out[64], const uint8_t *data, size_t length) {
  mbedtls_sha512_context ctx;
  mbedtls_sha512_init(&ctx);
  mbedtls_sha512_starts(&ctx, 0);
  if (length) mbedtls_sha512_update(&ctx, data, length);
  mbedtls_sha512_finish(&ctx, out);
  mbedtls_sha512_free(&ctx);
}

/**
 * Verify a detached Ed25519 signature.
 *
 * @param signature 64 bytes: R followed by S.
 * @param publicKey 32 bytes in RFC 8032 encoding.
 * @param message   the signed bytes.
 * @param length    message length.
 * @return true only when the signature is valid for this key and message.
 */
inline bool verify(const uint8_t signature[64], const uint8_t publicKey[32],
                   const uint8_t *message, size_t length) {
  if (!signature || !publicKey || (!message && length)) return false;

  // A non-canonical S (>= L) must be refused; it is the classic malleability bug.
  int order = 0;
  for (int i = 31; i >= 0; --i) {
    if (signature[32 + i] > detail::kL[i]) { order = 1; break; }
    if (signature[32 + i] < detail::kL[i]) { order = -1; break; }
  }
  if (order >= 0) return false;

  gf q[4];
  if (detail::unpackneg(q, publicKey) != 0) return false;

  // h = SHA-512(R || A || M) mod L
  uint8_t buffer[128];
  uint8_t digest[64];
  {
    mbedtls_sha512_context ctx;
    mbedtls_sha512_init(&ctx);
    mbedtls_sha512_starts(&ctx, 0);
    mbedtls_sha512_update(&ctx, signature, 32);
    mbedtls_sha512_update(&ctx, publicKey, 32);
    if (length) mbedtls_sha512_update(&ctx, message, length);
    mbedtls_sha512_finish(&ctx, digest);
    mbedtls_sha512_free(&ctx);
  }
  (void)buffer;
  detail::reduce(digest);

  gf p[4];
  detail::scalarmult(p, q, digest);
  detail::scalarbase(q, signature + 32);
  detail::addPoint(p, q);

  uint8_t check[32];
  detail::pack(check, p);
  return detail::vn(signature, check, 32) == 0;
}

}  // namespace ed25519
}  // namespace hc
