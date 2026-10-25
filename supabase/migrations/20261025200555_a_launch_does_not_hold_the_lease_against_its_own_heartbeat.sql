-- 20261025200555_a_launch_does_not_hold_the_lease_against_its_own_heartbeat.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- A LAUNCH DOES NOT HOLD THE LEASE AGAINST ITS OWN HEARTBEAT (2026-10-25).
-- Full account: docs/changelog/2026-10-25-a-launch-does-not-hold-the-lease-against-its-own-heartbeat.md
--
-- WHAT HAPPENED, READ FROM ROWS
--
-- 13:27:10 UTC: "Engine Restart Storm" paged the owner - 41 watchdog_kill_rebuild
-- rows in 140 ms, every one `tournament_lease_lost`, every one a table of
-- "Morning Free Buy (NLH)" (56b17547), whose launch receipt had just completed
-- at 13:26:55 after a 13:24:14 claim (41 tables, 369 entrants). Prometheus
-- shows the tournament heartbeat answering `busy` for the 30 s before the
-- kill (poker_lease_heartbeat_outcomes_total{scope="tournament",state="busy"}
-- +6 in the window ending 13:27:15). The same shape twice more the same day,
-- each on the ONE tournament that was launching while every other manager on
-- the fleet renewed normally:
--   18:25:35  7d1abc56  launch receipt 18:25:08 -> 18:25:24, busy +6 at 18:25:45,
--             "RUNNING - 1 tables" three seconds before its proof expired;
--   19:27:30  1cea37b0  claimed 19:27:06, launch queued behind an ExclusiveLock
--             waiter on advisory lock 530090 (the cutover of the owner-ordered
--             Lightning reset release), busy +2/+4, expired 23 s after Starting.
-- Engine log, each time: "[Tournament.lease_proof_expired] ... expired before
-- it was renewed" then "[GameServer.tournament_lease_lost] ... no answer
-- arrived, and the database did not say it moved" (verdict: unproven).
--
-- THE CAUSE
--
-- fn_begin_tournament_launch_atomic and fn_complete_tournament_launch_atomic
-- open with
--     SELECT ... FROM public.engine_tournament_leases l
--      WHERE l.tournament_id = p_tournament_id FOR UPDATE;
-- and hold that row lock for the life of the launch transaction (statement
-- budget 30 s; a 41-table launch on a slow afternoon takes most of it).
-- heartbeat_tournament_leases_v4 locks each claimed row
-- FOR NO KEY UPDATE ... SKIP LOCKED and answers `busy` for a row it cannot
-- lock. FOR UPDATE conflicts with FOR NO KEY UPDATE, so for as long as the
-- launch runs, every heartbeat for that one tournament is `busy`; `busy`
-- extends nothing by design (the proof rules in services/tournamentLease.ts).
-- The manager's 20 s proof window runs out, TournamentManagerBase expires its
-- authority, fenceForTournamentLeaseLoss fences every table it owns with
-- `tournament_lease_lost`, and GameServer rebuilds them all: 41 kills for one
-- launch. The lease never moved - the database still named this instance and
-- this generation on the row the whole time.
--
-- This is the exact defect fixed on the hand-commit path on 2026-09-10
-- (20260910064701_a_hand_commit_does_not_hold_the_lease_against_its_own_heartb):
-- "FOR KEY SHARE excludes a takeover (FOR UPDATE) and nothing else, so the
-- heartbeat can still renew this row." The launch functions were written with
-- the stronger lock and never given the same correction.
--
-- THE FIX
--
-- All six overloads (begin x3, complete x3) take FOR KEY SHARE on the lease
-- row instead of FOR UPDATE. What the launch needs from that lock is that the
-- generation it verified is not TAKEN OVER while it runs: a takeover is
-- claim_tournament_lease_v2's FOR UPDATE (a_busy_manager_keeps_its_lease),
-- a release is a DELETE, and FOR KEY SHARE blocks both exactly as before. The
-- heartbeat's FOR NO KEY UPDATE is not blocked, so the launching manager keeps
-- renewing through its own launch. Two launches of one event are still
-- serialized where they always were: tournament_launch_receipts FOR UPDATE
-- and tournaments FOR UPDATE inside fn_*_tournament_launch_before_lease_generation.
-- Nothing else in any overload changes: same rows read, same generation and
-- 30 s staleness checks, same receipt adoption, same answers.
--
-- The edit is by exact anchor on the live definition (one hit per overload,
-- measured 2026-10-25 20:05 UTC), it is a no-op once applied, and it refuses
-- a definition whose anchor count is not exactly one. Post-conditions: no
-- launch overload takes FOR UPDATE on engine_tournament_leases any more, every
-- overload carries the KEY SHARE clause, and the takeover still locks FOR
-- UPDATE (FOR KEY SHARE would fence nothing otherwise).
--
-- @live-proof: (SELECT count(*) = 6 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname IN ('fn_begin_tournament_launch_atomic','fn_complete_tournament_launch_atomic') AND position('A LAUNCH DOES NOT HOLD THE LEASE AGAINST ITS OWN HEARTBEAT' IN p.prosrc) > 0 AND p.prosrc !~ 'engine_tournament_leases l\s[^;]*FOR UPDATE;')
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $body$
DECLARE
  v_fn record;
  v_def text;
  v_n integer;
  v_done integer := 0;
  v_anchor text := E'   WHERE l.tournament_id = p_tournament_id\n   FOR UPDATE;';
  v_fixed  text := E'   WHERE l.tournament_id = p_tournament_id\n'
                || E'   -- A LAUNCH DOES NOT HOLD THE LEASE AGAINST ITS OWN HEARTBEAT\n'
                || E'   -- (2026-10-25): FOR KEY SHARE excludes a takeover (FOR UPDATE) and a\n'
                || E'   -- release (DELETE) and nothing else, so heartbeat_tournament_leases_v4\n'
                || E'   -- (FOR NO KEY UPDATE ... SKIP LOCKED) can still renew this row while\n'
                || E'   -- the launch runs. FOR UPDATE here answered every heartbeat of the\n'
                || E'   -- launching manager with busy, its 20 s proof ran out, and it fenced\n'
                || E'   -- every table it owned: 41 kills on one launch, 13:27:10 UTC.\n'
                || E'   FOR KEY SHARE;';
