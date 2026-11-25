-- ESP-NOW bidirectional link telemetry and Controller-reported Node roster.
--
-- Additive and nullable so existing boards, older firmware images, and all
-- switches, sensors, devices, rooms, pairing credentials and firmware history
-- remain untouched. Controllers persist their reported `nodes[]` roster
-- (node id, link state, peer RSSI, RF channel, sequence, report timestamp) and
-- Nodes persist their reported keepalive/ACK counters and peer signal metrics.

ALTER TABLE public.board_instances
  ADD COLUMN IF NOT EXISTS espnow_telemetry jsonb;

COMMENT ON COLUMN public.board_instances.espnow_telemetry IS
  'Hardware-reported ESP-NOW link diagnostics and Controller Node roster; NULL until reported by firmware.';
