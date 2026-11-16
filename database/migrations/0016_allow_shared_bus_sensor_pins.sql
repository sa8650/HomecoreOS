-- Allow multiple sensor measurements to share a GPIO pin when physically supported
-- (e.g. DHT22 temperature + humidity on one GPIO, multiple DS18B20 probes on one 1-Wire pin,
-- or multiple I2C sensors with an explicit SDA GPIO pin).
-- Non-shareable sensor pin conflicts (PIR, Reed, ADC) and duplicate measurements on the same
-- pin/bus continue to be strictly rejected by Worker & shared validation.

DROP INDEX IF EXISTS public.idx_sensors_unique_pin;

CREATE INDEX IF NOT EXISTS idx_sensors_controller_pin
  ON public.sensors (controller_id, gpio_pin)
  WHERE deleted_at IS NULL AND gpio_pin IS NOT NULL;
