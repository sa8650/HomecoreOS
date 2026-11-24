#!/usr/bin/env python3
"""HomecoreOS ESP-IDF firmware build, driver manifest & release package verifier."""

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

FIRMWARE_DRIVER_MANIFEST_VERSION = "1.0"

SUPPORTED_SENSOR_TYPE_ORDER = [
    "temperature_dht22",
    "humidity_dht22",
    "temperature_ds18b20",
    "temperature_bme280",
    "humidity_bme280",
    "pressure_bme280",
    "motion_pir",
    "contact_reed",
    "light_bh1750",
    "analog_voltage",
    "temperature_dht11",
    "humidity_dht11",
    "temperature_sht3x",
    "humidity_sht3x",
    "temperature_aht20",
    "humidity_aht20",
    "temperature_tmp117",
    "presence_ld2410",
    "motion_ld2410",
    "distance_ld2410",
    "presence_ld2450",
    "light_veml7700",
    "tvoc_sgp30",
    "eco2_sgp30",
    "water_leak",
    "water_level",
    "voltage_ina219",
    "current_ina219",
    "power_ina219",
    "voltage_ina226",
    "current_ina226",
    "power_ina226",
    "energy_ina226",
    "voltage_pzem",
    "current_pzem",
    "power_pzem",
    "energy_pzem",
    "current_sct013",
    "soil_moisture",
    "rain_level",
    "gas_mq2",
    "gas_mq135",
]

