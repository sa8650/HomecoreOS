-- 0003: mandatory four-step onboarding, stored on the user row.
--
-- Every newly registered customer must finish the same four steps before the
-- dashboard unlocks. The progress is account-level (never browser storage):
--
--   onboarding_step         1..4, the step the user resumes on
--   onboarding_started_at   first time the user advanced past step 1
--   onboarding_completed_at set once and never cleared by signing out
--
-- Users that already existed when onboarding shipped must never be interrupted,
-- so they are backfilled as completed here. Nothing else on the row changes.

ALTER TABLE public.users
  ADD COLUMN onboarding_step smallint DEFAULT 1::smallint NOT NULL,
  ADD COLUMN onboarding_started_at timestamp with time zone,
  ADD COLUMN onboarding_completed_at timestamp with time zone;

ALTER TABLE public.users
  ADD CONSTRAINT users_onboarding_step_check
    CHECK (onboarding_step >= 1 AND onboarding_step <= 4);

-- Only completion is terminal; a completed row always reports its last step.
ALTER TABLE public.users
  ADD CONSTRAINT users_onboarding_completion_step_check
    CHECK (onboarding_completed_at IS NULL OR onboarding_step = 4);

COMMENT ON COLUMN public.users.onboarding_step IS
  'Mandatory onboarding step (1..4) the user resumes on. Unused once onboarding_completed_at is set.';
COMMENT ON COLUMN public.users.onboarding_started_at IS
  'First time the user moved past the welcome step.';
COMMENT ON COLUMN public.users.onboarding_completed_at IS
  'Set when the user finishes step 4. NULL means the dashboard stays locked.';

CREATE INDEX idx_users_onboarding_pending
  ON public.users USING btree (user_kind, onboarding_step)
  WHERE (onboarding_completed_at IS NULL AND deleted_at IS NULL);

-- Existing accounts keep working exactly as before: backfill them as onboarded.
UPDATE public.users
   SET onboarding_step = 4,
       onboarding_completed_at = COALESCE(last_login_at, created_at, now())
 WHERE onboarding_completed_at IS NULL
   AND created_at < now();
