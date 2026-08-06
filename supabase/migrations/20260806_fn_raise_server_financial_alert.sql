-- ═════════════════════════════════════════════════════════════════════════════
-- AUDIT M3 / M7-GAP: SERVER-CALLABLE DURABLE FINANCIAL ALERTS
-- ═════════════════════════════════════════════════════════════════════════════
--
-- WHY THIS EXISTS
-- ---------------
-- M7 shipped `fn_raise_financial_alert`, which hard-requires `auth.uid()`:
--
--     IF v_uid IS NULL THEN
--       RAISE EXCEPTION 'Authentication required to raise a financial alert'
--         USING ERRCODE = '28000';
--     END IF;
--
-- That is correct for the browser client, where the alert must be attributable
-- to a signed-in reporter. But the game server connects with the SERVICE ROLE
-- key, under which `auth.uid()` is NULL. Verified live before writing this
-- migration -- calling the M7 function as `service_role` fails with SQLSTATE
-- 28000. In other words: the durable alert path M7 built was unreachable from
-- the game server, which is exactly where every money-critical settlement step
-- (rake, insurance, BBJ, add-ons, tournament sync) actually runs.
--
-- This function is the server-side twin. Identical alert shape, identical
-- severity vocabulary, identical flood-guard-returns-NULL contract -- but keyed
-- on `source` instead of a reporter uuid, because the server has no uuid.
--
-- SECURITY
-- --------
-- SECURITY DEFINER with a pinned search_path, and EXECUTE granted to
-- `service_role` ONLY. `anon` and `authenticated` are revoked BY NAME: this
-- project has ALTER DEFAULT PRIVILEGES granting EXECUTE on new public functions
-- to `anon`, and `REVOKE ALL ... FROM PUBLIC` does NOT remove a grant that was
-- made to a named role. Skipping the explicit revokes would let any logged-in
-- player forge alerts that carry `channel: server_rpc` and so appear to come
-- from the engine itself.
--
-- IDEMPOTENT: safe to re-run.
-- ═════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.fn_raise_server_financial_alert(
  p_severity text,
  p_source   text,
  p_message  text,
  p_context  jsonb DEFAULT '{}'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_id     uuid;
  v_sev    text;
  v_source text;
  v_recent integer;
BEGIN
  v_sev := lower(coalesce(p_severity, 'info'));
  IF v_sev NOT IN ('critical', 'warning', 'info') THEN
    v_sev := 'info';
  END IF;

  v_source := left(coalesce(nullif(p_source, ''), 'unknown'), 200);

  -- Flood guard: at most 60 alerts per source per minute. A stuck settlement
  -- loop must not be able to fill the alerts table faster than an operator can
  -- read it. Returning NULL rather than raising keeps the caller's error path
  -- clean -- the server helper still escalates to Sentry when it gets no id
  -- back, so a throttled alert is never silently lost.
  --
  -- The limit is per SOURCE (not global) so that one noisy subsystem cannot
  -- suppress a genuine first-occurrence alert from a different subsystem.
  SELECT count(*) INTO v_recent
    FROM public.financial_alerts
   WHERE created_at > now() - interval '1 minute'
     AND source = v_source
     AND context ->> 'channel' = 'server_rpc';

  IF v_recent >= 60 THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.financial_alerts (severity, source, message, context, resolved)
  VALUES (
    v_sev,
    v_source,
    left(coalesce(nullif(p_message, ''), '(no message)'), 4000),
    coalesce(p_context, '{}'::jsonb) || jsonb_build_object('channel', 'server_rpc'),
    false
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$function$;

-- Supports the flood-guard lookup above (source + recency).
CREATE INDEX IF NOT EXISTS idx_financial_alerts_source_created
  ON public.financial_alerts USING btree (source, created_at DESC);

-- ── GRANTS ───────────────────────────────────────────────────────────────────
-- Order matters: revoke the blanket PUBLIC grant first, then the named roles
-- that ALTER DEFAULT PRIVILEGES may have granted independently of PUBLIC.
REVOKE ALL ON FUNCTION public.fn_raise_server_financial_alert(text, text, text, jsonb)
  FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fn_raise_server_financial_alert(text, text, text, jsonb)
  FROM anon;
REVOKE EXECUTE ON FUNCTION public.fn_raise_server_financial_alert(text, text, text, jsonb)
  FROM authenticated;
GRANT EXECUTE ON FUNCTION public.fn_raise_server_financial_alert(text, text, text, jsonb)
  TO service_role;

COMMENT ON FUNCTION public.fn_raise_server_financial_alert(text, text, text, jsonb) IS
  'AUDIT M3: durable financial alert path for the game server (service_role, no auth.uid()). '
  'Companion to fn_raise_financial_alert, which is client-only because it requires an authenticated reporter. '
  'Flood-guarded at 60/minute per source; returns NULL when throttled so the caller escalates to Sentry instead.';