SENSOR_DRIVER_CATALOG = [
    {
        "id": "dht22",
        "version": "1.0.0",
        "kconfig_flag": "CONFIG_HOMECORE_DRIVER_DHT22",
        "measurements": ["temperature_dht22", "humidity_dht22"],
    },
    {
        "id": "ds18b20",
        "version": "1.0.0",
        "kconfig_flag": "CONFIG_HOMECORE_DRIVER_DS18B20",
        "measurements": ["temperature_ds18b20"],
    },
    {
        "id": "bme280",
        "version": "1.0.0",
        "kconfig_flag": "CONFIG_HOMECORE_DRIVER_BME280",
        "measurements": ["temperature_bme280", "humidity_bme280", "pressure_bme280"],
    },
    {
        "id": "pir",
        "version": "1.0.0",
        "kconfig_flag": "CONFIG_HOMECORE_DRIVER_PIR",
        "measurements": ["motion_pir"],
    },
    {
        "id": "reed",
        "version": "1.0.0",
        "kconfig_flag": "CONFIG_HOMECORE_DRIVER_REED",
        "measurements": ["contact_reed"],
    },
    {
        "id": "bh1750",
        "version": "1.0.0",
        "kconfig_flag": "CONFIG_HOMECORE_DRIVER_BH1750",
        "measurements": ["light_bh1750"],
    },
    {
        "id": "adc_voltage",
        "version": "1.0.0",
        "kconfig_flag": "CONFIG_HOMECORE_DRIVER_ADC_VOLTAGE",
        "measurements": ["analog_voltage"],
    },
    {
        "id": "dht11",
        "version": "1.0.0",
        "kconfig_flag": "CONFIG_HOMECORE_DRIVER_DHT11",
        "measurements": ["temperature_dht11", "humidity_dht11"],
    },
    {
        "id": "sht3x",
        "version": "1.0.0",
        "kconfig_flag": "CONFIG_HOMECORE_DRIVER_SHT3X",
        "measurements": ["temperature_sht3x", "humidity_sht3x"],
    },
    {
        "id": "aht20",
        "version": "1.0.0",
        "kconfig_flag": "CONFIG_HOMECORE_DRIVER_AHT20",
        "measurements": ["temperature_aht20", "humidity_aht20"],
    },
    {
        "id": "tmp117",
        "version": "1.0.0",
        "kconfig_flag": "CONFIG_HOMECORE_DRIVER_TMP117",
        "measurements": ["temperature_tmp117"],
    },
    {
        "id": "ld2410",
        "version": "1.0.0",
        "kconfig_flag": "CONFIG_HOMECORE_DRIVER_LD2410",
        "measurements": ["presence_ld2410", "motion_ld2410", "distance_ld2410"],
    },
    {
        "id": "ld2450",
        "version": "1.0.0",
        "kconfig_flag": "CONFIG_HOMECORE_DRIVER_LD2450",
        "measurements": ["presence_ld2450"],
    },
    {
        "id": "veml7700",
        "version": "1.0.0",
        "kconfig_flag": "CONFIG_HOMECORE_DRIVER_VEML7700",
        "measurements": ["light_veml7700"],
    },
    {
        "id": "sgp30",
        "version": "1.0.0",
        "kconfig_flag": "CONFIG_HOMECORE_DRIVER_SGP30",
        "measurements": ["tvoc_sgp30", "eco2_sgp30"],
    },
    {
        "id": "water_leak",
        "version": "1.0.0",
        "kconfig_flag": "CONFIG_HOMECORE_DRIVER_WATER_LEAK",
        "measurements": ["water_leak"],
    },
    {
        "id": "water_level",
        "version": "1.0.0",
        "kconfig_flag": "CONFIG_HOMECORE_DRIVER_WATER_LEVEL",
        "measurements": ["water_level"],
    },
    {
        "id": "soil_moisture",
        "version": "1.0.0",
        "kconfig_flag": "CONFIG_HOMECORE_DRIVER_SOIL_MOISTURE",
        "measurements": ["soil_moisture"],
    },
    {
        "id": "rain",
        "version": "1.0.0",
        "kconfig_flag": "CONFIG_HOMECORE_DRIVER_RAIN",
        "measurements": ["rain_level"],
    },
    {
        "id": "ina219",
        "version": "1.0.0",
        "kconfig_flag": "CONFIG_HOMECORE_DRIVER_INA219",
        "measurements": ["voltage_ina219", "current_ina219", "power_ina219"],
    },
    {
        "id": "ina226",
        "version": "1.0.0",
        "kconfig_flag": "CONFIG_HOMECORE_DRIVER_INA226",
        "measurements": ["voltage_ina226", "current_ina226", "power_ina226", "energy_ina226"],
    },
    {
        "id": "pzem004t",
        "version": "1.0.0",
        "kconfig_flag": "CONFIG_HOMECORE_DRIVER_PZEM004T",
        "measurements": ["voltage_pzem", "current_pzem", "power_pzem", "energy_pzem"],
    },
    {
        "id": "sct013",
        "version": "1.0.0",
        "kconfig_flag": "CONFIG_HOMECORE_DRIVER_SCT013",
        "measurements": ["current_sct013"],
    },
    {
        "id": "mq2",
        "version": "1.0.0",
        "kconfig_flag": "CONFIG_HOMECORE_DRIVER_MQ2",
        "measurements": ["gas_mq2"],
    },
    {
        "id": "mq135",
        "version": "1.0.0",
        "kconfig_flag": "CONFIG_HOMECORE_DRIVER_MQ135",
        "measurements": ["gas_mq135"],
    },
]

DRIVER_BY_ID = {d["id"]: d for d in SENSOR_DRIVER_CATALOG}

# Catalog-only entries: never claim compiled firmware support even if a stray
# Kconfig flag is enabled. Keep in sync with `hardwareVerificationStatus` in
# packages/shared/src/sensor-drivers.ts.
PLANNED_DRIVER_IDS = {"ld2450", "pzem004t", "sct013"}


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


def parse_flash_mb(flash_size_str: str | None) -> int | None:
    if not flash_size_str:
        return None
    m = re.match(r"^(\d+)\s*MB$", flash_size_str.strip(), re.IGNORECASE)
    return int(m.group(1)) if m else None


def detect_psram_mode_from_sdkconfig(sdk: dict[str, str]) -> str:
    if sdk.get("CONFIG_SPIRAM") != "y":
        return "none"
    if sdk.get("CONFIG_SPIRAM_MODE_OCT") == "y":
        return "octal"
    if sdk.get("CONFIG_SPIRAM_MODE_QUAD") == "y":
        return "quad"
    return "quad"


