/**
 * Helios verified ESP32 board catalog — SINGLE SOURCE OF TRUTH.
 *
 * Rules (do not relax):
 *  - Every pin row below is transcribed from the "Header Block" table of the
 *    official Espressif dev-kit user guide listed in `doc_source_url`.
 *  - Chip-family entries with no verified header table have `pins: []` and
 *    pin_status: "pending_verification". We never invent a pin map.
 *  - `restricted` pins are physically unavailable (flash/PSRAM/boot button).
 *  - `boot_strapping` pins are exposed but require a warning at boot.
 *  - Function lists are board header functions, not chip theoretical muxes.
 *
 * Run `node scripts/board-catalog.mjs` to regenerate:
 *   packages/core/data/board-catalog.json
 *   supabase/migrations/0008_board_catalog.sql
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const GENERIC = ['gpio', 'pwm', 'i2c', 'spi', 'uart'];

/** Compact pin spec helper. */
function p(gpio, label, side, no, o = {}) {
  return {
    gpio,
    header_label: label,
    side,
    header_pin: no,
    functions: o.f || GENERIC,
    adc_channels: o.adc || [],
    adc_bits: o.adc ? 12 : null,
    input_only: !!o.input,
    exposed: o.exposed !== false,
    boot_strapping: !!o.boot,
    usb_jtag: !!o.usb,
    flash_connected: !!o.flash,
    psram_connected: !!o.psram,
    touch_channel: o.touch || null,
    rtc_gpio: !!o.rtc,
    restricted: !!o.restricted,
    restriction_note: o.note || null,
    notes: o.notes || null,
  };
}

const ADC2_NOTE = 'ADC2 channels cannot be used while Wi-Fi is active on this chip; prefer ADC1 for analog sensors.';

