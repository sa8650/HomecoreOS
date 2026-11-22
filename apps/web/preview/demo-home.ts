/**
 * Dev-only design harness data.
 *
 * This file exists purely so the floor map can be rendered and reviewed without a
 * running Worker/Supabase stack. Nothing in `src/` imports it — the production
 * Overview page only ever renders the user's real rooms and devices.
 */
import type { OverviewData } from "@/features/types";

const home = { id: "h1", account_id: "a1", name: "Lakeview Home", timezone: "Asia/Dhaka" };

function room(
  id: string,
  name: string,
  type: OverviewData["rooms"][number]["room_type"],
  x: number,
  y: number,
  w: number,
  h: number,
  floorStyle: "wood" | "tile" | "stone" | "carpet" = "wood"
): OverviewData["rooms"][number] {
  return {
    id,
    account_id: "a1",
    home_id: "h1",
    name,
    icon: "home",
    floor_order: 1,
    grid_col_span: 1,
    room_type: type,
    floor_x: x,
    floor_y: y,
    floor_w: w,
    floor_h: h,
    layout_config: { floorStyle },
  };
}

export const demoOverview: OverviewData = {
  summary: {
    totalRooms: 8,
    totalDevices: 9,
    activeDevices: 4,
    totalSwitches: 8,
    activeSwitches: 4,
    totalSensors: 4,
    totalControllers: 2,
    onlineControllers: 2,
    offlineControllers: 0,
  },
  homes: [home],
  rooms: [
    room("media", "Media room", "living_room", 0, 0, 380, 420, "carpet"),
    room("deck", "Deck", "patio", 380, 0, 340, 180, "stone"),
    room("living", "Living room", "living_room", 380, 180, 500, 420, "wood"),
    room("kitchen", "Kitchen", "kitchen", 880, 0, 340, 300, "tile"),
    room("primary", "Primary suite", "bedroom", 880, 300, 340, 300, "carpet"),
    room("bedroom", "Bedroom", "bedroom", 0, 420, 380, 300, "carpet"),
    room("hall", "Hallway", "hallway", 380, 600, 180, 140, "wood"),
    room("dining", "Dining room", "dining", 560, 600, 320, 140, "tile"),
    room("laundry", "Laundry room", "utility", 880, 600, 130, 260, "tile"),
    room("bath", "Bathroom", "bathroom", 1010, 600, 210, 260, "tile"),
  ],
  controllers: [
    {
      id: "c1",
      account_id: "a1",
      home_id: "h1",
      room_id: "media",
      board_profile_id: "b1",
      custom_board_profile_id: null,
      name: "Media Hub",
      hardware_uid: "esp-1",
      board_model: "ESP32-S3-DevKitC-1",
      chip_variant: "ESP32-S3",
      flash_size_mb: 16,
      psram_size_mb: 8,
      firmware_version: "1.5.0",
      status: "online",
      mqtt_connected: true,
      wifi_ssid: "Lakeview",
      wifi_rssi: -48,
      local_ip: "192.168.1.20",
      last_heartbeat_at: new Date().toISOString(),
      last_communication_at: new Date().toISOString(),
      paired_at: "2026-01-01T00:00:00Z",
      connection_history: [],
    },
    {
      id: "c2",
      account_id: "a1",
      home_id: "h1",
      room_id: "kitchen",
      board_profile_id: "b2",
      custom_board_profile_id: null,
      name: "Kitchen Hub",
      hardware_uid: "esp-2",
      board_model: "XIAO ESP32-S3",
      chip_variant: "ESP32-S3",
      flash_size_mb: 8,
      psram_size_mb: 8,
      firmware_version: "1.5.0",
      status: "online",
      mqtt_connected: true,
      wifi_ssid: "Lakeview",
      wifi_rssi: -61,
      local_ip: "192.168.1.21",
      last_heartbeat_at: new Date().toISOString(),
      last_communication_at: new Date().toISOString(),
      paired_at: "2026-01-01T00:00:00Z",
      connection_history: [],
    },
  ],
  switches: [
    { id: "sw-media", account_id: "a1", home_id: "h1", room_id: "media", board_instance_id: "c1", name: "Media ceiling lights", gpio_pin: 4, is_on: true, inverted: false, is_online: true, last_changed_at: null },
    { id: "sw-living", account_id: "a1", home_id: "h1", room_id: "living", board_instance_id: "c1", name: "Living room lights", gpio_pin: 5, is_on: true, inverted: false, is_online: true, last_changed_at: null },
    { id: "sw-kitchen", account_id: "a1", home_id: "h1", room_id: "kitchen", board_instance_id: "c2", name: "Kitchen downlights", gpio_pin: 6, is_on: true, inverted: false, is_online: true, last_changed_at: null },
    { id: "sw-deck", account_id: "a1", home_id: "h1", room_id: "deck", board_instance_id: "c1", name: "Deck string lights", gpio_pin: 7, is_on: true, inverted: false, is_online: true, last_changed_at: null },
    { id: "sw-primary", account_id: "a1", home_id: "h1", room_id: "primary", board_instance_id: "c2", name: "Primary suite lamps", gpio_pin: 8, is_on: false, inverted: false, is_online: true, last_changed_at: null },
    { id: "sw-bedroom", account_id: "a1", home_id: "h1", room_id: "bedroom", board_instance_id: "c1", name: "Bedroom lights", gpio_pin: 9, is_on: false, inverted: false, is_online: true, last_changed_at: null },
    { id: "sw-dining", account_id: "a1", home_id: "h1", room_id: "dining", board_instance_id: "c2", name: "Dining pendant", gpio_pin: 10, is_on: false, inverted: false, is_online: true, last_changed_at: null },
    { id: "sw-bath", account_id: "a1", home_id: "h1", room_id: "bath", board_instance_id: "c2", name: "Bathroom light", gpio_pin: 11, is_on: false, inverted: false, is_online: true, last_changed_at: null },
  ],
  devices: [
    { id: "dev-tv", account_id: "a1", home_id: "h1", room_id: "media", board_instance_id: "c1", name: "Media TV", device_type: "tv", gpio_pin: 12, state: "on", is_online: true },
    { id: "dev-fan-living", account_id: "a1", home_id: "h1", room_id: "living", board_instance_id: "c1", name: "Ceiling fan", device_type: "fan", gpio_pin: 13, state: "speed_3", is_online: true },
    { id: "dev-ac-living", account_id: "a1", home_id: "h1", room_id: "living", board_instance_id: "c1", name: "Split AC", device_type: "ac", gpio_pin: 14, state: "on", is_online: true },
    { id: "dev-cam-porch", account_id: "a1", home_id: "h1", room_id: "deck", board_instance_id: "c1", name: "Deck camera", device_type: "camera", gpio_pin: 15, state: "on", is_online: true },
    { id: "dev-fridge", account_id: "a1", home_id: "h1", room_id: "kitchen", board_instance_id: "c2", name: "Fridge plug", device_type: "plug", gpio_pin: 16, state: "on", is_online: true },
    { id: "dev-lock", account_id: "a1", home_id: "h1", room_id: "hall", board_instance_id: "c2", name: "Front door lock", device_type: "lock", gpio_pin: 17, state: "locked", is_online: true },
    { id: "dev-fan-primary", account_id: "a1", home_id: "h1", room_id: "primary", board_instance_id: "c2", name: "Bedroom fan", device_type: "fan", gpio_pin: 18, state: "off", is_online: true },
    { id: "dev-cam-laundry", account_id: "a1", home_id: "h1", room_id: "laundry", board_instance_id: "c2", name: "Laundry camera", device_type: "camera", gpio_pin: 19, state: "off", is_online: false },
    { id: "dev-speaker", account_id: "a1", home_id: "h1", room_id: "dining", board_instance_id: "c2", name: "Dining speaker", device_type: "speaker", gpio_pin: 20, state: "off", is_online: true },
  ],
  sensors: [
    { id: "sen-temp-living", account_id: "a1", home_id: "h1", room_id: "living", board_instance_id: "c1", name: "Living temperature", sensor_type: "temperature_dht22", gpio_pin: 21, unit: "°C", last_value: 27.4, last_raw_payload: null, is_online: true, last_reading_at: new Date().toISOString() },
    { id: "sen-hum-living", account_id: "a1", home_id: "h1", room_id: "living", board_instance_id: "c1", name: "Living humidity", sensor_type: "humidity_dht22", gpio_pin: 21, unit: "%", last_value: 58, last_raw_payload: null, is_online: true, last_reading_at: new Date().toISOString() },
    { id: "sen-motion-hall", account_id: "a1", home_id: "h1", room_id: "hall", board_instance_id: "c2", name: "Hall motion", sensor_type: "motion_pir", gpio_pin: 22, unit: "", last_value: null, last_raw_payload: null, is_online: true, last_reading_at: null },
    { id: "sen-temp-primary", account_id: "a1", home_id: "h1", room_id: "primary", board_instance_id: "c2", name: "Suite temperature", sensor_type: "temperature_ds18b20", gpio_pin: 23, unit: "°C", last_value: 24.1, last_raw_payload: null, is_online: true, last_reading_at: new Date().toISOString() },
  ],
  recentActivity: [
    { id: "a-1", account_id: "a1", board_instance_id: "c1", category: "switch", action: "toggle", summary: "Living room lights turned on", created_at: new Date().toISOString() },
    { id: "a-2", account_id: "a1", board_instance_id: "c1", category: "controller", action: "heartbeat", summary: "Media Hub heartbeat received", created_at: new Date().toISOString() },
  ],
};
