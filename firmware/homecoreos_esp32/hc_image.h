#pragma once
/**
 * Manufacturer image validation.
 *
 * An ESP-IDF application image starts with a 24-byte header, carries a
 * descriptor at 0x20 and ends with a 32-byte SHA-256 plus an 8-bit checksum
 * stored in the header. A customer must never be able to brick a controller
 * with the wrong file, so exactly this structure is verified before an image is
 * accepted — by the browser installer and by OTA.
 */
#include <Arduino.h>

#include "esp_app_format.h"

namespace hc {

struct ImageInfo {
  bool valid = false;
  uint32_t size = 0;
  uint16_t chipId = 0;
  char appVersion[33] = {0};
  char projectName[33] = {0};
  char idfVersion[33] = {0};
  String error;
};

constexpr uint8_t kImageChecksumSeed = 0xEF;
constexpr uint32_t kAppDescOffset = 0x20;

/** Chip ids from esp_image_format; stable across ESP-IDF releases. */
constexpr uint16_t kChipIdEsp32 = 0;
constexpr uint16_t kChipIdEsp32S2 = 2;
constexpr uint16_t kChipIdEsp32S3 = 9;
constexpr uint16_t kChipIdEsp32C3 = 5;
constexpr uint16_t kChipIdEsp32C6 = 13;
constexpr uint16_t kChipIdEsp32H2 = 16;

inline uint16_t targetChipId() {
#if defined(CONFIG_IDF_TARGET_ESP32S3)
  return kChipIdEsp32S3;
#elif defined(CONFIG_IDF_TARGET_ESP32S2)
  return kChipIdEsp32S2;
#elif defined(CONFIG_IDF_TARGET_ESP32C3)
  return kChipIdEsp32C3;
#elif defined(CONFIG_IDF_TARGET_ESP32C6)
  return kChipIdEsp32C6;
#elif defined(CONFIG_IDF_TARGET_ESP32H2)
  return kChipIdEsp32H2;
#else
  return kChipIdEsp32;
#endif
}

inline void copyField(char *dst, size_t dstSize, const char *src, size_t srcSize) {
  size_t n = 0;
  while (n < srcSize && n + 1 < dstSize && src[n] != 0) {
    dst[n] = src[n];
    ++n;
  }
  dst[n] = 0;
}

/**
 * Validate an application-only image that begins at offset 0 of `data`.
 * `valid` is true only for a well-formed image built for this chip.
 */
inline ImageInfo inspectAppImage(const uint8_t *data, size_t len) {
  ImageInfo info;
  info.size = (uint32_t)len;
  const size_t minimum = kAppDescOffset + sizeof(esp_app_desc_t) + 32;
  if (!data || len < minimum) {
    info.error = "File is too small to be a HomecoreOS firmware image";
    return info;
  }
  if (data[0] != ESP_IMAGE_HEADER_MAGIC) {
    info.error = "Not an ESP32 application image (bad magic byte)";
    return info;
  }
  info.chipId = (uint16_t)data[offsetof(esp_image_header_t, chip_id)] |
                ((uint16_t)data[offsetof(esp_image_header_t, chip_id) + 1] << 8);
  if (info.chipId != targetChipId()) {
    info.error = "This image was built for a different chip";
    return info;
  }
  const esp_app_desc_t *desc = reinterpret_cast<const esp_app_desc_t *>(data + kAppDescOffset);
  if (desc->magic_word != ESP_APP_DESC_MAGIC_WORD) {
    info.error = "Application descriptor missing — not an application image";
    return info;
  }
  copyField(info.appVersion, sizeof(info.appVersion), desc->version, sizeof(desc->version));
  copyField(info.projectName, sizeof(info.projectName), desc->project_name, sizeof(desc->project_name));
  copyField(info.idfVersion, sizeof(info.idfVersion), desc->idf_ver, sizeof(desc->idf_ver));

  uint8_t checksum = kImageChecksumSeed;
  const size_t body = len - 32;
  for (size_t i = sizeof(esp_image_header_t); i < body; ++i) checksum ^= data[i];
  if (checksum != data[23]) {
    info.error = "Image checksum does not match the file contents";
    return info;
  }
  info.valid = true;
  return info;
}

}  // namespace hc
