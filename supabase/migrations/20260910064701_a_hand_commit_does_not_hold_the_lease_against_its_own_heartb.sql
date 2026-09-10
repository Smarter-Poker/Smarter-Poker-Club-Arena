-- a_hand_commit_does_not_hold_the_lease_against_its_own_heartbeat
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY (2026-09-10, the second half of
-- a_busy_manager_keeps_its_lease):
--
-- After the PostgREST hook moved to FOR KEY SHARE, two more readers were
-- still holding FOR SHARE on the event's engine_tournament_leases row for the
-- life of their transaction, and both are on the hot path:
--
--   fn_ca_commit_hand_settlement_exact_before_obligations - every tournament
--     hand commit (the busiest write on the platform);
--   fn_close_empty_tournament_table - every table break.
--
-- FOR SHARE conflicts with the heartbeat's FOR NO KEY UPDATE ... SKIP LOCKED,
-- so a manager committing hands on many tables kept reading 'busy' and expired
-- itself after four passes (2dbc9bb6 and 7f521f47 at 06:43, seven minutes
-- after the hook fix). Both readers only need what the hook needs: the row
-- must not be TAKEN OVER while they run. A takeover is FOR UPDATE (since
-- a_busy_manager_keeps_its_lease), and FOR KEY SHARE conflicts with exactly
-- that. Nothing else changes: the same rows are read, the same fencing holds.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $body$
DECLARE
  v_def text; v_n integer;
  v_a1 text := E'     WHERE l.tournament_id = v_tournament_id\n     FOR SHARE;';
  v_n1 text := E'     WHERE l.tournament_id = v_tournament_id\n'
            || E'     -- A HAND COMMIT DOES NOT HOLD THE LEASE AGAINST ITS OWN HEARTBEAT\n'
            || E'     -- (2026-09-10): FOR KEY SHARE excludes a takeover (FOR UPDATE) and\n'
            || E'     -- nothing else, so the heartbeat can still renew this row.\n'
            || E'     FOR KEY SHARE;';
  v_a2 text := E'     AND l.heartbeat_at >= clock_timestamp() - interval ''30 seconds''\n   FOR SHARE;';
  v_n2 text := E'     AND l.heartbeat_at >= clock_timestamp() - interval ''30 seconds''\n'
            || E'   -- A HAND COMMIT DOES NOT HOLD THE LEASE AGAINST ITS OWN HEARTBEAT (2026-09-10)\n'
            || E'   FOR KEY SHARE;';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p WHERE p.proname = 'fn_ca_commit_hand_settlement_exact_before_obligations';
  IF v_def IS NULL THEN RAISE EXCEPTION 'fn_ca_commit_hand_settlement_exact_before_obligations is missing'; END IF;
  IF position('A HAND COMMIT DOES NOT HOLD THE LEASE' IN v_def) = 0 THEN
    v_n := (length(v_def) - length(replace(v_def, v_a1, ''))) / length(v_a1);
    IF v_n <> 1 THEN RAISE EXCEPTION 'hand-commit anchor appears % times, expected 1', v_n; END IF;
    EXECUTE replace(v_def, v_a1, v_n1);
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p WHERE p.proname = 'fn_close_empty_tournament_table';
  IF v_def IS NULL THEN RAISE EXCEPTION 'fn_close_empty_tournament_table is missing'; END IF;
  IF position('A HAND COMMIT DOES NOT HOLD THE LEASE' IN v_def) = 0 THEN
    v_n := (length(v_def) - length(replace(v_def, v_a2, ''))) / length(v_a2);
    IF v_n <> 1 THEN RAISE EXCEPTION 'close-table anchor appears % times, expected 1', v_n; END IF;
    EXECUTE replace(v_def, v_a2, v_n2);
  END IF;

  -- post-conditions: no protocol-2 reader of engine_tournament_leases takes FOR SHARE any more
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname IN ('public', 'smarter_private')
     -- the lease SELECT and its lock clause live in one statement
     AND p.prosrc ~ 'engine_tournament_leases l\s[^;]*FOR SHARE;'
     AND p.proname <> 'fn_stage_a_bridge_legacy_capacity_receipt';  -- protocol 1, retired path
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'post-condition: % function(s) still take FOR SHARE on engine_tournament_leases', v_n;
  END IF;
  IF position('FOR UPDATE;' IN (SELECT prosrc FROM pg_proc WHERE proname = 'claim_tournament_lease_v2')) = 0 THEN
    RAISE EXCEPTION 'post-condition: the takeover no longer locks FOR UPDATE; FOR KEY SHARE would fence nothing';
  END IF;
END
$body$;

COMMIT;
