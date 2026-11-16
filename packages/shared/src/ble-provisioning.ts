import { chipSupportsBle, chipSupportsIntegratedWifi } from "./board-firmware-compat";

export const HOMECORE_BLE_DEVICE_NAME_PREFIX = "HomecoreOS-";
export const HOMECORE_SETUP_AP_SSID_PREFIX = "HomecoreOS-Setup-";

export const HOMECORE_BLE_SERVICE_UUID =
  "686f6d65-636f-7265-0001-000000000001";
export const HOMECORE_BLE_CHAR_DEVICE_INFO_UUID =
  "686f6d65-636f-7265-0002-000000000001";
export const HOMECORE_BLE_CHAR_HANDSHAKE_UUID =
  "686f6d65-636f-7265-0003-000000000001";
export const HOMECORE_BLE_CHAR_COMMAND_UUID =
  "686f6d65-636f-7265-0004-000000000001";
export const HOMECORE_BLE_CHAR_STATUS_UUID =
  "686f6d65-636f-7265-0005-000000000001";

export const HOMECORE_BLE_PROTOCOL_VERSION = 1;
export const HOMECORE_BLE_MAX_AUTH_ATTEMPTS = 5;
export const HOMECORE_BLE_LOCKOUT_SECONDS = 60;
export const HOMECORE_BLE_SESSION_TTL_SECONDS = 120;
export const HOMECORE_RECOVERY_TIMEOUT_MINUTES = 15;
export const HOMECORE_BOOT_RECOVERY_HOLD_MS = 3000;
export const HOMECORE_BOOT_FACTORY_RESET_HOLD_MS = 10000;

export const HOMECORE_BLE_S1_KDF_LABEL = "HomecoreOS-BLE-S1";
export const HOMECORE_BLE_S1_DEV_PROOF_LABEL = "dev-proof";
export const HOMECORE_BLE_S1_CLI_PROOF_LABEL = "cli-proof";
export const HOMECORE_BLE_DEFAULT_POP = "HOMECORE-S1-POP-V1";

export const HOMECORE_BLE_HS_CLIENT_HELLO = 0x01;
export const HOMECORE_BLE_HS_DEVICE_HELLO = 0x02;
export const HOMECORE_BLE_HS_CLIENT_PROOF = 0x03;
export const HOMECORE_BLE_HS_AUTH_RESULT = 0x04;

export interface BleDeviceInfoPayload {
  board?: string;
  chip: string;
  fw: string;
  mode: "unprovisioned" | "recovery";
  wifi: boolean;
  ble_wifi: boolean;
  paired: boolean;
  mac_suffix: string;
  proto: number;
  s1_mode?: "auto" | "pin";
}

export type BleProvisioningAction =
  | "provision_wifi"
  | "wifi_only"
  | "pair"
  | "recover";

export interface BleCommandPayload {
  action: BleProvisioningAction;
  ssid?: string;
  password?: string;
  backend_url?: string;
  pair_code?: string;
  physical_confirm?: boolean;
}

export type BleStatusState =
  | "idle"
  | "awaiting_auth"
  | "locked_out"
  | "connecting_wifi"
  | "wifi_connected"
  | "wifi_failed"
  | "pairing"
  | "paired"
  | "error";

export interface BleStatusPayload {
  state: BleStatusState;
  wifi_connected: boolean;
  paired: boolean;
  mqtt_connected: boolean;
  ip?: string;
  error?: string;
}

export interface BleBoardSupportSummary {
  supportsBle: boolean;
  supportsWifi: boolean;
  supportsBleWifiProvisioning: boolean;
  modeLabel: "ble_and_wifi" | "wifi_ap_only" | "ble_no_wifi" | "unsupported";
  reason: string | null;
}