// ---------------------------------------------------------------------------
// 1. ESP32-DevKitC V4 (ESP32-WROOM-32E) — official J2 / J3 header tables
// ---------------------------------------------------------------------------
const devkitcV4 = [
  p(36, 'VP', 'J2', 3, { f: ['gpio', 'adc', 'rtc'], adc: ['ADC1_CH0'], input: true, rtc: true, notes: ADC2_NOTE }),
  p(39, 'VN', 'J2', 4, { f: ['gpio', 'adc', 'rtc'], adc: ['ADC1_CH3'], input: true, rtc: true }),
  p(34, 'IO34', 'J2', 5, { f: ['gpio', 'adc', 'rtc'], adc: ['ADC1_CH6'], input: true, rtc: true }),
  p(35, 'IO35', 'J2', 6, { f: ['gpio', 'adc', 'rtc'], adc: ['ADC1_CH7'], input: true, rtc: true }),
  p(32, 'IO32', 'J2', 7, { f: [...GENERIC, 'adc', 'dac'], adc: ['ADC1_CH4'], touch: 'TOUCH9', rtc: true }),
  p(33, 'IO33', 'J2', 8, { f: [...GENERIC, 'adc', 'dac'], adc: ['ADC1_CH5'], touch: 'TOUCH8', rtc: true }),
  p(25, 'IO25', 'J2', 9, { f: [...GENERIC, 'adc', 'dac'], adc: ['ADC2_CH8'], notes: ADC2_NOTE }),
  p(26, 'IO26', 'J2', 10, { f: [...GENERIC, 'adc', 'dac'], adc: ['ADC2_CH9'], notes: ADC2_NOTE }),
  p(27, 'IO27', 'J2', 11, { f: [...GENERIC, 'adc'], adc: ['ADC2_CH7'], touch: 'TOUCH7', notes: ADC2_NOTE }),
  p(14, 'IO14', 'J2', 12, { f: [...GENERIC, 'adc', 'jtag'], adc: ['ADC2_CH6'], touch: 'TOUCH6', notes: ADC2_NOTE }),
  p(12, 'IO12', 'J2', 13, { f: [...GENERIC, 'adc', 'jtag'], adc: ['ADC2_CH5'], touch: 'TOUCH5', boot: true, notes: 'MTDI strapping pin: must be low at boot on 3.3 V flash modules; avoid as a relay output.' }),
  p(13, 'IO13', 'J2', 15, { f: [...GENERIC, 'adc', 'jtag'], adc: ['ADC2_CH4'], touch: 'TOUCH4', notes: ADC2_NOTE }),
  p(9, 'D2', 'J2', 16, { f: ['flash'], flash: true, restricted: true, note: 'Connected to internal SPI flash (D2); not usable as GPIO on WROOM-32E modules.' }),
  p(10, 'D3', 'J2', 17, { f: ['flash'], flash: true, restricted: true, note: 'Connected to internal SPI flash (D3); not usable as GPIO on WROOM-32E modules.' }),
  p(11, 'CMD', 'J2', 18, { f: ['flash'], flash: true, restricted: true, note: 'Connected to internal SPI flash (CMD); not usable as GPIO.' }),
  p(23, 'IO23', 'J3', 2, {}),
  p(22, 'IO22', 'J3', 3, {}),
  p(1, 'TX', 'J3', 4, { f: ['gpio', 'uart', 'pwm'], notes: 'U0TXD — connected to the on-board USB-to-UART bridge; avoid for other uses while flashing or logging.' }),
  p(3, 'RX', 'J3', 5, { f: ['gpio', 'uart', 'pwm'], notes: 'U0RXD — connected to the on-board USB-to-UART bridge.' }),
  p(21, 'IO21', 'J3', 6, {}),
  p(19, 'IO19', 'J3', 8, {}),
  p(18, 'IO18', 'J3', 9, {}),
  p(5, 'IO5', 'J3', 10, { boot: true, notes: 'Strapping pin (SDIO slave / VDD_SDIO timing); state at boot matters. Verify before driving a relay.' }),
  p(17, 'IO17', 'J3', 11, { psram: true, notes: 'Used by PSRAM on WROVER-E / WROVER-IE variants. Available on WROOM-32E / WROOM-32UE only.' }),
  p(16, 'IO16', 'J3', 12, { psram: true, notes: 'Used by PSRAM on WROVER-E / WROVER-IE variants. Available on WROOM-32E / WROOM-32UE only.' }),
  p(4, 'IO4', 'J3', 13, { f: [...GENERIC, 'adc'], adc: ['ADC2_CH0'], touch: 'TOUCH0', boot: true, notes: ADC2_NOTE }),
  p(0, 'IO0', 'J3', 14, { f: [...GENERIC, 'adc'], adc: ['ADC2_CH1'], touch: 'TOUCH1', boot: true, notes: 'Boot button strapping pin. Must be high to run normally; driving it low at reset enters download mode.' }),
  p(2, 'IO2', 'J3', 15, { f: [...GENERIC, 'adc'], adc: ['ADC2_CH2'], touch: 'TOUCH2', boot: true, notes: ADC2_NOTE }),
  p(15, 'IO15', 'J3', 16, { f: [...GENERIC, 'adc', 'jtag'], adc: ['ADC2_CH3'], touch: 'TOUCH3', boot: true, notes: 'MTDO strapping pin; must be high at boot for normal SDIO operation.' }),
  p(8, 'D1', 'J3', 17, { f: ['flash'], flash: true, restricted: true, note: 'Connected to internal SPI flash (D1); not usable as GPIO.' }),
  p(7, 'D0', 'J3', 18, { f: ['flash'], flash: true, restricted: true, note: 'Connected to internal SPI flash (D0); not usable as GPIO.' }),
  p(6, 'CLK', 'J3', 19, { f: ['flash'], flash: true, restricted: true, note: 'Connected to internal SPI flash (CLK); not usable as GPIO.' }),
];

