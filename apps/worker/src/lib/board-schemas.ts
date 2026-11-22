import { z } from "zod";

/**
 * GPIO definition payload shared by the admin board editor and the customer
 * board library. Both routes validate the exact same structure, so the schema
 * lives here once — editing a rule in one route used to leave the other behind.
 */
export const gpioPinSchema = z.object({
  pin: z.number().int().min(0).max(54),
  label: z.string().trim().min(1).max(64),
  board_pin_name: z.string().trim().max(48).nullable().optional(),
  header_side: z.enum(["left", "right"]).nullable().optional(),
  header_position: z.number().int().min(1).max(40).nullable().optional(),
  board_note: z.string().trim().max(160).nullable().optional(),
  capabilities: z.object({
    digital_in: z.boolean(),
    digital_out: z.boolean(),
    pwm: z.boolean(),
    adc: z.boolean(),
    i2c: z.boolean(),
    spi: z.boolean(),
    uart: z.boolean(),
    touch: z.boolean(),
    pull_up: z.boolean(),
    pull_down: z.boolean(),
  }),
  restrictions: z.object({
    input_only: z.boolean(),
    reserved: z.boolean(),
    reserved_reason: z.string().max(200).optional(),
    strapping_pin: z.boolean(),
    strapping_note: z.string().max(200).optional(),
    flash_psram_conflict: z.boolean(),
    usb_jtag_conflict: z.boolean(),
  }),
});
