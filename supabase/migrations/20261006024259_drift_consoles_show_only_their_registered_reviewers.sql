-- 20261006024259_drift_consoles_show_only_their_registered_reviewers.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT WAS WRONG
--
-- The drift board's writer already authorizes one incident at a time through
-- fn_ca_incident_recipient_ids. Its readers did not. Any owner of any club or
-- union passed a one-time "management" check, after which
-- fn_ca_incident_dashboard returned every chip incident and event on the
-- platform, fn_ca_drift_metrics returned global incident and ledger totals,
-- and fn_ca_gate_panel returned the platform supply and Diamond series. That
-- is a cross-club SECURITY DEFINER disclosure. A rejected caller also received
-- an empty set / empty object / NULL, which the old browser could paint as a
-- clean queue.
--
-- WHAT THIS CHANGES
--
-- One narrow capability answers whether the current caller is platform staff,
-- service_role, or an active row in the existing incident-recipient registry.
-- The dashboard then returns only incidents for which a non-platform caller
-- is an actual recipient. Metrics use that same visible set. Platform supply,
-- Diamond, suspense and balance-as-of evidence remains available only to
-- platform staff/service_role and the registry's explicitly global scopes
-- (platform, financial_ops, technical). A scoped club/union recipient may work
-- its own incident queue but cannot read a platform-wide supply certificate.
-- Unauthorized calls raise 42501 rather than returning a false empty. Each
-- dashboard row also says whether this caller is authorized by the unchanged
-- incident action door; a platform reader who is not a registered recipient
-- therefore receives a read-only row instead of a button that can only fail.
--
-- No incident, event, ledger, balance, recipient or financial row changes.
--
-- PRODUCTION PREIMAGE, 2026-10-06 UTC
--
--   fn_ca_incident_dashboard definition  f99151acc42a8d6f788779a1ae285a2c
--   fn_ca_drift_metrics definition       1c56814b0183603d34e3b868ea0e4d7b
--   fn_ca_gate_panel definition          0db0b5d0a7be50219e9b0d75004cffa3
--   fn_ca_balance_asof_admin definition  c491fa6a53e967e1bde3b9163b916380
--
-- @live-proof: (SELECT md5(prosrc)='f5da9d3b8fae7b840878498b67c6fc82' AND md5(pg_get_functiondef(oid))='8e8acf21077ffb728c4fd461cc1d723a' AND pg_get_userbyid(proowner)='postgres' AND prosecdef AND provolatile='s' AND proconfig=ARRAY['search_path=public, pg_temp']::text[] AND proacl::text='{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}' FROM pg_proc WHERE oid='public.fn_ca_can_view_drift_console()'::regprocedure)
-- @live-proof: (SELECT md5(prosrc)='eba4e72a10c4667ca8e09d17c3a20868' AND md5(pg_get_functiondef(oid))='2a7efba776e3845b9391e2934d1c642c' FROM pg_proc WHERE oid='public.fn_ca_incident_dashboard(text,integer)'::regprocedure)
-- @live-proof: (SELECT md5(prosrc)='68eaf86fa89d48255ab75e2503f645d5' AND md5(pg_get_functiondef(oid))='ce915eaeb1a22626afa9962800e2a904' FROM pg_proc WHERE oid='public.fn_ca_drift_metrics()'::regprocedure)
-- @live-proof: (SELECT md5(prosrc)='1fd06b5d4526e8e15cabfa823da329c2' AND md5(pg_get_functiondef(oid))='afb1a845a440e4851daf85433859bf7e' FROM pg_proc WHERE oid='public.fn_ca_gate_panel()'::regprocedure)
-- @live-proof: (SELECT md5(prosrc)='2bb316de9ab7e8051c39f943477bbfd3' AND md5(pg_get_functiondef(oid))='a2be83ba8bd5487154ab0fc74e08471f' FROM pg_proc WHERE oid='public.fn_ca_balance_asof_admin(text,uuid,timestamp with time zone)'::regprocedure)

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $pre$
DECLARE
  v_target record;
