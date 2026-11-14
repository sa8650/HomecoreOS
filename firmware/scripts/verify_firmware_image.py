#!/usr/bin/env python3
"""HomecoreOS ESP-IDF firmware build & release package verification tool."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import struct
import sys

ESP_IMAGE_CHIP_ID_TO_FAMILY = {
    0: "esp32",
    2: "esp32s2",
    5: "esp32c3",
    9: "esp32s3",
    12: "esp32c2",
    13: "esp32c6",
    16: "esp32h2",
    18: "esp32p4",
    20: "esp32c61",
    23: "esp32c5",
    25: "esp32h21",
    28: "esp32h4",
    32: "esp32s31",
}

ESP_APP_DESC_MAGIC = 0xABCD5432


def fail(msg: str) -> None:
    print(f"ERROR: {msg}", file=sys.stderr)
    sys.exit(1)


def normalize_version(ver: str) -> str:
    return ver.strip().lstrip("vV")


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            chunk = f.read(65536)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


def parse_app_image(path: str) -> dict:
    if not os.path.isfile(path):
        fail(f"Application binary not found: {path}")
    size = os.path.getsize(path)
    if size < 0x90:
        fail(f"Application binary too small ({size} bytes): {path}")

    with open(path, "rb") as f:
        hdr = f.read(0x8040)

    if hdr[0] != 0xE9:
        fail(f"Invalid ESP-IDF image magic 0x{hdr[0]:02x} (expected 0xE9) in {path}")
    if (
        len(hdr) >= 0x8040
        and hdr[0x8000] == 0xAA
        and hdr[0x8001] == 0x50
        and hdr[0x8020] == 0xAA
        and hdr[0x8021] == 0x50
    ):
        fail(f"OTA binary {path} contains partition table at 0x8000 (looks like USB factory image)")

    chip_id = struct.unpack_from("<H", hdr, 12)[0]
    chip_family = ESP_IMAGE_CHIP_ID_TO_FAMILY.get(chip_id)
    magic = struct.unpack_from("<I", hdr, 0x20)[0]
    if magic != ESP_APP_DESC_MAGIC:
        fail(f"Invalid esp_app_desc_t magic 0x{magic:08x} at 0x20 in {path}")

    embedded_ver = hdr[0x30:0x50].split(b"\x00", 1)[0].decode("utf-8", errors="replace").strip()
    embedded_proj = hdr[0x50:0x70].split(b"\x00", 1)[0].decode("utf-8", errors="replace").strip()

    return {
        "size": size,
        "chip_id": chip_id,
        "chip_family": chip_family,
        "version": embedded_ver,
        "project_name": embedded_proj,
    }


def parse_partition_table(path: str) -> list[dict]:
    if not os.path.isfile(path):
        fail(f"Partition table binary missing: {path}")
    with open(path, "rb") as f:
        pt_data = f.read()

    entries = []
    for off in range(0, len(pt_data) - 31, 32):
        if pt_data[off] == 0xAA and pt_data[off + 1] == 0x50:
            ptype, psub, poff, psize = struct.unpack_from("<BBII", pt_data, off + 2)
            label = pt_data[off + 12 : off + 28].split(b"\x00", 1)[0].decode("utf-8", errors="replace")
            entries.append({
                "type": ptype,
                "subtype": psub,
                "offset": poff,
                "size": psize,
                "label": label,
            })
    if not entries:
        fail(f"No valid partition entries found in {path}")
    return entries


def read_sdkconfig_kv(path: str) -> dict[str, str]:
    if not os.path.isfile(path):
        fail(f"sdkconfig not found: {path}")
    kv: dict[str, str] = {}
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            if v.startswith('"') and v.endswith('"') and len(v) >= 2:
                v = v[1:-1]
            kv[k] = v
    return kv


def cmd_write_sdkconfig_version(version: str, out_path: str) -> None:
    clean = normalize_version(version)
    if not clean or any(c in clean for c in ['"', "\n", "\r", "'"]):
        fail(f"Invalid firmware version string: {version!r}")
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(f'CONFIG_HOMECORE_FW_VERSION="{clean}"\n')
    print(f"Wrote {out_path} with CONFIG_HOMECORE_FW_VERSION={clean}")


def cmd_verify_build(args: argparse.Namespace) -> None:
    requested = normalize_version(args.version)
    if not requested:
        fail("Requested firmware version is empty.")

    env_ver = normalize_version(os.environ.get("HOMECORE_FW_VERSION", ""))
    if env_ver and env_ver != requested:
        fail(f"HOMECORE_FW_VERSION env ({env_ver!r}) != --version ({requested!r})")

    sdk = read_sdkconfig_kv(args.sdkconfig)
    sdk_ver = normalize_version(sdk.get("CONFIG_HOMECORE_FW_VERSION", ""))
    sdk_target = sdk.get("CONFIG_IDF_TARGET", "")
    sdk_board = sdk.get("CONFIG_HOMECORE_BOARD_SLUG", "")
    sdk_scheme = sdk.get("CONFIG_HOMECORE_PARTITION_SCHEME", "")
    sdk_rollback = sdk.get("CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE", "")

    app = parse_app_image(args.image)
    entries = parse_partition_table(args.partition_table)

    print(f"Requested release version        : {requested}")
    print(f"sdkconfig CONFIG_HOMECORE_FW_VER : {sdk_ver}")
    print(f"Embedded esp_app_desc_t.version  : {app['version']}")
    print(f"Embedded esp_app_desc_t.project  : {app['project_name']}")
    print(f"Detected image chip family       : {app['chip_family']} (chip_id={app['chip_id']})")

    if sdk_ver != requested:
        fail(f"sdkconfig CONFIG_HOMECORE_FW_VERSION ({sdk_ver!r}) != requested ({requested!r})")
    if normalize_version(app["version"]) != requested:
        fail(f"Embedded esp_app_desc_t.version ({app['version']!r}) != requested ({requested!r})")
    if app["project_name"] != "homecoreos":
        fail(f"Unexpected esp_app_desc_t.project_name ({app['project_name']!r}); expected 'homecoreos'")
    if args.target and app["chip_family"] and app["chip_family"] != args.target:
        fail(f"Image chip_family ({app['chip_family']}) != target ({args.target})")
    if args.target and sdk_target and sdk_target != args.target:
        fail(f"sdkconfig CONFIG_IDF_TARGET ({sdk_target!r}) != target ({args.target!r})")
    if args.board and sdk_board and sdk_board != args.board:
        fail(f"sdkconfig CONFIG_HOMECORE_BOARD_SLUG ({sdk_board!r}) != board ({args.board!r})")
    if args.partition_scheme and sdk_scheme and sdk_scheme != args.partition_scheme:
        fail(f"sdkconfig CONFIG_HOMECORE_PARTITION_SCHEME ({sdk_scheme!r}) != scheme ({args.partition_scheme!r})")
    if sdk_rollback != "y":
        fail("CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE=y must remain enabled")

    if args.target == "esp32s2":
        if sdk.get("CONFIG_BT_ENABLED") == "y" or sdk.get("CONFIG_BT_NIMBLE_ENABLED") == "y":
            fail("ESP32-S2 has no Bluetooth hardware; CONFIG_BT_ENABLED / CONFIG_BT_NIMBLE_ENABLED must remain disabled")
    elif args.target:
        if sdk.get("CONFIG_BT_ENABLED") != "y" or sdk.get("CONFIG_BT_NIMBLE_ENABLED") != "y":
            fail(f"Target {args.target} must enable NimBLE BLE provisioning (CONFIG_BT_ENABLED=y and CONFIG_BT_NIMBLE_ENABLED=y)")

    if args.board == "esp32-s3-devkitc-1-n16r8":
        if sdk.get("CONFIG_ESPTOOLPY_FLASHSIZE_16MB") != "y":
            fail("ESP32-S3 N16R8 must have CONFIG_ESPTOOLPY_FLASHSIZE_16MB=y")
        if sdk.get("CONFIG_ESPTOOLPY_FLASHMODE_QIO") != "y":
            fail("ESP32-S3 N16R8 must have CONFIG_ESPTOOLPY_FLASHMODE_QIO=y")
        if sdk.get("CONFIG_SPIRAM") != "y" or sdk.get("CONFIG_SPIRAM_MODE_OCT") != "y":
            fail("ESP32-S3 N16R8 must enable 8MB Octal PSRAM (CONFIG_SPIRAM_MODE_OCT=y)")

    has_nvs = any(e["type"] == 0x01 and e["subtype"] == 0x02 for e in entries)
    has_otadata = any(e["type"] == 0x01 and e["subtype"] == 0x00 for e in entries)
    ota_slots = [e for e in entries if e["type"] == 0x00 and e["subtype"] in (0x10, 0x11)]

    if not has_nvs:
        fail("Partition table missing 'nvs' data partition")
    if not has_otadata:
        fail("Partition table missing 'otadata' partition required for OTA rollback")
    if len(ota_slots) < 2:
        fail(f"Dual OTA partitions (ota_0, ota_1) missing in {args.partition_table}: {entries}")

    min_slot_bytes = min(e["size"] for e in ota_slots)
    max_part_end = max(e["offset"] + e["size"] for e in entries)
    if args.flash_size:
        m = re.match(r"^(\d+)MB$", args.flash_size.strip(), re.IGNORECASE)
        if m:
            flash_bytes = int(m.group(1)) * 1024 * 1024
            if max_part_end > flash_bytes:
                fail(f"Partition layout end (0x{max_part_end:x}) exceeds flash ({args.flash_size})")

    print(
        f"Verified dual-OTA partitions ({len(ota_slots)} slots, min slot={min_slot_bytes} bytes), "
        f"homecoreos.bin={app['size']} bytes"
    )
    if app["size"] > min_slot_bytes:
        fail(f"homecoreos.bin ({app['size']} bytes) exceeds partition slot ({min_slot_bytes} bytes)")
    if args.max_ota_bytes and app["size"] > args.max_ota_bytes:
        fail(f"homecoreos.bin ({app['size']} bytes) exceeds max_ota_bytes ({args.max_ota_bytes} bytes)")


def cmd_verify_package(args: argparse.Namespace) -> None:
    requested = normalize_version(args.version)
    app = parse_app_image(args.ota_bin)
    if normalize_version(app["version"]) != requested:
        fail(f"OTA package binary version ({app['version']!r}) != requested ({requested!r})")
    if args.target and app["chip_family"] and app["chip_family"] != args.target:
        fail(f"OTA package chip_family ({app['chip_family']}) != target ({args.target})")

    if not os.path.isfile(args.usb_bin):
        fail(f"USB factory binary missing: {args.usb_bin}")
    usb_size = os.path.getsize(args.usb_bin)
    if usb_size <= app["size"]:
        fail(
            f"USB factory binary ({usb_size} bytes) is not larger than OTA app ({app['size']} bytes); "
            "factory and OTA binaries may be mixed up"
        )

    boot_off = int(args.bootloader_offset, 16)
    with open(args.usb_bin, "rb") as uf:
        usb_hdr = uf.read(max(0x8020, boot_off + 24))
    if len(usb_hdr) < max(0x8020, boot_off + 24):
        fail(f"USB factory binary too small ({len(usb_hdr)} bytes)")
    if usb_hdr[boot_off] != 0xE9:
        fail(f"USB factory binary missing 0xE9 bootloader magic at 0x{boot_off:x}")
    if usb_hdr[0x8000] != 0xAA or usb_hdr[0x8001] != 0x50:
        fail("USB factory binary missing partition table magic 0xAA50 at 0x8000")

    if not os.path.isfile(args.manifest):
        fail(f"Release manifest missing: {args.manifest}")
    with open(args.manifest, "r", encoding="utf-8") as mf:
        manifest = json.load(mf)

    if normalize_version(str(manifest.get("version", ""))) != requested:
        fail(f"manifest.json version ({manifest.get('version')!r}) != requested ({requested!r})")
    if manifest.get("chip_family") != args.target:
        fail(f"manifest.json chip_family ({manifest.get('chip_family')!r}) != {args.target!r}")
    if manifest.get("target_board_slug") != args.board:
        fail(f"manifest.json target_board_slug ({manifest.get('target_board_slug')!r}) != {args.board!r}")
    if manifest.get("partition_scheme") != args.partition_scheme:
        fail(f"manifest.json partition_scheme ({manifest.get('partition_scheme')!r}) != {args.partition_scheme!r}")

    expected_ble = args.target not in ("esp32s2", "esp32p4")
    expected_ble_wifi = args.target not in ("esp32s2", "esp32p4", "esp32h2", "esp32h21", "esp32h4")
    if "supports_ble" in manifest and bool(manifest.get("supports_ble")) != expected_ble:
        fail(f"manifest.json supports_ble ({manifest.get('supports_ble')!r}) != expected {expected_ble!r} for {args.target}")
    if "supports_ble_wifi_provisioning" in manifest and bool(manifest.get("supports_ble_wifi_provisioning")) != expected_ble_wifi:
        fail(
            f"manifest.json supports_ble_wifi_provisioning ({manifest.get('supports_ble_wifi_provisioning')!r}) "
            f"!= expected {expected_ble_wifi!r} for {args.target}"
        )

    files = manifest.get("files") or []
    by_type = {f.get("file_type"): f for f in files}
    if "usb_factory" not in by_type or "ota_app" not in by_type:
        fail("manifest.json must contain both usb_factory and ota_app entries")

    for ftype, bin_path in [("usb_factory", args.usb_bin), ("ota_app", args.ota_bin)]:
        entry = by_type[ftype]
        expected_name = os.path.basename(bin_path)
        if entry.get("file_name") != expected_name:
            fail(f"manifest.json {ftype}.file_name ({entry.get('file_name')}) != {expected_name}")
        actual_sha = sha256_file(bin_path)
        actual_sz = os.path.getsize(bin_path)
        if entry.get("sha256") != actual_sha:
            fail(f"manifest.json {ftype}.sha256 mismatch for {expected_name}")
        if entry.get("file_size_bytes") != actual_sz:
            fail(f"manifest.json {ftype}.file_size_bytes mismatch for {expected_name}")

    print(
        f"Verified release package for {args.board} v{requested}: "
        f"usb={usb_size}B, ota={app['size']}B, sha256 verified."
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="HomecoreOS ESP-IDF firmware verifier")
    parser.add_argument("--write-sdkconfig-version", help="Write sdkconfig.version for the given version")
    parser.add_argument("--out", default="sdkconfig.version", help="Output path for sdkconfig.version")
    parser.add_argument("--verify-build", action="store_true", help="Verify compiled ESP-IDF build artifacts")
    parser.add_argument("--verify-package", action="store_true", help="Verify packaged USB, OTA, and manifest artifacts")
    parser.add_argument("--version", default="", help="Requested firmware version")
    parser.add_argument("--target", default="", help="Expected chip family (e.g. esp32s3)")
    parser.add_argument("--board", default="", help="Expected board slug")
    parser.add_argument("--partition-scheme", default="", help="Expected partition scheme")
    parser.add_argument("--flash-size", default="", help="Expected flash size label (e.g. 16MB)")
    parser.add_argument("--bootloader-offset", default="0x0", help="Expected bootloader flash offset hex")
    parser.add_argument("--max-ota-bytes", type=int, default=0, help="Maximum allowed OTA image size in bytes")
    parser.add_argument("--image", default="build/homecoreos.bin", help="Compiled OTA application binary")
    parser.add_argument("--sdkconfig", default="sdkconfig", help="Generated sdkconfig file")
    parser.add_argument("--partition-table", default="build/partition_table/partition-table.bin", help="Compiled partition table binary")
    parser.add_argument("--usb-bin", default="", help="Packaged USB factory binary")
    parser.add_argument("--ota-bin", default="", help="Packaged OTA binary")
    parser.add_argument("--manifest", default="", help="Packaged manifest.json path")

    args = parser.parse_args()

    if args.write_sdkconfig_version is not None:
        cmd_write_sdkconfig_version(args.write_sdkconfig_version, args.out)
    elif args.verify_build:
        cmd_verify_build(args)
    elif args.verify_package:
        cmd_verify_package(args)
    else:
        parser.print_help()
        sys.exit(2)


if __name__ == "__main__":
    main()