// ---------------------------------------------------------------------------
// 2. ESP32-S3-DevKitC-1 v1.1 — official J1 / J3 header tables
// ---------------------------------------------------------------------------
const s3 = [
  p(4, '4', 'J1', 4, { f: [...GENERIC, 'adc'], adc: ['ADC1_CH3'], touch: 'TOUCH4', rtc: true }),
  p(5, '5', 'J1', 5, { f: [...GENERIC, 'adc'], adc: ['ADC1_CH4'], touch: 'TOUCH5', rtc: true }),
  p(6, '6', 'J1', 6, { f: [...GENERIC, 'adc'], adc: ['ADC1_CH5'], touch: 'TOUCH6', rtc: true }),
  p(7, '7', 'J1', 7, { f: [...GENERIC, 'adc'], adc: ['ADC1_CH6'], touch: 'TOUCH7', rtc: true }),
  p(15, '15', 'J1', 8, { f: [...GENERIC, 'adc'], adc: ['ADC2_CH4'], rtc: true }),
  p(16, '16', 'J1', 9, { f: [...GENERIC, 'adc'], adc: ['ADC2_CH5'], rtc: true }),
  p(17, '17', 'J1', 10, { f: [...GENERIC, 'adc'], adc: ['ADC2_CH6'], rtc: true }),
  p(18, '18', 'J1', 11, { f: [...GENERIC, 'adc'], adc: ['ADC2_CH7'], rtc: true }),
  p(8, '8', 'J1', 12, { f: [...GENERIC, 'adc'], adc: ['ADC1_CH7'], touch: 'TOUCH8', rtc: true }),
  p(3, '3', 'J1', 13, { f: [...GENERIC, 'adc'], adc: ['ADC1_CH2'], touch: 'TOUCH3', rtc: true, boot: true, notes: 'Strapping pin on ESP32-S3 (JTAG signal source). Verify boot state before use.' }),
  p(46, '46', 'J1', 14, { boot: true, notes: 'Strapping pin: selects VDD_SPI source and controls ROM log printing.' }),
  p(9, '9', 'J1', 15, { f: [...GENERIC, 'adc'], adc: ['ADC1_CH8'], touch: 'TOUCH9', rtc: true }),
  p(10, '10', 'J1', 16, { f: [...GENERIC, 'adc'], adc: ['ADC1_CH9'], touch: 'TOUCH10', rtc: true }),
  p(11, '11', 'J1', 17, { f: [...GENERIC, 'adc'], adc: ['ADC2_CH0'], touch: 'TOUCH11', rtc: true }),
  p(12, '12', 'J1', 18, { f: [...GENERIC, 'adc'], adc: ['ADC2_CH1'], touch: 'TOUCH12', rtc: true }),
  p(13, '13', 'J1', 19, { f: [...GENERIC, 'adc'], adc: ['ADC2_CH2'], touch: 'TOUCH13', rtc: true }),
  p(14, '14', 'J1', 20, { f: [...GENERIC, 'adc'], adc: ['ADC2_CH3'], touch: 'TOUCH14', rtc: true }),
  p(43, 'TX', 'J3', 2, { f: ['gpio', 'uart', 'pwm'], notes: 'U0TXD — USB-to-UART bridge; reserved while flashing/logging.' }),
  p(44, 'RX', 'J3', 3, { f: ['gpio', 'uart', 'pwm'], notes: 'U0RXD — USB-to-UART bridge.' }),
  p(1, '1', 'J3', 4, { f: [...GENERIC, 'adc'], adc: ['ADC1_CH0'], touch: 'TOUCH1', rtc: true }),
  p(2, '2', 'J3', 5, { f: [...GENERIC, 'adc'], adc: ['ADC1_CH1'], touch: 'TOUCH2', rtc: true }),
  p(42, '42', 'J3', 6, { f: [...GENERIC, 'jtag'], notes: 'MTMS (JTAG).' }),
  p(41, '41', 'J3', 7, { f: [...GENERIC, 'jtag'], notes: 'MTDI (JTAG).' }),
  p(40, '40', 'J3', 8, { f: [...GENERIC, 'jtag'], notes: 'MTDO (JTAG).' }),
  p(39, '39', 'J3', 9, { f: [...GENERIC, 'jtag'], notes: 'MTCK (JTAG).' }),
  p(38, '38', 'J3', 10, { notes: 'Drives the addressable RGB LED on some DevKitC-1 variants; check your module.' }),
  p(37, '37', 'J3', 11, { psram: true, notes: 'SPIDQS / FSPIIO — occupied by octal SPI flash/PSRAM on N16R8 and N32R16V variants. Verify your module before assigning.' }),
  p(36, '36', 'J3', 12, { psram: true, notes: 'FSPICLK — occupied by octal SPI flash/PSRAM on N16R8 and N32R16V variants.' }),
  p(35, '35', 'J3', 13, { psram: true, notes: 'FSPID — occupied by octal SPI flash/PSRAM on N16R8 and N32R16V variants.' }),
  p(0, '0', 'J3', 14, { boot: true, rtc: true, notes: 'Boot strapping pin (BOOT button).' }),
  p(45, '45', 'J3', 15, { boot: true, notes: 'Strapping pin: VDD_SPI voltage selection.' }),
  p(48, '48', 'J3', 16, {}),
  p(47, '47', 'J3', 17, {}),
  p(21, '21', 'J3', 18, { rtc: true }),
  p(20, '20', 'J3', 19, { f: [...GENERIC, 'usb'], usb: true, adc: ['ADC2_CH9'], rtc: true, notes: 'USB_D+ on ESP32-S3; do not use as GPIO when native USB is active.' }),
  p(19, '19', 'J3', 20, { f: [...GENERIC, 'usb'], usb: true, adc: ['ADC2_CH8'], rtc: true, notes: 'USB_D- on ESP32-S3; do not use as GPIO when native USB is active.' }),
];

