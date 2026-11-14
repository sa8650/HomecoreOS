import type { ReactNode } from "react";

type IconPair = {
  left: [ReactNode, ReactNode, ReactNode];
  right: [ReactNode, ReactNode, ReactNode];
};

// Board Library (ESP32 QFN, GPIO Header, Wi-Fi/BLE, Flash/PSRAM, USB-C, DevKit PCB)
export const BOARD_LIBRARY_HERO_ICONS: IconPair = {
  left: [
    <svg key="bl-l1" viewBox="0 0 36 36" fill="none" className="size-full">
      <rect x="10" y="10" width="16" height="16" rx="2.5" stroke="currentColor" strokeWidth="2" />
      <rect x="14.5" y="14.5" width="7" height="7" rx="1" stroke="currentColor" strokeWidth="1.6" />
      <path d="M14 6v4M18 6v4M22 6v4M14 26v4M18 26v4M22 26v4M6 14h4M6 18h4M6 22h4M26 14h4M26 18h4M26 22h4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>,
    <svg key="bl-l2" viewBox="0 0 36 36" fill="none" className="size-full">
      <rect x="11" y="5" width="14" height="26" rx="2.5" stroke="currentColor" strokeWidth="2" />
      <path d="M15 10h0.5M20.5 10h0.5M15 15h0.5M20.5 15h0.5M15 20h0.5M20.5 20h0.5M15 25h0.5M20.5 25h0.5" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
      <path d="M7 10h4M7 15h4M7 20h4M25 15h4M25 20h4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>,
    <svg key="bl-l3" viewBox="0 0 36 36" fill="none" className="size-full">
      <path d="M7 14c6.2-5.6 15.8-5.6 22 0" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M11 19c3.9-3.5 10.1-3.5 14 0" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M15 24c1.7-1.5 4.3-1.5 6 0" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <circle cx="18" cy="28" r="1.7" fill="currentColor" />
    </svg>,
  ],
  right: [
    <svg key="bl-r1" viewBox="0 0 36 36" fill="none" className="size-full">
      <rect x="9" y="10" width="18" height="16" rx="2" stroke="currentColor" strokeWidth="2" />
      <path d="M13 6v4M18 6v4M23 6v4M13 26v4M18 26v4M23 26v4" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
      <path d="M13 15.5h10M13 20.5h6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>,
    <svg key="bl-r2" viewBox="0 0 36 36" fill="none" className="size-full">
      <rect x="5" y="11.5" width="26" height="13" rx="6.5" stroke="currentColor" strokeWidth="2" />
      <rect x="10.5" y="16" width="15" height="4" rx="2" stroke="currentColor" strokeWidth="1.7" />
      <path d="M13 8v3.5M23 8v3.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>,
    <svg key="bl-r3" viewBox="0 0 36 36" fill="none" className="size-full">
      <rect x="9" y="5" width="18" height="26" rx="2.5" stroke="currentColor" strokeWidth="2" />
      <rect x="13" y="8.5" width="10" height="9" rx="1.2" stroke="currentColor" strokeWidth="1.6" />
      <rect x="15" y="26.5" width="6" height="4.5" rx="1" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="13.5" cy="23" r="1.4" fill="currentColor" />
      <path d="M6 11h3M6 16h3M6 21h3M6 26h3M27 11h3M27 16h3M27 21h3M27 26h3" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>,
  ],
};