def extract_compiled_drivers_from_sdkconfig(sdk: dict[str, str]) -> list[dict]:
    compiled: list[dict] = []
    for drv in SENSOR_DRIVER_CATALOG:
        if drv["id"] in PLANNED_DRIVER_IDS:
            continue
        if sdk.get(drv["kconfig_flag"]) == "y":
            compiled.append({
                "id": drv["id"],
                "version": drv["version"],
                "measurements": list(drv["measurements"]),
                "kconfig_flag": drv["kconfig_flag"],
                "status": "compiled",
            })
    return compiled


def compute_driver_manifest_hash(
    *,
    manifest_version: str,
    firmware_version: str,
    target_board_slug: str | None,
    chip_family: str,
    partition_scheme: str | None,
    flash_size_mb: int | None,
    psram_mode: str | None,
    sensor_drivers: list[dict],
) -> str:
    """Computes the exact canonical SHA-256 hash matching packages/shared/src/sensor-drivers.ts."""
    normalized_drivers = sorted(
        [
            {
                "id": str(d["id"]),
                "version": str(d["version"]),
                "measurements": sorted(str(m) for m in (d.get("measurements") or [])),
            }
            for d in sensor_drivers
        ],
        key=lambda item: item["id"],
    )
    canonical = {
        "chip_family": chip_family.strip().lower(),
        "firmware_version": firmware_version.strip(),
        "flash_size_mb": flash_size_mb,
        "manifest_version": manifest_version.strip(),
        "partition_scheme": partition_scheme,
        "psram_mode": psram_mode,
        "sensor_drivers": normalized_drivers,
        "target_board_slug": target_board_slug,
    }
    payload = json.dumps(canonical, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def build_driver_manifest_from_sdkconfig(
    *,
    sdk: dict[str, str],
    firmware_version: str,
    chip_family: str,
    target_board_slug: str,
    partition_scheme: str | None,
    flash_size_mb: int | None,
    psram_mode: str | None,
    idf_version: str | None = None,
    ci_commit_sha: str | None = None,
) -> tuple[dict, list[str], list[str], str]:
    drivers = extract_compiled_drivers_from_sdkconfig(sdk)
    compiled_ids = [d["id"] for d in drivers]
    supported_set = {m for d in drivers for m in d["measurements"]}
    supported_types = [t for t in SUPPORTED_SENSOR_TYPE_ORDER if t in supported_set]
    eff_psram = psram_mode or detect_psram_mode_from_sdkconfig(sdk)

    manifest_hash = compute_driver_manifest_hash(
        manifest_version=FIRMWARE_DRIVER_MANIFEST_VERSION,
        firmware_version=firmware_version,
        target_board_slug=target_board_slug,
        chip_family=chip_family,
        partition_scheme=partition_scheme,
        flash_size_mb=flash_size_mb,
        psram_mode=eff_psram,
        sensor_drivers=drivers,
    )
    driver_manifest = {
        "manifest_version": FIRMWARE_DRIVER_MANIFEST_VERSION,
        "manifest_hash": manifest_hash,
        "release_id": None,
        "firmware_version": firmware_version,
        "target_board_slug": target_board_slug,
        "chip_family": chip_family.strip().lower(),
        "partition_scheme": partition_scheme,
        "flash_size_mb": flash_size_mb,
        "psram_mode": eff_psram,
        "sensor_drivers": drivers,
        "supported_sensor_types": supported_types,
        "build_verification": {
            "verified": True,
            "verifier": "homecoreos-verify-firmware-image",
            "ci_commit_sha": ci_commit_sha or None,
            "idf_version": idf_version or None,
        },
    }
    return driver_manifest, compiled_ids, supported_types, manifest_hash


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
    compiled_drivers = extract_compiled_drivers_from_sdkconfig(sdk)
    compiled_ids = [d["id"] for d in compiled_drivers]

    print(f"Requested release version        : {requested}")
    print(f"sdkconfig CONFIG_HOMECORE_FW_VER : {sdk_ver}")
    print(f"Embedded esp_app_desc_t.version  : {app['version']}")
    print(f"Embedded esp_app_desc_t.project  : {app['project_name']}")
    print(f"Detected image chip family       : {app['chip_family']} (chip_id={app['chip_id']})")
    print(f"Compiled sensor drivers ({len(compiled_ids)})      : {', '.join(compiled_ids) or 'none'}")

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

    if not compiled_ids:
        fail("No CONFIG_HOMECORE_DRIVER_* sensor drivers are enabled in sdkconfig")

    # Verify I2C default pins whenever an I2C sensor driver is compiled
    if any(d in compiled_ids for d in ("bme280", "bh1750")):
        sda_raw = sdk.get("CONFIG_HOMECORE_I2C_DEFAULT_SDA_GPIO", "-1")
        scl_raw = sdk.get("CONFIG_HOMECORE_I2C_DEFAULT_SCL_GPIO", "-1")
        try:
            sda_pin = int(sda_raw)
            scl_pin = int(scl_raw)
        except ValueError:
            fail(f"Invalid I2C default GPIOs in sdkconfig: SDA={sda_raw!r}, SCL={scl_raw!r}")
        if sda_pin < 0 or scl_pin < 0 or sda_pin == scl_pin:
            fail(f"I2C drivers enabled but default I2C pins are invalid: SDA={sda_pin}, SCL={scl_pin}")

    if args.target == "esp32s2":
        if sdk.get("CONFIG_BT_ENABLED") == "y" or sdk.get("CONFIG_BT_NIMBLE_ENABLED") == "y":
            fail("ESP32-S2 has no Bluetooth hardware; CONFIG_BT_ENABLED / CONFIG_BT_NIMBLE_ENABLED must remain disabled")
    elif args.target:
        if sdk.get("CONFIG_BT_ENABLED") != "y" or sdk.get("CONFIG_BT_NIMBLE_ENABLED") != "y":
            fail(f"Target {args.target} must enable NimBLE BLE provisioning (CONFIG_BT_ENABLED=y and CONFIG_BT_NIMBLE_ENABLED=y)")

    if args.psram_mode:
        actual_psram = detect_psram_mode_from_sdkconfig(sdk)
        if actual_psram != args.psram_mode:
            fail(f"sdkconfig PSRAM mode ({actual_psram}) != expected ({args.psram_mode}) for {args.board}")

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
    flash_mb = parse_flash_mb(args.flash_size)
    if flash_mb is not None:
        flash_bytes = flash_mb * 1024 * 1024
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


def cmd_build_release_manifest(args: argparse.Namespace) -> None:
    requested = normalize_version(args.version)
    if not requested:
        fail("Firmware release version is empty.")
    sdk = read_sdkconfig_kv(args.sdkconfig)
    flash_mb = parse_flash_mb(args.flash_size)
    psram_mode = args.psram_mode or detect_psram_mode_from_sdkconfig(sdk)
    driver_manifest, compiled_ids, supported_types, manifest_hash = build_driver_manifest_from_sdkconfig(
        sdk=sdk,
        firmware_version=requested,
        chip_family=args.target,
        target_board_slug=args.board,
        partition_scheme=args.partition_scheme,
        flash_size_mb=flash_mb,
        psram_mode=psram_mode,
        idf_version=args.idf_version or None,
        ci_commit_sha=args.commit_sha or None,
    )

    usb_sha = sha256_file(args.usb_bin)
    ota_sha = sha256_file(args.ota_bin)
    usb_size = os.path.getsize(args.usb_bin)
    ota_size = os.path.getsize(args.ota_bin)
    short_sha = (args.commit_sha or "")[:7] or "local"

    manifest = {
        "name": "HomecoreOS Firmware",
        "version": requested,
        "channel": args.channel or "stable",
        "chip_family": args.target,
        "chip_variant": args.chip_variant,
        "target_board_slug": args.board,
        "partition_scheme": args.partition_scheme,
        "psram_mode": psram_mode,
        "flash_size_mb": flash_mb,
        "flash_mode": args.flash_mode,
        "flash_freq": args.flash_freq,
        "supports_wifi": args.supports_wifi.strip().lower() == "true",
        "supports_ble": args.supports_ble.strip().lower() == "true",
        "supports_ble_wifi_provisioning": args.supports_ble_wifi.strip().lower() == "true",
        "idf_version": args.idf_version,
        "manifest_version": FIRMWARE_DRIVER_MANIFEST_VERSION,
        "manifest_hash": manifest_hash,
        "compiled_sensor_drivers": compiled_ids,
        "supported_sensor_types": supported_types,
        "driver_manifest": driver_manifest,
        "release_notes": (
            f"Automated ESP-IDF {args.idf_version} CI build for {args.board} (commit {short_sha}). "
            f"Includes merged USB factory binary (0x0), OTA application binary (0x20000), "
            f"and verified sensor driver manifest ({len(compiled_ids)} drivers)."
        ),
        "compatible_board_slugs": [args.board],
        "files": [
            {
                "file_type": "usb_factory",
                "file_name": os.path.basename(args.usb_bin),
                "sha256": usb_sha,
                "file_size_bytes": usb_size,
                "flash_address": "0x0",
                "flash_mode": args.flash_mode,
                "flash_freq": args.flash_freq,
                "flash_size": args.flash_size,
            },
            {
                "file_type": "ota_app",
                "file_name": os.path.basename(args.ota_bin),
                "sha256": ota_sha,
                "file_size_bytes": ota_size,
                "flash_address": "0x20000",
            },
        ],
    }

    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, indent=2)
        fh.write("\n")
    print(f"Wrote release manifest {args.out} ({len(compiled_ids)} drivers, hash={manifest_hash[:12]}...)")


