-- scripts/dev/fixtures/lightning-remediation-two-fixture.sql
--
-- WHAT scripts/dev/test-lightning-remediation-two.sh NEEDS THAT NO EARLIER
-- LIGHTNING FIXTURE CREATES, in the shape production has it (read from the
-- live catalogue on 2026-09-26), and the writers the harness drives it with.
--
--   engine_table_leases and fn_engine_lease_stale_seconds: the lease that
--     claim_table_lease_v2 grants and heartbeat_table_leases_v4 keeps. A lease
--     is live while heartbeat_at is inside the stale window; the commit's halt
--     observation test reads exactly that.
--   hand_state_snapshots, with idx_hand_snapshots_one_active_per_table: the
--     row the engine writes after every action of a hand with is_complete =
--     false and completes after settlement. The commit's in-flight test.
--   ca_declared_money_triggers: the register a trigger on table_seats must be
--     declared in, by the migration that creates it.
--   dblink in its own schema, for the second backend the lock-order proofs
--     need.
--
-- NOTHING HERE READS is_horse OR horse_id TO DECIDE ANYTHING. Law 10.5.

CREATE TABLE IF NOT EXISTS public.engine_table_leases (
  table_id         uuid PRIMARY KEY,
  instance_id      text NOT NULL,
  engine_version   text,
  acquired_at      timestamptz NOT NULL DEFAULT now(),
  heartbeat_at     timestamptz NOT NULL DEFAULT now(),
  lease_generation uuid NOT NULL DEFAULT gen_random_uuid(),
  protocol_version integer NOT NULL DEFAULT 1
);

CREATE OR REPLACE FUNCTION public.fn_engine_lease_stale_seconds()
RETURNS integer LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path TO 'public', 'pg_temp'
AS $fx$ SELECT 30; $fx$;

