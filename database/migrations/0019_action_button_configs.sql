-- Per-user Dynamic Island "Action Button" configurations.
-- Each user stores an independent set of button programs for their own workspace.
-- A program targets existing switches / devices / rooms / automation rules only;
-- no parallel device-control system is introduced.

CREATE TABLE IF NOT EXISTS public.action_button_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  icon TEXT NOT NULL DEFAULT 'zap',
  color TEXT NOT NULL DEFAULT 'blue',
  category TEXT NOT NULL DEFAULT 'custom'
    CHECK (category IN ('global', 'room', 'group', 'automation', 'custom')),
  config JSONB NOT NULL DEFAULT '{"single": [], "double": null, "long": null}'::jsonb,
  confirmation_required BOOLEAN NOT NULL DEFAULT false,
  is_enabled BOOLEAN NOT NULL DEFAULT true,
  is_active BOOLEAN NOT NULL DEFAULT false,
  last_executed_at TIMESTAMPTZ,
  last_execution_status TEXT
    CHECK (last_execution_status IN ('success', 'partial', 'failed')),
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_action_button_configs_user_account
  ON public.action_button_configs (user_id, account_id, created_at DESC);

-- Only one configuration may be assigned to a user's Dynamic Island button at a time.
CREATE UNIQUE INDEX IF NOT EXISTS idx_action_button_configs_one_active
  ON public.action_button_configs (user_id, account_id)
  WHERE is_active;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE public.action_button_configs FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE public.action_button_configs FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.action_button_configs TO service_role;
  END IF;
END $$;
