-- Board Setup & Repair: the board's own health facts.
--
-- Repair/recovery diagnoses "is this controller healthy?" from what the
-- controller itself reports. Until now the heartbeat carried Wi-Fi, MQTT,
-- firmware and config state; recovery also needs the running image's identity,
-- the boot partition, uptime, heap, the server URL the board stored, OTA
-- capability and the ESP-NOW link. All of these are additive and nullable: an
-- old firmware that never reports them leaves them NULL, which the recovery
-- engine renders as "unable to verify" rather than as a fault.
--
-- No existing column changes meaning, so installed boards keep working
-- unchanged and devices, rooms, sensors, switches and Nodes are untouched.

ALTER TABLE public.board_instances
  ADD COLUMN IF NOT EXISTS reported_partition_scheme text,
  ADD COLUMN IF NOT EXISTS uptime_sec integer,
  ADD COLUMN IF NOT EXISTS free_heap_bytes integer,
  -- The server URL the controller has stored, so recovery can point a board
  -- that is missing it (or aimed at a different deployment) at this website.
  ADD COLUMN IF NOT EXISTS backend_url text,
  ADD COLUMN IF NOT EXISTS ota_supported boolean,
  ADD COLUMN IF NOT EXISTS ota_pending boolean,
  ADD COLUMN IF NOT EXISTS ota_error text,
  ADD COLUMN IF NOT EXISTS espnow_supported boolean,
  ADD COLUMN IF NOT EXISTS espnow_link_state text,
  -- Radios the running image was built with (a H2 has no Wi-Fi, a bare module
  -- may have no BLE); recovery must not promise an interface that cannot open.
  ADD COLUMN IF NOT EXISTS supports_wifi boolean,
  ADD COLUMN IF NOT EXISTS supports_ble boolean,
  -- When the board last wrote any of the above.
  ADD COLUMN IF NOT EXISTS health_reported_at timestamp with time zone;

-- The recovery engine compares the stored URL against the website origin, so
-- an operator can find boards aimed at a stale deployment.
CREATE INDEX IF NOT EXISTS board_instances_backend_url_idx
  ON public.board_instances USING btree (backend_url)
  WHERE (deleted_at IS NULL AND backend_url IS NOT NULL);

COMMENT ON COLUMN public.board_instances.backend_url IS
  'HomecoreOS server URL stored on the controller; NULL means older firmware did not report it.';
COMMENT ON COLUMN public.board_instances.uptime_sec IS
  'Seconds since the running image booted; a small value after a repair proves the restart.';
COMMENT ON COLUMN public.board_instances.espnow_link_state IS
  'ESP-NOW link state as reported by the board (linked, standalone, unassigned, controller_lost, reconnecting).';