BEGIN
  IF to_regprocedure('public.fn_ca_can_view_drift_console()') IS NOT NULL THEN
    RAISE EXCEPTION 'DRIFT_CONSOLE_REVIEWER_CAPABILITY_ALREADY_EXISTS';
  END IF;

  FOR v_target IN
    SELECT * FROM (VALUES
      ('public.fn_ca_incident_dashboard(text,integer)'::regprocedure,
       'd1115881f25c20a16ef0582aa437ef28'::text,
       'f99151acc42a8d6f788779a1ae285a2c'::text,
       'jsonb'::regtype, true),
      ('public.fn_ca_drift_metrics()'::regprocedure,
       'aa4e90713542be9b9799f1f554eee171'::text,
       '1c56814b0183603d34e3b868ea0e4d7b'::text,
       'jsonb'::regtype, false),
      ('public.fn_ca_gate_panel()'::regprocedure,
       '54c610e78e619d692b52723dea10cb8b'::text,
       '0db0b5d0a7be50219e9b0d75004cffa3'::text,
       'jsonb'::regtype, false),
      ('public.fn_ca_balance_asof_admin(text,uuid,timestamp with time zone)'::regprocedure,
       '1929a7587da75dd32e86c66c2640edac'::text,
       'c491fa6a53e967e1bde3b9163b916380'::text,
       'jsonb'::regtype, false)
    ) AS expected(signature, prosrc_md5, definition_md5, return_type, returns_set)
  LOOP
    IF NOT EXISTS (
      SELECT 1
        FROM pg_proc p
       WHERE p.oid = v_target.signature
         AND pg_get_userbyid(p.proowner) = 'postgres'
         AND p.prosecdef
         AND p.provolatile = 's'
         AND p.prokind = 'f'
         AND p.prorettype = v_target.return_type
         AND p.proretset = v_target.returns_set
         AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public']::text[]
         AND p.proacl::text IS NOT DISTINCT FROM
             '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'
         AND md5(p.prosrc) = v_target.prosrc_md5
         AND md5(pg_get_functiondef(p.oid)) = v_target.definition_md5
    ) THEN
      RAISE EXCEPTION 'DRIFT_CONSOLE_READER_PREIMAGE_CHANGED: %', v_target.signature;
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid =
       'public.fn_ca_incident_recipient_ids(public.ca_drift_incidents,boolean)'::regprocedure
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND NOT p.prosecdef
       AND p.provolatile = 's'
       AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
       AND md5(p.prosrc) = '1c2ea9c78ca402a49de131740cd0ed91'
       AND md5(pg_get_functiondef(p.oid)) = 'c4db682ce0dea4c63265dab3d97b83ff'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid =
       'public.fn_ca_incident_action(uuid,text,text,uuid,text,text)'::regprocedure
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.prosecdef
       AND p.provolatile = 'v'
       AND p.prokind = 'f'
       AND p.prorettype = 'jsonb'::regtype
       AND NOT p.proretset
       AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public']::text[]
       AND p.proacl::text IS NOT DISTINCT FROM
           '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'
       AND md5(p.prosrc) = 'e6eb7478051ee1c23500e85b6c14d01e'
       AND md5(pg_get_functiondef(p.oid)) = '1017987e76a8327b7d379d795a317401'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = 'public.fn_is_platform_admin()'::regprocedure
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.prosecdef
       AND p.provolatile = 's'
       AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public']::text[]
       AND md5(p.prosrc) = 'a8d8672e0201c8036e326989ea82d05c'
       AND md5(pg_get_functiondef(p.oid)) = 'ed89787c7b832e76a886734e16a27c3d'
  ) THEN
    RAISE EXCEPTION 'DRIFT_CONSOLE_AUTHORITY_DEPENDENCY_CHANGED';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_class c
     WHERE c.oid IN (
       'public.ca_drift_incidents'::regclass,
       'public.ca_incident_events'::regclass,
       'public.ca_incident_recipients'::regclass
     )
       AND (pg_get_userbyid(c.relowner) <> 'postgres'
            OR NOT c.relrowsecurity
            OR c.relforcerowsecurity
            OR c.relacl::text IS DISTINCT FROM
               '{postgres=arwdDxtm/postgres,service_role=arwdDxtm/postgres}')
  ) THEN
    RAISE EXCEPTION 'DRIFT_CONSOLE_TABLE_AUTHORITY_CHANGED';
  END IF;
