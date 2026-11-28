-- 0012: Per-board live Log.
--
-- One row = one logical event that happened on ONE board. Rows are scoped to
-- the owning account and to a single board instance so a Controller's Log and
-- a Node's Log can never be mixed: a Node only ever appears in a Controller's
-- Log as the peer of a communication event.
--
-- This is a dedicated table instead of a reuse of `activity_logs` for three
-- reasons:
--   1. `activity_logs.category` has a fixed CHECK constraint and no per-board
--      filtering, so it cannot express the console's category/severity/status
--      vocabulary without weakening an existing constraint.
--   2. The console reads newest-first with a stable cursor; that needs a
--      composite (account, board, created_at DESC, id DESC) index.
--   3. Log rows are pruned on their own schedule and never mix with the
--      account-wide audit trail, whose retention rules differ.
--
-- Storage is intentionally light: no payloads, no command bodies, no sensor
-- values. Only short tokens and bounded metadata are stored.

CREATE TABLE public.board_log_events (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  -- Monotonic insertion order. The console pages with this column so a live
  -- insert never shifts or duplicates an already-read page, which a timestamp
  -- cursor cannot guarantee when two rows share a millisecond.
  seq bigint GENERATED ALWAYS AS IDENTITY,
  account_id uuid NOT NULL,
  board_instance_id uuid NOT NULL,
  category text NOT NULL,
  severity text DEFAULT 'info'::text NOT NULL,
  status text,
  method text,
  source text,
  destination text,
  message text NOT NULL,
  metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
  -- Identity of the logical event. The same key is never stored twice, so a
  -- retried request or a replayed device report cannot duplicate a line.
  dedupe_key text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT board_log_events_pkey PRIMARY KEY (id),
  CONSTRAINT board_log_events_account_fkey FOREIGN KEY (account_id)
    REFERENCES public.accounts(id) ON DELETE CASCADE,
  CONSTRAINT board_log_events_board_fkey FOREIGN KEY (board_instance_id)
    REFERENCES public.board_instances(id) ON DELETE CASCADE,
  CONSTRAINT board_log_events_category_check CHECK (category = ANY (ARRAY[
    'communication'::text,
    'device_activity'::text,
    'connection'::text,
    'command'::text,
    'binding'::text,
    'system'::text
  ])),
  CONSTRAINT board_log_events_severity_check CHECK (severity = ANY (ARRAY[
    'info'::text,
    'success'::text,
    'warning'::text,
    'error'::text
  ])),
  CONSTRAINT board_log_events_message_check CHECK (length(message) > 0)
);

-- Cursor pagination for the console: newest first, stable when two rows share
-- a timestamp (the sequence is the tiebreaker).
CREATE INDEX idx_board_log_events_board_cursor
  ON public.board_log_events USING btree (account_id, board_instance_id, seq DESC);

-- Category/severity filters always run inside one board.
CREATE INDEX idx_board_log_events_board_category
  ON public.board_log_events USING btree (account_id, board_instance_id, category, created_at DESC);

-- Retention sweep.
CREATE INDEX idx_board_log_events_created
  ON public.board_log_events USING btree (created_at DESC);

-- One row per logical event.
CREATE UNIQUE INDEX idx_board_log_events_dedupe
  ON public.board_log_events USING btree (account_id, board_instance_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;

-- Bounded retention. The Worker calls this on its scheduled tick; it removes
-- rows older than the retention window for one account (or for the whole
-- table when no account is given).
CREATE OR REPLACE FUNCTION public.prune_board_log_events(
  p_keep_days integer DEFAULT 14,
  p_account_id uuid DEFAULT NULL
) RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  cutoff timestamp with time zone := now() - make_interval(days => GREATEST(p_keep_days, 1));
  removed integer := 0;
BEGIN
  IF p_account_id IS NULL THEN
    DELETE FROM public.board_log_events WHERE created_at < cutoff;
    GET DIAGNOSTICS removed = ROW_COUNT;
  ELSE
    DELETE FROM public.board_log_events
      WHERE account_id = p_account_id AND created_at < cutoff;
    GET DIAGNOSTICS removed = ROW_COUNT;
  END IF;
  RETURN removed;
END;
$$;

-- Bounded per-board storage. A board that produces a lot of activity keeps its
-- newest rows only, so one noisy board can never grow the table without bound.
CREATE OR REPLACE FUNCTION public.trim_board_log_events(
  p_max_rows integer DEFAULT 2000
) RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  removed integer := 0;
BEGIN
  WITH ranked AS (
    SELECT id,
           ROW_NUMBER() OVER (PARTITION BY board_instance_id ORDER BY seq DESC) AS rn
      FROM public.board_log_events
  ), doomed AS (
    SELECT id FROM ranked WHERE rn > GREATEST(p_max_rows, 100)
  ), deleted AS (
    DELETE FROM public.board_log_events e USING doomed d WHERE e.id = d.id
    RETURNING e.id
  )
  SELECT COUNT(*) INTO removed FROM deleted;
  RETURN removed;
END;
$$;

COMMENT ON TABLE public.board_log_events IS
  'Per-board live Log: one row per logical event, scoped to one board instance and its owning account.';
COMMENT ON COLUMN public.board_log_events.dedupe_key IS
  'Identity of the logical event; a repeated key is never stored twice.';
