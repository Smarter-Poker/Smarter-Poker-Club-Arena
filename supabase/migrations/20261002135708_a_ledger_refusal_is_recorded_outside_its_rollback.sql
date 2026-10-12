-- ===========================================================================
--  A LEDGER REFUSAL IS RECORDED OUTSIDE ITS ROLLBACK
-- ===========================================================================
--
-- Dan, launch plan phase 1a: a ledger-invariant refusal must never fail
-- silently.
--
-- THE GAP. Every chip store refuses (ca_ledger_invariant_store_mode, all 16
-- rows 'refuse'). The deferred constraint triggers zz_ca_balance_has_its_ledger_row
-- and zz_ca_ledger_row_has_its_balance call fn_ca_balance_has_its_ledger_row at
-- COMMIT, and a disagreement raises SQLSTATE 23514
--   REFUSED: balance_moved_without_its_ledger_row ...
--   REFUSED: balance_moved_against_settlement_suspense ...
-- The raise rolls the WHOLE transaction back, and with it anything the check
-- could have written: the ca_ledger_invariant_findings row is written only in
-- observe mode, and in refuse mode it would roll back anyway. So a refused hand,
-- payout, cron job, World Hub route or client RPC left a Postgres log line and
-- nothing else, and "0 findings" could not tell "0 refusals" from "nobody
-- recorded the refusals" (CLAUDE.md 10.83, 10.86 rule 1).
--
-- WHY THE RECORD IS WRITTEN HERE, AND NOT AT EACH CALLER. A refusal can be hit
-- by four kinds of caller - the Hetzner engine, World Hub API routes, pg_cron
-- jobs, and any client RPC - and only the database sees all four. So the
-- refusing session writes the record itself, on a SECOND connection that
-- commits on its own (an autonomous write), immediately before it raises:
--
--   * dblink is installed on this project (public, 1.2). It is not called
--     with dblink_connect_u (superuser only) and there is no foreign server
--     (dblink_fdw belongs to supabase_admin; postgres has no USAGE on it). The
--     loopback is an ordinary password connection, which is what dblink allows
--     a non-superuser.
--   * Measured from the database itself, 2026-10-02 13:44 UTC, each in a
--     rolled-back DO block: localhost/127.0.0.1 and the unix socket are TRUST
--     (dblink refuses those for a non-superuser: "Non-superusers may only
--     connect using credentials they provide"), while the project host
--     db.kuklfnapbkmacvwxktbh.supabase.co reaches scram-sha-256 password
--     authentication in 54 ms. That is the loopback used.
--   * THE CREDENTIAL IS NEVER IN SOURCE. This file creates a LOGIN role,
--     ca_ledger_refusal_recorder, whose password is generated inside this
--     transaction (two gen_random_uuid(), 244 random bits), set by a nested
--     EXECUTE (log_statement = ddl logs top-level statements only; pgaudit.log
--     is none), and stored in Supabase Vault - the project's existing secret
--     store, already holding mlb_cron_secret - as the connection string
--     'ca_ledger_refusal_recorder_conninfo'. Nobody, including the author,
--     ever sees the value. Re-applying the file rotates it.
--   * THE ROLE CAN DO TWO THINGS. It has EXECUTE on fn_ca_ledger_refusal_file
--     and fn_ca_ledger_refusal_raise and USAGE on the schema, nothing else: no
--     table privilege, not a member of any role, CONNECTION LIMIT 4,
--     statement_timeout 3s, lock_timeout 1s. It is not granted to
--     authenticator, so PostgREST cannot reach it.
--   * IT NEVER BLOCKS OR FAILS THE REFUSAL. fn_ca_ledger_refusal_record wraps
--     every step in its own exception block and returns false on any failure;
--     the refusal is raised exactly as before, with the same SQLSTATE, message,
--     DETAIL and HINT. connect_timeout=2 bounds the connect, the role's
--     statement_timeout bounds the remote work, and the incident is raised in
--     a SEPARATE remote statement after the record has committed, so a slow
--     incident board can never cost the record. A refusing transaction holds
--     its row locks for the ~60 ms the record takes.
--   * "COULD NOT TELL" IS NOT ZERO. Before it tries the connection the
--     refusing session takes the next value of ca_ledger_invariant_refusal_counter.
--     nextval is not rolled back, so the counter is a durable count of every
--     refusal even when its record could not be written (role at its
--     connection limit, DNS, Vault). fn_ca_ledger_invariant_refusal_census()
--     compares the counter with the records; fn_ca_ledger_invariant_refusal_watch()
--     turns every number that never got a record into an explicit 'unrecorded'
--     row and a critical incident. It runs inside the existing
--     fn_ca_cron_failure_watch (ca-cron-health-30m) - no new schedule.
--
-- THE READER. Every recorded refusal raises (or folds into) a CRITICAL
-- ca_drift_incidents row through fn_ca_raise_drift_incident, source
-- 'ledger_invariant.refused', classification ledger_imbalance, layer ledger,
-- with the function, the account, the balance delta and the ledger net.
-- Dedupe key ledger-invariant-refused:<kind>:<function>:<account>: a loop that
-- refuses the same account through the same function folds into one open
-- incident whose occurrences count climbs, so it cannot flood the board, and
-- every individual refusal is still a row in ca_ledger_invariant_refusals.
--
-- NOTHING ELSE CHANGES. The judgement (which transactions are refused, and
-- why) is byte-for-byte the body 20261002065836 left live; the two refuse
-- branches gain one PERFORM each, before their RAISE. No money moves, no hot
-- table is locked (the new objects reference nothing), nothing is dropped.
--
-- CLAUDE.md section 2: one migration, one transaction, applied once by
-- apply-merged-migration.yml outside :50-:03 UTC.
-- ===========================================================================
-- @live-proof: to_regclass('public.ca_ledger_invariant_refusals') IS NOT NULL AND position('fn_ca_ledger_refusal_record' IN (SELECT prosrc FROM pg_proc WHERE oid = 'public.fn_ca_balance_has_its_ledger_row()'::regprocedure)) > 0 AND EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'ca_ledger_refusal_recorder_conninfo')

