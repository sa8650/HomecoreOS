#!/usr/bin/env python3
"""Unit tests for HomecoreOS firmware verifier and driver manifest generator."""

from __future__ import annotations

import json
import os
import struct
import subprocess
import sys
import tempfile
import unittest

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
FIRMWARE_DIR = os.path.dirname(SCRIPT_DIR)
VERIFIER = os.path.join(SCRIPT_DIR, "verify_firmware_image.py")

sys.path.insert(0, SCRIPT_DIR)
import verify_firmware_image as vfi  # noqa: E402


def make_synthetic_ota_bin(path: str, *, chip_id: int, version: str, project: str = "homecoreos", size: int = 0x4000) -> None:
    buf = bytearray(size)
    buf[0] = 0xE9
    struct.pack_into("<H", buf, 12, chip_id)
    struct.pack_into("<I", buf, 0x20, 0xABCD5432)
    ver_b = version.encode("utf-8")[:31]
    buf[0x30 : 0x30 + len(ver_b)] = ver_b
    proj_b = project.encode("utf-8")[:31]
    buf[0x50 : 0x50 + len(proj_b)] = proj_b
    with open(path, "wb") as f:
        f.write(buf)


def make_synthetic_usb_bin(path: str, *, boot_offset: int, ota_size: int) -> None:
    total = max(0x9000, ota_size + 0x2000)
    buf = bytearray(total)
    buf[boot_offset] = 0xE9
    buf[0x8000] = 0xAA
    buf[0x8001] = 0x50
    with open(path, "wb") as f:
        f.write(buf)


def make_synthetic_partition_table(path: str) -> None:
    entries = [
        (0x01, 0x02, 0x9000, 0x6000, b"nvs"),
        (0x01, 0x00, 0xF000, 0x2000, b"otadata"),
        (0x00, 0x10, 0x20000, 0x300000, b"ota_0"),
        (0x00, 0x11, 0x320000, 0x300000, b"ota_1"),
    ]
    buf = bytearray()
    for ptype, psub, poff, psize, label in entries:
        ent = bytearray(32)
        ent[0] = 0xAA
        ent[1] = 0x50
        struct.pack_into("<BBII", ent, 2, ptype, psub, poff, psize)
        ent[12 : 12 + len(label)] = label
        buf.extend(ent)
    with open(path, "wb") as f:
        f.write(buf)