def verify_driver_manifest_section(manifest: dict, *, requested_ver: str, target: str, board: str, partition_scheme: str) -> None:
    dm = manifest.get("driver_manifest")
    if not isinstance(dm, dict):
        fail("manifest.json is missing required 'driver_manifest' object")

    if normalize_version(str(dm.get("firmware_version", ""))) != requested_ver:
        fail(f"driver_manifest.firmware_version ({dm.get('firmware_version')!r}) != {requested_ver!r}")
    if dm.get("chip_family") != target:
        fail(f"driver_manifest.chip_family ({dm.get('chip_family')!r}) != {target!r}")
    if dm.get("target_board_slug") != board:
        fail(f"driver_manifest.target_board_slug ({dm.get('target_board_slug')!r}) != {board!r}")
    if dm.get("partition_scheme") != partition_scheme:
        fail(f"driver_manifest.partition_scheme ({dm.get('partition_scheme')!r}) != {partition_scheme!r}")

    drivers = dm.get("sensor_drivers")
    if not isinstance(drivers, list) or len(drivers) == 0:
        fail("driver_manifest.sensor_drivers must be a non-empty list")

    seen_ids: set[str] = set()
    derived_measurements: set[str] = set()
    for entry in drivers:
        if not isinstance(entry, dict):
            fail("driver_manifest.sensor_drivers entries must be objects")
        drv_id = entry.get("id")
        if drv_id not in DRIVER_BY_ID:
            fail(f"Unknown driver_id {drv_id!r} in driver_manifest")
        if drv_id in PLANNED_DRIVER_IDS:
            fail(f"Planned driver {drv_id!r} cannot be claimed as compiled firmware support")
        if drv_id in seen_ids:
            fail(f"Duplicate driver_id {drv_id!r} in driver_manifest")
        seen_ids.add(drv_id)
        for m in entry.get("measurements") or []:
            derived_measurements.add(m)

    expected_hash = compute_driver_manifest_hash(
        manifest_version=str(dm.get("manifest_version") or FIRMWARE_DRIVER_MANIFEST_VERSION),
        firmware_version=str(dm.get("firmware_version") or ""),
        target_board_slug=dm.get("target_board_slug"),
        chip_family=str(dm.get("chip_family") or ""),
        partition_scheme=dm.get("partition_scheme"),
        flash_size_mb=dm.get("flash_size_mb"),
        psram_mode=dm.get("psram_mode"),
        sensor_drivers=drivers,
    )
    declared_hash = dm.get("manifest_hash") or manifest.get("manifest_hash")
    if declared_hash != expected_hash:
        fail(f"driver_manifest.manifest_hash mismatch: declared={declared_hash!r} expected={expected_hash!r}")
    if manifest.get("manifest_hash") and manifest.get("manifest_hash") != expected_hash:
        fail("Top-level manifest.json manifest_hash != driver_manifest.manifest_hash")

    compiled_top = manifest.get("compiled_sensor_drivers")
    if compiled_top is not None and set(compiled_top) != seen_ids:
        fail("manifest.json compiled_sensor_drivers does not match driver_manifest.sensor_drivers")

    supported_top = manifest.get("supported_sensor_types")
    if supported_top is not None and set(supported_top) != derived_measurements:
        fail("manifest.json supported_sensor_types does not match driver_manifest measurements")


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

    verify_driver_manifest_section(
        manifest,
        requested_ver=requested,
        target=args.target,
        board=args.board,
        partition_scheme=args.partition_scheme,
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
        f"usb={usb_size}B, ota={app['size']}B, driver_manifest & sha256 verified."
    )