BEGIN;

SET LOCAL lock_timeout = '250ms';
SET LOCAL statement_timeout = '60s';

-- ---------------------------------------------------------------------------
-- 0. Preimage: the bodies this file builds on are the ones read on 2026-10-02
-- ---------------------------------------------------------------------------

DO $pre$
DECLARE
  r record;
  v_live text;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('fn_ca_balance_has_its_ledger_row', 'ddf1a2f088a47c1466d996efb7143e85'),
      ('fn_ca_cron_failure_watch',         'b07401212a118bc574611691e7bd152c')) AS x(f, m)
  LOOP
    SELECT md5(pg_get_functiondef(p.oid)) INTO v_live
      FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = r.f;
    IF v_live IS DISTINCT FROM r.m THEN
      RAISE EXCEPTION 'preimage: % is not the body read on 2026-10-02 (md5 %, expected %); re-read it before redefining it', r.f, v_live, r.m;
    END IF;
  END LOOP;
  IF to_regnamespace('vault') IS NULL OR to_regprocedure('vault.create_secret(text,text,text,uuid)') IS NULL THEN
    RAISE EXCEPTION 'preimage: Supabase Vault is not installed; the recorder has nowhere to keep its credential';
  END IF;
  IF to_regprocedure('public.fn_ca_raise_drift_incident(text,text,text,text,numeric,numeric,numeric,text,text,uuid,uuid,uuid,uuid,uuid,uuid,text,uuid[],uuid[],text,boolean,jsonb)') IS NULL THEN
    RAISE EXCEPTION 'preimage: fn_ca_raise_drift_incident is not the signature this file raises through';
  END IF;
  IF to_regprocedure('public.dblink_connect(text,text)') IS NULL THEN
    RAISE EXCEPTION 'preimage: dblink is not installed in public';
  END IF;
END $pre$;

-- ---------------------------------------------------------------------------
-- 1. The counter, the record, and the watch's watermark
-- ---------------------------------------------------------------------------

CREATE SEQUENCE IF NOT EXISTS public.ca_ledger_invariant_refusal_counter
  AS bigint START 1 MINVALUE 1 NO CYCLE CACHE 1;
COMMENT ON SEQUENCE public.ca_ledger_invariant_refusal_counter IS
  'One value per ledger-invariant refusal, taken by the refusing session before it raises. nextval is not rolled back, so this counts every refusal even when its record could not be written. fn_ca_ledger_invariant_refusal_census() compares it with ca_ledger_invariant_refusals. 20261002135708.';
REVOKE ALL ON SEQUENCE public.ca_ledger_invariant_refusal_counter FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON SEQUENCE public.ca_ledger_invariant_refusal_counter TO service_role;

CREATE TABLE IF NOT EXISTS public.ca_ledger_invariant_refusals (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  counter_no       bigint UNIQUE,
  kind             text NOT NULL CHECK (kind IN (
                     'balance_moved_without_its_ledger_row',
                     'balance_moved_against_settlement_suspense',
                     'unrecorded')),
  refused_at       timestamptz,
  recorded_at      timestamptz NOT NULL DEFAULT now(),
  txid             text,
  account_key      text,
  store            text,
  balance_delta    numeric,
  ledger_net       numeric,
  mode             text,
  rpc              text,
  db_role          text,
  session_role     text,
  application_name text,
  jwt_role         text,
  jwt_sub          text,
  first_writer     text,
  query            text,
  backend_pid      integer,
  message          text,
  moved            text,
  incident_id      uuid
);
COMMENT ON TABLE public.ca_ledger_invariant_refusals IS
  'Every ledger-invariant refusal (REFUSED: balance_moved_without_its_ledger_row / balance_moved_against_settlement_suspense, SQLSTATE 23514), written by the refusing session on its own loopback connection so the row survives the refused transaction''s rollback. kind = unrecorded: the counter shows a refusal whose record never arrived (fn_ca_ledger_invariant_refusal_watch). No foreign keys, by rule (CLAUDE.md section 2 rule 7). 20261002135708.';
CREATE INDEX IF NOT EXISTS ca_ledger_invariant_refusals_refused_at_idx
  ON public.ca_ledger_invariant_refusals (refused_at DESC);
CREATE INDEX IF NOT EXISTS ca_ledger_invariant_refusals_rpc_account_idx
  ON public.ca_ledger_invariant_refusals (rpc, account_key);
CREATE INDEX IF NOT EXISTS ca_ledger_invariant_refusals_unraised_idx
  ON public.ca_ledger_invariant_refusals (id) WHERE incident_id IS NULL;
ALTER TABLE public.ca_ledger_invariant_refusals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_ledger_invariant_refusals FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.ca_ledger_invariant_refusals TO service_role;