class TestVerifyFirmwareImage(unittest.TestCase):
    def run_cli(self, *args: str) -> subprocess.CompletedProcess:
        return subprocess.run(
            [sys.executable, VERIFIER, *args],
            capture_output=True,
            text=True,
            check=False,
        )

    def test_verify_all_21_board_overlays(self) -> None:
        boards_dir = os.path.join(FIRMWARE_DIR, "boards")
        res = self.run_cli("--verify-board-overlays", boards_dir)
        self.assertEqual(res.returncode, 0, res.stderr)
        self.assertIn("Verified 21 ESP-IDF board overlays", res.stdout)

    def test_verify_isolated_esp8266_profile(self) -> None:
        profile = os.path.join(FIRMWARE_DIR, "esp8266", "board-profile.json")
        res = self.run_cli("--verify-esp8266-profile", profile)
        self.assertEqual(res.returncode, 0, res.stderr)
        self.assertIn("nodemcu-esp8266", res.stdout)

    def test_build_and_package_verification_roundtrip(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            ota_bin = os.path.join(tmp, "homecoreos-waveshare-esp32-s3-relay-6ch-ota.bin")
            usb_bin = os.path.join(tmp, "homecoreos-waveshare-esp32-s3-relay-6ch-usb-factory.bin")
            pt_bin = os.path.join(tmp, "partition-table.bin")
            sdk_path = os.path.join(tmp, "sdkconfig")
            manifest_path = os.path.join(tmp, "manifest.json")

            make_synthetic_ota_bin(ota_bin, chip_id=9, version="1.3.0")
            make_synthetic_usb_bin(usb_bin, boot_offset=0x0, ota_size=0x4000)
            make_synthetic_partition_table(pt_bin)

            with open(os.path.join(FIRMWARE_DIR, "boards", "waveshare-esp32-s3-relay-6ch.sdkconfig"), "r", encoding="utf-8") as src:
                base_cfg = src.read()
            with open(sdk_path, "w", encoding="utf-8") as dst:
                dst.write(base_cfg)
                dst.write('\nCONFIG_HOMECORE_FW_VERSION="1.3.0"\n')
                dst.write("CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE=y\n")
                dst.write("CONFIG_BT_ENABLED=y\n")
                dst.write("CONFIG_BT_NIMBLE_ENABLED=y\n")

            res_build = self.run_cli(
                "--verify-build",
                "--version", "1.3.0",
                "--target", "esp32s3",
                "--board", "waveshare-esp32-s3-relay-6ch",
                "--partition-scheme", "dual_ota_16mb",
                "--psram-mode", "octal",
                "--flash-size", "16MB",
                "--max-ota-bytes", "3145728",
                "--image", ota_bin,
                "--sdkconfig", sdk_path,
                "--partition-table", pt_bin,
            )
            self.assertEqual(res_build.returncode, 0, res_build.stderr)

            res_manifest = self.run_cli(
                "--build-release-manifest",
                "--version", "1.3.0",
                "--channel", "stable",
                "--target", "esp32s3",
                "--chip-variant", "ESP32-S3-WROOM-1-N16R8",
                "--board", "waveshare-esp32-s3-relay-6ch",
                "--partition-scheme", "dual_ota_16mb",
                "--psram-mode", "octal",
                "--flash-size", "16MB",
                "--flash-mode", "qio",
                "--flash-freq", "80m",
                "--idf-version", "v5.4",
                "--commit-sha", "abc1234deadbeef",
                "--supports-wifi", "true",
                "--supports-ble", "true",
                "--supports-ble-wifi", "true",
                "--sdkconfig", sdk_path,
                "--usb-bin", usb_bin,
                "--ota-bin", ota_bin,
                "--out", manifest_path,
            )
            self.assertEqual(res_manifest.returncode, 0, res_manifest.stderr)

            res_pkg = self.run_cli(
                "--verify-package",
                "--version", "1.3.0",
                "--target", "esp32s3",
                "--board", "waveshare-esp32-s3-relay-6ch",
                "--partition-scheme", "dual_ota_16mb",
                "--bootloader-offset", "0x0",
                "--usb-bin", usb_bin,
                "--ota-bin", ota_bin,
                "--manifest", manifest_path,
            )
            self.assertEqual(res_pkg.returncode, 0, res_pkg.stderr)

            # Tamper with compiled driver list -> must fail hash verification
            with open(manifest_path, "r", encoding="utf-8") as fh:
                manifest_data = json.load(fh)
            manifest_data["driver_manifest"]["sensor_drivers"].pop()
            with open(manifest_path, "w", encoding="utf-8") as fh:
                json.dump(manifest_data, fh)

            res_tampered = self.run_cli(
                "--verify-package",
                "--version", "1.3.0",
                "--target", "esp32s3",
                "--board", "waveshare-esp32-s3-relay-6ch",
                "--partition-scheme", "dual_ota_16mb",
                "--bootloader-offset", "0x0",
                "--usb-bin", usb_bin,
                "--ota-bin", ota_bin,
                "--manifest", manifest_path,
            )
            self.assertNotEqual(res_tampered.returncode, 0)
            self.assertIn("manifest_hash mismatch", res_tampered.stderr)

    def test_verify_build_rejects_psram_mismatch_and_invalid_i2c(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            ota_bin = os.path.join(tmp, "homecoreos.bin")
            pt_bin = os.path.join(tmp, "partition-table.bin")
            sdk_path = os.path.join(tmp, "sdkconfig")
            make_synthetic_ota_bin(ota_bin, chip_id=9, version="1.3.0")
            make_synthetic_partition_table(pt_bin)

            with open(sdk_path, "w", encoding="utf-8") as dst:
                dst.write('CONFIG_IDF_TARGET="esp32s3"\n')
                dst.write('CONFIG_HOMECORE_FW_VERSION="1.3.0"\n')
                dst.write('CONFIG_HOMECORE_BOARD_SLUG="waveshare-esp32-s3-zero"\n')
                dst.write('CONFIG_HOMECORE_PARTITION_SCHEME="dual_ota_4mb"\n')
                dst.write("CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE=y\n")
                dst.write("CONFIG_BT_ENABLED=y\n")
                dst.write("CONFIG_BT_NIMBLE_ENABLED=y\n")
                dst.write("CONFIG_SPIRAM=y\n")
                dst.write("CONFIG_SPIRAM_MODE_OCT=y\n")  # wrong for S3-Zero (quad!)
                dst.write("CONFIG_HOMECORE_DRIVER_BME280=y\n")
                dst.write("CONFIG_HOMECORE_I2C_DEFAULT_SDA_GPIO=8\n")
                dst.write("CONFIG_HOMECORE_I2C_DEFAULT_SCL_GPIO=7\n")

            res = self.run_cli(
                "--verify-build",
                "--version", "1.3.0",
                "--target", "esp32s3",
                "--board", "waveshare-esp32-s3-zero",
                "--partition-scheme", "dual_ota_4mb",
                "--psram-mode", "quad",
                "--flash-size", "4MB",
                "--image", ota_bin,
                "--sdkconfig", sdk_path,
                "--partition-table", pt_bin,
            )
            self.assertNotEqual(res.returncode, 0)
            self.assertIn("PSRAM mode", res.stderr)

    def test_verify_build_checks_default_i2c_for_all_i2c_drivers(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            ota_bin = os.path.join(tmp, "homecoreos.bin")
            pt_bin = os.path.join(tmp, "partition-table.bin")
            sdk_path = os.path.join(tmp, "sdkconfig")
            make_synthetic_ota_bin(ota_bin, chip_id=9, version="1.3.0")
            make_synthetic_partition_table(pt_bin)

            with open(sdk_path, "w", encoding="utf-8") as dst:
                dst.write('CONFIG_IDF_TARGET="esp32s3"\n')
                dst.write('CONFIG_HOMECORE_FW_VERSION="1.3.0"\n')
                dst.write('CONFIG_HOMECORE_BOARD_SLUG="waveshare-esp32-s3-zero"\n')
                dst.write('CONFIG_HOMECORE_PARTITION_SCHEME="dual_ota_4mb"\n')
                dst.write("CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE=y\n")
                dst.write("CONFIG_BT_ENABLED=y\n")
                dst.write("CONFIG_BT_NIMBLE_ENABLED=y\n")
                dst.write("CONFIG_HOMECORE_DRIVER_SHT3X=y\n")
                dst.write("CONFIG_HOMECORE_I2C_DEFAULT_SDA_GPIO=-1\n")
                dst.write("CONFIG_HOMECORE_I2C_DEFAULT_SCL_GPIO=-1\n")

            res = self.run_cli(
                "--verify-build",
                "--version", "1.3.0",
                "--target", "esp32s3",
                "--board", "waveshare-esp32-s3-zero",
                "--partition-scheme", "dual_ota_4mb",
                "--flash-size", "4MB",
                "--image", ota_bin,
                "--sdkconfig", sdk_path,
                "--partition-table", pt_bin,
            )
            self.assertNotEqual(res.returncode, 0)
            self.assertIn("default I2C pins are invalid", res.stderr)


if __name__ == "__main__":
    unittest.main()