def cmd_verify_board_overlays(boards_dir: str) -> None:
    if not os.path.isdir(boards_dir):
        fail(f"Boards directory not found: {boards_dir}")
    firmware_root = os.path.dirname(os.path.abspath(boards_dir))
    files = sorted(f for f in os.listdir(boards_dir) if f.endswith(".sdkconfig"))
    if not files:
        fail(f"No .sdkconfig board overlays found in {boards_dir}")

    valid_targets = set(ESP_IMAGE_CHIP_ID_TO_FAMILY.values())
    for fname in files:
        slug = fname[:-10]
        full = os.path.join(boards_dir, fname)
        sdk = read_sdkconfig_kv(full)
        target = sdk.get("CONFIG_IDF_TARGET", "")
        if target == "esp8266":
            fail(f"ESP8266 board overlay {fname} must NOT be placed in ESP-IDF firmware/boards/")
        if target not in valid_targets:
            fail(f"{fname}: invalid or missing CONFIG_IDF_TARGET={target!r}")
        if sdk.get("CONFIG_HOMECORE_BOARD_SLUG") != slug:
            fail(f"{fname}: CONFIG_HOMECORE_BOARD_SLUG ({sdk.get('CONFIG_HOMECORE_BOARD_SLUG')!r}) != {slug!r}")
        part_file = sdk.get("CONFIG_PARTITION_TABLE_CUSTOM_FILENAME", "")
        if not part_file or not os.path.isfile(os.path.join(firmware_root, part_file)):
            fail(f"{fname}: partition table file not found: {part_file!r}")
        if not sdk.get("CONFIG_HOMECORE_PARTITION_SCHEME"):
            fail(f"{fname}: missing CONFIG_HOMECORE_PARTITION_SCHEME")
        if "CONFIG_HOMECORE_BOOT_BUTTON_GPIO" not in sdk:
            fail(f"{fname}: missing CONFIG_HOMECORE_BOOT_BUTTON_GPIO")
        compiled = extract_compiled_drivers_from_sdkconfig(sdk)
        if not compiled:
            fail(f"{fname}: must explicitly enable at least one CONFIG_HOMECORE_DRIVER_* flag")
        if any(d["id"] in ("bme280", "bh1750") for d in compiled):
            sda = int(sdk.get("CONFIG_HOMECORE_I2C_DEFAULT_SDA_GPIO", "-1"))
            scl = int(sdk.get("CONFIG_HOMECORE_I2C_DEFAULT_SCL_GPIO", "-1"))
            if sda < 0 or scl < 0 or sda == scl:
                fail(f"{fname}: invalid default I2C pins SDA={sda}, SCL={scl}")
        if target == "esp32s2" and (sdk.get("CONFIG_BT_ENABLED") == "y" or sdk.get("CONFIG_BT_NIMBLE_ENABLED") == "y"):
            fail(f"{fname}: esp32s2 must not enable BT/NimBLE")

    print(f"Verified {len(files)} ESP-IDF board overlays in {boards_dir}.")


