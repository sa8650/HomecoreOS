-- HomecoreOS Smart Home Planner: account-scoped saved plans.
--
-- A saved plan keeps the customer's requirements together with the
-- recommendation that was computed from them. `catalog_revision` is a
-- fingerprint of the exact Board Library and Firmware Management records that
-- recommendation was derived from. The Worker reuses a stored result only while
-- that fingerprint (and the rule-engine version) still matches the live data;
-- as soon as an administrator changes a board or a firmware release the
-- fingerprint differs and the plan is analyzed again.
--
-- No board, firmware, price or stock data is stored here: the planner always
-- reads those from the existing admin-managed tables.

CREATE TABLE IF NOT EXISTS public.planner_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  created_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  -- Canonical, validated requirements (never the raw request body).
  requirements JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Last recommendation computed by the Worker, or NULL before the first analysis.
  result JSONB,
  result_state TEXT CHECK (
    result_state IS NULL
    OR result_state IN ('ready', 'partially_ready', 'not_supported', 'incomplete')
  ),
  -- Small listing summary so plan lists never have to read the full result.
  result_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  catalog_revision TEXT,
  engine_version INTEGER NOT NULL DEFAULT 1,
  analyzed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_planner_plans_account
  ON public.planner_plans (account_id, created_at DESC)
  WHERE deleted_at IS NULL;

DROP TRIGGER IF EXISTS trg_planner_plans_updated_at ON public.planner_plans;
CREATE TRIGGER trg_planner_plans_updated_at
  BEFORE UPDATE ON public.planner_plans
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Match 0001_initial_schema.sql privilege pattern: Worker uses service_role exclusively;
-- lock down anon/authenticated roles directly without enabling RLS.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE public.planner_plans FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE public.planner_plans FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.planner_plans TO service_role;
  END IF;
END $$;
