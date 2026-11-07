/** Shared GPIO compatibility rules (used by UI and server-side validation). */

export type PinFunction = 'output' | 'input' | 'adc' | 'pwm' | 'dac' | 'i2c' | 'spi' | 'uart' | 'pulse';
export type PinState = 'available' | 'assigned' | 'system' | 'restricted' | 'incompatible';

export interface PinLike {
  gpio: number;
  header_label?: string | null;
  side?: string | null;
  header_pin?: number | null;
  state: string;
  restricted: boolean;
  boot_strapping: boolean;
  usb_jtag: boolean;
  flash_connected: boolean;
  psram_connected: boolean;
  input_only: boolean;
  functions: string[];
  adc_channels: string[];
  notes?: string | null;
  restriction_note?: string | null;
}

export interface PinEvaluation {
  state: PinState;
  reason: string | null;
  warnings: string[];
}

export function evaluatePin(pin: PinLike, fn: PinFunction): PinEvaluation {
  const warnings: string[] = [];
  if (pin.restricted) {
    return {
      state: 'restricted',
      reason: pin.restriction_note || `GPIO ${pin.gpio} is hardware-reserved on this board.`,
      warnings,
    };
  }
  if (pin.state === 'assigned') {
    return { state: 'assigned', reason: `GPIO ${pin.gpio} is already assigned on this board.`, warnings };
  }
  if (pin.state === 'system') {
    return { state: 'system', reason: `GPIO ${pin.gpio} is system-reserved.`, warnings };
  }
  if ((fn === 'output' || fn === 'pwm' || fn === 'dac') && pin.input_only) {
    return { state: 'incompatible', reason: `GPIO ${pin.gpio} is input-only and cannot drive an output.`, warnings };
  }
  if (fn === 'adc' && pin.adc_channels.length === 0) {
    return { state: 'incompatible', reason: `GPIO ${pin.gpio} has no ADC channel on this board.`, warnings };
  }
  if (pin.boot_strapping) warnings.push('Boot-strapping pin: verify its level at reset before using it.');
  if (pin.usb_jtag) warnings.push('USB/JTAG pin: unavailable as GPIO while native USB or JTAG is active.');
  if (pin.flash_connected) warnings.push('Connected to SPI flash: not usable as GPIO.');
  if (pin.psram_connected) warnings.push('May be occupied by PSRAM on some module variants — verify your exact module.');
  if (pin.notes) warnings.push(pin.notes);
  return { state: 'available', reason: null, warnings };
}

/** Shared-bus arrangements never consume exclusive GPIO ownership per sensor. */
export const SHARED_BUS_KINDS = ['i2c', 'spi', 'uart', 'onewire'] as const;

export function busPinsPayload(kind: string, data: Record<string, unknown>) {
  const keys: Record<string, string[]> = {
    i2c: ['sda_gpio', 'scl_gpio'],
    spi: ['mosi_gpio', 'miso_gpio', 'sck_gpio'],
    uart: ['tx_gpio', 'rx_gpio'],
    onewire: ['gpio'],
  };
  return Object.fromEntries((keys[kind] || []).filter((k) => data[k] !== undefined).map((k) => [k, data[k]]));
}
