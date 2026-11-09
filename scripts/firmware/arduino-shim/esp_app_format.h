// Minimal stand-in for the ESP-IDF image format header.
//
// hc_image.h includes "esp_app_format.h", which is part of the ESP-IDF
// toolchain and is not available on the host. Only the few declarations the
// firmware uses are needed, and they must match the real ones exactly:
//
//   esp_app_desc_t          the application descriptor, as ESP-IDF declares it
//   ESP_APP_DESC_MAGIC_WORD  0xABCD5432
//   ESP_IMAGE_HEADER_MAGIC  0xE9
//   esp_image_header_t      the 24-byte image header
//
// The field order and the byte order matter: ESP-IDF writes the descriptor as
// a plain C structure, so on the little-endian ESP32-S3 the uint32_t fields
// are stored little-endian.
#pragma once
#include <cstddef>
#include <cstdint>

#ifndef ESP_APP_DESC_MAGIC_WORD
#define ESP_APP_DESC_MAGIC_WORD (0xABCD5432)
#endif

#ifndef ESP_IMAGE_HEADER_MAGIC
#define ESP_IMAGE_HEADER_MAGIC 0xE9
#endif

// The application descriptor, in the order ESP-IDF declares it.
typedef struct {
  uint32_t magic_word;
  uint32_t secure_version;
  uint32_t reserv1[2];
  char version[32];
  char project_name[32];
  char time[16];
  char date[16];
  char idf_ver[32];
  uint8_t app_elf_sha256[32];
  uint32_t reserv2[20];
} esp_app_desc_t;

// The 24-byte image header, in the order ESP-IDF declares it.
typedef struct {
  uint8_t magic;
  uint8_t segment_count;
  uint8_t spi_mode;
  uint8_t spi_speed_size;
  uint32_t entry_addr;
  uint8_t wp_pin;
  uint8_t spi_pin_drv[3];
  int32_t chip_id;
  uint8_t min_chip_rev;
  uint8_t min_chip_rev_full[2];
  uint8_t max_chip_rev_full[2];
  uint8_t reserved[4];
  uint8_t hash_appended;
} esp_image_header_t;
