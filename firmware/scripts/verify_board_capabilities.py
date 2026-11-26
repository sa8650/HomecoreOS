#!/usr/bin/env python3
"""Verify the canonical board registry against every repository source of truth.

This is a CI gate: it fails when a board ID is missing, when sdkconfig/chip/
memory metadata disagree, when the ESP8266 profile drifts, when the firmware
build matrix omits a registered board, or when generated C headers are stale.
"""
from __future__ import annotations

import json
import pathlib
import re
import subprocess
import sys
import tempfile

REPO = pathlib.Path(__file__).resolve().parents[2]
REGISTRY = REPO / "packages/shared/src/board-capabilities.data.json"
COMPAT = REPO / "packages/shared/src/board-firmware-compat.ts"
WORKFLOW = REPO / ".github/workflows/build-firmware.yml"
ESP8266_PROFILE = REPO / "firmware/esp8266/board-profile.json"
GENERATOR = REPO / "firmware/scripts/generate_board_capabilities.py"
GENERATED = REPO / "firmware/main/generated"

errors: list[str] = []


def fail(message: str) -> None:
    errors.append(message)


data = json.loads(REGISTRY.read_text())
boards = {b["board_id"]: b for b in data["boards"]}
if len(boards) != len(data["boards"]):
    fail("duplicate board IDs in capability registry")

compat_slugs = set(re.findall(r'^  "([\w-]+)": \{', COMPAT.read_text(), re.M))
for slug in compat_slugs:
    if slug not in boards:
        fail(f"compat profile {slug} has no capability registry entry")
for slug in boards:
    if slug not in compat_slugs:
        fail(f"registry board {slug} has no compat profile")

workflow_slugs = set(re.findall(r'"board_slug": "([\w-]+)"', WORKFLOW.read_text()))
for slug, board in boards.items():
    if board["firmware"]["framework"] != "esp_idf":
        continue
    if slug not in workflow_slugs:
        fail(f"registry board {slug} is missing from the firmware build matrix")

for config in sorted((REPO / "firmware/boards").glob("*.sdkconfig")):
    slug = config.stem
    board = boards.get(slug)
    if not board:
        fail(f"firmware overlay {config.name} has no registry entry")
        continue
    text = config.read_text()

    def config_value(key: str) -> str | None:
        m = re.search(rf'^{key}="?([^"\n]+)"?$', text, re.M)
        return m.group(1).strip() if m else None

    target = config_value("CONFIG_IDF_TARGET")
    if target != board["chip_target"]:
        fail(f"{slug}: sdkconfig target {target} != registry {board['chip_target']}")
    flash = config_value("CONFIG_HOMECORE_FLASH_SIZE_MB")
    if flash != str(board["memory"]["flash_mb"]):
        fail(f"{slug}: sdkconfig flash {flash} != registry {board['memory']['flash_mb']}")
    psram = config_value("CONFIG_HOMECORE_PSRAM_SIZE_MB")
    if psram != str(board["memory"]["psram_mb"]):
        fail(f"{slug}: sdkconfig PSRAM {psram} != registry {board['memory']['psram_mb']}")
    sdk_slug = config_value("CONFIG_HOMECORE_BOARD_SLUG")
    if sdk_slug != slug:
        fail(f"{slug}: overlay board slug is {sdk_slug}")

esp8266 = json.loads(ESP8266_PROFILE.read_text())
board = boards.get("nodemcu-esp8266")
if board:
    if esp8266["chip_family"] != board["chip_target"]:
        fail("ESP8266 chip family drift")
    if esp8266["supports_wifi"] != board["radio"]["wifi"]:
        fail("ESP8266 Wi-Fi capability drift")
    if esp8266["supports_ble"] != board["radio"]["ble_provisioning"]:
        fail("ESP8266 BLE capability drift")
    if board["radio"]["espnow"] or "controller" in board["roles"]["supported"]:
        fail("ESP8266 ESP-NOW/Controller must remain disabled until interoperability tests")

for slug, board in boards.items():
    radio, roles, transports = board["radio"], board["roles"], board["transports"]
    if "espnow" in transports and not radio["espnow"]:
        fail(f"{slug}: espnow transport without radio capability")
    if "wifi_mqtt" in transports and not (radio["wifi"] and radio["mqtt"]):
        fail(f"{slug}: wifi_mqtt transport without Wi-Fi/MQTT capability")
    if "controller" in roles["supported"] and not radio["espnow"]:
        fail(f"{slug}: Controller role without ESP-NOW")
    if radio["espnow"] and radio["espnow_mtu_bytes"] > 250:
        fail(f"{slug}: ESP-NOW MTU exceeds the v1-compatible 250-byte ceiling")
    if board["limits"]["max_controller_nodes"] > radio["espnow_peer_limit"]:
        fail(f"{slug}: Node capacity exceeds peer table")
    if board["limits"]["max_tested_controller_nodes"] > board["limits"]["max_controller_nodes"]:
        fail(f"{slug}: tested Node count exceeds supported Node count")
    if board["support"]["hardware_tested"] and board["support"]["status"] == "unsupported":
        fail(f"{slug}: unsupported board marked hardware-tested")

with tempfile.TemporaryDirectory() as tmp:
    result = subprocess.run(
        [sys.executable, str(GENERATOR), "--out-dir", tmp],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        fail(f"header generator failed: {result.stderr}")
    else:
        for name in ("hc_board_capabilities.h", "hc_board_capabilities_selected.h"):
            generated = pathlib.Path(tmp) / name
            checked_in = GENERATED / name
            if not checked_in.exists() or generated.read_text() != checked_in.read_text():
                fail(f"stale generated header: {name} (run the generator)")

if errors:
    print("board capability verification FAILED:")
    for error in errors:
        print(f"  - {error}")
    sys.exit(1)

print(
    f"board capability verification OK: {len(boards)} profiles, "
    f"{len(list((REPO / 'firmware/boards').glob('*.sdkconfig')))} overlays, "
    "generated headers current"
)
