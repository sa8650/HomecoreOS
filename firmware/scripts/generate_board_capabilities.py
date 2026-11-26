#!/usr/bin/env python3
"""Generate compile-time C capability headers from the canonical board registry.

The JSON registry in packages/shared/src/board-capabilities.data.json is the
single source of truth. This script emits:

  hc_board_capabilities.h         full lookup table (checked into the repo)
  hc_board_capabilities_selected.h macros for one board (CMake build dir)

Usage:
  python3 firmware/scripts/generate_board_capabilities.py [--slug SLUG] [--out-dir DIR]

CI runs this with the default slug and checks that the checked-in header is
unchanged. CMake runs it with CONFIG_HOMECORE_BOARD_SLUG at configure time.
"""
from __future__ import annotations

import argparse
import json
import pathlib

REPO = pathlib.Path(__file__).resolve().parents[2]
REGISTRY = REPO / "packages/shared/src/board-capabilities.data.json"
DEFAULT_OUT = REPO / "firmware/main/generated"


def cstr(value: str | None) -> str:
    return "NULL" if value is None else '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def b(value: bool) -> str:
    return "true" if value else "false"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--slug", default="esp32-s3-devkitc-1-n16r8")
    parser.add_argument("--out-dir", type=pathlib.Path, default=DEFAULT_OUT)
    args = parser.parse_args()

    data = json.loads(REGISTRY.read_text())
    boards = data["boards"]
    by_slug = {b["board_id"]: b for b in boards}
    if args.slug not in by_slug:
        raise SystemExit(f"unknown board slug for firmware build: {args.slug}")

    args.out_dir.mkdir(parents=True, exist_ok=True)
    lines = [
        "/* GENERATED FILE - do not edit. Run firmware/scripts/generate_board_capabilities.py. */",
        "#pragma once",
        "#include <stdbool.h>",
        "#include <stddef.h>",
        "#include <stdint.h>",
        "#include <string.h>",
        "",
        "typedef struct {",
        "    const char *board_id;",
        "    const char *chip_target;",
        "    const char *sdk_version;",
        "    const char *framework;",
        "    bool has_wifi;",
        "    bool has_mqtt;",
        "    bool has_espnow;",
        "    bool has_ble_provisioning;",
        "    bool has_softap_provisioning;",
        "    bool has_usb_recovery;",
        "    bool can_controller;",
        "    bool can_node;",
        "    uint16_t espnow_mtu_bytes;",
        "    uint16_t espnow_peer_limit;",
        "    uint16_t espnow_encrypted_peer_limit;",
        "    uint16_t max_controller_nodes;",
        "    uint16_t max_tested_controller_nodes;",
        "    uint32_t mqtt_buffer_bytes;",
        "    uint16_t connectivity_queue_depth;",
        "    uint32_t telemetry_interval_sec;",
        "    uint32_t keepalive_ms;",
        "    uint32_t link_timeout_ms;",
        "    uint32_t recovery_window_ms;",
        "    uint32_t discovery_interval_ms;",
        "    uint32_t connectivity_task_stack_bytes;",
        "    uint16_t flash_mb;",
        "    uint16_t psram_mb;",
        "    uint16_t nominal_sram_kb;",
        "    bool experimental;",
        "    bool hardware_tested;",
        "} hc_board_capability_t;",
        "",
        "static const hc_board_capability_t HC_BOARD_CAPABILITIES[] = {",
    ]
    for board in boards:
        radio, memory, limits, roles, support = (
            board["radio"], board["memory"], board["limits"], board["roles"], board["support"]
        )
        lines.append(
            "    { " + ", ".join([
                cstr(board["board_id"]), cstr(board["chip_target"]), cstr(board["firmware"]["sdk_version"]),
                cstr(board["firmware"]["framework"]), b(radio["wifi"]), b(radio["mqtt"]), b(radio["espnow"]),
                b(radio["ble_provisioning"]), b(radio["softap_provisioning"]), b(radio["usb_recovery"]),
                b("controller" in roles["supported"]), b("node" in roles["supported"]),
                str(radio["espnow_mtu_bytes"]), str(radio["espnow_peer_limit"]),
                str(radio["espnow_encrypted_peer_limit"]), str(limits["max_controller_nodes"]),
                str(limits["max_tested_controller_nodes"]), str(limits["mqtt_buffer_bytes"]),
                str(limits["connectivity_queue_depth"]), str(limits["telemetry_interval_sec"]),
                str(limits["keepalive_ms"]), str(limits["link_timeout_ms"]), str(limits["recovery_window_ms"]),
                str(limits["discovery_interval_ms"]), str(limits["connectivity_task_stack_bytes"]),
                str(memory["flash_mb"]), str(memory["psram_mb"]), str(memory["nominal_sram_kb"]),
                b(support["status"] == "experimental"), b(support["hardware_tested"]),
            ]) + " },"
        )
    lines += [
        "};",
        "",
        "#define HC_BOARD_CAPABILITY_COUNT (sizeof(HC_BOARD_CAPABILITIES) / sizeof(HC_BOARD_CAPABILITIES[0]))",
        "",
        "static inline const hc_board_capability_t *hc_board_capability_for_slug(const char *slug) {",
        "    if (!slug) return NULL;",
        "    for (size_t i = 0; i < HC_BOARD_CAPABILITY_COUNT; ++i) {",
        "        if (strcmp(HC_BOARD_CAPABILITIES[i].board_id, slug) == 0) return &HC_BOARD_CAPABILITIES[i];",
        "    }",
        "    return NULL; /* unknown boards have no capabilities */",
        "}",
        "",
    ]
    (args.out_dir / "hc_board_capabilities.h").write_text("\n".join(lines))

    board = by_slug[args.slug]
    radio, memory, limits, roles = board["radio"], board["memory"], board["limits"], board["roles"]
    sel = [
        "/* GENERATED FILE - do not edit. Generated at firmware configure time. */",
        "#pragma once",
        f'#define HC_BOARD_ID {cstr(board["board_id"])}',
        f'#define HC_BOARD_CHIP {cstr(board["chip_target"])}',
        f'#define HC_BOARD_SDK {cstr(board["firmware"]["sdk_version"])}',
        f'#define HC_BOARD_FRAMEWORK {cstr(board["firmware"]["framework"])}',
        f"#define HC_BOARD_HAS_WIFI {1 if radio['wifi'] else 0}",
        f"#define HC_BOARD_HAS_MQTT {1 if radio['mqtt'] else 0}",
        f"#define HC_BOARD_HAS_ESPNOW {1 if radio['espnow'] else 0}",
        f"#define HC_BOARD_HAS_BLE_PROVISIONING {1 if radio['ble_provisioning'] else 0}",
        f"#define HC_BOARD_HAS_SOFTAP_PROVISIONING {1 if radio['softap_provisioning'] else 0}",
        f"#define HC_BOARD_HAS_USB_RECOVERY {1 if radio['usb_recovery'] else 0}",
        f"#define HC_BOARD_CAN_CONTROLLER {1 if 'controller' in roles['supported'] else 0}",
        f"#define HC_BOARD_CAN_NODE {1 if 'node' in roles['supported'] else 0}",
        f"#define HC_BOARD_ESPNOW_MTU {radio['espnow_mtu_bytes']}",
        f"#define HC_BOARD_ESPNOW_PEERS {radio['espnow_peer_limit']}",
        f"#define HC_BOARD_ENCRYPTED_PEERS {radio['espnow_encrypted_peer_limit']}",
        f"#define HC_BOARD_MAX_NODES {limits['max_controller_nodes']}",
        f"#define HC_BOARD_KEEPALIVE_MS {limits['keepalive_ms']}",
        f"#define HC_BOARD_LINK_TIMEOUT_MS {limits['link_timeout_ms']}",
        f"#define HC_BOARD_RECOVERY_WINDOW_MS {limits['recovery_window_ms']}",
        f"#define HC_BOARD_DISCOVERY_MS {limits['discovery_interval_ms']}",
        f"#define HC_BOARD_TELEMETRY_SEC {limits['telemetry_interval_sec']}",
        f"#define HC_BOARD_MQTT_BUFFER_BYTES {limits['mqtt_buffer_bytes']}",
        f"#define HC_BOARD_QUEUE_DEPTH {limits['connectivity_queue_depth']}",
        f"#define HC_BOARD_TASK_STACK_BYTES {limits['connectivity_task_stack_bytes']}",
        f"#define HC_BOARD_FLASH_MB {memory['flash_mb']}",
        f"#define HC_BOARD_PSRAM_MB {memory['psram_mb']}",
        "",
    ]
    (args.out_dir / "hc_board_capabilities_selected.h").write_text("\n".join(sel))
    print(f"generated capability headers for {args.slug} in {args.out_dir}")


if __name__ == "__main__":
    main()
