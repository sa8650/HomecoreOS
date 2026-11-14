-- Development-only sample home structure for local testing.
-- Do NOT run this file in production.
-- Users and platform administrators are created via the application /setup and /register endpoints
-- so passwords are always securely hashed with Argon2id.

SELECT id, slug, model, flash_size_mb, psram_size_mb
FROM public.board_catalog
WHERE deleted_at IS NULL;