// Switches (Toggle Switch, Wall Rocker Plate, Relay Schematic, Light Bulb, Dimmer Slider, Power Outlet)
export const SWITCHES_HERO_ICONS: IconPair = {
  left: [
    <svg key="sw-l1" viewBox="0 0 36 36" fill="none" className="size-full">
      <rect x="5" y="11" width="26" height="14" rx="7" stroke="currentColor" strokeWidth="2" />
      <circle cx="24" cy="18" r="4" stroke="currentColor" strokeWidth="2" />
    </svg>,
    <svg key="sw-l2" viewBox="0 0 36 36" fill="none" className="size-full">
      <rect x="8" y="6" width="20" height="24" rx="3" stroke="currentColor" strokeWidth="2" />
      <rect x="13.5" y="11.5" width="9" height="13" rx="1.5" stroke="currentColor" strokeWidth="1.7" />
      <path d="M15 15.5h6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>,
    <svg key="sw-l3" viewBox="0 0 36 36" fill="none" className="size-full">
      <path d="M6 22h7l10-8M23 22h7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="13" cy="22" r="2" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="23" cy="22" r="2" stroke="currentColor" strokeWidth="1.8" />
      <path d="M18 8v4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>,
  ],
  right: [
    <svg key="sw-r1" viewBox="0 0 36 36" fill="none" className="size-full">
      <path d="M18 7a7 7 0 0 0-4.5 12.3c1 .9 1.5 2 1.5 3.2V24h6v-1.5c0-1.2.5-2.3 1.5-3.2A7 7 0 0 0 18 7z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
      <path d="M15.5 28h5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M18 3v2M8 8l1.5 1.5M28 8l-1.5 1.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>,
    <svg key="sw-r2" viewBox="0 0 36 36" fill="none" className="size-full">
      <path d="M7 13h22M7 23h22" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <circle cx="14" cy="13" r="3" fill="var(--card)" stroke="currentColor" strokeWidth="2" />
      <circle cx="23" cy="23" r="3" fill="var(--card)" stroke="currentColor" strokeWidth="2" />
    </svg>,
    <svg key="sw-r3" viewBox="0 0 36 36" fill="none" className="size-full">
      <circle cx="18" cy="18" r="11" stroke="currentColor" strokeWidth="2" />
      <path d="M14 14v4M22 14v4M18 22.5v2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>,
  ],
};

// Sensors (Thermometer, Humidity Droplet, Motion Radar, Lux Sun, Contact Magnet, Telemetry Gauge)
export const SENSORS_HERO_ICONS: IconPair = {
  left: [
    <svg key="sn-l1" viewBox="0 0 36 36" fill="none" className="size-full">
      <path d="M15 9a3 3 0 1 1 6 0v10.2a5.5 5.5 0 1 1-6 0V9z" stroke="currentColor" strokeWidth="2" />
      <circle cx="18" cy="24" r="2" fill="currentColor" />
      <path d="M18 14v8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>,
    <svg key="sn-l2" viewBox="0 0 36 36" fill="none" className="size-full">
      <path d="M18 6.5S10 15.5 10 21.5a8 8 0 0 0 16 0c0-6-8-15-8-15z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
      <path d="M14.5 22.5a3.5 3.5 0 0 0 3.5 3.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>,
    <svg key="sn-l3" viewBox="0 0 36 36" fill="none" className="size-full">
      <circle cx="18" cy="18" r="3" stroke="currentColor" strokeWidth="2" />
      <path d="M11.5 11.5a9.2 9.2 0 0 0 0 13M24.5 11.5a9.2 9.2 0 0 1 0 13M7.5 8a14.8 14.8 0 0 0 0 20M28.5 8a14.8 14.8 0 0 1 0 20" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>,
  ],
  right: [
    <svg key="sn-r1" viewBox="0 0 36 36" fill="none" className="size-full">
      <circle cx="18" cy="18" r="5" stroke="currentColor" strokeWidth="2" />
      <path d="M18 6v3M18 27v3M6 18h3M27 18h3M9.5 9.5l2.1 2.1M24.4 24.4l2.1 2.1M26.5 9.5l-2.1 2.1M11.6 24.4l-2.1 2.1" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>,
    <svg key="sn-r2" viewBox="0 0 36 36" fill="none" className="size-full">
      <rect x="7" y="8" width="9" height="20" rx="2" stroke="currentColor" strokeWidth="2" />
      <rect x="21" y="12" width="8" height="12" rx="2" stroke="currentColor" strokeWidth="2" />
      <path d="M16 18h5" stroke="currentColor" strokeWidth="1.8" strokeDasharray="2 2" strokeLinecap="round" />
    </svg>,
    <svg key="sn-r3" viewBox="0 0 36 36" fill="none" className="size-full">
      <path d="M8 24a11 11 0 1 1 20 0" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M18 21l5-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <circle cx="18" cy="21" r="2" fill="currentColor" />
      <path d="M12 26h12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>,
  ],
};