def cmd_verify_esp8266_profile(profile_path: str) -> None:
    if not os.path.isfile(profile_path):
        fail(f"ESP8266 board profile not found: {profile_path}")
    with open(profile_path, "r", encoding="utf-8") as fh:
        prof = json.load(fh)
    if prof.get("board_slug") != "nodemcu-esp8266":
        fail(f"Unexpected ESP8266 board_slug: {prof.get('board_slug')!r}")
    if prof.get("chip_family") != "esp8266":
        fail(f"Unexpected ESP8266 chip_family: {prof.get('chip_family')!r}")
    if prof.get("build_platform") != "esp8266_rtos_sdk":
        fail(f"ESP8266 build_platform must be 'esp8266_rtos_sdk', got {prof.get('build_platform')!r}")
    if prof.get("supports_ble") is not False or prof.get("supports_ble_wifi_provisioning") is not False:
        fail("ESP8266 profile must declare supports_ble=false and supports_ble_wifi_provisioning=false")
    if prof.get("adc_pin") != 17:
        fail(f"NodeMCU ESP8266 dedicated ADC pin must be 17 (A0), got {prof.get('adc_pin')!r}")
    drivers = prof.get("compiled_sensor_drivers") or []
    for d in drivers:
        if d not in DRIVER_BY_ID:
            fail(f"Unknown driver {d!r} in ESP8266 profile")
    if not drivers:
        fail("ESP8266 profile must declare compiled_sensor_drivers")

    # Verify strict isolation from ESP-IDF boards/
    firmware_dir = os.path.dirname(os.path.dirname(os.path.abspath(profile_path)))
    forbidden_overlay = os.path.join(firmware_dir, "boards", "nodemcu-esp8266.sdkconfig")
    if os.path.exists(forbidden_overlay):
        fail(f"ESP8266 must not exist as an ESP-IDF overlay: {forbidden_overlay}")

    print(f"Verified isolated ESP8266 profile ({prof['board_slug']}, {len(drivers)} drivers).")