CREATE TABLE IF NOT EXISTS public.ca_ledger_invariant_refusal_watch_state (
  id                    boolean PRIMARY KEY DEFAULT true CHECK (id),
  checked_through       bigint NOT NULL DEFAULT 0,
  counted_at_last_watch bigint NOT NULL DEFAULT 0,
  watched_at            timestamptz
);
COMMENT ON TABLE public.ca_ledger_invariant_refusal_watch_state IS
  'One row: how far fn_ca_ledger_invariant_refusal_watch has checked the refusal counter against its records. A number is only judged unrecorded once a whole watch interval has passed since it was counted. 20261002135708.';
ALTER TABLE public.ca_ledger_invariant_refusal_watch_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_ledger_invariant_refusal_watch_state FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.ca_ledger_invariant_refusal_watch_state TO service_role;
INSERT INTO public.ca_ledger_invariant_refusal_watch_state (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

INSERT INTO public.ca_detector_registry (source, owner, sla_hours, note)
VALUES ('ledger_invariant.refused', 'chip standard', 4,
        'a ledger-invariant refusal (SQLSTATE 23514 REFUSED:) recorded outside its rollback by fn_ca_ledger_refusal_record; one open incident per kind, function and account; 20261002135708')
ON CONFLICT (source) DO UPDATE SET owner = EXCLUDED.owner, sla_hours = EXCLUDED.sla_hours, note = EXCLUDED.note, updated_at = now();

-- ---------------------------------------------------------------------------
-- 2. What the recorder's connection may run: file the row, raise the incident
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn_ca_ledger_refusal_file(p_refusal jsonb)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_id bigint;
  v_no bigint := NULLIF(p_refusal ->> 'counter_no', '')::bigint;
BEGIN
  /* Runs on the recorder's own connection and commits on its own: this row
     outlives the refused transaction. A placeholder the watch wrote for the
     same counter number (kind unrecorded) is replaced by the late record. */
  INSERT INTO public.ca_ledger_invariant_refusals AS x
    (counter_no, kind, refused_at, txid, account_key, store, balance_delta,
     ledger_net, mode, rpc, db_role, session_role, application_name, jwt_role,
     jwt_sub, first_writer, query, backend_pid, message, moved)
  VALUES
    (v_no,
     p_refusal ->> 'kind',
     NULLIF(p_refusal ->> 'refused_at', '')::timestamptz,
     p_refusal ->> 'txid',
     p_refusal ->> 'account_key',
     p_refusal ->> 'store',
     NULLIF(p_refusal ->> 'balance_delta', '')::numeric,
     NULLIF(p_refusal ->> 'ledger_net', '')::numeric,
     p_refusal ->> 'mode',
     left(p_refusal ->> 'rpc', 200),
     p_refusal ->> 'db_role',
     p_refusal ->> 'session_role',
     p_refusal ->> 'application_name',
     p_refusal ->> 'jwt_role',
     p_refusal ->> 'jwt_sub',
     left(p_refusal ->> 'first_writer', 1000),
     left(p_refusal ->> 'query', 2000),
     NULLIF(p_refusal ->> 'backend_pid', '')::integer,
     left(p_refusal ->> 'message', 2000),
     left(p_refusal ->> 'moved', 2000))
  ON CONFLICT (counter_no) DO UPDATE
    SET kind = EXCLUDED.kind, refused_at = EXCLUDED.refused_at, recorded_at = now(),
        txid = EXCLUDED.txid, account_key = EXCLUDED.account_key, store = EXCLUDED.store,
        balance_delta = EXCLUDED.balance_delta, ledger_net = EXCLUDED.ledger_net,
        mode = EXCLUDED.mode, rpc = EXCLUDED.rpc, db_role = EXCLUDED.db_role,
        session_role = EXCLUDED.session_role, application_name = EXCLUDED.application_name,
        jwt_role = EXCLUDED.jwt_role, jwt_sub = EXCLUDED.jwt_sub,
        first_writer = EXCLUDED.first_writer, query = EXCLUDED.query,
        backend_pid = EXCLUDED.backend_pid, message = EXCLUDED.message,
        moved = EXCLUDED.moved, incident_id = NULL
    WHERE x.kind = 'unrecorded'
  RETURNING x.id INTO v_id;

  IF v_id IS NULL THEN
    SELECT id INTO v_id FROM public.ca_ledger_invariant_refusals WHERE counter_no = v_no;
  END IF;
  RETURN v_id;
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_ledger_refusal_file(jsonb) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_ca_ledger_invariant_refusal_census()
RETURNS TABLE (counted bigint, recorded bigint, unrecorded bigint, unraised bigint, last_refused_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
  /* counted: refusals the counter saw (durable through every rollback).
     recorded: refusals whose own record arrived. unrecorded = counted -
     recorded: refusals known to have happened whose details never arrived.
     unraised: records with no incident yet. */
  WITH c AS (
    SELECT CASE WHEN s.is_called THEN s.last_value ELSE 0 END AS n
      FROM public.ca_ledger_invariant_refusal_counter s
  ), r AS (
    SELECT count(*) FILTER (WHERE kind <> 'unrecorded' AND counter_no IS NOT NULL) AS recorded,
           count(*) FILTER (WHERE kind <> 'unrecorded' AND incident_id IS NULL) AS unraised,
           max(refused_at) AS last_refused_at
      FROM public.ca_ledger_invariant_refusals
  )
  SELECT c.n, r.recorded, greatest(c.n - r.recorded, 0), r.unraised, r.last_refused_at
    FROM c, r;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_ledger_invariant_refusal_census() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_ledger_invariant_refusal_census() TO service_role;

CREATE OR REPLACE FUNCTION public.fn_ca_ledger_refusal_raise(p_id bigint)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  r public.ca_ledger_invariant_refusals%ROWTYPE;
  c record;
  v_incident uuid;
  v_key text;
BEGIN
  SELECT * INTO r FROM public.ca_ledger_invariant_refusals WHERE id = p_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  SELECT * INTO c FROM public.fn_ca_ledger_invariant_refusal_census();

  /* ONE INCIDENT PER BURST. A loop refusing the same account through the
     same function folds into the open incident (occurrences + 1); every
     refusal is still its own row in ca_ledger_invariant_refusals. */
  v_key := CASE WHEN r.kind = 'unrecorded'
                THEN 'ledger-invariant-refusal-unrecorded'
                ELSE 'ledger-invariant-refused:' || r.kind || ':' || COALESCE(r.rpc, 'unknown') || ':' || COALESCE(r.account_key, 'unknown')
           END;

  v_incident := public.fn_ca_raise_drift_incident(
    p_source          := 'ledger_invariant.refused',
    p_classification  := 'ledger_imbalance',
    p_severity        := 'critical',
    p_dedupe_key      := v_key,
    p_discrepancy     := round(COALESCE(r.balance_delta, 0) - COALESCE(r.ledger_net, 0), 2),
    p_expected        := r.ledger_net,
    p_actual          := r.balance_delta,
    p_layer           := 'ledger',
    p_entity_type     := 'chip_store',
    p_suspected_cause := CASE WHEN r.kind = 'unrecorded'
      THEN 'the ledger invariant refused a transaction and its record never arrived (counter ' || r.counter_no
           || '); the refusal is real, its details are only in the Postgres log under LEDGER_REFUSAL_UNRECORDED counter=' || r.counter_no
      ELSE left(COALESCE(r.message, r.kind), 400) || ' via ' || COALESCE(r.rpc, 'unknown')
           || ' (role ' || COALESCE(r.db_role, '?') || ', application ' || COALESCE(r.application_name, '?') || ')'
      END,
    p_metadata        := jsonb_build_object(
      'refusal_id', r.id, 'counter_no', r.counter_no, 'kind', r.kind,
      'function', r.rpc, 'account_key', r.account_key, 'store', r.store,
      'balance_delta', r.balance_delta, 'ledger_net', r.ledger_net, 'moved', r.moved,
      'db_role', r.db_role, 'application_name', r.application_name,
      'jwt_role', r.jwt_role, 'jwt_sub', r.jwt_sub, 'txid', r.txid,
      'refused_at', r.refused_at, 'first_writer', left(r.first_writer, 300),
      'census', jsonb_build_object('counted', c.counted, 'recorded', c.recorded,
                                   'unrecorded', c.unrecorded, 'unraised', c.unraised)));

  UPDATE public.ca_ledger_invariant_refusals SET incident_id = v_incident WHERE id = p_id;
  RETURN v_incident;
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_ledger_refusal_raise(bigint) FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. The recorder's identity: a login that can only file a refusal, whose
--    password nobody sees, kept in Vault
-- ---------------------------------------------------------------------------

DO $role$
DECLARE
  v_pw   text := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  v_host text := COALESCE(NULLIF(current_setting('ca.ledger_refusal_recorder_host', true), ''), 'db.kuklfnapbkmacvwxktbh.supabase.co');
  v_port text := COALESCE(NULLIF(current_setting('ca.ledger_refusal_recorder_port', true), ''), '5432');
  v_ssl  text := COALESCE(NULLIF(current_setting('ca.ledger_refusal_recorder_sslmode', true), ''), 'require');
  v_info text;
  v_secret uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ca_ledger_refusal_recorder') THEN
    CREATE ROLE ca_ledger_refusal_recorder LOGIN NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION CONNECTION LIMIT 4;
  END IF;
  ALTER ROLE ca_ledger_refusal_recorder LOGIN NOINHERIT CONNECTION LIMIT 4;
  EXECUTE format('ALTER ROLE ca_ledger_refusal_recorder PASSWORD %L', v_pw);

  v_info := format('host=%s port=%s dbname=%s user=ca_ledger_refusal_recorder password=%s sslmode=%s connect_timeout=2 application_name=ca_ledger_refusal_recorder',
                   v_host, v_port, current_database(), v_pw, v_ssl);
  SELECT id INTO v_secret FROM vault.secrets WHERE name = 'ca_ledger_refusal_recorder_conninfo';
  IF v_secret IS NULL THEN
    PERFORM vault.create_secret(v_info, 'ca_ledger_refusal_recorder_conninfo',
      'loopback for fn_ca_ledger_refusal_record (20261002135708): a ledger refusal is recorded outside its rollback');
  ELSE
    PERFORM vault.update_secret(v_secret, v_info);
  END IF;
END $role$;

ALTER ROLE ca_ledger_refusal_recorder SET statement_timeout = '3s';
ALTER ROLE ca_ledger_refusal_recorder SET lock_timeout = '1s';
ALTER ROLE ca_ledger_refusal_recorder SET idle_in_transaction_session_timeout = '5s';
GRANT USAGE ON SCHEMA public TO ca_ledger_refusal_recorder;
GRANT EXECUTE ON FUNCTION public.fn_ca_ledger_refusal_file(jsonb) TO ca_ledger_refusal_recorder;
GRANT EXECUTE ON FUNCTION public.fn_ca_ledger_refusal_raise(bigint) TO ca_ledger_refusal_recorder;

-- ---------------------------------------------------------------------------
-- 4. The recorder: called by the refusing session, never fails it
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn_ca_ledger_refusal_record(p_refusal jsonb)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_no      bigint;
  v_conn    text := 'ca_ledger_refusal_' || pg_backend_pid();
  v_info    text;
  v_id      bigint;
  v_claims  jsonb;
  v_path    text;
  v_q       text;
  v_src     text;
  v_payload jsonb;
BEGIN
  /* 1. COUNT IT FIRST. nextval survives the rollback that follows, so the
        refusal is counted even if nothing below works. */
  BEGIN
    v_no := nextval('public.ca_ledger_invariant_refusal_counter');
  EXCEPTION WHEN OTHERS THEN
    v_no := NULL;
  END;

  /* 2. Say who refused it. Inside SECURITY DEFINER current_user is the owner,
        so the caller is read from the role setting (PostgREST's SET ROLE),
        the session user, the JWT claims and the request path. */
  BEGIN
    v_path := NULLIF(current_setting('request.path', true), '');
    v_q := left(current_query(), 2000);
    /* The check is deferred to COMMIT, so for an explicit transaction the
       current statement is the COMMIT itself; the statement that first wrote
       the money (kept by the tally) then names the caller instead. */
    v_src := CASE WHEN v_q ~* '^\s*(commit|end)\y'
                  THEN COALESCE(NULLIF(p_refusal ->> 'first_writer', ''), v_q)
                  ELSE v_q END;
    BEGIN
      v_claims := NULLIF(current_setting('request.jwt.claims', true), '')::jsonb;
    EXCEPTION WHEN OTHERS THEN
      v_claims := NULL;
    END;
    v_payload := COALESCE(p_refusal, '{}'::jsonb) || jsonb_build_object(
      'counter_no',       v_no,
      'refused_at',       clock_timestamp(),
      'txid',             pg_current_xact_id()::text,
      'rpc',              COALESCE(
                            substring(v_path from '^/rpc/([A-Za-z0-9_]+)'),
                            CASE WHEN v_path IS NOT NULL
                                 THEN COALESCE(NULLIF(current_setting('request.method', true), ''), '?') || ' ' || v_path END,
                            substring(v_src from '(?i)(?:select|perform|call)\s+(?:\*\s+from\s+)?(?:"?[a-z_][a-z0-9_]*"?\.)?"?([a-z_][a-z0-9_]*)"?\s*\('),
                            (SELECT lower(regexp_replace(m[1], '\s+', ' ', 'g')) || ' ' || m[2]
                               FROM regexp_match(v_src, '(?i)^\s*(update|insert\s+into|delete\s+from)\s+([a-z0-9_."]+)') m),
                            'unknown'),
      'db_role',          COALESCE(NULLIF(current_setting('role', true), 'none'), session_user::text),
      'session_role',     session_user::text,
      'application_name', current_setting('application_name', true),
      'jwt_role',         v_claims ->> 'role',
      'jwt_sub',          v_claims ->> 'sub',
      'query',            v_q,
      'backend_pid',      pg_backend_pid());
  EXCEPTION WHEN OTHERS THEN
    v_payload := COALESCE(p_refusal, '{}'::jsonb) || jsonb_build_object('counter_no', v_no, 'refused_at', clock_timestamp());
  END;

  /* 3. WRITE IT WHERE THE ROLLBACK CANNOT REACH: the recorder's own
        connection, which commits each statement on its own. */
  BEGIN
    SELECT s.decrypted_secret INTO v_info
      FROM vault.decrypted_secrets s
     WHERE s.name = 'ca_ledger_refusal_recorder_conninfo'
     LIMIT 1;
    IF v_info IS NULL THEN
      RAISE WARNING 'LEDGER_REFUSAL_UNRECORDED counter=% reason=no recorder connection string in vault', v_no;
      RETURN false;
    END IF;

    IF v_conn = ANY (COALESCE(public.dblink_get_connections(), ARRAY[]::text[])) THEN
      PERFORM public.dblink_disconnect(v_conn);
    END IF;
    PERFORM public.dblink_connect(v_conn, v_info);

    SELECT t.id INTO v_id
      FROM public.dblink(v_conn, format('SELECT public.fn_ca_ledger_refusal_file(%L::jsonb)', v_payload::text)) AS t(id bigint);

    /* 4. The incident, in its own remote statement, after the record has
          committed: a slow board can cost the incident, never the record. */
    BEGIN
      PERFORM 1 FROM public.dblink(v_conn, format('SELECT public.fn_ca_ledger_refusal_raise(%s)', v_id)) AS t(incident uuid);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'LEDGER_REFUSAL_RECORDED_NOT_RAISED refusal=% counter=% reason=%', v_id, v_no, SQLERRM;
    END;

    PERFORM public.dblink_disconnect(v_conn);
    RETURN true;
  EXCEPTION WHEN OTHERS THEN
    BEGIN
      IF v_conn = ANY (COALESCE(public.dblink_get_connections(), ARRAY[]::text[])) THEN
        PERFORM public.dblink_disconnect(v_conn);
      END IF;
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
    RAISE WARNING 'LEDGER_REFUSAL_UNRECORDED counter=% reason=%', v_no, SQLERRM;
    RETURN false;
  END;
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_ledger_refusal_record(jsonb) FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. The judgement, unchanged, now recording each refusal before it raises
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn_ca_balance_has_its_ledger_row()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_ver text := NULLIF(current_setting('ca.ledger_tally_ver', true), '');
  v_checked text := NULLIF(current_setting('ca.ledger_tally_checked', true), '');
  v_mode text;
  t jsonb;
  r record;
  v_b numeric; v_l numeric;
  v_s numeric; v_moved text; v_moved_abs numeric;
BEGIN
  /* Deferred to commit. Every queued event re-enters here, so the tally is
     verified once per version: when nothing has been added since the last
     verification this is one setting read and out. A deferred trigger that
     writes money after us bumps the version and queues its own event, which
     verifies again, so the last word is always on the complete tally. */
  IF v_ver IS NULL OR v_ver = v_checked THEN
    RETURN NULL;
  END IF;

  t := COALESCE(NULLIF(current_setting('ca.ledger_tally', true), '')::jsonb, '{}'::jsonb);

  FOR r IN SELECT key, value FROM jsonb_each(t) LOOP
    v_b := round(COALESCE((r.value ->> 'b')::numeric, 0), 2);
    v_l := round(COALESCE((r.value ->> 'l')::numeric, 0), 2);
    IF v_b = v_l THEN
      CONTINUE;
    END IF;

    /* 2026-10-02: each store is judged by its own mode
       (ca_ledger_invariant_store_mode, keyed by the account-key prefix), so a
       store still being measured records a finding while a proven store
       refuses. A store with no row falls back to the one global row. */
    v_mode := COALESCE(
      (SELECT sm.mode FROM public.ca_ledger_invariant_store_mode sm WHERE sm.store = split_part(r.key, ':', 1)),
      (SELECT m.mode FROM public.ca_ledger_invariant_mode m LIMIT 1),
      'refuse');

    IF v_mode = 'refuse' THEN
      /* 20261002135708: the refusal rolls this transaction back, so it is
         recorded first on the recorder's own connection, which commits on
         its own. The recorder never raises and never changes the refusal. */
      BEGIN
        PERFORM public.fn_ca_ledger_refusal_record(jsonb_build_object(
          'kind',          'balance_moved_without_its_ledger_row',
          'account_key',   r.key,
          'store',         split_part(r.key, ':', 1),
          'balance_delta', v_b,
          'ledger_net',    v_l,
          'mode',          v_mode,
          'first_writer',  left(COALESCE(r.value ->> 'q', '(unknown statement)'), 1000),
          'message',       format('REFUSED: balance_moved_without_its_ledger_row account=%s balance_delta=%s ledger_net=%s', r.key, v_b, v_l)));
      EXCEPTION WHEN OTHERS THEN
        NULL;
      END;
      RAISE EXCEPTION 'REFUSED: balance_moved_without_its_ledger_row account=% balance_delta=% ledger_net=%',
        r.key, v_b, v_l
        USING ERRCODE = '23514',
              DETAIL  = CASE
                          WHEN v_l = 0 THEN 'the balance column moved and no chip_ledger leg in this transaction accounts for it'
                          WHEN v_b = 0 THEN 'a chip_ledger leg names this account and its balance column did not move in this transaction'
                          ELSE 'the balance column and the chip_ledger legs in this transaction disagree on how much moved'
                        END || '; first written in this transaction by: ' || COALESCE(r.value ->> 'q', '(unknown statement)'),
              HINT    = 'Every chip movement is written by its door as balance + leg in one transaction. If the door stood the autoledger down (app.ledger_autoskip_<table>), its own leg must equal the delta and name the same user, club, union, pool, table, tournament or ticket float. Nothing is corrected here; the transaction is refused whole.';
    END IF;

    INSERT INTO public.ca_ledger_invariant_findings
      (txid, account_key, balance_delta, ledger_net, mode, actor_service, db_role, statement)
    VALUES
      (pg_current_xact_id(), r.key, v_b, v_l, v_mode,
       current_setting('application_name', true), current_user,
       COALESCE(r.value ->> 'q', left(current_query(), 300)))
    ON CONFLICT (txid, account_key) DO UPDATE
      SET balance_delta = EXCLUDED.balance_delta,
          ledger_net    = EXCLUDED.ledger_net,
          found_at      = EXCLUDED.found_at,
          statement     = EXCLUDED.statement;
    RAISE WARNING 'OBSERVED: balance_moved_without_its_ledger_row account=% balance_delta=% ledger_net=% (store mode observe; this transaction would be refused)',
      r.key, v_b, v_l;
  END LOOP;

  /* NO BALANCE MOVES AGAINST SETTLEMENT SUSPENSE (2026-10-02). Every store
     above can balance and the chips still come from nowhere: a journal
     trigger whose writer declared no counterparty posts the store's leg
     against settlement_suspense, which holds no balance and is outside the
     supply count. A transaction that wrote a suspense leg may not move any
     covered balance. A journal-only suspense correction moves none. */
  v_s := round(COALESCE((t -> 'settlement_suspense' ->> 's')::numeric, 0), 2);
  IF v_s <> 0 THEN
    SELECT string_agg(e.key || ' ' || round((e.value ->> 'b')::numeric, 2)::text, ', ' ORDER BY e.key),
           sum(abs(round((e.value ->> 'b')::numeric, 2)))
      INTO v_moved, v_moved_abs
      FROM jsonb_each(t) e
     WHERE e.key <> 'settlement_suspense'
       AND round(COALESCE((e.value ->> 'b')::numeric, 0), 2) <> 0;

    IF v_moved IS NOT NULL THEN
      v_mode := COALESCE(
        (SELECT sm.mode FROM public.ca_ledger_invariant_store_mode sm WHERE sm.store = 'settlement_suspense'),
        (SELECT m.mode FROM public.ca_ledger_invariant_mode m LIMIT 1),
        'refuse');

      IF v_mode = 'refuse' THEN
        /* 20261002135708: recorded first, outside the rollback. */
        BEGIN
          PERFORM public.fn_ca_ledger_refusal_record(jsonb_build_object(
            'kind',          'balance_moved_against_settlement_suspense',
            'account_key',   'settlement_suspense',
            'store',         'settlement_suspense',
            'balance_delta', v_moved_abs,
            'ledger_net',    v_s,
            'mode',          v_mode,
            'moved',         left(v_moved, 2000),
            'first_writer',  left(COALESCE(t -> 'settlement_suspense' ->> 'q', '(unknown statement)'), 1000),
            'message',       format('REFUSED: balance_moved_against_settlement_suspense suspense_legs=%s moved=%s', v_s, left(v_moved, 1500))));
        EXCEPTION WHEN OTHERS THEN
          NULL;
        END;
        RAISE EXCEPTION 'REFUSED: balance_moved_against_settlement_suspense suspense_legs=% moved=%',
          v_s, v_moved
          USING ERRCODE = '23514',
                DETAIL  = 'this transaction wrote a chip_ledger leg against settlement_suspense, which holds no balance and is outside the supply count, and moved a covered chip balance; the suspense leg was first written by: '
                          || COALESCE(t -> 'settlement_suspense' ->> 'q', '(unknown statement)'),
                HINT    = 'A door names where its chips come from and go to: app.ledger_counterparty (+ app.ledger_counterparty_entity) before the balance write, or app.ledger_autoskip_<table> and its own leg. An undeclared journal trigger falls to settlement_suspense, and that is what is refused here. A journal-only correction that moves no balance is not affected.';
      END IF;

      INSERT INTO public.ca_ledger_invariant_findings
        (txid, account_key, balance_delta, ledger_net, mode, actor_service, db_role, statement)
      VALUES
        (pg_current_xact_id(), 'settlement_suspense', v_moved_abs, v_s, v_mode,
         current_setting('application_name', true), current_user,
         left(COALESCE(t -> 'settlement_suspense' ->> 'q', left(current_query(), 300)) || ' | moved: ' || v_moved, 1000))
      ON CONFLICT (txid, account_key) DO UPDATE
        SET balance_delta = EXCLUDED.balance_delta,
            ledger_net    = EXCLUDED.ledger_net,
            found_at      = EXCLUDED.found_at,
            statement     = EXCLUDED.statement;
      RAISE WARNING 'OBSERVED: balance_moved_against_settlement_suspense suspense_legs=% moved=% (mode observe; this transaction would be refused)',
        v_s, v_moved;
    END IF;
  END IF;

  PERFORM set_config('ca.ledger_tally_checked', v_ver, true);
  RETURN NULL;
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_balance_has_its_ledger_row() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6. The watch: a counted refusal with no record becomes an explicit row and
--    a critical incident, inside the existing 30-minute cron health watch
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn_ca_ledger_invariant_refusal_watch()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  st record;
  c record;
  v_n integer := 0;
  v_id bigint;
  g bigint;
BEGIN
  SELECT * INTO st FROM public.ca_ledger_invariant_refusal_watch_state WHERE id FOR UPDATE;
  SELECT * INTO c FROM public.fn_ca_ledger_invariant_refusal_census();

  /* A number counted before the PREVIOUS watch has had a whole interval for
     its record to arrive. One that still has none is a refusal whose details
     were lost: it becomes an explicit 'unrecorded' row, never a silent zero. */
  FOR g IN SELECT s FROM generate_series(st.checked_through + 1, st.counted_at_last_watch) s
            WHERE NOT EXISTS (SELECT 1 FROM public.ca_ledger_invariant_refusals x WHERE x.counter_no = s)
  LOOP
    v_id := NULL;
    INSERT INTO public.ca_ledger_invariant_refusals (counter_no, kind, message)
    VALUES (g, 'unrecorded',
            'the ledger invariant refused a transaction (counter ' || g || ') and its record never arrived; search the Postgres log for LEDGER_REFUSAL_UNRECORDED counter=' || g)
    ON CONFLICT (counter_no) DO NOTHING
    RETURNING id INTO v_id;
    IF v_id IS NOT NULL THEN
      PERFORM public.fn_ca_ledger_refusal_raise(v_id);
      v_n := v_n + 1;
    END IF;
  END LOOP;

  /* A record whose incident did not arrive (the separate remote statement
     failed) is raised here. */
  FOR v_id IN SELECT x.id FROM public.ca_ledger_invariant_refusals x
               WHERE x.incident_id IS NULL AND x.recorded_at < now() - interval '2 minutes'
               ORDER BY x.id LIMIT 200
  LOOP
    PERFORM public.fn_ca_ledger_refusal_raise(v_id);
    v_n := v_n + 1;
  END LOOP;

  UPDATE public.ca_ledger_invariant_refusal_watch_state
     SET checked_through = greatest(st.checked_through, st.counted_at_last_watch),
         counted_at_last_watch = c.counted,
         watched_at = now()
   WHERE id;
  RETURN v_n;
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_ledger_invariant_refusal_watch() FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_ca_cron_failure_watch()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE r record; n integer := 0; v_is_guard boolean;
BEGIN
  FOR r IN
    SELECT j.jobname,
           count(*) FILTER (WHERE d.status = 'failed')    AS fails,
           count(*) FILTER (WHERE d.status = 'succeeded') AS successes,
           max(d.start_time) FILTER (WHERE d.status = 'succeeded') AS last_success,
           max(left(d.return_message, 200)) FILTER (WHERE d.status = 'failed') AS sample_error
    FROM cron.job j
    JOIN cron.job_run_details d ON d.jobid = j.jobid
    WHERE j.active AND d.start_time > now() - interval '2 hours'
    GROUP BY j.jobname
    HAVING count(*) FILTER (WHERE d.status = 'failed') >= 5
       AND count(*) FILTER (WHERE d.status = 'succeeded') = 0
    LIMIT 20
  LOOP
    SELECT EXISTS (SELECT 1 FROM public.ca_guard_inventory g
                    WHERE g.kind = 'cron' AND g.object_a = r.jobname AND g.active)
      INTO v_is_guard;
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_cron_failure_watch', 'unknown',
      CASE WHEN v_is_guard THEN 'critical' ELSE 'warning' END,
      'cron-failing:' || r.jobname || ':' || CURRENT_DATE::text,
      0, NULL, NULL, 'reporting', 'cron.job_run_details',
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      'scheduled job ' || r.jobname || ' has failed ' || r.fails
        || ' times in 2h with zero successes. Last error: ' || COALESCE(r.sample_error, '?'),
      NULL, jsonb_build_object('jobname', r.jobname, 'fails_2h', r.fails,
                               'last_success', r.last_success));
    n := n + 1;
  END LOOP;

  /* 20261002135708: a ledger refusal the counter saw and no record reached
     becomes an explicit row and a critical incident here. Isolated, so it can
     never stop the cron watch above from reporting, and a failure of its own
     is itself a critical incident rather than a silent zero. */
  BEGIN
    n := n + public.fn_ca_ledger_invariant_refusal_watch();
  EXCEPTION WHEN OTHERS THEN
    PERFORM public.fn_ca_raise_drift_incident(
      'ledger_invariant.refused', 'unknown', 'critical',
      'ledger-invariant-refusal-watch-failed',
      NULL, NULL, NULL, 'ledger', 'chip_store',
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      'fn_ca_ledger_invariant_refusal_watch failed, so a ledger refusal whose record was lost cannot be told from no refusal: ' || SQLERRM,
      NULL, NULL);
  END;
  RETURN n;
END $function$;
-- As live (proacl postgres, service_role): pg_cron runs it as the owner.
REVOKE ALL ON FUNCTION public.fn_ca_cron_failure_watch() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_cron_failure_watch() TO service_role;

DO $declare$
BEGIN
  IF to_regprocedure('public.fn_ca_guard_watchlist()') IS NOT NULL THEN
    IF 'fn_ca_balance_has_its_ledger_row' = ANY (public.fn_ca_guard_watchlist()) THEN
      PERFORM public.fn_ca_declare_guard_redefinition('fn_ca_balance_has_its_ledger_row', 'migration 20261002135708_a_ledger_refusal_is_recorded_outside_its_rollback');
    END IF;
    IF 'fn_ca_cron_failure_watch' = ANY (public.fn_ca_guard_watchlist()) THEN
      PERFORM public.fn_ca_declare_guard_redefinition('fn_ca_cron_failure_watch', 'migration 20261002135708_a_ledger_refusal_is_recorded_outside_its_rollback');
    END IF;
  END IF;
END $declare$;

-- ---------------------------------------------------------------------------
-- 7. Read back
-- ---------------------------------------------------------------------------

DO $post$
BEGIN
  IF position('fn_ca_ledger_refusal_record' IN (SELECT prosrc FROM pg_proc WHERE oid = 'public.fn_ca_balance_has_its_ledger_row()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'the judgement does not record its refusals';
  END IF;
  IF position('fn_ca_ledger_invariant_refusal_watch' IN (SELECT prosrc FROM pg_proc WHERE oid = 'public.fn_ca_cron_failure_watch()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'the cron health watch does not read the refusal census';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'ca_ledger_refusal_recorder_conninfo') THEN
    RAISE EXCEPTION 'the recorder has no connection string in vault';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member WHERE r.rolname = 'ca_ledger_refusal_recorder') THEN
    RAISE EXCEPTION 'the recorder role is a member of another role; it may only file a refusal';
  END IF;
  IF has_table_privilege('ca_ledger_refusal_recorder', 'public.ca_ledger_invariant_refusals', 'INSERT,UPDATE,DELETE,SELECT')
     OR has_function_privilege('anon', 'public.fn_ca_ledger_refusal_file(jsonb)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_ca_ledger_refusal_record(jsonb)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.fn_ca_ledger_refusal_raise(bigint)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.fn_ca_ledger_invariant_refusal_watch()', 'EXECUTE') THEN
    RAISE EXCEPTION 'a refusal door is reachable by a role that should not reach it';
  END IF;
  IF EXISTS (SELECT 1 FROM public.ca_ledger_invariant_store_mode WHERE mode <> 'refuse') THEN
    RAISE EXCEPTION 'a chip store stopped refusing';
  END IF;
  RAISE NOTICE 'a ledger refusal is recorded outside its rollback: installed';
END $post$;

COMMIT;