END
$pre$;

CREATE FUNCTION public.fn_ca_can_view_drift_console()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT COALESCE(auth.role(), '') = 'service_role'
      OR (
        auth.uid() IS NOT NULL
        AND (
          COALESCE(public.fn_is_platform_admin(), false)
          OR EXISTS (
            SELECT 1
              FROM public.ca_incident_recipients r
             WHERE r.user_id = auth.uid()
               AND r.active
          )
        )
      )
$function$;

ALTER FUNCTION public.fn_ca_can_view_drift_console() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_can_view_drift_console()
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_can_view_drift_console()
  TO postgres, authenticated, service_role;

COMMENT ON FUNCTION public.fn_ca_can_view_drift_console() IS
  'True only for service_role, platform staff, or an active incident-recipient registry row. This is the route/read admission check; each non-platform dashboard row is still bound to fn_ca_incident_recipient_ids for that incident.';

CREATE OR REPLACE FUNCTION public.fn_ca_incident_dashboard(
  p_status text DEFAULT NULL,
  p_limit integer DEFAULT 100
)
RETURNS SETOF jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_service boolean := COALESCE(auth.role(), '') = 'service_role';
  v_platform boolean := v_service OR COALESCE(public.fn_is_platform_admin(), false);
BEGIN
  IF NOT public.fn_ca_can_view_drift_console() THEN
    RAISE EXCEPTION 'drift console reviewer required' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT to_jsonb(i) ||
         jsonb_build_object(
           'club_name',  (SELECT name FROM public.clubs c WHERE c.id = i.club_id),
           'union_name', (SELECT name FROM public.unions u WHERE u.id = i.union_id),
           'age_minutes', floor(extract(epoch FROM now() - i.detected_at) / 60),
           'can_act', v_service OR
             (v_uid IS NOT NULL
              AND v_uid = ANY (public.fn_ca_incident_recipient_ids(i, false))),
           'events', (
             SELECT COALESCE(jsonb_agg(to_jsonb(e)), '[]'::jsonb)
               FROM (
                 SELECT at, kind, actor, detail
                   FROM public.ca_incident_events e2
                  WHERE e2.incident_id = i.id
                  ORDER BY at DESC
                  LIMIT 30
               ) e
           )
         )
    FROM public.ca_drift_incidents i
   WHERE (p_status IS NULL OR i.status = p_status)
     AND (
       v_platform
       OR (v_uid IS NOT NULL
           AND v_uid = ANY (public.fn_ca_incident_recipient_ids(i, false)))
     )
   ORDER BY (i.status = 'resolved'), i.detected_at DESC
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500);
END
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_drift_metrics()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_service boolean := COALESCE(auth.role(), '') = 'service_role';
  v_platform boolean := v_service OR COALESCE(public.fn_is_platform_admin(), false);
  v_global boolean;
  v jsonb;
