#pragma once
/**
 * Manufacturer image validation.
 *
 * An ESP-IDF application image starts with a 24-byte header, is followed by a
 * table of segments and ends with a 32-byte SHA-256 plus an 8-bit checksum. A
 * customer must never be able to brick a controller with the wrong file, so
 * exactly this structure is verified before an image is accepted — by the
 * browser installer and by OTA.
 *
 * The application descriptor is NOT at file offset 0x20. ESP-IDF links
 * `esp_app_desc_t` into the `.flash.appdesc` section, which is the first thing
 * in the DROM segment, and the 0x20-byte MMU mapping header in front of it
 * takes the first 0x20 bytes of that segment. The IROM segment is normally
 * emitted first, so the descriptor usually sits well past offset 0x20 of the
 * file. The segment table is walked to find it, and the magic word confirms
 * the match.
 *
 * The checksum follows the same rules the ROM loader uses: it is the XOR of
 * the segment data seeded with 0xEF, and it does not cover the segment headers
 * or the 24-byte image header. For an image built with an appended hash the
 * checksum byte is the last byte before the 32-byte digest.
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
/** Load address of the DROM segment, where the application descriptor lives. */
constexpr uint32_t kDromLoadAddr = 0x3f400020;
/** Length of the ESP image header, in bytes. */
constexpr size_t kImageHeaderSize = 24;

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

inline uint32_t readUint32LE(const uint8_t *p) {
  return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

/**
 * The offset of the application descriptor within the file, or 0 when the
 * image has none.
 *
 * The descriptor is found through the segment table, because its position
 * depends on how the image was linked. The magic word confirms the match, so a
 * file that merely has the right bytes somewhere is not mistaken for one.
 */
inline size_t findAppDescriptorOffset(const uint8_t *data, size_t len) {
  if (!data || len < kImageHeaderSize + 8) return 0;
  size_t cursor = kImageHeaderSize;
  size_t fallback = 0;
  while (cursor + 8 <= len) {
    const uint32_t addr = readUint32LE(data + cursor);
    const uint32_t length = readUint32LE(data + cursor + 4);
    if (length == 0 || (size_t)length > len - cursor - 8) break;
    const size_t dataOffset = cursor + 8;
    if (addr == kDromLoadAddr) {
      const size_t offset = dataOffset + kAppDescOffset;
      if (offset + sizeof(uint32_t) <= len &&
          readUint32LE(data + offset) == (uint32_t)ESP_APP_DESC_MAGIC_WORD) {
        return offset;
      }
    } else if (!fallback && dataOffset + kAppDescOffset + sizeof(uint32_t) <= len &&
               readUint32LE(data + dataOffset + kAppDescOffset) ==
                   (uint32_t)ESP_APP_DESC_MAGIC_WORD) {
      fallback = dataOffset + kAppDescOffset;
    }
    cursor = dataOffset + length;
  }
  if (fallback) return fallback;
  // An image whose only segment is the DROM segment carries the descriptor at
  // the start of that segment's data.
  if (len >= kAppDescOffset + sizeof(uint32_t) &&
      readUint32LE(data + kAppDescOffset) == (uint32_t)ESP_APP_DESC_MAGIC_WORD) {
    return kAppDescOffset;
  }
  return 0;
}

/**
 * Validate an application-only image that begins at offset 0 of `data`.
 * `valid` is true only for a well-formed image built for this chip.
 */
inline ImageInfo inspectAppImage(const uint8_t *data, size_t len) {
  ImageInfo info;
  info.size = (uint32_t)len;
  const size_t minimum = kImageHeaderSize + sizeof(esp_app_desc_t) + 32;
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
  const size_t descOffset = findAppDescriptorOffset(data, len);
  if (!descOffset) {
    info.error = "Application descriptor missing — not an application image";
    return info;
  }
  const esp_app_desc_t *desc = reinterpret_cast<const esp_app_desc_t *>(data + descOffset);
  if (desc->magic_word != ESP_APP_DESC_MAGIC_WORD) {
    info.error = "Application descriptor missing — not an application image";
    return info;
  }
  copyField(info.appVersion, sizeof(info.appVersion), desc->version, sizeof(desc->version));
  copyField(info.projectName, sizeof(info.projectName), desc->project_name, sizeof(desc->project_name));
  copyField(info.idfVersion, sizeof(info.idfVersion), desc->idf_ver, sizeof(desc->idf_ver));

  // The checksum is the XOR of the segment data, seeded with 0xEF. The segment
  // headers and the image header are not part of it. Byte 23 of the header is
  // the hash-appended flag, so for an image with an appended digest the
  // checksum is the last byte before that digest.
  const bool hashAppended = data[23] == 1;
  uint8_t checksum = kImageChecksumSeed;
  size_t cursor = kImageHeaderSize;
  size_t dataEnd = 0;
  while (cursor + 8 <= len) {
    const uint32_t length = readUint32LE(data + cursor + 4);
    if (length == 0 || (size_t)length > len - cursor - 8) break;
    for (uint32_t i = 0; i < length; ++i) checksum ^= data[cursor + 8 + i];
    cursor += 8 + length;
    dataEnd = cursor;
  }
  if (!dataEnd) {
    info.error = "Image has no loadable segment";
    return info;
  }
  size_t checksumOffset;
  if (hashAppended) {
    if (len < 33) {
      info.error = "Image is too short to hold its digest";
      return info;
    }
    checksumOffset = len - 33;
    // The padding between the last segment and the checksum is zero, so it
    // does not change the running XOR, but it is walked for exactness.
    for (size_t i = dataEnd; i < checksumOffset; ++i) checksum ^= data[i];
  } else {
    checksumOffset = dataEnd;
  }
  if (checksumOffset >= len || checksum != data[checksumOffset]) {
    info.error = "Image checksum does not match the file contents";
    return info;
  }
  info.valid = true;
  return info;
}

}  // namespace hc
