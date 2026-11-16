-- HomecoreOS Initial Platform Settings & Supported Hardware Catalog Seed
-- Safe to run once after 0001_initial_schema.sql (uses ON CONFLICT DO NOTHING).

INSERT INTO public.platform_settings (id)
VALUES (1)
ON CONFLICT (id) DO NOTHING;

-- Initial priority board: Espressif ESP32-S3-DevKitC-1 N16R8 (16 MB Flash, 8 MB Octal PSRAM)
WITH inserted_board AS (
  INSERT INTO public.board_catalog (
    slug,
    manufacturer,
    model,
    revision,
    chip_family,
    chip_variant,
    flash_size_mb,
    psram_size_mb,
    usb_vid,
    usb_pid,
    is_available,
    description
  )
  VALUES (
    'esp32-s3-devkitc-1-n16r8',
    'Espressif',
    'ESP32-S3-DevKitC-1 N16R8',
    'v1.1',
    'esp32s3',
    'ESP32-S3-WROOM-1-N16R8',
    16,
    8,
    '303a',
    '1001',
    true,
    'Dual-core Xtensa LX7 with 16 MB QIO Flash and 8 MB Octal (OPI) PSRAM. GPIO 26-37 are reserved for Flash/Octal PSRAM.'
  )
  ON CONFLICT (slug) DO NOTHING
  RETURNING id
),
board_ref AS (
  SELECT id FROM inserted_board
  UNION ALL
  SELECT id FROM public.board_catalog WHERE slug = 'esp32-s3-devkitc-1-n16r8'
  LIMIT 1
),
pin_numbers AS (
  SELECT gs AS pin
  FROM generate_series(0, 48) AS gs
  WHERE gs NOT BETWEEN 22 AND 25
)
INSERT INTO public.board_gpio_definitions (
  board_catalog_id,
  pin,
  label,
  capabilities,
  restrictions
)
SELECT
  board_ref.id,
  p.pin,
  CASE
    WHEN p.pin = 48 THEN 'GPIO48 (Onboard RGB LED)'
    WHEN p.pin = 19 THEN 'GPIO19 (USB D-)'
    WHEN p.pin = 20 THEN 'GPIO20 (USB D+)'
    WHEN p.pin = 43 THEN 'GPIO43 (UART0 TX)'
    WHEN p.pin = 44 THEN 'GPIO44 (UART0 RX)'
    ELSE 'GPIO' || p.pin::text
  END,
  jsonb_build_object(
    'digital_in', NOT (p.pin BETWEEN 26 AND 37),
    'digital_out', NOT (p.pin BETWEEN 26 AND 37 OR p.pin IN (43, 44, 46)),
    'pwm', NOT (p.pin BETWEEN 26 AND 37 OR p.pin IN (43, 44, 46)),
    'adc', (p.pin BETWEEN 1 AND 10),
    'i2c', NOT (p.pin BETWEEN 26 AND 37 OR p.pin IN (19, 20, 43, 44, 46)),
    'spi', NOT (p.pin BETWEEN 26 AND 37 OR p.pin IN (19, 20, 43, 44, 46)),
    'uart', NOT (p.pin BETWEEN 26 AND 37 OR p.pin IN (19, 20, 43, 44, 46)),
    'touch', (p.pin BETWEEN 1 AND 14),
    'pull_up', NOT (p.pin BETWEEN 26 AND 37),
    'pull_down', NOT (p.pin BETWEEN 26 AND 37)
  ),
  jsonb_build_object(
    'input_only', (p.pin = 46),
    'reserved', (p.pin BETWEEN 26 AND 37 OR p.pin IN (43, 44)),
    'reserved_reason', CASE
      WHEN p.pin BETWEEN 26 AND 32 THEN 'Internal SPI0/1 Flash bus'
      WHEN p.pin BETWEEN 33 AND 37 THEN 'Internal 8 MB Octal (OPI) PSRAM bus on N16R8'
      WHEN p.pin IN (43, 44) THEN 'UART0 USB-UART console / flashing TX-RX'
      ELSE NULL
    END,
    'strapping_pin', (p.pin IN (0, 3, 45, 46)),
    'strapping_note', CASE p.pin
      WHEN 0 THEN 'Boot mode select (pull-up; LOW enters ROM download mode)'
      WHEN 3 THEN 'JTAG signal source select'
      WHEN 45 THEN 'VDD_SPI flash voltage select (must stay LOW for 3.3V flash)'
      WHEN 46 THEN 'Boot mode / ROM print enable (input-only strapping during boot)'
      ELSE NULL
    END,
    'flash_psram_conflict', (p.pin BETWEEN 26 AND 37),
    'usb_jtag_conflict', (p.pin IN (19, 20))
  )
FROM board_ref
CROSS JOIN pin_numbers p
ON CONFLICT DO NOTHING;