// Devices (Ceiling Fan, Smart Lamp, Smart Lock, AC Airflow, Smart TV, Smart Plug)
export const DEVICES_HERO_ICONS: IconPair = {
  left: [
    <svg key="dv-l1" viewBox="0 0 36 36" fill="none" className="size-full">
      <circle cx="18" cy="18" r="3" stroke="currentColor" strokeWidth="2" />
      <path d="M18 15c0-4 2.5-7 5-7s3 2 1 4.5C22.5 14.3 20.5 15 18 15zM21 18c4 0 7 2.5 7 5s-2 3-4.5 1C21.7 22.5 21 20.5 21 18zM18 21c0 4-2.5 7-5 7s-3-2-1-4.5C13.5 21.7 15.5 21 18 21zM15 18c-4 0-7-2.5-7-5s2-3 4.5-1C14.3 13.5 15 15.5 15 18z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
    </svg>,
    <svg key="dv-l2" viewBox="0 0 36 36" fill="none" className="size-full">
      <path d="M10 18l3-9h10l3 9H10z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
      <path d="M18 18v10M13 28h10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>,
    <svg key="dv-l3" viewBox="0 0 36 36" fill="none" className="size-full">
      <rect x="9" y="16" width="18" height="13" rx="2.5" stroke="currentColor" strokeWidth="2" />
      <path d="M13 16v-4a5 5 0 0 1 10 0v4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <circle cx="18" cy="22" r="1.7" fill="currentColor" />
    </svg>,
  ],
  right: [
    <svg key="dv-r1" viewBox="0 0 36 36" fill="none" className="size-full">
      <rect x="6" y="8" width="24" height="10" rx="2.5" stroke="currentColor" strokeWidth="2" />
      <path d="M11 14h14M12 22c0 2-1.5 3-1.5 5M18 22c0 2-1.5 3-1.5 5M24 22c0 2-1.5 3-1.5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>,
    <svg key="dv-r2" viewBox="0 0 36 36" fill="none" className="size-full">
      <rect x="6" y="9" width="24" height="16" rx="2" stroke="currentColor" strokeWidth="2" />
      <path d="M14 28h8M18 25v3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>,
    <svg key="dv-r3" viewBox="0 0 36 36" fill="none" className="size-full">
      <path d="M13 8v5M23 8v5M10 13h16v4a8 8 0 0 1-16 0v-4zM18 25v5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>,
  ],
};

// Firmware & Updates (USB-C Connector, Cloud OTA Download, Verified Shield, Flash IC, Binary Hex, Flash Bolt)
export const FIRMWARE_HERO_ICONS: IconPair = {
  left: [
    <svg key="fw-l1" viewBox="0 0 36 36" fill="none" className="size-full">
      <rect x="11" y="13" width="14" height="13" rx="2" stroke="currentColor" strokeWidth="2" />
      <path d="M14 7v6M22 7v6M18 26v4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M15 18h6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>,
    <svg key="fw-l2" viewBox="0 0 36 36" fill="none" className="size-full">
      <path d="M11 24h14.5a5 5 0 0 0 .8-9.9A6.5 6.5 0 0 0 13.7 12a5.5 5.5 0 0 0-2.7 12z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
      <path d="M18 16v9M14.5 22l3.5 3.5L21.5 22" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>,
    <svg key="fw-l3" viewBox="0 0 36 36" fill="none" className="size-full">
      <path d="M18 6l10 4v8c0 6-4.3 10.5-10 12-5.7-1.5-10-6-10-12v-8l10-4z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
      <path d="M13.5 18l3 3 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>,
  ],
  right: [
    <svg key="fw-r1" viewBox="0 0 36 36" fill="none" className="size-full">
      <rect x="10" y="10" width="16" height="16" rx="2" stroke="currentColor" strokeWidth="2" />
      <path d="M14 6v4M22 6v4M14 26v4M22 26v4M6 14h4M6 22h4M26 14h4M26 22h4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M14 18h8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>,
    <svg key="fw-r2" viewBox="0 0 36 36" fill="none" className="size-full">
      <path d="M13 12l-6 6 6 6M23 12l6 6-6 6M19.5 9l-3 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>,
    <svg key="fw-r3" viewBox="0 0 36 36" fill="none" className="size-full">
      <path d="M20 6L10 20h7l-1 10 10-14h-7l1-10z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
    </svg>,
  ],
};