// ---------------------------------------------------------------------------
// 3. ESP32-C3-DevKitM-1 v1 — official J1 / J3 header tables
// ---------------------------------------------------------------------------
const c3 = [
  p(2, 'IO2', 'J1', 4, { adc: ['ADC1_CH2'], boot: true, notes: 'Strapping pin (FSPIQ); also ADC1_CH2. Boot state matters.' }),
  p(3, 'IO3', 'J1', 5, { adc: ['ADC1_CH3'] }),
  p(0, 'IO0', 'J1', 9, { adc: ['ADC1_CH0'], notes: 'XTAL_32K_P; usable as GPIO with care.' }),
  p(1, 'IO1', 'J1', 10, { adc: ['ADC1_CH1'], notes: 'XTAL_32K_N; usable as GPIO with care.' }),
  p(10, 'IO10', 'J1', 11, { notes: 'FSPICS0; typically free on MINI-1 modules.' }),
  p(21, 'TX', 'J3', 2, { f: ['gpio', 'uart', 'pwm'], notes: 'U0TXD — USB-to-UART bridge.' }),
  p(20, 'RX', 'J3', 3, { f: ['gpio', 'uart', 'pwm'], notes: 'U0RXD — USB-to-UART bridge.' }),
  p(9, 'IO9', 'J3', 5, { boot: true, restricted: true, note: 'Connected to the BOOT button and is a strapping pin; held low to enter download mode. Not usable as a general output.' }),
  p(8, 'IO8', 'J3', 6, { boot: true, notes: 'Drives the on-board addressable RGB LED and is a strapping pin. Usable but must be high at boot.' }),
  p(7, 'IO7', 'J3', 8, { notes: 'FSPID / MTDO.' }),
  p(6, 'IO6', 'J3', 9, { notes: 'FSPICLK / MTCK.' }),
  p(5, 'IO5', 'J3', 10, { adc: ['ADC2_CH0'], notes: 'FSPIWP / MTDI; ADC2_CH0.' }),
  p(4, 'IO4', 'J3', 11, { adc: ['ADC1_CH4'], notes: 'FSPIHD / MTMS; ADC1_CH4.' }),
  p(18, 'IO18', 'J3', 13, { f: [...GENERIC, 'usb'], usb: true, notes: 'USB_D- on ESP32-C3; unavailable as GPIO when native USB is in use.' }),
  p(19, 'IO19', 'J3', 14, { f: [...GENERIC, 'usb'], usb: true, notes: 'USB_D+ on ESP32-C3; unavailable as GPIO when native USB is in use.' }),
];

