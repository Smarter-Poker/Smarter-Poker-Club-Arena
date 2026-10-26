-- 20261025224305_the_spin_draw_does_not_hold_the_lease_against_its_own_heartb.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- THE SPIN DRAW DOES NOT HOLD THE LEASE AGAINST ITS OWN HEARTBEAT (2026-10-25,
-- phase 1 of the lease follow-ups). Full account:
-- docs/changelog/2026-10-25-the-spin-draw-does-not-hold-the-lease-against-its-own-heartbeat.md
--
-- THE AUDIT
--
-- After 20261025200555 fixed the two MTT launch doors, every function on this
-- database that takes FOR UPDATE or FOR SHARE on public.engine_tournament_leases
-- was listed from pg_proc and classified by who calls it and what the lock is
-- for. The engine (server/src, non-test) calls exactly seven of them:
--   claim_tournament_lease_v2, release_tournament_leases_v2,
--   reap_dead_engine_leases          - the takeover, the release, the reaper:
--                                      these MOVE or END a lease and must lock it;
--   fn_f06_prepare_mixed_manager_custody - runs only against a lease whose
--                                      heartbeat is already STALE (it raises
--                                      F06_MIXED_OLD_LEASE_CHANGED otherwise), so
--                                      no live heartbeat is blocked by it;
--   fn_f06_abort_abandoned_generation - the resume-time door, whose FOR UPDATE
--                                      is documented in its own body as a
--                                      deliberate barrier that drains every
--                                      protocol-2 request before the abort;
--                                      it runs before any dealer is built;
--   fn_spin_draw_and_settle_atomic   - THE SPIN LAUNCH: this file.
-- The other twelve (the breakfast and sep8 witnesses, the welcome-certification
-- board preparers, continue_retired_undealt_paid_entry, the five f06 abort /
-- retired-origin functions, fn_f06_close_abandoned_manager_transfer,
-- fn_stage_a_bridge_legacy_capacity_receipt) have no caller in the engine, no
-- caller in any other database function on a live path and no cron: historical
-- one-off settlement doors. They are left as they are.
--
-- THE SPIN LAUNCH
--
-- fn_spin_draw_and_settle_atomic is the Spin's launch: the same shape as
-- fn_begin_tournament_launch_atomic (30 s statement budget, the shared
-- maintenance advisory lock, the launch receipt and the 'launch_lease_lost'
-- answer), opening with
--     SELECT * INTO v_lease FROM public.engine_tournament_leases
--      WHERE tournament_id = p_tournament_id FOR UPDATE;
-- and holding that lock for the whole draw and settlement. For as long as it
-- runs, heartbeat_tournament_leases_v4 (FOR NO KEY UPDATE ... SKIP LOCKED)
-- answers `busy` for that one Spin, `busy` extends nothing, and a draw that
-- runs past the manager's 20 s proof window fences the Spin's table with
-- `tournament_lease_lost`. engine_recovery_events, last 7 days: 9 Spin tables
-- killed that way, one per Spin, including 7d1abc56 at 18:25:35 UTC today
-- (receipt 18:25:08 -> 18:25:24, busy +6 in the window ending 18:25:45).
--
-- THE FIX
--
-- FOR KEY SHARE, exactly as the MTT launch doors and the hand commit: it still
-- blocks a takeover (claim_tournament_lease_v2's FOR UPDATE) and a release
-- (DELETE), and no longer blocks the heartbeat. The function never writes the
-- lease row. The draw stays serialized where it always was:
-- fn_lock_tournament_launch_proof_parents, the launch receipt and the
-- tournaments row. Same generation and 30 s staleness checks, same answers.
-- Edited by exact anchor (one hit, one overload, md5 1e5b6175ed91b8fc measured
-- 2026-10-25 22:40 UTC), no-op once applied.
--
-- @live-proof: (SELECT count(*) = 1 FROM pg_proc p WHERE p.proname = 'fn_spin_draw_and_settle_atomic' AND position('THE SPIN DRAW DOES NOT HOLD THE LEASE AGAINST ITS OWN HEARTBEAT' IN p.prosrc) > 0 AND p.prosrc !~ 'engine_tournament_leases\s[^;]*FOR UPDATE;')
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $body$
DECLARE
  v_oid oid;
  v_def text;
  v_n integer;
  v_anchor text := E'  SELECT * INTO v_lease FROM public.engine_tournament_leases\n'
                || E'   WHERE tournament_id = p_tournament_id FOR UPDATE;';
  v_fixed  text := E'  SELECT * INTO v_lease FROM public.engine_tournament_leases\n'
                || E'   WHERE tournament_id = p_tournament_id\n'
                || E'   -- THE SPIN DRAW DOES NOT HOLD THE LEASE AGAINST ITS OWN HEARTBEAT\n'
                || E'   -- (2026-10-25): FOR KEY SHARE excludes a takeover (FOR UPDATE) and a\n'
                || E'   -- release (DELETE) and nothing else, so heartbeat_tournament_leases_v4\n'
                || E'   -- (FOR NO KEY UPDATE ... SKIP LOCKED) renews this row while the draw\n'
                || E'   -- runs. FOR UPDATE here answered the launching manager''s every\n'
                || E'   -- heartbeat with busy until its 20 s proof ran out: 9 Spin tables in\n'
                || E'   -- 7 days fenced with tournament_lease_lost at their own launch.\n'
                || E'   FOR KEY SHARE;';
BEGIN
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_spin_draw_and_settle_atomic';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'expected exactly one fn_spin_draw_and_settle_atomic, found %', v_n;
  END IF;
  SELECT p.oid INTO v_oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_spin_draw_and_settle_atomic';
  v_def := pg_get_functiondef(v_oid);

  IF position('THE SPIN DRAW DOES NOT HOLD THE LEASE AGAINST ITS OWN HEARTBEAT' IN v_def) = 0 THEN
    v_n := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'spin draw lease anchor appears % times, expected exactly 1', v_n;
    END IF;
    EXECUTE replace(v_def, v_anchor, v_fixed);
  END IF;

  -- Post-condition 1: the Spin launch no longer takes FOR UPDATE on the lease row.
  IF (SELECT prosrc FROM pg_proc WHERE oid = v_oid) ~ 'engine_tournament_leases\s[^;]*FOR UPDATE;' THEN
    RAISE EXCEPTION 'post-condition: fn_spin_draw_and_settle_atomic still takes FOR UPDATE on engine_tournament_leases';
  END IF;
  -- Post-condition 2: it takes FOR KEY SHARE, and still writes nothing to the row.
  IF (SELECT prosrc FROM pg_proc WHERE oid = v_oid) !~ 'engine_tournament_leases\s[^;]*FOR KEY SHARE;'
     OR (SELECT prosrc FROM pg_proc WHERE oid = v_oid) ~ '(UPDATE|DELETE FROM)\s+public\.engine_tournament_leases' THEN
    RAISE EXCEPTION 'post-condition: fn_spin_draw_and_settle_atomic lock clause is not FOR KEY SHARE, or it writes the lease row';
  END IF;
  -- Post-condition 3: no live launch door takes FOR UPDATE on the lease row any more
  -- (the two MTT doors were fixed by 20261025200555).
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('fn_begin_tournament_launch_atomic', 'fn_complete_tournament_launch_atomic', 'fn_spin_draw_and_settle_atomic')
     AND p.prosrc ~ 'engine_tournament_leases l?\s[^;]*FOR UPDATE;';
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'post-condition: % launch door(s) still take FOR UPDATE on engine_tournament_leases', v_n;
  END IF;
  -- Post-condition 4: the takeover still locks FOR UPDATE, or KEY SHARE fences nothing.
  IF position('FOR UPDATE;' IN (SELECT prosrc FROM pg_proc WHERE proname = 'claim_tournament_lease_v2')) = 0 THEN
    RAISE EXCEPTION 'post-condition: the takeover no longer locks FOR UPDATE; FOR KEY SHARE would fence nothing';
  END IF;
  -- Post-condition 5: the heartbeat still skips a locked row rather than queueing behind it.
  IF (SELECT prosrc FROM pg_proc WHERE proname = 'heartbeat_tournament_leases_v4')
     !~ 'FOR NO KEY UPDATE OF l SKIP LOCKED' THEN
    RAISE EXCEPTION 'post-condition: heartbeat_tournament_leases_v4 no longer locks FOR NO KEY UPDATE ... SKIP LOCKED';
  END IF;
END
$body$;

COMMIT;
