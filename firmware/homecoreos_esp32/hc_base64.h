#pragma once
/** Strict base64 helpers — no line breaks, no padding tolerance games. */
#include <Arduino.h>

namespace hc {

inline int b64Value(char c) {
  if (c >= 'A' && c <= 'Z') return c - 'A';
  if (c >= 'a' && c <= 'z') return c - 'a' + 26;
  if (c >= '0' && c <= '9') return c - '0' + 52;
  if (c == '+') return 62;
  if (c == '/') return 63;
  if (c == '=') return -2;
  return -1;
}

inline bool b64Decode(const char *in, size_t inLen, uint8_t *out, size_t outCap, size_t *outLen) {
  size_t o = 0;
  uint32_t buffer = 0;
  int bits = 0;
  for (size_t i = 0; i < inLen; ++i) {
    const int v = b64Value(in[i]);
    if (v == -1) continue;           // tolerate wrapped PEM bodies
    if (v == -2) break;              // padding ends the stream
    buffer = (buffer << 6) | (uint32_t)v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      if (o >= outCap) return false;
      out[o++] = (uint8_t)((buffer >> bits) & 0xFF);
    }
  }
  if (outLen) *outLen = o;
  return o > 0;
}

inline String b64Encode(const uint8_t *data, size_t len) {
  static const char *kTable = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  String out;
  out.reserve(((len + 2) / 3) * 4);
  size_t i = 0;
  while (i + 2 < len) {
    const uint32_t n = ((uint32_t)data[i] << 16) | ((uint32_t)data[i + 1] << 8) | data[i + 2];
    out += kTable[(n >> 18) & 63];
    out += kTable[(n >> 12) & 63];
    out += kTable[(n >> 6) & 63];
    out += kTable[n & 63];
    i += 3;
  }
  if (i + 1 == len) {
    const uint32_t n = (uint32_t)data[i] << 16;
    out += kTable[(n >> 18) & 63];
    out += kTable[(n >> 12) & 63];
    out += "==";
  } else if (i + 2 == len) {
    const uint32_t n = ((uint32_t)data[i] << 16) | ((uint32_t)data[i + 1] << 8);
    out += kTable[(n >> 18) & 63];
    out += kTable[(n >> 12) & 63];
    out += kTable[(n >> 6) & 63];
    out += '=';
  }
  return out;
}

inline bool hexToBytes(const char *hex, uint8_t *out, size_t outCap, size_t *outLen) {
  size_t n = 0;
  for (size_t i = 0; hex[i] && hex[i + 1]; i += 2) {
    auto nibble = [](char c) -> int {
      if (c >= '0' && c <= '9') return c - '0';
      if (c >= 'a' && c <= 'f') return c - 'a' + 10;
      if (c >= 'A' && c <= 'F') return c - 'A' + 10;
      return -1;
    };
    const int hi = nibble(hex[i]), lo = nibble(hex[i + 1]);
    if (hi < 0 || lo < 0) return false;
    if (n >= outCap) return false;
    out[n++] = (uint8_t)((hi << 4) | lo);
  }
  if (outLen) *outLen = n;
  return n > 0;
}

}  // namespace hc
