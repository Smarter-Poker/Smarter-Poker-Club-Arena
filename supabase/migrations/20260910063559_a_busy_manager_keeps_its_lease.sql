-- a_busy_manager_keeps_its_lease
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY (2026-09-10, measured 05:59-06:29 UTC on the
-- single running engine instance 1-781c16fb):
--
--   649 "Lost the tournament lease ... to another engine instance" in 30
--   minutes across 235 events, with ONE engine instance alive and every lease
--   row heartbeated within 4-5 seconds. There was no other instance. The
--   busiest event (f922df63, 21 tables) was fenced, torn down and re-adopted
--   at 06:10, 06:19 and 06:24, and no table of it was broken or balanced in
--   between; 29 RUNNING events sat at one player per table.
--
-- Two locks that cannot both be right:
--
--   1. smarter_private.fn_smarter_data_api_pre_request takes
--      `SELECT ... FOR SHARE` on the event's engine_tournament_leases row for
--      every non-GET request a tournament manager makes (a hand commit, a
--      seat move, an elimination), for the life of that transaction.
--   2. heartbeat_tournament_leases_v4 renews with
--      `FOR NO KEY UPDATE OF l SKIP LOCKED`. FOR SHARE conflicts with
--      FOR NO KEY UPDATE, so a row a manager request is holding is SKIPPED and
--      reported 'busy'. The engine treats 'busy' as "extends nothing"
--      (server/src/services/tournamentLease.ts), and after four busy passes -
--      the 20-second proof window at a 5-second cadence - the manager's own
--      expiry timer fires, fences it, and stops it. A 21-table event writes
--      almost continuously, so it was busy almost every pass.
--
-- THE FIX, at the lock: the hook takes FOR KEY SHARE instead of FOR SHARE.
-- FOR KEY SHARE conflicts only with FOR UPDATE, so the heartbeat's
-- FOR NO KEY UPDATE renewal proceeds while a manager request is in flight.
-- The fencing property the hook exists for - a takeover waits until every
-- in-flight manager transaction commits - is kept by making the takeover an
-- explicit FOR UPDATE: claim_tournament_lease_v2 now locks the row FOR UPDATE
-- before its upsert. (The upsert alone only ever took FOR NO KEY UPDATE, so a
-- takeover never actually waited on FOR KEY SHARE holders; it waited on
-- FOR SHARE holders by accident of the same conflict that broke the
-- heartbeat. Now it waits by design.)
--
-- Lock matrix, PostgreSQL 17 (Explicit Locking, row-level):
--   FOR KEY SHARE   conflicts with FOR UPDATE only
--   FOR SHARE       conflicts with FOR NO KEY UPDATE, FOR UPDATE
--   heartbeat UPDATE of heartbeat_at (non-key) takes FOR NO KEY UPDATE
--
-- Asserted text substitution on both live definitions; each anchor must
-- appear exactly once; post-conditions re-read the catalog.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $body$
DECLARE
  v_def text; v_n integer;
  v_hook_anchor text := E'     FOR SHARE;\n  END IF;';
  v_hook_new    text := E'     /* A BUSY MANAGER KEEPS ITS LEASE (2026-09-10): FOR KEY SHARE, not\n'
                     || E'        FOR SHARE. The heartbeat renews heartbeat_at with FOR NO KEY\n'
                     || E'        UPDATE ... SKIP LOCKED; FOR SHARE made every in-flight manager\n'
                     || E'        request read as busy and expired the manager after 20 seconds.\n'
                     || E'        A takeover still waits: claim_tournament_lease_v2 takes FOR\n'
                     || E'        UPDATE, which FOR KEY SHARE does conflict with. */\n'
                     || E'     FOR KEY SHARE;\n  END IF;';
  v_claim_anchor text := E'  INSERT INTO public.engine_tournament_leases AS l (';
  v_claim_new    text := E'  /* A BUSY MANAGER KEEPS ITS LEASE (2026-09-10): the takeover waits for\n'
                      || E'     every in-flight manager transaction (they hold FOR KEY SHARE in the\n'
                      || E'     PostgREST pre-request hook). The upsert below only takes FOR NO KEY\n'
                      || E'     UPDATE on its own, which FOR KEY SHARE does not block. */\n'
                      || E'  PERFORM 1 FROM public.engine_tournament_leases l\n'
                      || E'   WHERE l.tournament_id = p_tournament_id\n'
                      || E'   FOR UPDATE;\n\n'
                      || E'  INSERT INTO public.engine_tournament_leases AS l (';
BEGIN
  -- 1. the hook
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'smarter_private' AND p.proname = 'fn_smarter_data_api_pre_request';
  IF v_def IS NULL THEN RAISE EXCEPTION 'smarter_private.fn_smarter_data_api_pre_request is missing'; END IF;
  IF position('FOR KEY SHARE' IN v_def) > 0 THEN
    RAISE NOTICE 'hook already takes FOR KEY SHARE';
  ELSE
    v_n := (length(v_def) - length(replace(v_def, v_hook_anchor, ''))) / length(v_hook_anchor);
    IF v_n <> 1 THEN RAISE EXCEPTION 'hook anchor appears % times, expected 1', v_n; END IF;
    EXECUTE replace(v_def, v_hook_anchor, v_hook_new);
  END IF;

  -- 2. the takeover
  SELECT pg_get_functiondef('public.claim_tournament_lease_v2(uuid,text,text,uuid,integer)'::regprocedure) INTO v_def;
  IF position('FOR UPDATE;' IN v_def) > 0 THEN
    RAISE NOTICE 'claim_tournament_lease_v2 already locks FOR UPDATE';
  ELSE
    v_n := (length(v_def) - length(replace(v_def, v_claim_anchor, ''))) / length(v_claim_anchor);
    IF v_n <> 1 THEN RAISE EXCEPTION 'claim anchor appears % times, expected 1', v_n; END IF;
    EXECUTE replace(v_def, v_claim_anchor, v_claim_new);
  END IF;

  -- post-conditions
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'smarter_private' AND p.proname = 'fn_smarter_data_api_pre_request';
  IF position(E'     FOR SHARE;' IN v_def) > 0 THEN RAISE EXCEPTION 'post-condition: the hook still takes FOR SHARE'; END IF;
  IF position('FOR KEY SHARE;' IN v_def) = 0 THEN RAISE EXCEPTION 'post-condition: the hook does not take FOR KEY SHARE'; END IF;
  SELECT pg_get_functiondef('public.claim_tournament_lease_v2(uuid,text,text,uuid,integer)'::regprocedure) INTO v_def;
  IF position(E'   FOR UPDATE;\n\n  INSERT INTO public.engine_tournament_leases' IN v_def) = 0 THEN
    RAISE EXCEPTION 'post-condition: the takeover does not lock FOR UPDATE before its upsert';
  END IF;
  -- the heartbeat is untouched and still renews with SKIP LOCKED, which is what this fix makes harmless
  IF position('FOR NO KEY UPDATE OF l SKIP LOCKED' IN (SELECT prosrc FROM pg_proc WHERE proname = 'heartbeat_tournament_leases_v4')) = 0 THEN
    RAISE EXCEPTION 'post-condition: heartbeat_tournament_leases_v4 changed shape; re-read this migration before applying';
  END IF;
END
$body$;

COMMIT;
