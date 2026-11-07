/** Platform-wide, transport-independent constants. */

export const PERMISSIONS = [
  { key: 'dashboard.view', category: 'Dashboard access', label: 'View dashboard' },
  { key: 'rooms.manage', category: 'Room management', label: 'Manage rooms' },
  { key: 'boards.manage', category: 'Board management', label: 'Manage controllers' },
  { key: 'devices.manage', category: 'Device management', label: 'Manage devices' },
  { key: 'devices.control', category: 'Switch control', label: 'Control switches' },
  { key: 'sensors.view', category: 'Sensor monitoring', label: 'View sensor telemetry' },
  { key: 'automation.manage', category: 'Automation management', label: 'Manage automation' },
  { key: 'devices.configure', category: 'Device configuration', label: 'Configure devices' },
  { key: 'firmware.update', category: 'Firmware updates', label: 'Manage firmware' },
  { key: 'staff.manage', category: 'Staff management', label: 'Manage staff' },
  { key: 'usage.view', category: 'Usage viewing', label: 'View usage' },
  { key: 'settings.manage', category: 'Account settings', label: 'Manage account settings' },
] as const;

export type PermissionKey = (typeof PERMISSIONS)[number]['key'];

export const SYSTEM_ROLES = [
  { key: 'owner', name: 'Owner', rank: 0, description: 'Complete workspace access' },
  { key: 'administrator', name: 'Administrator', rank: 10, description: 'Manage home hardware and automation' },
  { key: 'operator', name: 'Operator', rank: 20, description: 'Control permitted devices' },
  { key: 'viewer', name: 'Viewer', rank: 30, description: 'Read-only access' },
] as const;

/** EMQX Cloud Serverless free-tier quotas (documented by the provider). */
export const EMQX_QUOTAS = {
  sessionMinutes: 1_000_000,
  trafficBytes: 1_073_741_824, // 1 GB
  ruleActions: 1_000_000,
  maxConnections: 1_000,
  maxMessageBytes: 1_048_576,
} as const;

export const WARNING_THRESHOLDS = [50, 75, 90, 100] as const;

export const CHIP_FAMILIES = [
  'ESP32', 'ESP32-S2', 'ESP32-S3', 'ESP32-C2', 'ESP32-C3',
  'ESP32-C5', 'ESP32-C6', 'ESP32-H2', 'ESP32-P4',
] as const;

export const DEVICE_TYPES = [
  'light', 'fan', 'water_pump', 'relay', 'smart_socket', 'motor', 'main_line_monitor', 'custom',
] as const;

export const SENSOR_CATEGORIES = [
  'temperature', 'humidity', 'motion', 'water_level', 'rain', 'light', 'soil_moisture',
  'contact', 'voltage', 'current', 'power', 'gas', 'air_quality', 'custom',
] as const;

export const PROVISIONING_METHODS = [
  { id: 'mqtt_tls', label: 'MQTT over TLS', scope: 'cloud', detail: 'Primary worldwide control path. Device keeps an outbound TLS connection to EMQX.' },
  { id: 'mqtt_wss', label: 'MQTT over WebSocket', scope: 'cloud', detail: 'Secure WSS transport where the network blocks port 8883.' },
  { id: 'lan', label: 'Local network (LAN)', scope: 'local', detail: 'Same-network control through a supported local gateway; no router port forwarding.' },
  { id: 'ble', label: 'Bluetooth LE', scope: 'provisioning', detail: 'Nearby discovery and Wi-Fi credential hand-off only; not a cloud control path.' },
  { id: 'softap', label: 'ESP32 SoftAP', scope: 'provisioning', detail: 'Temporary access point for initial Wi-Fi setup; not a cloud control path.' },
  { id: 'usb_serial', label: 'USB serial', scope: 'provisioning', detail: 'Initial firmware flashing and recovery; not remote control.' },
] as const;
