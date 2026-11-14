-- Remove legacy static board PNG image paths now that all boards render via interactive vector SVGs.
UPDATE public.board_catalog
SET image_url = NULL
WHERE image_url LIKE '/boards/%';
