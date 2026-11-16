-- Users choose a built-in avatar; no uploaded image is stored.
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_seed text DEFAULT NULL;