BEGIN
  FOR v_fn IN
    SELECT p.oid, p.oid::regprocedure::text AS signature
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('fn_begin_tournament_launch_atomic', 'fn_complete_tournament_launch_atomic')
     ORDER BY 2
  LOOP
    v_def := pg_get_functiondef(v_fn.oid);
    IF position('A LAUNCH DOES NOT HOLD THE LEASE AGAINST ITS OWN HEARTBEAT' IN v_def) > 0 THEN
      v_done := v_done + 1;
      CONTINUE;  -- already applied to this overload
    END IF;
    v_n := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'launch lease anchor appears % times in %, expected exactly 1', v_n, v_fn.signature;
    END IF;
    EXECUTE replace(v_def, v_anchor, v_fixed);
    v_done := v_done + 1;
  END LOOP;

  IF v_done <> 6 THEN
    RAISE EXCEPTION 'expected the six launch overloads (begin x3, complete x3), found %', v_done;
  END IF;

  -- Post-condition 1: no launch overload takes FOR UPDATE on the lease row.
  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('fn_begin_tournament_launch_atomic', 'fn_complete_tournament_launch_atomic')
     AND p.prosrc ~ 'engine_tournament_leases l\s[^;]*FOR UPDATE;';
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'post-condition: % launch overload(s) still take FOR UPDATE on engine_tournament_leases', v_n;
  END IF;

  -- Post-condition 2: every overload carries the KEY SHARE clause.
  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('fn_begin_tournament_launch_atomic', 'fn_complete_tournament_launch_atomic')
     AND p.prosrc ~ 'engine_tournament_leases l\s[^;]*FOR KEY SHARE;';
  IF v_n <> 6 THEN
    RAISE EXCEPTION 'post-condition: only % of 6 launch overloads take FOR KEY SHARE on engine_tournament_leases', v_n;
  END IF;

  -- Post-condition 3: the takeover still locks FOR UPDATE, or KEY SHARE fences nothing.
  IF position('FOR UPDATE;' IN (SELECT prosrc FROM pg_proc WHERE proname = 'claim_tournament_lease_v2')) = 0 THEN
    RAISE EXCEPTION 'post-condition: the takeover no longer locks FOR UPDATE; FOR KEY SHARE would fence nothing';
  END IF;

  -- Post-condition 4: the heartbeat still skips a locked row rather than queueing
  -- behind it; this fix relies on that lock being FOR NO KEY UPDATE, which KEY SHARE
  -- does not block.
  IF (SELECT prosrc FROM pg_proc WHERE proname = 'heartbeat_tournament_leases_v4')
     !~ 'FOR NO KEY UPDATE OF l SKIP LOCKED' THEN
    RAISE EXCEPTION 'post-condition: heartbeat_tournament_leases_v4 no longer locks FOR NO KEY UPDATE ... SKIP LOCKED';
  END IF;
END
$body$;

COMMIT;