BEGIN
  IF NOT public.fn_ca_can_view_drift_console() THEN
    RAISE EXCEPTION 'drift console reviewer required' USING ERRCODE = '42501';
  END IF;

  v_global := v_platform OR EXISTS (
    SELECT 1
      FROM public.ca_incident_recipients r
     WHERE r.user_id = v_uid
       AND r.active
       AND r.scope IN ('platform', 'financial_ops', 'technical')
  );

  WITH visible AS MATERIALIZED (
    SELECT i.*
      FROM public.ca_drift_incidents i
     WHERE v_platform
        OR (v_uid IS NOT NULL
            AND v_uid = ANY (public.fn_ca_incident_recipient_ids(i, false)))
  )
  SELECT jsonb_build_object(
    'open_total', count(*) FILTER (WHERE status <> 'resolved'),
    'open_critical', count(*) FILTER (
      WHERE status <> 'resolved' AND severity = 'critical'
    ),
    'past_target', count(*) FILTER (WHERE status <> 'resolved' AND past_target),
    'auto_repairing', count(*) FILTER (
      WHERE status <> 'resolved' AND auto_repair_status = 'running'
    ),
    'resolved_today', count(*) FILTER (
      WHERE status = 'resolved' AND resolved_at > CURRENT_DATE
    ),
    'median_resolve_min', (
      SELECT round(percentile_cont(0.5) WITHIN GROUP (
        ORDER BY extract(epoch FROM (resolved_at - detected_at)) / 60
      )::numeric, 1)
        FROM visible
       WHERE status = 'resolved'
         AND resolved_at > now() - interval '7 days'
    ),
    'worst_open_drift', COALESCE(max(abs(discrepancy_amount)) FILTER (
      WHERE status <> 'resolved'
    ), 0)
  ) INTO v
    FROM visible;

  IF v_global THEN
    v := v || jsonb_build_object(
      'suspense_today', (
        SELECT COALESCE(sum(
          CASE WHEN to_type = 'settlement_suspense' THEN amount ELSE -amount END
        ), 0)
          FROM public.chip_ledger
         WHERE (from_type = 'settlement_suspense' OR to_type = 'settlement_suspense')
           AND created_at > CURRENT_DATE
      ),
      'suspense_today_gross', (
        SELECT COALESCE(sum(amount), 0)
          FROM public.chip_ledger
         WHERE (from_type = 'settlement_suspense' OR to_type = 'settlement_suspense')
           AND created_at > CURRENT_DATE
      ),
      'ledger_write_failures_24h', (
        SELECT count(*)
          FROM public.ca_ledger_write_failures
         WHERE occurred_at > now() - interval '24 hours'
      ),
      'supply_unexplained_last', (
        SELECT unexplained
          FROM public.ca_supply_snapshots
         ORDER BY taken_at DESC
         LIMIT 1
      ),
      'ledger_rows_today', (
        SELECT count(*)
          FROM public.chip_ledger
         WHERE created_at > CURRENT_DATE
      )
    );
  END IF;

  RETURN v;
END
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_gate_panel()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_service boolean := COALESCE(auth.role(), '') = 'service_role';
  v_global boolean;
BEGIN
  IF NOT public.fn_ca_can_view_drift_console() THEN
    RAISE EXCEPTION 'drift console reviewer required' USING ERRCODE = '42501';
  END IF;

  v_global := v_service
    OR COALESCE(public.fn_is_platform_admin(), false)
    OR EXISTS (
      SELECT 1
        FROM public.ca_incident_recipients r
       WHERE r.user_id = v_uid
         AND r.active
         AND r.scope IN ('platform', 'financial_ops', 'technical')
    );
  IF NOT v_global THEN RETURN NULL; END IF;

  RETURN jsonb_build_object(
    'gate', (
      SELECT to_jsonb(g)
        FROM (
          SELECT run_at, pass, window_hours, failing, result
            FROM public.ca_gate_runs
           ORDER BY run_at DESC
           LIMIT 1
        ) g
    ),
    'supply_series', (
      SELECT COALESCE(jsonb_agg(to_jsonb(s) ORDER BY s.taken_at), '[]'::jsonb)
        FROM (
          SELECT taken_at, round(unexplained, 2) AS unexplained,
                 round(total, 2) AS total, round(cert_wallets, 2) AS cert_wallets,
                 round(leaderboard_liability, 2) AS leaderboard_liability
            FROM public.ca_supply_snapshots
           WHERE taken_at > now() - interval '24 hours'
           ORDER BY taken_at DESC
           LIMIT 48
        ) s
    ),
    'diamond_series', (
      SELECT COALESCE(jsonb_agg(to_jsonb(d) ORDER BY d.taken_at), '[]'::jsonb)
        FROM (
          SELECT taken_at, round(unexplained, 2) AS unexplained,
                 round(total, 2) AS total
            FROM public.ca_diamond_snapshots
           WHERE taken_at > now() - interval '24 hours'
           ORDER BY taken_at DESC
           LIMIT 48
        ) d
    ),
    'open_counts', (
      SELECT jsonb_object_agg(severity, n)
        FROM (
          SELECT severity, count(*) AS n
            FROM public.ca_drift_incidents
           WHERE status <> 'resolved'
           GROUP BY severity
        ) c
    ),
    'generated_at', now()
  );
