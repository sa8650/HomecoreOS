-- 0005: browser real-time state synchronization over MQTT.
--
-- The console used to poll HTTP endpoints to notice that a switch, sensor or
-- Node had changed. Polling was the root cause of "nothing updates until I
-- refresh": the browser had no push channel, so a change that happened between
-- two polls was invisible, and every extra poll cost a Worker request plus a
-- Supabase query.
--
-- The browser now keeps exactly one MQTT-over-WebSocket session per signed-in
-- browser session and receives account-scoped state events published by the
-- Worker. The credential that opens that socket is deliberately weak:
--
--   * it can only subscribe to `homecore/<accountId>/realtime/#`
--   * it cannot publish anywhere (`deny publish #`)
--   * it cannot subscribe to any device, command or config topic
--   * it is scoped to one login session and dies with that session
--
-- The password is never stored. It is derived on demand from the Worker's
-- EMQX app secret and the session id (see `lib/realtime.ts`), so a database
-- dump alone cannot be replayed against the broker. This table only tracks the
-- broker user name that was provisioned for a session, so the Worker can avoid
-- re-provisioning it on every page load and can revoke it on sign-out.

CREATE TABLE public.realtime_web_sessions (
  session_id uuid NOT NULL,
  account_id uuid NOT NULL,
  user_id uuid NOT NULL,
  mqtt_username text NOT NULL,
  provisioned_at timestamp with time zone,
  last_issued_at timestamp with time zone DEFAULT now() NOT NULL,
  revoked_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT realtime_web_sessions_pkey PRIMARY KEY (session_id),
  CONSTRAINT realtime_web_sessions_mqtt_username_key UNIQUE (mqtt_username),
  CONSTRAINT realtime_web_sessions_session_id_fkey FOREIGN KEY (session_id)
    REFERENCES public.sessions(id) ON DELETE CASCADE,
  CONSTRAINT realtime_web_sessions_account_id_fkey FOREIGN KEY (account_id)
    REFERENCES public.accounts(id) ON DELETE CASCADE,
  CONSTRAINT realtime_web_sessions_user_id_fkey FOREIGN KEY (user_id)
    REFERENCES public.users(id) ON DELETE CASCADE,
  CONSTRAINT realtime_web_sessions_mqtt_username_check
    CHECK (((char_length(mqtt_username) >= 8) AND (char_length(mqtt_username) <= 128)))
);

CREATE INDEX idx_realtime_web_sessions_account
  ON public.realtime_web_sessions USING btree (account_id)
  WHERE (revoked_at IS NULL);

COMMENT ON TABLE public.realtime_web_sessions IS
  'Per-sign-in, subscribe-only MQTT identities used by the browser real-time state channel (passwords are derived, never stored).';