// Rooms (Floor Plan Grid, Door Swing, Window Frame, Sofa/Lounge, Pendant Lamp, Blueprint Ruler)
export const ROOMS_HERO_ICONS: IconPair = {
  left: [
    <svg key="rm-l1" viewBox="0 0 36 36" fill="none" className="size-full">
      <rect x="6" y="7" width="24" height="22" rx="2" stroke="currentColor" strokeWidth="2" />
      <path d="M18 7v12M6 19h16M22 19v10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>,
    <svg key="rm-l2" viewBox="0 0 36 36" fill="none" className="size-full">
      <path d="M9 28V8h13v20" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M14 28V12l11 3v13" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
      <circle cx="22" cy="20" r="1.3" fill="currentColor" />
    </svg>,
    <svg key="rm-l3" viewBox="0 0 36 36" fill="none" className="size-full">
      <rect x="7" y="8" width="22" height="20" rx="2" stroke="currentColor" strokeWidth="2" />
      <path d="M18 8v20M7 18h22" stroke="currentColor" strokeWidth="1.8" />
    </svg>,
  ],
  right: [
    <svg key="rm-r1" viewBox="0 0 36 36" fill="none" className="size-full">
      <path d="M8 21v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5M6 21a2 2 0 0 1 2-2h20a2 2 0 0 1 2 2v4H6v-4zM9 25v3M27 25v3" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>,
    <svg key="rm-r2" viewBox="0 0 36 36" fill="none" className="size-full">
      <path d="M18 6v7M11 21l3-8h8l3 8H11zM15.5 21a2.5 2.5 0 0 0 5 0" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>,
    <svg key="rm-r3" viewBox="0 0 36 36" fill="none" className="size-full">
      <path d="M8 8v20h20L8 8z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
      <path d="M13 19v4h4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>,
  ],
};

// Controllers (MCU Chip, Wi-Fi Router, Bluetooth Wave, MQTT Mesh Nodes, Health Pulse, Pin Header)
export const CONTROLLERS_HERO_ICONS: IconPair = {
  left: [
    <svg key="ct-l1" viewBox="0 0 36 36" fill="none" className="size-full">
      <rect x="10" y="10" width="16" height="16" rx="2.5" stroke="currentColor" strokeWidth="2" />
      <rect x="14.5" y="14.5" width="7" height="7" rx="1" stroke="currentColor" strokeWidth="1.6" />
      <path d="M14 6v4M18 6v4M22 6v4M14 26v4M18 26v4M22 26v4M6 14h4M6 18h4M6 22h4M26 14h4M26 18h4M26 22h4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>,
    <svg key="ct-l2" viewBox="0 0 36 36" fill="none" className="size-full">
      <rect x="7" y="21" width="22" height="8" rx="2" stroke="currentColor" strokeWidth="2" />
      <path d="M12 21V11M24 21V11M11 25h2M17 25h2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M15 9a5 5 0 0 1 6 0" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>,
    <svg key="ct-l3" viewBox="0 0 36 36" fill="none" className="size-full">
      <path d="M13 12l10 10-5 5V9l5 5-10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>,
  ],
  right: [
    <svg key="ct-r1" viewBox="0 0 36 36" fill="none" className="size-full">
      <circle cx="18" cy="9" r="3" stroke="currentColor" strokeWidth="2" />
      <circle cx="9" cy="25" r="3" stroke="currentColor" strokeWidth="2" />
      <circle cx="27" cy="25" r="3" stroke="currentColor" strokeWidth="2" />
      <path d="M16.5 11.5l-6 11M19.5 11.5l6 11M12 25h12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>,
    <svg key="ct-r2" viewBox="0 0 36 36" fill="none" className="size-full">
      <path d="M5 18h5l3.5-8 4.5 16 4-11 2.5 3H31" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>,
    <svg key="ct-r3" viewBox="0 0 36 36" fill="none" className="size-full">
      <rect x="11" y="6" width="14" height="24" rx="2.5" stroke="currentColor" strokeWidth="2" />
      <path d="M15 11h0.5M20.5 11h0.5M15 16h0.5M20.5 16h0.5M15 21h0.5M20.5 21h0.5M15 26h0.5M20.5 26h0.5" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
    </svg>,
  ],
};

