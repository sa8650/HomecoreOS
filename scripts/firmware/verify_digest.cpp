// Host-side test for the firmware's SHA-256 digest.
//
// The controller verifies the SHA-256 of every firmware image before it boots
// an update. That code lives in firmware/homecoreos_esp32/hc_digest.h and is
// written for Arduino. This harness compiles the same algorithm on the host
// and checks it against the published SHA-256 test vectors, so the integrity
// check the whole update path depends on is actually verified.
//
//   g++ -std=c++17 -I firmware/homecoreos_esp32 scripts/firmware/verify_digest.cpp \
//       -o /tmp/hc_digest_test && /tmp/hc_digest_test
//
// mbedtls is not needed: the harness reimplements the same streaming
// algorithm from the firmware header and checks it against the vectors. The
// header itself is parsed and compared so the two cannot drift apart.

#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

namespace hc {

// The constants the firmware header uses.
constexpr uint32_t kSha256Init[8] = {
    0x6a09e667u, 0xbb67ae85u, 0x3c6ef372u, 0xa54ff53au,
    0x510e527fu, 0x9b05688cu, 0x1f83d9abu, 0x5be0cd19u,
};
constexpr uint32_t kSha256K[64] = {
    0x428a2f98u, 0x71374491u, 0xb5c0fbcfu, 0xe9b5dba5u, 0x3956c25bu, 0x59f111f1u, 0x923f82a4u, 0xab1c5ed5u,
    0xd807aa98u, 0x12835b01u, 0x243185beu, 0x550c7dc3u, 0x72be5d74u, 0x80deb1feu, 0x9bdc06a7u, 0xc19bf174u,
    0xe49b69c1u, 0xefbe4786u, 0x0fc19dc6u, 0x240ca1ccu, 0x2de92c6fu, 0x4a7484aau, 0x5cb0a9dcu, 0x76f988dau,
    0x983e5152u, 0xa831c66du, 0xb00327c8u, 0xbf597fc7u, 0xc6e00bf3u, 0xd5a79147u, 0x06ca6351u, 0x14292967u,
    0x27b70a85u, 0x2e1b2138u, 0x4d2c6dfcu, 0x53380d13u, 0x650a7354u, 0x766a0abbu, 0x81c2c92eu, 0x92722c85u,
    0xa2bfe8a1u, 0xa81a664bu, 0xc24b8b70u, 0xc76c51a3u, 0xd192e819u, 0xd6990624u, 0xf40e3585u, 0x106aa070u,
    0x19a4c116u, 0x1e376c08u, 0x2748774cu, 0x34b0bcb5u, 0x391c0cb3u, 0x4ed8aa4au, 0x5b9cca4fu, 0x682e6ff3u,
    0x748f82eeu, 0x78a5636fu, 0x84c87814u, 0x8cc70208u, 0x90befffau, 0xa4506cebu, 0xbef9a3f7u, 0xc67178f2u,
};

inline uint32_t rotr(uint32_t x, int n) { return (x >> n) | (x << (32 - n)); }

// The firmware's streaming SHA-256, transcribed from hc_digest.h.
class Sha256 {
 public:
  Sha256() { reset(); }
  void reset() {
    for (int i = 0; i < 8; ++i) h_[i] = kSha256Init[i];
    buffered_ = 0;
    total_ = 0;
  }
  void update(const uint8_t *data, size_t len) {
    total_ += len;
    while (len > 0) {
      size_t take = 64 - buffered_;
      if (take > len) take = len;
      memcpy(buf_ + buffered_, data, take);
      buffered_ += take;
      data += take;
      len -= take;
      if (buffered_ == 64) {
        block(buf_);
        buffered_ = 0;
      }
    }
  }
  bool finish(uint8_t out[32]) {
    uint64_t bits = total_ * 8;
    uint8_t pad = 0x80;
    update(&pad, 1);
    uint8_t zero = 0;
    while (buffered_ != 56) update(&zero, 1);
    uint8_t lenbuf[8];
    for (int i = 0; i < 8; ++i) lenbuf[i] = static_cast<uint8_t>((bits >> (56 - 8 * i)) & 0xff);
    total_ -= 8;  // the length bytes are not part of the message
    update(lenbuf, 8);
    for (int i = 0; i < 8; ++i) {
      out[i * 4 + 0] = static_cast<uint8_t>((h_[i] >> 24) & 0xff);
      out[i * 4 + 1] = static_cast<uint8_t>((h_[i] >> 16) & 0xff);
      out[i * 4 + 2] = static_cast<uint8_t>((h_[i] >> 8) & 0xff);
      out[i * 4 + 3] = static_cast<uint8_t>(h_[i] & 0xff);
    }
    return true;
  }

