-- HomecoreOS MQTT Optimization (Config Revisions/Sync Queue) & Persistent Notifications

ALTER TABLE public.controllers
  ADD COLUMN IF NOT EXISTS config_revision INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS config_hash TEXT,
  ADD COLUMN IF NOT EXISTS last_synced_config_revision INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_config_published_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_config_synced_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pending_config_sync BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS heartbeat_interval_sec INTEGER NOT NULL DEFAULT 60;

CREATE INDEX IF NOT EXISTS idx_controllers_pending_sync
  ON public.controllers (account_id, pending_config_sync)
  WHERE deleted_at IS NULL AND pending_config_sync = true;

-- Persistent Notification System (User Console & Admin Console)
CREATE TABLE IF NOT EXISTS public.notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope TEXT NOT NULL CHECK (scope IN ('user', 'admin')),
  account_id UUID REFERENCES public.accounts(id) ON DELETE CASCADE,
  user_id UUID REFERENCES public.users(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  event_key TEXT NOT NULL,
  preference_key TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'success', 'warning', 'danger')),
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  dedup_key TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_read BOOLEAN NOT NULL DEFAULT false,
  read_at TIMESTAMPTZ,
  cleared_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notifications_user_active
  ON public.notifications (scope, account_id, created_at DESC)
  WHERE cleared_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_notifications_unread
  ON public.notifications (scope, account_id, is_read)
  WHERE cleared_at IS NULL AND is_read = false;

CREATE INDEX IF NOT EXISTS idx_notifications_dedup
  ON public.notifications (scope, dedup_key, created_at DESC)
  WHERE cleared_at IS NULL AND dedup_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.notification_preferences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope TEXT NOT NULL CHECK (scope IN ('user', 'admin')),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  account_id UUID REFERENCES public.accounts(id) ON DELETE CASCADE,
  account_key TEXT NOT NULL DEFAULT '',
  preferences JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (scope, user_id, account_key)
);

-- Match 0001_initial_schema.sql privilege pattern: Worker uses service_role exclusively;
-- lock down anon/authenticated roles directly without enabling RLS.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE public.notifications FROM anon;
    REVOKE ALL ON TABLE public.notification_preferences FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE public.notifications FROM authenticated;
    REVOKE ALL ON TABLE public.notification_preferences FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.notifications TO service_role;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.notification_preferences TO service_role;
  END IF;
END $$;