def main() -> None:
    parser = argparse.ArgumentParser(description="HomecoreOS ESP-IDF firmware verifier")
    parser.add_argument("--write-sdkconfig-version", help="Write sdkconfig.version for the given version")
    parser.add_argument("--out", default="sdkconfig.version", help="Output path")
    parser.add_argument("--verify-build", action="store_true", help="Verify compiled ESP-IDF build artifacts")
    parser.add_argument("--build-release-manifest", action="store_true", help="Build release manifest.json with driver manifest")
    parser.add_argument("--verify-package", action="store_true", help="Verify packaged USB, OTA, and manifest artifacts")
    parser.add_argument("--verify-board-overlays", help="Verify all .sdkconfig board overlays in directory")
    parser.add_argument("--verify-esp8266-profile", help="Verify isolated ESP8266 board-profile.json")
    parser.add_argument("--version", default="", help="Requested firmware version")
    parser.add_argument("--channel", default="stable", help="Release channel")
    parser.add_argument("--target", default="", help="Expected chip family (e.g. esp32s3)")
    parser.add_argument("--chip-variant", default="", help="Chip variant display label")
    parser.add_argument("--board", default="", help="Expected board slug")
    parser.add_argument("--partition-scheme", default="", help="Expected partition scheme")
    parser.add_argument("--psram-mode", default="", help="Expected PSRAM mode (none|quad|octal)")
    parser.add_argument("--flash-size", default="", help="Expected flash size label (e.g. 16MB)")
    parser.add_argument("--flash-mode", default="dio", help="Flash mode (dio|qio)")
    parser.add_argument("--flash-freq", default="80m", help="Flash freq (40m|60m|64m|80m)")
    parser.add_argument("--idf-version", default="", help="ESP-IDF version")
    parser.add_argument("--commit-sha", default="", help="CI commit SHA")
    parser.add_argument("--supports-wifi", default="true", help="true|false")
    parser.add_argument("--supports-ble", default="true", help="true|false")
    parser.add_argument("--supports-ble-wifi", default="true", help="true|false")
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
    elif args.build_release_manifest:
        cmd_build_release_manifest(args)
    elif args.verify_package:
        cmd_verify_package(args)
    elif args.verify_board_overlays:
        cmd_verify_board_overlays(args.verify_board_overlays)
    elif args.verify_esp8266_profile:
        cmd_verify_esp8266_profile(args.verify_esp8266_profile)
    else:
        parser.print_help()
        sys.exit(2)


if __name__ == "__main__":
    main()
