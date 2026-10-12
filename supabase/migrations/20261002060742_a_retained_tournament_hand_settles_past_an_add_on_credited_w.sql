-- 20261002060742_a_retained_tournament_hand_settles_past_an_add_on_credited_w.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- CLAUDE.md 10.9 / 10.11 / 10.12: the reasoning is in this header. This file
-- changes ONE clause of ONE door, public.fn_ca_resume_hand_submission. It
-- schedules nothing, writes no row itself and moves no chip itself.
--
-- ===========================================================================
-- WHAT WAS WRONG, READ FROM ROWS AND LOG LINES (2026-10-02 ~06:05 UTC)
--
-- 09a56a25 "Prime Time Free Buy (NLH)" (28 playing, level 28) has dealt
-- nothing on its three 9-handed tables since 01:49 UTC. Each holds one
-- reserved permit and one retained hand submission from dead generation
-- 68bbf392 (be8ecfbb #20015131, c971a187 #20015246, eb64e7c5 #20015129).
-- Every successor asks this door to hand the finished hand off and gets
--
--   [Tournament.09a56a25.resume_table_error] RetainedHandSubmissionRefusedError:
--     retained_hand_submission_readback_failed: HAND_SUBMISSION_HANDOFF_STATE_CHANGED
--
-- Measured against the live rows, the only failing clause on all three is
-- "every named chair still holds exactly stack_before": on each table exactly
-- one chair holds stack_before + 10,000 (72f2fedb 2036 -> 12036, 00000000
-- 2419 -> 12419, 5bb61f42 2747 -> 12747), and each of those registrations
-- has add_on = true; the event's addon_chips is 10,000. The add-on was
-- credited to the seat while the hand waited. Every other clause (late
-- chairs, duplicate seats, later commits, history, permits, table, event
-- RUNNING) already passes.
--
-- ===========================================================================
-- WHAT THIS CHANGES
--
-- That clause admits, for a tournament table only, a chair holding exactly
-- stack_before + the event's addon_chips when its registration bought the
-- add-on. Nothing else. The settlement this door calls
-- (fn_ca_commit_hand_settlement -> fn_ca_settle_hand_stacks_absolute) runs in
-- delta mode because every stacks element carries stack_before: it writes
-- seat + (stack_after - stack_before), records the add-on as a rebase in
-- ca_seat_stack_rebases, checks conservation on the deltas, and mirrors the
-- result into tournament_players. The hand's result is honoured and the
-- add-on is kept; nobody loses a chip.
--
-- Same signature, owner, ACL {postgres=X/postgres,service_role=X/postgres},
-- SECURITY DEFINER, volatility and search_path (the live definition is
-- edited in place, as 20260929031904 did).
--
-- PROVED FIRST (read-only, 2026-10-02 06:06 UTC): for the three submissions
-- the installed clause fails and the add-on clause passes on every element.
--
-- Pinned by tests/a-retained-tournament-hand-settles-past-an-add-on-credited-while-it-waited.law.test.ts.

-- @live-proof: (SELECT md5(prosrc)='09fdd355fff94da94c4dcdc8667364d4' AND md5(pg_get_functiondef(oid))='a29b3dbcc63bba8bcd61dd127241f862' AND proacl::text='{postgres=X/postgres,service_role=X/postgres}' FROM pg_proc WHERE oid='public.fn_ca_resume_hand_submission(uuid,text,uuid)'::regprocedure)

BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';

DO $retained_addon_preimage$
DECLARE v_reason text;
BEGIN
  v_reason := public.fn_ca_break_window_refuses_migrations(now());
  IF v_reason IS NOT NULL THEN
    RAISE EXCEPTION 'RETAINED_ADDON_REFUSED: %', v_reason USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = to_regprocedure('public.fn_ca_resume_hand_submission(uuid,text,uuid)')
       AND md5(p.prosrc) = '4cc9df92758a39ed78ce6ade1e26849c'
       AND md5(pg_get_functiondef(p.oid)) = '0d0668ccaba3d7215ebebad1dff203a6'
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.proacl::text = '{postgres=X/postgres,service_role=X/postgres}'
       AND p.proconfig = ARRAY['search_path=pg_catalog, public']
       AND p.prosecdef AND p.provolatile = 'v') THEN
    RAISE EXCEPTION 'RETAINED_ADDON_PREIMAGE_DRIFT: public.fn_ca_resume_hand_submission(uuid,text,uuid)';
  END IF;
END
$retained_addon_preimage$;

-- The edit, found exactly once in the live definition, executed as the live
-- definition itself (same signature, owner, ACL, SECURITY DEFINER,
-- volatility and search_path).
DO $retained_addon_patch$
DECLARE v_def text; v_old text; v_new text; n int;
BEGIN
  v_def := pg_get_functiondef('public.fn_ca_resume_hand_submission(uuid,text,uuid)'::regprocedure);
  -- addon
  v_old := $a$       AND seat.left_at IS NULL AND seat.stack=(x->>'stack_before')::numeric))
$a$;
  v_new := $b$       AND seat.left_at IS NULL AND (seat.stack=(x->>'stack_before')::numeric
       -- AN ADD-ON CREDITED WHILE THE HAND WAITED (2026-10-02). A tournament
       -- chair may hold exactly the event's addon_chips more than the hand
       -- dealt from, only when its registration bought the add-on. The
       -- settlement runs in delta mode (every element carries stack_before),
       -- so that credit is preserved, not overwritten.
       OR (tour IS NOT NULL AND EXISTS(SELECT 1 FROM public.tournament_players tp
         JOIN public.tournaments ev ON ev.id=tp.tournament_id
         WHERE tp.tournament_id=tour AND tp.user_id=seat.user_id AND tp.add_on IS TRUE
           AND COALESCE(ev.addon_chips,0)>0
           AND seat.stack=(x->>'stack_before')::numeric+ev.addon_chips)))))
$b$;
  n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF n <> 1 THEN
    RAISE EXCEPTION 'RETAINED_ADDON_ANCHOR_FOUND_%_TIMES', n;
  END IF;
  v_def := replace(v_def, v_old, v_new);
  EXECUTE v_def;
END
$retained_addon_patch$;

DO $retained_addon_postimage$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = 'public.fn_ca_resume_hand_submission(uuid,text,uuid)'::regprocedure
       AND md5(p.prosrc) = '09fdd355fff94da94c4dcdc8667364d4'
       AND md5(pg_get_functiondef(p.oid)) = 'a29b3dbcc63bba8bcd61dd127241f862'
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.proacl::text = '{postgres=X/postgres,service_role=X/postgres}'
       AND p.proconfig = ARRAY['search_path=pg_catalog, public']
       AND p.prosecdef AND p.provolatile = 'v') THEN
    RAISE EXCEPTION 'RETAINED_ADDON_POSTIMAGE_DRIFT: public.fn_ca_resume_hand_submission(uuid,text,uuid)';
  END IF;
END
$retained_addon_postimage$;

COMMIT;
