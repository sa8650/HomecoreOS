-- 0004: password recovery by emailed one-time code, plus the Brevo sender the
-- platform sends it from.
--
-- A customer who forgets a password asks for a code on the sign-in card. The
-- Worker stores a hash of a random six-digit code (never the code itself),
-- emails the code through Brevo, and lets the customer exchange a correct code
-- for a short-lived, single-use reset token. Only that token can set a new
-- password, so a guessed code alone is never enough.
--
--   otp_hash                SHA-256 of the code, salted with the user id
--   attempts                wrong-code attempts, capped so a code cannot be brute-forced
--   consumed_at             set when the code was verified; a code works once
--   reset_token_hash        SHA-256 of the reset token issued after verification
--   reset_token_*           short lifetime, single use
--
-- Only active codes are queried; old rows are pruned by the hourly cron.

CREATE TABLE public.password_reset_otps (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  email text NOT NULL,
  otp_hash text NOT NULL,
  attempts smallint DEFAULT 0 NOT NULL,
  expires_at timestamp with time zone NOT NULL,
  consumed_at timestamp with time zone,
  reset_token_hash text,
  reset_token_expires_at timestamp with time zone,
  reset_token_used_at timestamp with time zone,
  request_ip text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT password_reset_otps_pkey PRIMARY KEY (id),
  CONSTRAINT password_reset_otps_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE,
  CONSTRAINT password_reset_otps_attempts_check CHECK (((attempts >= 0) AND (attempts <= 10))),
  CONSTRAINT password_reset_otps_email_check CHECK (((char_length(email) >= 3) AND (char_length(email) <= 200)))
);

CREATE INDEX idx_password_reset_otps_email
  ON public.password_reset_otps USING btree (email, created_at DESC);

CREATE INDEX idx_password_reset_otps_user
  ON public.password_reset_otps USING btree (user_id, created_at DESC);

CREATE INDEX idx_password_reset_otps_reset_token
  ON public.password_reset_otps USING btree (reset_token_hash)
  WHERE (reset_token_hash IS NOT NULL);

COMMENT ON TABLE public.password_reset_otps IS
  'Emailed six-digit password-recovery codes and the single-use reset tokens they unlock.';

-- The Brevo sender is administrator-managed so the reply address can change
-- without a deploy. The API key itself is a Worker secret, never a row.
ALTER TABLE public.platform_settings
  ADD COLUMN brevo_from_name text DEFAULT 'HomecoreOS'::text NOT NULL,
  ADD COLUMN brevo_from_email text,
  ADD COLUMN brevo_reply_to text;

ALTER TABLE public.platform_settings
  ADD CONSTRAINT platform_settings_brevo_from_name_check
    CHECK (((char_length(brevo_from_name) >= 1) AND (char_length(brevo_from_name) <= 120))),
  ADD CONSTRAINT platform_settings_brevo_from_email_check
    CHECK (((brevo_from_email IS NULL) OR ((char_length(brevo_from_email) >= 3) AND (char_length(brevo_from_email) <= 200)))),
  ADD CONSTRAINT platform_settings_brevo_reply_to_check
    CHECK (((brevo_reply_to IS NULL) OR ((char_length(brevo_reply_to) >= 3) AND (char_length(brevo_reply_to) <= 200))));

COMMENT ON COLUMN public.platform_settings.brevo_from_name IS
  'Display name of the sender on transactional email (password recovery codes).';
COMMENT ON COLUMN public.platform_settings.brevo_from_email IS
  'Verified Brevo sender address. Password recovery stays disabled until it is set.';
COMMENT ON COLUMN public.platform_settings.brevo_reply_to IS
  'Optional Reply-To address shown to customers receiving a recovery code.';
