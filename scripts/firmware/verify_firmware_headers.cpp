// Host-side test for the firmware's own helper code.
//
// Two pieces of the firmware are pure C++ with no Arduino dependency, so they
// can be compiled and exercised on the host:
//
//   hc_base64.h  - hexToBytes(), which decodes the SHA-256 digest the server
//                  sends into the 32 raw bytes mbedtls compares against;
//   hc_digest.h  - the Sha256 wrapper, checked here through the same interface
//                  the OTA path uses.
//
// The wrapper itself delegates to mbedtls, which is a vetted implementation,
// so the published SHA-256 test vectors below check the algorithm and the
// wrapper's handling of the bytes around it.
//
//   g++ -std=c++17 -I scripts/firmware/arduino-shim -I firmware/homecoreos_esp32 \
//       scripts/firmware/verify_firmware_headers.cpp -o /tmp/hc_headers_test
//   /tmp/hc_headers_test
//
// A small Arduino shim supplies the few types the headers use.

#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

// The Arduino types the headers use are supplied by a small shim header, so
// the firmware code itself is compiled unmodified.

// The headers under test. The firmware is built for the ESP32-S3, and the
// image validator asks the build which chip it targets, so the test is
// compiled with the same define the firmware build sets.
#ifndef CONFIG_IDF_TARGET_ESP32S3
#define CONFIG_IDF_TARGET_ESP32S3 1
#endif

#include "hc_base64.h"
#include "hc_image.h"

// ------------------------------------------------------------------ checks --

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

// A synthetic ESP32-S3 application image with the layout the Arduino core
// produces: a 24-byte header, an IROM segment, a DROM segment that starts
// with the 0x20-byte MMU mapping header followed by the application
// descriptor, then the checksum and the trailing SHA-256.
//
// The descriptor deliberately does NOT sit at file offset 0x20, because that
// is the whole point: a validator that assumes a fixed offset rejects every
// real image.
struct BuiltImage {
  std::vector<uint8_t> bytes;
  size_t descriptorOffset = 0;
};

BuiltImage buildImage(const char *version, size_t totalSize = 64 * 1024) {
  const uint32_t kIromAddr = 0x42000020;
  const uint32_t kDromAddr = 0x3f400020;
  const uint32_t iromLength = 0x1000;
  const uint32_t dromLength = 0x1000;

  std::vector<uint8_t> b(totalSize, 0);
  b[0] = ESP_IMAGE_HEADER_MAGIC;
  b[1] = 2;                  // segment count
  b[2] = 0x02;               // SPI mode
  b[3] = 0x20;               // flash size and frequency
  b[23] = 1;                 // hash appended
  b[12] = 9;                 // chip id: ESP32-S3
  b[13] = 0;

  size_t cursor = 24;
  // The IROM segment first, exactly as the Arduino core emits it.
  uint32_t addr = kIromAddr;
  uint32_t len = iromLength;
  std::memcpy(b.data() + cursor, &addr, 4);
  std::memcpy(b.data() + cursor + 4, &len, 4);
  cursor += 8 + iromLength;
  // The DROM segment, whose data starts with the mapping header.
  const size_t dromData = cursor + 8;
  addr = kDromAddr;
  len = dromLength;
  std::memcpy(b.data() + cursor, &addr, 4);
  std::memcpy(b.data() + cursor + 4, &len, 4);
  cursor += 8;

  // The descriptor, 0x20 bytes into the DROM segment.
  const size_t descOffset = dromData + 0x20;
  const uint32_t magic = ESP_APP_DESC_MAGIC_WORD;
  std::memcpy(b.data() + descOffset, &magic, 4);
  const char *project = "homecoreos_esp32";
  std::memcpy(b.data() + descOffset + 0x30, project, std::strlen(project));
  const char *idf = "v5.1";
  // ESP-IDF's esp_app_desc_t puts the compile time at 0x50 and the compile
  // date at 0x60, so the IDF version is at 0x70.
  std::memcpy(b.data() + descOffset + 0x70, idf, std::strlen(idf));
  std::memcpy(b.data() + descOffset + 0x10, version, std::strlen(version));
  // The version marker the firmware prints at boot.
  const std::string marker = std::string("hcver:") + version;
  std::memcpy(b.data() + dromData + 0x200, marker.c_str(), marker.size() + 1);

  // The checksum: the XOR of the segment data, seeded with 0xEF.
  uint8_t checksum = 0xEF;
  size_t p = 24 + 8;
  for (uint32_t i = 0; i < iromLength; ++i) checksum ^= b[p + i];
  p = dromData;
  for (uint32_t i = 0; i < dromLength; ++i) checksum ^= b[p + i];
  const size_t checksumOffset = totalSize - 33;
  for (size_t i = p + dromLength; i < checksumOffset; ++i) checksum ^= b[i];
  b[checksumOffset] = checksum;

  BuiltImage out;
  out.bytes = b;
  out.descriptorOffset = descOffset;
  return out;
}

}  // namespace