// ---------------------------------------------------------------------------
// 4. ESP32-C6-DevKitC-1 v1.2 — official J1 / J3 header tables
// ---------------------------------------------------------------------------
const c6 = [
  p(4, '4', 'J1', 3, { f: [...GENERIC, 'adc', 'jtag'], adc: ['ADC1_CH4'], notes: 'MTMS / LP_UART_RXD / FSPIHD.' }),
  p(5, '5', 'J1', 4, { f: [...GENERIC, 'adc', 'jtag'], adc: ['ADC1_CH5'], notes: 'MTDI / LP_UART_TXD / FSPIWP.' }),
  p(6, '6', 'J1', 5, { f: [...GENERIC, 'adc', 'jtag'], adc: ['ADC1_CH6'], notes: 'MTCK / LP_I2C_SDA / FSPICLK.' }),
  p(7, '7', 'J1', 6, { f: [...GENERIC, 'jtag'], notes: 'MTDO / LP_I2C_SCL / FSPID.' }),
  p(0, '0', 'J1', 7, { f: [...GENERIC, 'adc'], adc: ['ADC1_CH0'], notes: 'XTAL_32K_P / LP_GPIO0.' }),
  p(1, '1', 'J1', 8, { f: [...GENERIC, 'adc'], adc: ['ADC1_CH1'], notes: 'XTAL_32K_N / LP_GPIO1.' }),
  p(8, '8', 'J1', 9, { boot: true, notes: 'Strapping pin on ESP32-C6; boot state matters.' }),
  p(10, '10', 'J1', 10, {}),
  p(11, '11', 'J1', 11, {}),
  p(2, '2', 'J1', 12, { f: [...GENERIC, 'adc'], adc: ['ADC1_CH2'], notes: 'LP_GPIO2 / FSPIQ.' }),
  p(3, '3', 'J1', 13, { f: [...GENERIC, 'adc'], adc: ['ADC1_CH3'], notes: 'LP_GPIO3.' }),
  p(16, 'TX', 'J3', 2, { f: ['gpio', 'uart', 'pwm'], notes: 'U0TXD — USB-to-UART bridge / FSPICS0.' }),
  p(17, 'RX', 'J3', 3, { f: ['gpio', 'uart', 'pwm'], notes: 'U0RXD — USB-to-UART bridge / FSPICS1.' }),
  p(15, '15', 'J3', 4, { boot: true, notes: 'Strapping pin on ESP32-C6; verify boot state.' }),
  p(23, '23', 'J3', 5, { notes: 'SDIO_DATA3.' }),
  p(22, '22', 'J3', 6, { notes: 'SDIO_DATA2.' }),
  p(21, '21', 'J3', 7, { notes: 'SDIO_DATA1 / FSPICS5.' }),
  p(20, '20', 'J3', 8, { notes: 'SDIO_DATA0 / FSPICS4.' }),
  p(19, '19', 'J3', 9, { notes: 'SDIO_CLK / FSPICS3.' }),
  p(18, '18', 'J3', 10, { notes: 'SDIO_CMD / FSPICS2.' }),
  p(9, '9', 'J3', 11, { boot: true, notes: 'Strapping pin on ESP32-C6; verify boot state.' }),
  p(13, '13', 'J3', 13, { f: [...GENERIC, 'usb'], usb: true, notes: 'USB_D+ on ESP32-C6; unavailable as GPIO when native USB is in use.' }),
  p(12, '12', 'J3', 14, { f: [...GENERIC, 'usb'], usb: true, notes: 'USB_D- on ESP32-C6; unavailable as GPIO when native USB is in use.' }),
];