END
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_balance_asof_admin(
  p_entity_type text,
  p_entity_id uuid,
  p_asof timestamp with time zone
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_service boolean := COALESCE(auth.role(), '') = 'service_role';
  v_global boolean;
BEGIN
  IF NOT public.fn_ca_can_view_drift_console() THEN
    RAISE EXCEPTION 'drift console reviewer required' USING ERRCODE = '42501';
  END IF;

  v_global := v_service
    OR COALESCE(public.fn_is_platform_admin(), false)
    OR EXISTS (
      SELECT 1
        FROM public.ca_incident_recipients r
       WHERE r.user_id = v_uid
         AND r.active
         AND r.scope IN ('platform', 'financial_ops', 'technical')
    );
  IF NOT v_global THEN RETURN NULL; END IF;
  RETURN public.fn_ca_balance_asof(p_entity_type, p_entity_id, p_asof);
END
$function$;

ALTER FUNCTION public.fn_ca_incident_dashboard(text, integer) OWNER TO postgres;
ALTER FUNCTION public.fn_ca_drift_metrics() OWNER TO postgres;
ALTER FUNCTION public.fn_ca_gate_panel() OWNER TO postgres;
ALTER FUNCTION public.fn_ca_balance_asof_admin(text, uuid, timestamptz) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.fn_ca_incident_dashboard(text, integer)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_ca_drift_metrics()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_ca_gate_panel()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_ca_balance_asof_admin(text, uuid, timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.fn_ca_incident_dashboard(text, integer)
  TO postgres, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_drift_metrics()
  TO postgres, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_gate_panel()
  TO postgres, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_balance_asof_admin(text, uuid, timestamptz)
  TO postgres, authenticated, service_role;

DO $negative$
DECLARE
  v_prior_sub text := current_setting('request.jwt.claim.sub', true);
  v_prior_role text := current_setting('request.jwt.claim.role', true);
  v_refused integer := 0;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000099', true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);

  IF public.fn_ca_can_view_drift_console() THEN
    RAISE EXCEPTION 'UNKNOWN_CALLER_WAS_ADMITTED_TO_DRIFT_CONSOLE';
  END IF;

  BEGIN
    PERFORM public.fn_ca_incident_dashboard(NULL, 1);
    RAISE EXCEPTION 'UNKNOWN_CALLER_READ_DRIFT_DASHBOARD';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM <> 'drift console reviewer required' THEN RAISE; END IF;
    v_refused := v_refused + 1;
  END;

  BEGIN
    PERFORM public.fn_ca_drift_metrics();
    RAISE EXCEPTION 'UNKNOWN_CALLER_READ_DRIFT_METRICS';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM <> 'drift console reviewer required' THEN RAISE; END IF;
    v_refused := v_refused + 1;
  END;

  BEGIN
    PERFORM public.fn_ca_gate_panel();
    RAISE EXCEPTION 'UNKNOWN_CALLER_READ_DRIFT_GATE';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM <> 'drift console reviewer required' THEN RAISE; END IF;
    v_refused := v_refused + 1;
  END;

  BEGIN
    PERFORM public.fn_ca_balance_asof_admin(
      'club', '00000000-0000-4000-8000-000000000099'::uuid, now()
    );
    RAISE EXCEPTION 'UNKNOWN_CALLER_READ_BALANCE_ASOF';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM <> 'drift console reviewer required' THEN RAISE; END IF;
    v_refused := v_refused + 1;
  END;

  PERFORM set_config('request.jwt.claim.sub', COALESCE(v_prior_sub, ''), true);
  PERFORM set_config('request.jwt.claim.role', COALESCE(v_prior_role, ''), true);

  IF v_refused <> 4 THEN
    RAISE EXCEPTION 'DRIFT_CONSOLE_REFUSAL_PROBE_FAILED';
  END IF;
END
$negative$;

DO $post$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = 'public.fn_ca_can_view_drift_console()'::regprocedure
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.prosecdef
       AND p.provolatile = 's'
       AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
       AND p.proacl::text IS NOT DISTINCT FROM
           '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'
       AND md5(p.prosrc) = 'f5da9d3b8fae7b840878498b67c6fc82'
       AND md5(pg_get_functiondef(p.oid)) = '8e8acf21077ffb728c4fd461cc1d723a'
       AND position('ca_incident_recipients' IN p.prosrc) > 0
       AND position('fn_is_platform_admin' IN p.prosrc) > 0
  ) THEN
    RAISE EXCEPTION 'DRIFT_CONSOLE_REVIEWER_CAPABILITY_POSTIMAGE_FAILED';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = 'public.fn_ca_incident_dashboard(text,integer)'::regprocedure
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.prosecdef
       AND p.provolatile = 's'
       AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
       AND p.proacl::text IS NOT DISTINCT FROM
           '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'
       AND md5(p.prosrc) = 'eba4e72a10c4667ca8e09d17c3a20868'
       AND md5(pg_get_functiondef(p.oid)) = '2a7efba776e3845b9391e2934d1c642c'
       AND position('fn_ca_can_view_drift_console' IN p.prosrc) > 0
       AND position('fn_ca_incident_recipient_ids(i, false)' IN p.prosrc) > 0
       AND position('''can_act''' IN p.prosrc) > 0
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = 'public.fn_ca_drift_metrics()'::regprocedure
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.prosecdef
       AND p.provolatile = 's'
       AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
       AND p.proacl::text IS NOT DISTINCT FROM
           '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'
       AND md5(p.prosrc) = '68eaf86fa89d48255ab75e2503f645d5'
       AND md5(pg_get_functiondef(p.oid)) = 'ce915eaeb1a22626afa9962800e2a904'
       AND position('WITH visible AS MATERIALIZED' IN p.prosrc) > 0
       AND position('fn_ca_incident_recipient_ids(i, false)' IN p.prosrc) > 0
       AND position('financial_ops' IN p.prosrc) > 0
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = 'public.fn_ca_gate_panel()'::regprocedure
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.prosecdef
       AND p.provolatile = 's'
       AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
       AND p.proacl::text IS NOT DISTINCT FROM
           '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'
       AND md5(p.prosrc) = '1fd06b5d4526e8e15cabfa823da329c2'
       AND md5(pg_get_functiondef(p.oid)) = 'afb1a845a440e4851daf85433859bf7e'
       AND position('IF NOT v_global THEN RETURN NULL' IN p.prosrc) > 0
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid =
       'public.fn_ca_balance_asof_admin(text,uuid,timestamp with time zone)'::regprocedure
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.prosecdef
       AND p.provolatile = 's'
       AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
       AND p.proacl::text IS NOT DISTINCT FROM
           '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'
       AND md5(p.prosrc) = '2bb316de9ab7e8051c39f943477bbfd3'
       AND md5(pg_get_functiondef(p.oid)) = 'a2be83ba8bd5487154ab0fc74e08471f'
       AND position('IF NOT v_global THEN RETURN NULL' IN p.prosrc) > 0
  ) THEN
    RAISE EXCEPTION 'DRIFT_CONSOLE_READER_POSTIMAGE_FAILED';
  END IF;
END
$post$;

COMMIT;