export function supportsBleProvisioningForBoard(
  board:
    | {
        slug?: string | null;
        chip_family?: string | null;
        supports_ble?: boolean | null;
        supports_wifi?: boolean | null;
        supports_ble_wifi_provisioning?: boolean | null;
      }
    | null
    | undefined
): BleBoardSupportSummary {
  if (!board) {
    return {
      supportsBle: true,
      supportsWifi: true,
      supportsBleWifiProvisioning: true,
      modeLabel: "ble_and_wifi",
      reason: null,
    };
  }

  const chip = (board.chip_family ?? "").trim().toLowerCase();
  const supportsBle =
    typeof board.supports_ble === "boolean"
      ? board.supports_ble
      : board.slug === "esp32-s2-devkitc-1"
        ? false
        : chip
          ? chipSupportsBle(chip)
          : true;

  const supportsWifi =
    typeof board.supports_wifi === "boolean"
      ? board.supports_wifi
      : board.slug === "esp32-h2-devkitm-1"
        ? false
        : chip
          ? chipSupportsIntegratedWifi(chip)
          : true;

  const supportsBleWifiProvisioning =
    typeof board.supports_ble_wifi_provisioning === "boolean"
      ? board.supports_ble_wifi_provisioning && supportsBle && supportsWifi
      : supportsBle && supportsWifi;

  if (!supportsBle && supportsWifi) {
    return {
      supportsBle: false,
      supportsWifi: true,
      supportsBleWifiProvisioning: false,
      modeLabel: "wifi_ap_only",
      reason:
        "This microcontroller (e.g. ESP32-S2) has no Bluetooth radio. Use the WPA2 Setup AP (HomecoreOS-Setup-XXXX -> http://192.168.4.1) or USB Web Serial.",
    };
  }

  if (supportsBle && !supportsWifi) {
    return {
      supportsBle: true,
      supportsWifi: false,
      supportsBleWifiProvisioning: false,
      modeLabel: "ble_no_wifi",
      reason:
        "This board supports encrypted BLE pairing/configuration but has no integrated Wi-Fi radio (IEEE 802.15.4 / Thread / Matter only).",
    };
  }

  if (!supportsBle && !supportsWifi) {
    return {
      supportsBle: false,
      supportsWifi: false,
      supportsBleWifiProvisioning: false,
      modeLabel: "unsupported",
      reason: "Neither integrated Bluetooth nor Wi-Fi radio is present on this silicon.",
    };
  }

  return {
    supportsBle: true,
    supportsWifi: true,
    supportsBleWifiProvisioning: supportsBleWifiProvisioning,
    modeLabel: "ble_and_wifi",
    reason: null,
  };
}

export function validateBleProvisioningInputs(params: {
  action: BleProvisioningAction;
  setupPin?: string;
  ssid?: string;
  password?: string;
  backendUrl?: string;
  pairCode?: string;
  supportsWifi?: boolean;
}): { valid: boolean; error?: string } {
  if (params.setupPin !== undefined) {
    const pin = params.setupPin.trim();
    if (pin.length < 6 || pin.length > 32) {
      return {
        valid: false,
        error: "Enter the controller's Setup PIN / Proof-of-Possession (6-32 characters).",
      };
    }
  }

  const requiresWifi =
    (params.supportsWifi ?? true) &&
    (params.action === "provision_wifi" || params.action === "wifi_only");

  if (requiresWifi) {
    const ssid = (params.ssid ?? "").trim();
    if (!ssid || ssid.length > 32) {
      return {
        valid: false,
        error: "Enter a valid 2.4 GHz Wi-Fi network name (SSID, 1-32 characters).",
      };
    }
    const pass = params.password ?? "";
    if (pass.length > 63 || (pass.length > 0 && pass.length < 8)) {
      return {
        valid: false,
        error: "WPA2/WPA3 Wi-Fi passphrase must be 8-63 characters (or blank for open network).",
      };
    }
  }

  if (params.action !== "wifi_only") {
    const backend = (params.backendUrl ?? "").trim();
    if (backend && !/^https?:\/\/.+/.test(backend)) {
      return {
        valid: false,
        error: "Backend URL must start with https:// or http://.",
      };
    }
    const code = (params.pairCode ?? "").trim();
    if (!/^\d{6}$/.test(code)) {
      return {
        valid: false,
        error: "Enter the 6-digit pairing or recovery code from HomecoreOS.",
      };
    }
  }

  return { valid: true };
}