CREATE TABLE IF NOT EXISTS public.hand_state_snapshots (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id          uuid NOT NULL,
  hand_number       integer NOT NULL,
  state_json        jsonb NOT NULL,
  config_json       jsonb NOT NULL,
  dealer_seat       integer NOT NULL,
  players_json      jsonb NOT NULL,
  stage             text NOT NULL DEFAULT 'preflop',
  is_complete       boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  pending_deadlines jsonb NOT NULL DEFAULT '[]'::jsonb,
  disconnect_states jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_hand_snapshots_one_active_per_table
  ON public.hand_state_snapshots (table_id) WHERE is_complete = false;

CREATE TABLE IF NOT EXISTS public.ca_declared_money_triggers (
  table_name   text NOT NULL,
  trigger_name text NOT NULL,
  declared_at  timestamptz NOT NULL DEFAULT now(),
  note         text,
  PRIMARY KEY (table_name, trigger_name)
);

CREATE SCHEMA IF NOT EXISTS harness;
CREATE EXTENSION IF NOT EXISTS dblink SCHEMA harness;

-- A LIVE ENGINE ON A TABLE, or a dead one: a lease whose heartbeat is now, or
-- one a minute old, which is twice the stale window.
CREATE FUNCTION public.fxr_lease(p_table uuid, p_live boolean DEFAULT true)
RETURNS void LANGUAGE plpgsql AS $fx$
BEGIN
  INSERT INTO public.engine_table_leases (table_id, instance_id, heartbeat_at, protocol_version)
  VALUES (p_table, 'fxr-engine', CASE WHEN p_live THEN clock_timestamp() ELSE clock_timestamp() - interval '1 minute' END, 2)
  ON CONFLICT (table_id) DO UPDATE SET heartbeat_at = EXCLUDED.heartbeat_at;
END $fx$;

-- A HAND IN FLIGHT, in the shape save_hand_state_snapshot leaves it.
CREATE FUNCTION public.fxr_snapshot(p_table uuid, p_complete boolean DEFAULT false,
                                    p_age interval DEFAULT interval '0 seconds')
RETURNS uuid LANGUAGE plpgsql AS $fx$
DECLARE v uuid;
BEGIN
  INSERT INTO public.hand_state_snapshots
    (table_id, hand_number, state_json, config_json, dealer_seat, players_json, stage, is_complete, created_at, updated_at)
  VALUES (p_table, 1 + (SELECT count(*) FROM public.hand_state_snapshots WHERE table_id = p_table)::integer,
          '{}'::jsonb, '{}'::jsonb, 1, '[]'::jsonb, 'flop', p_complete,
          clock_timestamp() - p_age, clock_timestamp() - p_age)
  RETURNING id INTO v;
  RETURN v;
END $fx$;

-- THE MAIN TABLE OF A CLUSTER.
CREATE FUNCTION public.fxr_main(p_game uuid) RETURNS uuid LANGUAGE sql STABLE AS $fx$
  SELECT tb.id FROM public.tables tb
   WHERE tb.cluster_id = p_game AND coalesce(tb.is_deleted, false) = false
     AND coalesce(tb.lifecycle, '') <> 'closed'
   ORDER BY tb.created_at, tb.id LIMIT 1;
$fx$;

-- ONE MORE PLAYER, seated on a named table of a Cluster, with or without the
-- cluster-scoped cash session the pool needs. The session is opened AFTER the
-- seat, in the same transaction, which is the order the live buy-in uses.
CREATE FUNCTION public.fxr_join(p_game uuid, p_table uuid, p_seat integer, p_stack numeric,
                                p_horse boolean DEFAULT false, p_session boolean DEFAULT true,
                                p_user uuid DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql AS $fx$
DECLARE v_u uuid := coalesce(p_user, gen_random_uuid()); v_seat uuid;
BEGIN
  INSERT INTO public.table_seats
    (table_id, user_id, seat_number, stack, is_sitting_out, leave_pending, joined_at, horse_id)
  VALUES (p_table, v_u, p_seat, p_stack, false, false, clock_timestamp(),
          CASE WHEN p_horse THEN gen_random_uuid() ELSE NULL END)
  RETURNING id INTO v_seat;
  IF p_session THEN
    INSERT INTO public.cash_player_session
      (player_id, club_id, scope_type, scope_id, table_id, variant, sb, bb, baseline, cluster_id, opened_at)
    VALUES (v_u, 'cb000000-0000-0000-0000-000000000001', 'cluster', p_game, p_table,
            'nlh', 1.00, 2.00, p_stack, p_game, clock_timestamp());
  END IF;
  RETURN v_seat;
END $fx$;

-- THE SEAT OF A PLAYER'S OPEN POOL SESSION.
-- PL/pgSQL, not SQL, because it is created before the column it reads.
CREATE FUNCTION public.fxr_anchor(p_game uuid, p_player uuid) RETURNS uuid LANGUAGE plpgsql STABLE AS $fx$
BEGIN
  RETURN (SELECT ps.anchor_seat_id FROM public.lightning_pool_session ps
           WHERE ps.cluster_id = p_game AND ps.player_id = p_player AND ps.exited_at IS NULL);
END $fx$;

-- A FORMATION WITH A MATCHER VERSION, the only kind 20260926023047 accepts.
-- PL/pgSQL for the same reason: p_request_id does not exist until the
-- migration under test has run.
CREATE FUNCTION public.fxr_form(p_game uuid, p_players uuid[], p_request uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql AS $fx$
BEGIN
  RETURN public.fn_lightning_form_hand(p_game, p_players, p_matcher_version => 'fxr-matcher-1', p_request_id => p_request);
END $fx$;

-- A SQLSTATE OF ANY CLASS, WITH A NAMED CONSTRAINT, at a named depth. The
-- barrier now decides retry-or-freeze by class AND constraint, so the injector
-- has to be able to name both.
CREATE FUNCTION public.fxr_raise() RETURNS trigger LANGUAGE plpgsql AS $fx$
DECLARE
  v text := coalesce(current_setting('fxr.raise_' || TG_ARGV[0], true), '');
  c text := coalesce(current_setting('fxr.raise_constraint_' || TG_ARGV[0], true), '');
BEGIN
  IF v <> '' THEN
    IF c <> '' THEN
      RAISE EXCEPTION USING ERRCODE = v, CONSTRAINT = c, MESSAGE = 'FXR_INJECTED ' || v || ' on ' || c || ' at ' || TG_ARGV[0];
    END IF;
    RAISE EXCEPTION USING ERRCODE = v, MESSAGE = 'FXR_INJECTED ' || v || ' at ' || TG_ARGV[0];
  END IF;
  RETURN NEW;
END $fx$;

-- A CHIP MOVED ON A PARTICIPANT'S ANCHOR SEAT DURING A FORMATION, switched by
-- a GUC and carried out under the settlement exemption for the hand being
-- formed, so the anchor guard lets it through and only the barrier's own money
-- comparison is left to catch it.
CREATE FUNCTION public.fxr_move_anchor_chip() RETURNS trigger LANGUAGE plpgsql AS $fx$
BEGIN
  IF coalesce(current_setting('fxr.move_anchor_chip', true), '') = 'on' THEN
    PERFORM set_config('fxr.move_anchor_chip', '', true);
    PERFORM set_config('ca.lightning_settlement_hand', NEW.hand_id::text, true);
    UPDATE public.table_seats ts SET stack = ts.stack + 1
     WHERE ts.id = (SELECT ps.anchor_seat_id FROM public.lightning_pool_slot sl
                      JOIN public.lightning_pool_session ps ON ps.id = sl.pool_session_id
                     WHERE sl.id = NEW.pool_slot_id);
    PERFORM set_config('ca.lightning_settlement_hand', '', true);
  END IF;
  RETURN NEW;
END $fx$;

-- A CONVERSION ABORT THAT FAILS FOR ONE NAMED CLUSTER.
CREATE FUNCTION public.fxr_break_abort() RETURNS trigger LANGUAGE plpgsql AS $fx$
BEGIN
  IF NEW.cluster_id::text = coalesce(current_setting('fxr.break_abort_cluster', true), '')
     AND NEW.status = 'aborted' THEN
    RAISE EXCEPTION 'FXR_INJECTED_ABORT_FAULT for Cluster %', NEW.cluster_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $fx$;

-- A SECOND BACKEND THAT HOLDS A TRANSACTION OPEN across calls, for proving
-- what waits and what does not.
CREATE FUNCTION public.fxr_other(p_sql text) RETURNS text LANGUAGE plpgsql AS $fx$
DECLARE v_r text;
BEGIN
  IF NOT coalesce('fxr_other' = ANY (harness.dblink_get_connections()), false) THEN
    PERFORM harness.dblink_connect('fxr_other',
      'host=' || current_setting('unix_socket_directories') || ' port=' || current_setting('port')
      || ' dbname=' || current_database() || ' user=' || current_user);
    PERFORM harness.dblink_exec('fxr_other', 'SET lock_timeout = ''300ms''');
  END IF;
  v_r := harness.dblink_exec('fxr_other', p_sql, false);
  IF v_r = 'ERROR' THEN
    RETURN 'ERROR: ' || harness.dblink_error_message('fxr_other');
  END IF;
  RETURN v_r;
END $fx$;

-- A CATCHER THAT NAMES THE CLASS. The anchor guard and the barrier are judged
-- by SQLSTATE as well as by message, so the harness reads both.
CREATE FUNCTION public.fxr_try(p_sql text) RETURNS text LANGUAGE plpgsql AS $fx$
DECLARE v_state text; v_msg text;
BEGIN
  EXECUTE p_sql;
  RETURN 'no error';
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
  RETURN v_state || ': ' || v_msg;
END $fx$;

-- A STATEMENT THAT SUCCEEDS AND IS THEN UNDONE. Returns 'ok <rows>' when the
-- statement ran and was rolled back by the probe itself, or the error it
-- raised - so the good twin of a refusal can be proved without leaving
-- anything behind on the estate.
CREATE FUNCTION public.fxr_probe(p_sql text) RETURNS text LANGUAGE plpgsql AS $fx$
DECLARE v_state text; v_msg text; v_n bigint;
BEGIN
  EXECUTE p_sql;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE EXCEPTION 'FXR_PROBE_ROLLBACK %', v_n USING ERRCODE = 'P0001';
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
  IF v_msg LIKE 'FXR_PROBE_ROLLBACK %' THEN
    RETURN 'ok ' || substr(v_msg, 20);
  END IF;
  RETURN v_state || ': ' || v_msg;
END $fx$;

-- THE OTHER BACKEND, ASKED ONE QUESTION, answered as text.
CREATE FUNCTION public.fxr_other_ask(p_sql text) RETURNS text LANGUAGE plpgsql AS $fx$
DECLARE v_r text;
BEGIN
  PERFORM public.fxr_other('SET application_name = ''fxr_other''');
  SELECT t.a INTO v_r FROM harness.dblink('fxr_other', p_sql) AS t(a text);
  RETURN v_r;
END $fx$;

-- FROM INSIDE A FORMATION: run the GUC's statement ONCE in the other backend,
-- hung on lightning_hand_player, and leave what it said in a second GUC. The
-- barrier holds the anchor seats FOR SHARE at that moment, so this is how the
-- lock is observed rather than assumed.
CREATE FUNCTION public.fxr_elsewhere_during() RETURNS trigger LANGUAGE plpgsql AS $fx$
DECLARE v_sql text := coalesce(current_setting('fxr.during_sql', true), '');
BEGIN
  IF v_sql <> '' THEN
    PERFORM set_config('fxr.during_sql', '', false);
    PERFORM set_config('fxr.during_said', public.fxr_other(v_sql), false);
  END IF;
  RETURN NEW;
END $fx$;

-- PRODUCTION'S GRANT, NOT THE MIGRATION'S. 20260921151618 grants service_role
-- SELECT, INSERT and UPDATE on cash_cluster_conversion, but Supabase's default
-- privileges had already given it everything: production shows DELETE and
-- TRUNCATE (read 2026-09-26). The revoke under test is proved against that.
GRANT DELETE, TRUNCATE ON public.cash_cluster_conversion TO service_role;

-- A PROOF EVALUATED AS CODE. Section 17 hands every @live-proof expression of
-- this file and of the four Lightning files before it to this, which runs it
-- as a boolean and answers NULL - never false - when it does not evaluate at
-- all, so "false" and "no longer parses or names something that is gone" stay
-- two different findings.
CREATE FUNCTION public.fxr_eval(p_expr text) RETURNS boolean LANGUAGE plpgsql AS $fx$
DECLARE v boolean;
BEGIN
  EXECUTE 'SELECT (' || p_expr || ')::boolean' INTO v;
  RETURN coalesce(v, false);
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END $fx$;