export const BOARDS = [
  {
    id: 'espressif.esp32-devkitc-v4.wroom32e',
    manufacturer: 'Espressif', model: 'ESP32-DevKitC V4', variant: 'ESP32-WROOM-32E / 32UE',
    chip_family: 'ESP32', chip_variant: 'ESP32-WROOM-32E', revision: 'V4', category: 'devkit',
    doc_source_url: 'https://docs.espressif.com/projects/esp-dev-kits/en/latest/esp32/esp32-devkitc/user_guide.html',
    pinout_url: 'https://docs.espressif.com/projects/esp-dev-kits/en/latest/esp32/_images/esp32_devkitC_v4_pinlayout.png',
    summary: 'Dual-core ESP32 classic devkit. 38-pin headers; GPIO6–11 are consumed by internal SPI flash.',
    attributes: { flash_mb: 4, psram_mb: 0, wifi: '2.4 GHz', ble: 'BLE 4.2', cores: 2, usb: 'USB-to-UART bridge' },
    version: 1, pin_status: 'verified', pins: devkitcV4,
  },
  {
    id: 'espressif.esp32-s3-devkitc-1.v1.1',
    manufacturer: 'Espressif', model: 'ESP32-S3-DevKitC-1', variant: 'N8 / N16R8 / N32R16V',
    chip_family: 'ESP32-S3', chip_variant: 'ESP32-S3-WROOM-1', revision: 'v1.1', category: 'devkit',
    doc_source_url: 'https://docs.espressif.com/projects/esp-dev-kits/en/latest/esp32s3/esp32-s3-devkitc-1/user_guide_v1.1.html',
    pinout_url: 'https://docs.espressif.com/projects/esp-dev-kits/en/latest/esp32s3/_images/ESP32-S3_DevKitC-1_pinlayout_v1.1.jpg',
    summary: '44-pin dual headers, AI-vector instructions, native USB-OTG. Octal-PSRAM variants reserve GPIO35–37.',
    attributes: { flash_mb: '8/16/32', psram_mb: '0/2/8/16 (variant dependent)', wifi: '2.4 GHz', ble: 'BLE 5', cores: 2, usb: 'USB-OTG + USB-to-UART' },
    version: 1, pin_status: 'verified', pins: s3,
  },
  {
    id: 'espressif.esp32-c3-devkitm-1.v1',
    manufacturer: 'Espressif', model: 'ESP32-C3-DevKitM-1', variant: 'ESP32-C3-MINI-1 (N4X)',
    chip_family: 'ESP32-C3', chip_variant: 'ESP32-C3-MINI-1', revision: 'v1.0', category: 'devkit',
    doc_source_url: 'https://docs.espressif.com/projects/esp-dev-kits/en/latest/esp32c3/esp32-c3-devkitm-1/user_guide.html',
    pinout_url: 'https://docs.espressif.com/projects/esp-dev-kits/en/latest/esp32c3/_images/esp32-c3-devkitm-1-v1-pinout.png',
    summary: 'Compact RISC-V board. Flash SPI pins are not broken out; GPIO9 is the BOOT button.',
    attributes: { flash_mb: 4, psram_mb: 0, wifi: '2.4 GHz', ble: 'BLE 5', cores: 1, usb: 'USB Serial/JTAG' },
    version: 1, pin_status: 'verified', pins: c3,
  },
  {
    id: 'espressif.esp32-c6-devkitc-1.v1.2',
    manufacturer: 'Espressif', model: 'ESP32-C6-DevKitC-1', variant: 'ESP32-C6-WROOM-1',
    chip_family: 'ESP32-C6', chip_variant: 'ESP32-C6-WROOM-1', revision: 'v1.2', category: 'devkit',
    doc_source_url: 'https://docs.espressif.com/projects/esp-dev-kits/en/latest/esp32c6/esp32-c6-devkitc-1/user_guide.html',
    pinout_url: 'https://docs.espressif.com/projects/esp-dev-kits/en/latest/esp32c6/_images/esp32-c6-devkitc-1-pin-layout.png',
    summary: 'Wi-Fi 6 / Thread / Zigbee RISC-V devkit with two USB-C ports and J5 current-measurement header.',
    attributes: { flash_mb: 4, psram_mb: 0, wifi: '2.4 GHz Wi-Fi 6', ieee802154: true, cores: 1, usb: 'USB Serial/JTAG' },
    version: 1, pin_status: 'verified', pins: c6,
  },
  // Chip families that are supported by the platform but whose DEV BOARD header
  // map has not been transcribed and verified yet. No pins are invented.
  ...[
    ['ESP32-S2', 'ESP32-S2', 'https://docs.espressif.com/projects/esp-dev-kits/en/latest/esp32s2/index.html', 'Single-core USB-OTG capable ESP32 variant.'],
    ['ESP32-C2', 'ESP32-C2', 'https://www.espressif.com/en/products/socs/esp32-c2', 'Cost-optimised RISC-V Wi-Fi + BLE variant.'],
    ['ESP32-C5', 'ESP32-C5', 'https://www.espressif.com/en/products/socs/esp32-c5', 'Dual-band Wi-Fi 6 RISC-V variant.'],
    ['ESP32-H2', 'ESP32-H2', 'https://docs.espressif.com/projects/esp-dev-kits/en/latest/esp32h2/index.html', 'Thread / Zigbee / BLE SoC without Wi-Fi.'],
    ['ESP32-P4', 'ESP32-P4', 'https://docs.espressif.com/projects/esp-dev-kits/en/latest/esp32p4/index.html', 'High-performance MCU with no on-chip wireless; needs a host radio.'],
  ].map(([family, variant, url, summary]) => ({
    id: `family.${family.toLowerCase().replace(/-/g, '')}`,
    manufacturer: 'Espressif', model: `${family} family`, variant,
    chip_family: family, chip_variant: variant, revision: null, category: 'chip_family',
    doc_source_url: url, pinout_url: null, summary,
    attributes: { note: 'Chip family entry. A verified dev-board header map is required before GPIO allocation.' },
    version: 1, pin_status: 'pending_verification', pins: [],
  })),
];