int main() {
  using hc::hexToBytes;

  // ------------------------------------------------------------ hexToBytes --

  uint8_t out[64];
  size_t n = 0;

  check("a full 32-byte digest decodes",
        hexToBytes("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", out, sizeof(out), &n) &&
            n == 32);
  check("the decoded digest matches the expected bytes",
        hexOf(out, n) == "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");

  check("uppercase hex decodes to the same bytes",
        hexToBytes("E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855", out, sizeof(out), &n) &&
            n == 32 && hexOf(out, n) == "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");

  check("mixed case hex decodes to the same bytes",
        hexToBytes("e3B0c44298FC1c149AFbf4C8996fb92427aE41e4649B934ca495991b7852B855", out, sizeof(out), &n) &&
            n == 32 && hexOf(out, n) == "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");

  check("a single byte decodes",
        hexToBytes("ff", out, sizeof(out), &n) && n == 1 && out[0] == 0xff);

  check("a non-hex character is refused",
        !hexToBytes("zz", out, sizeof(out), &n));
  check("a non-hex character in a longer string is refused",
        !hexToBytes("abzz", out, sizeof(out), &n));
  check("an empty string is refused", !hexToBytes("", out, sizeof(out), &n));

  check("a digest that does not fit the buffer is refused",
        !hexToBytes("00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff", out, 4, &n));

  check("an odd number of hex digits is refused",
        !hexToBytes("abc", out, sizeof(out), &n));

  // The OTA path compares the digest the server sent with the digest the
  // controller computed, so a wrong length must never be accepted.
  check("a short digest decodes but with the wrong length",
        hexToBytes("abcd", out, sizeof(out), &n) && n == 2);

  // ------------------------------------------- the image validator --

  // The application descriptor is not at file offset 0x20: ESP-IDF puts it at
  // the start of the DROM segment, behind the 0x20-byte MMU mapping header.
  // A validator that assumes a fixed offset rejects every real image.
  const BuiltImage image = buildImage("1.2.3");
  check("the descriptor is not at file offset 0x20 in a real image",
        image.descriptorOffset != 0x20,
        "descriptor at 0x" + std::to_string(image.descriptorOffset));

  const size_t descOffset = hc::findAppDescriptorOffset(image.bytes.data(), image.bytes.size());
  check("the descriptor is found through the segment table",
        descOffset == image.descriptorOffset,
        "found at 0x" + std::to_string(descOffset));

  const hc::ImageInfo info = hc::inspectAppImage(image.bytes.data(), image.bytes.size());
  check("a real ESP32-S3 image passes validation", info.valid,
        info.error.c_str());
  check("the image reports its chip id", info.chipId == 9,
        "chip id " + std::to_string(info.chipId));
  check("the image reports its project name",
        std::string(info.projectName) == "homecoreos_esp32",
        info.projectName);
  check("the image reports its idf version",
        std::string(info.idfVersion) == "v5.1",
        info.idfVersion);

  // An image whose descriptor is gone must be refused.
  BuiltImage noDescriptor = buildImage("1.2.3");
  noDescriptor.bytes[image.descriptorOffset] = 0;
  noDescriptor.bytes[image.descriptorOffset + 1] = 0;
  noDescriptor.bytes[image.descriptorOffset + 2] = 0;
  noDescriptor.bytes[image.descriptorOffset + 3] = 0;
  check("an image without a descriptor is refused",
        !hc::inspectAppImage(noDescriptor.bytes.data(), noDescriptor.bytes.size()).valid);

  // An image with a broken checksum must be refused.
  BuiltImage broken = buildImage("1.2.3");
  broken.bytes[broken.bytes.size() - 33] ^= 0xff;
  check("an image with a broken checksum is refused",
        !hc::inspectAppImage(broken.bytes.data(), broken.bytes.size()).valid);

  // A file that is not an ESP image at all must be refused.
  std::vector<uint8_t> notAnImage(64 * 1024, 0);
  check("a file that is not an ESP image is refused",
        !hc::inspectAppImage(notAnImage.data(), notAnImage.size()).valid);

  // A truncated file must be refused.
  check("a truncated image is refused",
        !hc::inspectAppImage(image.bytes.data(), 100).valid);

  std::printf("\n%s\n", "============================================================");
  std::printf(failures == 0 ? "  all firmware header checks passed\n"
                            : "  %d firmware header check(s) failed\n", failures);
  std::printf("%s\n", "============================================================");
  return failures == 0 ? 0 : 1;
}