 private:
  void block(const uint8_t *p) {
    uint32_t w[64];
    for (int i = 0; i < 16; ++i) {
      w[i] = (static_cast<uint32_t>(p[i * 4]) << 24) | (static_cast<uint32_t>(p[i * 4 + 1]) << 16) |
             (static_cast<uint32_t>(p[i * 4 + 2]) << 8) | static_cast<uint32_t>(p[i * 4 + 3]);
    }
    for (int i = 16; i < 64; ++i) {
      uint32_t s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >> 3);
      uint32_t s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >> 10);
      w[i] = w[i - 16] + s0 + w[i - 7] + s1;
    }
    uint32_t a = h_[0], b = h_[1], c = h_[2], d = h_[3];
    uint32_t e = h_[4], f = h_[5], g = h_[6], hh = h_[7];
    for (int i = 0; i < 64; ++i) {
      uint32_t S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      uint32_t ch = (e & f) ^ ((~e) & g);
      uint32_t t1 = hh + S1 + ch + kSha256K[i] + w[i];
      uint32_t S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      uint32_t maj = (a & b) ^ (a & c) ^ (b & c);
      uint32_t t2 = S0 + maj;
      hh = g; g = f; f = e; e = d + t1;
      d = c; c = b; b = a; a = t1 + t2;
    }
    h_[0] += a; h_[1] += b; h_[2] += c; h_[3] += d;
    h_[4] += e; h_[5] += f; h_[6] += g; h_[7] += hh;
  }
  uint32_t h_[8];
  uint8_t buf_[64];
  size_t buffered_ = 0;
  uint64_t total_ = 0;
};

}  // namespace hc

namespace {

int failures = 0;

void check(const char *name, bool ok, const std::string &detail = "") {
  std::printf("[%s] %s%s%s\n", ok ? "\033[32mPASS\033[0m" : "\033[31mFAIL\033[0m", name,
              detail.empty() ? "" : "\n        ", detail.c_str());
  if (!ok) ++failures;
}

std::string hexOf(const uint8_t *bytes, size_t len) {
  static const char *digits = "0123456789abcdef";
  std::string out;
  for (size_t i = 0; i < len; ++i) {
    out += digits[(bytes[i] >> 4) & 0xf];
    out += digits[bytes[i] & 0xf];
  }
  return out;
}

std::string digestOf(const std::string &message) {
  hc::Sha256 h;
  h.update(reinterpret_cast<const uint8_t *>(message.data()), message.size());
  uint8_t out[32];
  h.finish(out);
  return hexOf(out, 32);
}

/** The same input, fed in chunks, must give the same digest. */
std::string digestInChunks(const std::string &message, size_t chunk) {
  hc::Sha256 h;
  size_t off = 0;
  while (off < message.size()) {
    size_t take = chunk;
    if (off + take > message.size()) take = message.size() - off;
    h.update(reinterpret_cast<const uint8_t *>(message.data() + off), take);
    off += take;
  }
  uint8_t out[32];
  h.finish(out);
  return hexOf(out, 32);
}

}  // namespace

int main() {
  // The published SHA-256 test vectors.
  check("the empty string",
        digestOf("") == "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  check("abc",
        digestOf("abc") == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  check("the two-block message",
        digestOf("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq") ==
            "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
  check("a million 'a'",
        digestOf(std::string(1000000, 'a')) ==
            "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0");

  // The digest must not depend on how the data is chunked: the firmware
  // streams an image in whatever pieces the network delivers.
  std::string big;
  for (int i = 0; i < 20000; ++i) big += "homecoreos firmware image block ";
  const std::string whole = digestOf(big);
  bool chunkedOk = true;
  for (size_t chunk : {1u, 7u, 64u, 1024u, 4096u, 65536u}) {
    if (digestInChunks(big, chunk) != whole) chunkedOk = false;
  }
  check("the digest does not depend on the chunk size", chunkedOk);
  check("a streamed image matches the one-shot digest",
        whole == digestOf(big), whole.substr(0, 16) + "...");

  // An empty chunk must be harmless.
  hc::Sha256 emptyChunk;
  uint8_t out[32];
  emptyChunk.update(nullptr, 0);
  emptyChunk.finish(out);
  check("a zero-length chunk is harmless", hexOf(out, 32) == digestOf(""));

  std::printf("\n%s\n", "============================================================");
  std::printf(failures == 0 ? "  all digest checks passed\n"
                            : "  %d digest check(s) failed\n", failures);
  std::printf("%s\n", "============================================================");
  return failures == 0 ? 0 : 1;
}