// ---------------------------------------------------------------------------
// Emit JSON + SQL
// ---------------------------------------------------------------------------
const q = (v) => v === null || v === undefined ? 'null'
  : typeof v === 'boolean' ? (v ? 'true' : 'false')
  : typeof v === 'number' ? String(v)
  : `'${String(v).replace(/'/g, "''")}'`;
const arr = (a) => `array[${a.map(q).join(',')}]::text[]`;
const json = (o) => `${q(JSON.stringify(o))}::jsonb`;

const lines = [];
lines.push('-- Generated by scripts/board-catalog.mjs — DO NOT EDIT BY HAND.');
lines.push('-- Pin maps transcribed from official Espressif dev-kit user guides.');
lines.push('');
lines.push('insert into public.board_catalog (id, manufacturer, model, variant, chip_family, chip_variant, revision, category, image_url, pinout_url, doc_source_url, summary, connectivity, attributes, active) values');
lines.push(BOARDS.map((b) => `  (${[b.id, b.manufacturer, b.model, b.variant, b.chip_family, b.chip_variant, b.revision, b.category, null, b.pinout_url, b.doc_source_url, b.summary].map(q).join(', ')}, '{}'::jsonb, ${json({ ...b.attributes, pin_status: b.pin_status, catalog_version: b.version })}, true)`).join(',\n') + '\non conflict (id) do update set manufacturer = excluded.manufacturer, model = excluded.model, variant = excluded.variant, chip_family = excluded.chip_family, chip_variant = excluded.chip_variant, revision = excluded.revision, summary = excluded.summary, pinout_url = excluded.pinout_url, doc_source_url = excluded.doc_source_url, attributes = excluded.attributes, updated_at = now();');
lines.push('');
lines.push('insert into public.board_catalog_versions (board_id, version, changelog, published) values');
lines.push(BOARDS.map((b, i) => `  (${q(b.id)}, ${b.version}, ${q(b.pin_status === 'verified' ? 'Initial verified header-pin map from official Espressif user guide.' : 'Chip family registered; dev-board pin map pending verification.')}, true)`).join(',\n') + '\non conflict (board_id, version) do nothing;');
lines.push('');
const allPins = BOARDS.flatMap((b) => b.pins.map((x) => ({ b, x })));
lines.push('insert into public.board_catalog_pins (board_id, gpio, header_label, side, header_pin, functions, adc_channels, adc_bits, input_only, exposed, boot_strapping, usb_jtag, flash_connected, psram_connected, touch_channel, rtc_gpio, restricted, restriction_note, notes) values');
lines.push(allPins.map(({ b, x }) => `  (${[b.id, x.gpio, x.header_label, x.side, x.header_pin].map(q).join(', ')}, ${arr(x.functions)}, ${arr(x.adc_channels)}, ${q(x.adc_bits)}, ${x.input_only}, ${x.exposed}, ${x.boot_strapping}, ${x.usb_jtag}, ${x.flash_connected}, ${x.psram_connected}, ${q(x.touch_channel)}, ${x.rtc_gpio}, ${x.restricted}, ${q(x.restriction_note)}, ${q(x.notes)})`).join(',\n'));
lines.push('on conflict (board_id, gpio) do update set header_label = excluded.header_label, side = excluded.side, header_pin = excluded.header_pin, functions = excluded.functions, adc_channels = excluded.adc_channels, input_only = excluded.input_only, boot_strapping = excluded.boot_strapping, usb_jtag = excluded.usb_jtag, flash_connected = excluded.flash_connected, psram_connected = excluded.psram_connected, restricted = excluded.restricted, restriction_note = excluded.restriction_note, notes = excluded.notes;');
lines.push('');

mkdirSync(resolve(ROOT, 'packages/core/data'), { recursive: true });
writeFileSync(resolve(ROOT, 'packages/core/data/board-catalog.json'), JSON.stringify({ generated_at: 'build', schema_version: 1, boards: BOARDS }, null, 2) + '\n');
writeFileSync(resolve(ROOT, 'supabase/migrations/0008_board_catalog.sql'), lines.join('\n'));
console.log(`Board catalog: ${BOARDS.length} boards, ${allPins.length} verified pin rows.`);