// Automation (Lightning Trigger, Flow Branch, Schedule Clock, Sun Horizon, Logic Node, Play Action)
export const AUTOMATIONS_HERO_ICONS: IconPair = {
  left: [
    <svg key="au-l1" viewBox="0 0 36 36" fill="none" className="size-full">
      <path d="M19.5 6L9 20h8.5l-1.5 10L27 16h-8.5L19.5 6z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
    </svg>,
    <svg key="au-l2" viewBox="0 0 36 36" fill="none" className="size-full">
      <circle cx="10" cy="10" r="3" stroke="currentColor" strokeWidth="2" />
      <circle cx="10" cy="26" r="3" stroke="currentColor" strokeWidth="2" />
      <circle cx="26" cy="18" r="3" stroke="currentColor" strokeWidth="2" />
      <path d="M10 13v10M13 10h6a4 4 0 0 1 4 4v1" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>,
    <svg key="au-l3" viewBox="0 0 36 36" fill="none" className="size-full">
      <circle cx="18" cy="18" r="11" stroke="currentColor" strokeWidth="2" />
      <path d="M18 11v7l4.5 2.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>,
  ],
  right: [
    <svg key="au-r1" viewBox="0 0 36 36" fill="none" className="size-full">
      <path d="M5 24h26M11 24a7 7 0 0 1 14 0" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M18 9v4M9.5 13.5l2.5 2.5M26.5 13.5L24 16" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
    </svg>,
    <svg key="au-r2" viewBox="0 0 36 36" fill="none" className="size-full">
      <rect x="6" y="13" width="8" height="10" rx="2" stroke="currentColor" strokeWidth="2" />
      <rect x="22" y="8" width="8" height="8" rx="2" stroke="currentColor" strokeWidth="2" />
      <rect x="22" y="20" width="8" height="8" rx="2" stroke="currentColor" strokeWidth="2" />
      <path d="M14 18h4M18 12v12M18 12h4M18 24h4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>,
    <svg key="au-r3" viewBox="0 0 36 36" fill="none" className="size-full">
      <circle cx="18" cy="18" r="11" stroke="currentColor" strokeWidth="2" />
      <path d="M15 13l9 5-9 5V13z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
    </svg>,
  ],
};

// Smart Home Planner (Home + Gear, Floor Plan, Checklist, Controller Board, Relay Module, Ruler)
export const PLANNER_HERO_ICONS: IconPair = {
  left: [
    <svg key="pl-l1" viewBox="0 0 36 36" fill="none" className="size-full">
      <path d="M5 17 18 6l13 11" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M8.5 15v14.5h19V15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="18" cy="21.5" r="3.2" stroke="currentColor" strokeWidth="1.8" />
      <path d="M18 16.3v1.6M18 25.1v1.6M12.8 21.5h1.6M21.6 21.5h1.6M14.3 17.8l1.1 1.1M20.6 24.1l1.1 1.1M21.7 17.8l-1.1 1.1M15.4 24.1l-1.1 1.1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>,
    <svg key="pl-l2" viewBox="0 0 36 36" fill="none" className="size-full">
      <rect x="5" y="6" width="26" height="24" rx="2" stroke="currentColor" strokeWidth="2" />
      <path d="M17 6v9M17 21v9M5 18h7M17 15h14M23 15v6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M12 18a5 5 0 0 1 5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>,
    <svg key="pl-l3" viewBox="0 0 36 36" fill="none" className="size-full">
      <rect x="8" y="5" width="20" height="26" rx="2.5" stroke="currentColor" strokeWidth="2" />
      <path d="m12 12 1.6 1.6L16.4 10.8M12 19l1.6 1.6 2.8-2.8M12 26l1.6 1.6 2.8-2.8" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M19.5 12.5H24M19.5 19.5H24M19.5 26.5H24" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>,
  ],
  right: [
    <svg key="pl-r1" viewBox="0 0 36 36" fill="none" className="size-full">
      <rect x="9" y="5" width="18" height="26" rx="2.5" stroke="currentColor" strokeWidth="2" />
      <rect x="13" y="9" width="10" height="8" rx="1.2" stroke="currentColor" strokeWidth="1.6" />
      <path d="M5 10h4M5 15h4M5 20h4M5 25h4M27 10h4M27 15h4M27 20h4M27 25h4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <path d="m13.5 24 2 2 4.5-4.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>,
    <svg key="pl-r2" viewBox="0 0 36 36" fill="none" className="size-full">
      <rect x="5" y="9" width="26" height="18" rx="2.5" stroke="currentColor" strokeWidth="2" />
      <rect x="9" y="13" width="7" height="10" rx="1.2" stroke="currentColor" strokeWidth="1.6" />
      <rect x="20" y="13" width="7" height="10" rx="1.2" stroke="currentColor" strokeWidth="1.6" />
      <path d="M12.5 5v4M23.5 5v4M12.5 27v4M23.5 27v4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>,
    <svg key="pl-r3" viewBox="0 0 36 36" fill="none" className="size-full">
      <path d="M6 24 24 6l6 6-18 18z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
      <path d="m11 19 2.5 2.5M15 15l3.5 3.5M19 11l2.5 2.5M23 7l3.5 3.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>,
  ],
};
