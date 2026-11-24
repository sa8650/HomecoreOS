-- Physical sensor identity: one hardware module can own several measurement
-- entities (e.g. BME280 temperature + humidity + pressure). Existing rows are
-- backfilled so sensor ids, sensor_type values, automations and telemetry
-- history stay untouched.

CREATE TABLE public.physical_sensor_instances (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  account_id uuid NOT NULL,
  board_instance_id uuid NOT NULL,
  driver_id text NOT NULL,
  model text,
  bus_id text,
  i2c_address text,
  resource_config jsonb DEFAULT '{}'::jsonb NOT NULL,
  source_gpio_pin integer,
  source_i2c_address text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  deleted_at timestamp with time zone,
  CONSTRAINT physical_sensor_instances_pkey PRIMARY KEY (id)
);

CREATE INDEX idx_physical_sensor_instances_controller
  ON public.physical_sensor_instances USING btree (account_id, board_instance_id)
  WHERE (deleted_at IS NULL);

ALTER TABLE public.sensors
  ADD COLUMN physical_sensor_id uuid REFERENCES public.physical_sensor_instances(id) ON DELETE SET NULL,
  ADD COLUMN driver_config jsonb DEFAULT '{}'::jsonb NOT NULL;

CREATE INDEX idx_sensors_physical_sensor ON public.sensors USING btree (physical_sensor_id)
  WHERE (deleted_at IS NULL);

-- One representative row per legacy physical binding.
INSERT INTO public.physical_sensor_instances (
  account_id, board_instance_id, driver_id, model, bus_id, i2c_address,
  resource_config, source_gpio_pin, source_i2c_address
)
SELECT
  ranked.account_id,
  ranked.board_instance_id,
  ranked.driver_id,
  CASE WHEN ranked.last_raw_payload->>'model' = '' THEN NULL ELSE ranked.last_raw_payload->>'model' END,
  CASE
    WHEN ranked.last_raw_payload->>'i2c_address' IS NOT NULL
      THEN 'i2c:' || COALESCE(ranked.gpio_pin::text, 'default')
    WHEN ranked.gpio_pin IS NOT NULL THEN 'gpio:' || ranked.gpio_pin::text
    ELSE NULL
  END,
  ranked.last_raw_payload->>'i2c_address',
  CASE
    WHEN jsonb_typeof(ranked.last_raw_payload->'resources') = 'object'
      THEN ranked.last_raw_payload->'resources'
    ELSE '{}'::jsonb
  END,
  ranked.gpio_pin,
  ranked.last_raw_payload->>'i2c_address'
FROM (
  SELECT
    s.*,
    COALESCE(
      s.last_raw_payload->>'driver_id',
      CASE
        WHEN s.sensor_type LIKE 'temperature_dht22%' OR s.sensor_type LIKE 'humidity_dht22%' THEN 'dht22'
        WHEN s.sensor_type LIKE '%ds18b20%' THEN 'ds18b20'
        WHEN s.sensor_type LIKE '%bme280%' THEN 'bme280'
        WHEN s.sensor_type LIKE 'motion_pir%' OR s.sensor_type = 'motion' THEN 'pir'
        WHEN s.sensor_type LIKE 'contact_reed%' OR s.sensor_type = 'contact' THEN 'reed'
        WHEN s.sensor_type LIKE '%bh1750%' OR s.sensor_type = 'light' THEN 'bh1750'
        ELSE 'adc_voltage'
      END
    ) AS driver_id,
    row_number() OVER (
      PARTITION BY
        s.account_id, s.board_instance_id,
        COALESCE(
          s.last_raw_payload->>'driver_id',
          CASE
            WHEN s.sensor_type LIKE 'temperature_dht22%' OR s.sensor_type LIKE 'humidity_dht22%' THEN 'dht22'
            WHEN s.sensor_type LIKE '%ds18b20%' THEN 'ds18b20'
            WHEN s.sensor_type LIKE '%bme280%' THEN 'bme280'
            WHEN s.sensor_type LIKE 'motion_pir%' OR s.sensor_type = 'motion' THEN 'pir'
            WHEN s.sensor_type LIKE 'contact_reed%' OR s.sensor_type = 'contact' THEN 'reed'
            WHEN s.sensor_type LIKE '%bh1750%' OR s.sensor_type = 'light' THEN 'bh1750'
            ELSE 'adc_voltage'
          END
        ),
        s.gpio_pin,
        s.last_raw_payload->>'i2c_address'
      ORDER BY s.created_at ASC
    ) AS rn
  FROM public.sensors s
  WHERE s.deleted_at IS NULL
) ranked
WHERE ranked.rn = 1;

UPDATE public.sensors s
SET physical_sensor_id = p.id
FROM public.physical_sensor_instances p
WHERE s.deleted_at IS NULL
  AND s.account_id = p.account_id
  AND s.board_instance_id = p.board_instance_id
  AND s.gpio_pin IS NOT DISTINCT FROM p.source_gpio_pin
  AND (s.last_raw_payload->>'i2c_address') IS NOT DISTINCT FROM p.source_i2c_address
  AND COALESCE(
    s.last_raw_payload->>'driver_id',
    CASE
      WHEN s.sensor_type LIKE 'temperature_dht22%' OR s.sensor_type LIKE 'humidity_dht22%' THEN 'dht22'
      WHEN s.sensor_type LIKE '%ds18b20%' THEN 'ds18b20'
      WHEN s.sensor_type LIKE '%bme280%' THEN 'bme280'
      WHEN s.sensor_type LIKE 'motion_pir%' OR s.sensor_type = 'motion' THEN 'pir'
      WHEN s.sensor_type LIKE 'contact_reed%' OR s.sensor_type = 'contact' THEN 'reed'
      WHEN s.sensor_type LIKE '%bh1750%' OR s.sensor_type = 'light' THEN 'bh1750'
      ELSE 'adc_voltage'
    END
  ) = p.driver_id;
