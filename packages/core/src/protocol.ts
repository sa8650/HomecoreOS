import { z } from 'zod';

/** Versioned wire protocol shared by the Worker, firmware and simulator. */

export const TelemetryMessage = z.object({
  schema_version: z.literal(1),
  device_id: z.string().min(1),
  timestamp: z.number().int().nonnegative(),
  config_version: z.number().int().nonnegative().optional(),
  sensors: z.record(z.object({
    value: z.number().finite(),
    unit: z.string().min(1),
    status: z.enum(['valid', 'warning', 'invalid', 'stale']).default('valid'),
  })),
});
export type TelemetryMessageT = z.infer<typeof TelemetryMessage>;

export const SwitchCommand = z.object({
  schema_version: z.literal(1).optional(),
  command_id: z.string().uuid(),
  device_id: z.string().min(1),
  component_id: z.string().min(1),
  action: z.enum(['set_state', 'pulse', 'get_state', 'reboot', 'update_firmware']),
  value: z.boolean().optional(),
  expires_at: z.number().int().positive(),
  config_version: z.number().int().optional(),
});
export type SwitchCommandT = z.infer<typeof SwitchCommand>;

export const CommandAck = z.object({
  schema_version: z.literal(1).optional(),
  command_id: z.string().uuid(),
  component_id: z.string().min(1),
  requested_state: z.boolean().optional(),
  actual_state: z.boolean().nullable(),
  status: z.enum(['confirmed', 'failed', 'rejected']),
  error: z.string().optional(),
});
export type CommandAckT = z.infer<typeof CommandAck>;

export const StateReport = z.object({
  schema_version: z.literal(1),
  device_id: z.string().min(1),
  timestamp: z.number().int(),
  config_version: z.number().int().optional(),
  availability: z.enum(['online', 'offline']).optional(),
  devices: z.record(z.object({ state: z.enum(['on', 'off', 'unknown']), source: z.string().optional() })).optional(),
  command_id: z.string().uuid().optional(),
  component_id: z.string().optional(),
  actual_state: z.boolean().nullable().optional(),
  requested_state: z.boolean().optional(),
  status: z.enum(['confirmed', 'failed', 'rejected']).optional(),
  error: z.string().optional(),
});

export const ConfigAck = z.object({
  schema_version: z.literal(1),
  device_id: z.string().min(1),
  config_version: z.number().int().nonnegative(),
  status: z.enum(['applied', 'rejected']),
  checksum: z.string().optional(),
  error: z.string().optional(),
});

export const OtaProgress = z.object({
  schema_version: z.literal(1),
  device_id: z.string().min(1),
  status: z.enum(['downloading', 'installing', 'verifying', 'success', 'failed', 'rolled_back']),
  progress: z.number().int().min(0).max(100).optional(),
  bytes_done: z.number().int().optional(),
  version: z.string().optional(),
  error: z.string().optional(),
});

export const ConfigDocument = z.object({
  schema_version: z.literal(1),
  board_id: z.string(),
  config_version: z.number().int(),
  devices: z.array(z.any()),
  sensors: z.array(z.any()),
  buses: z.array(z.any()),
  local_automations: z.array(z.any()).optional(),
  safety: z.record(z.any()).optional(),
});

/** Never trust tenant_id/device_id found inside a device payload. */
export function stripUntrustedIdentities<T extends Record<string, unknown>>(payload: T): T {
  const copy = { ...payload };
  delete copy.tenant_id;
  delete copy.tenantId;
  return copy;
}
