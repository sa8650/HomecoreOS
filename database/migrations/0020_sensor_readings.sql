-- Lightweight rolling history of numeric sensor readings.
-- Powers the mini sparkline graphs on the User Console sensor cards.
-- Rows are written by the existing device telemetry ingest path only;
-- nothing else writes here and no extra MQTT traffic is introduced.
-- Readings older than the retention window (30 days) are pruned opportunistically
-- by the telemetry handler so the table stays small.

CREATE TABLE IF NOT EXISTS public.sensor_readings (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sensor_id UUID NOT NULL REFERENCES public.sensors(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  value DOUBLE PRECISION NOT NULL,
  unit TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sensor_readings_sensor_time
  ON public.sensor_readings (sensor_id, recorded_at DESC);

CREATE INDEX IF NOT EXISTS idx_sensor_readings_account_time
  ON public.sensor_readings (account_id, recorded_at DESC);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE public.sensor_readings FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE public.sensor_readings FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.sensor_readings TO service_role;
  END IF;
END $$;
