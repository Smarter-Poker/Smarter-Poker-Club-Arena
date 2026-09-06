-- THE BOMB GUARD IS ATTACHED, NOW THE ENGINE CAN SATISFY IT.
--
-- 20260906100735 defined fn_ca_bomb_hand_keeps_its_award_units(): a bomb-pot
-- hand that distributes chips may not commit without award units, and the
-- units must sum to what was distributed. 20260906101230 detached it, because
-- the engine still wrote hand_history and bomb_pot_award_units as two
-- transactions and nothing in production could obey the rule yet. The record
-- there says the trigger goes back in "once something can satisfy it", and
-- this is that migration.
--
-- WHAT CHANGED SINCE, measured on production 2026-09-06 14:30 UTC before this
-- was written (Club Arena CLAUDE.md 1.4: verify by reading, never by assuming):
--
--   * PR #3272 (f33035d32b, merged 12:28 UTC) makes the engine write the hand
--     and its units in ONE call to fn_ca_insert_hand_with_awards, carries the
--     units through the retry queue, and sets wroteAwardUnits from the write.
--   * The engine restarted with it at the 12:55 maintenance break: the
--     per-minute hand count dips to 5 at 12:54 and resumes at 13:00.
--   * Since 12:58 UTC: 397 bomb-pot hands, 0 without units, 0 whose units do
--     not sum to the distributable pot. The last unit-less bomb hand is
--     12:47:27, eleven minutes BEFORE the restart. Over the trailing 7 days:
--     26,448 bomb hands, 0 sum mismatches ever, 5 unit-less, all pre-restart.
--   * Atomicity is visible in the rows themselves: for the 248 bomb hands in
--     the hour before this was written, every award unit carries the same
--     xmin as its hand_history row - one transaction, not two.
--
-- So the rule now describes what the engine does. Attaching it changes nothing
-- about the happy path and turns the failure this programme was opened on (a
-- bomb hand committing with its breakdown lost) from a drift the detector
-- under-reports into a write that cannot commit. Dan's ruling, 2026-09-06:
-- "I WANT NOTHING BUT CODE BASE FIXES FOR ANY AND ALL CHIP DRIFT ISSUES" -
-- this is the write that cannot lose, not a sweep that finds what it lost.
--
-- WHY THE DDL IS GUARDED. A bare DROP/CREATE TRIGGER on hand_history takes
-- AccessExclusiveLock against ~450 inserts a minute; it deadlocked twice
-- (40P01) on 2026-09-06. The existence check means a replay is a no-op and
-- never reaches for the lock, and lock_timeout means a live insert wins.
--
-- WHY THE PROBES. Part 7.2 of the programme record: a function that failed
-- on every call shipped behind green tests that asserted the call, not the
-- effect. This migration therefore exercises the attached trigger against
-- the real table, three ways, in subtransactions it rolls back, and aborts
-- itself if any of them disagrees with the rule:
--   1. a bomb hand distributing chips with NO units is REFUSED (23000);
--   2. the same hand written through fn_ca_insert_hand_with_awards with
--      units that sum to the pot is ACCEPTED;
--   3. a bomb hand distributing nothing (folded around) with no units is
--      ACCEPTED - not every bomb row owes a breakdown.
-- SET CONSTRAINTS ... IMMEDIATE is what makes a DEFERRED trigger fire inside
-- the probe instead of at the COMMIT this migration never reaches for them.
--
-- ORDER MATTERS, AND THE FIRST DRAFT OF THIS MIGRATION GOT IT WRONG. Setting
-- IMMEDIATE before the call makes the trigger fire at the end of the hand
-- INSERT, which inside fn_ca_insert_hand_with_awards is one statement BEFORE
-- the units INSERT - so the atomic write itself was refused and the migration
-- aborted (14:36 UTC; nothing committed, the abort is the design). The rule
-- only holds because the trigger is DEFERRED to commit, after both writes.
-- The probes therefore call the function under DEFERRED and set IMMEDIATE
-- afterwards, which checks the outstanding events retroactively - the same
-- moment production checks them, without a COMMIT. Corollary for the engine
-- and for anyone with a psql session: never SET CONSTRAINTS ALL IMMEDIATE
-- around a hand insert; it would refuse every bomb hand the RPC writes.
--
-- ROLLBACK, if bomb hands stop committing (watch bomb_pot_award_units and the
-- engine's retry-queue depth for ten minutes after apply):
--   SET lock_timeout = '9s';
--   DROP TRIGGER IF EXISTS zz_ca_bomb_hand_keeps_its_award_units ON public.hand_history;
-- and record the drop in a follow-up migration so files and database agree.

BEGIN;

DO $attach$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgrelid = 'public.hand_history'::regclass
                    AND tgname = 'zz_ca_bomb_hand_keeps_its_award_units') THEN
    SET LOCAL lock_timeout = '10s';
    CREATE CONSTRAINT TRIGGER zz_ca_bomb_hand_keeps_its_award_units
      AFTER INSERT ON public.hand_history
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW WHEN (NEW.bomb_pot IS NOT NULL)
      EXECUTE FUNCTION public.fn_ca_bomb_hand_keeps_its_award_units();
  END IF;
END $attach$;

COMMENT ON FUNCTION public.fn_ca_bomb_hand_keeps_its_award_units() IS
  'ATTACHED as constraint trigger zz_ca_bomb_hand_keeps_its_award_units on '
  'hand_history (20260906143315). A bomb-pot hand that distributes chips '
  'cannot commit without award units summing to the distributable pot. The '
  'engine satisfies it through fn_ca_insert_hand_with_awards (PR #3272). '
  'Detached history: 20260906100735 defined, 20260906101230 detached.';

-- ---------------------------------------------------------------------------
-- PROVE IT, on the real table, then roll every probe back.
-- ---------------------------------------------------------------------------
DO $verify$
DECLARE
  v_id      uuid;
  v_state   text;
  v_msg     text;
  v_table   uuid := '00000000-0000-0000-0000-0000000000aa';
  v_user    uuid := '00000000-0000-0000-0000-0000000000bb';
  v_refused boolean := false;
  v_accepted_with_units boolean := false;
  v_accepted_nondist    boolean := false;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgrelid = 'public.hand_history'::regclass
                    AND tgname = 'zz_ca_bomb_hand_keeps_its_award_units'
                    AND tgenabled <> 'D') THEN
    RAISE EXCEPTION 'VERIFY FAILED: the bomb constraint trigger is not attached and enabled';
  END IF;

  -- 1. A bomb hand distributing 10 chips with NO units must be refused.
  BEGIN
    SET CONSTRAINTS public.zz_ca_bomb_hand_keeps_its_award_units DEFERRED;
    v_id := public.fn_ca_insert_hand_with_awards(
      jsonb_build_object(
        'table_id',    v_table,
        'hand_number', -1,
        'pot_size',    10,
        'rake_amount', 0,
        'bbj_amount',  0,
        'bomb_pot',    jsonb_build_object('board_count', 1),
        'players',     '[]'::jsonb,
        'actions',     '[]'::jsonb),
      '[]'::jsonb);
    -- what COMMIT would do, done now
    SET CONSTRAINTS public.zz_ca_bomb_hand_keeps_its_award_units IMMEDIATE;
    RAISE EXCEPTION 'VERIFY FAILED: a bomb hand with no award units committed past the guard (id %)', v_id;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    IF v_state = '23000' AND v_msg LIKE 'bomb pot hand%no award units%' THEN
      v_refused := true;
    ELSE
      RAISE EXCEPTION 'VERIFY FAILED: expected the guard (23000) to refuse, got % %', v_state, v_msg;
    END IF;
  END;

  -- 2. The same hand with units summing to the pot must be accepted.
  BEGIN
    SET CONSTRAINTS public.zz_ca_bomb_hand_keeps_its_award_units DEFERRED;
    v_id := public.fn_ca_insert_hand_with_awards(
      jsonb_build_object(
        'table_id',    v_table,
        'hand_number', -1,
        'pot_size',    10,
        'rake_amount', 0,
        'bbj_amount',  0,
        'bomb_pot',    jsonb_build_object('board_count', 1),
        'players',     '[]'::jsonb,
        'actions',     '[]'::jsonb),
      jsonb_build_array(jsonb_build_object(
        'table_id', v_table, 'hand_number', -1, 'pot_index', 0,
        'board', 1, 'side', 'high', 'user_id', v_user, 'amount', 10)));
    SET CONSTRAINTS public.zz_ca_bomb_hand_keeps_its_award_units IMMEDIATE;
    IF v_id IS NULL THEN
      RAISE EXCEPTION 'VERIFY FAILED: the atomic insert returned no id';
    END IF;
    v_accepted_with_units := true;
    RAISE EXCEPTION 'ca_verify_rollback';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'ca_verify_rollback' THEN
      RAISE EXCEPTION 'VERIFY FAILED: a bomb hand WITH matching units was refused: % %', SQLSTATE, SQLERRM;
    END IF;
  END;

  -- 3. A bomb hand distributing nothing, with no units, must be accepted.
  BEGIN
    SET CONSTRAINTS public.zz_ca_bomb_hand_keeps_its_award_units DEFERRED;
    v_id := public.fn_ca_insert_hand_with_awards(
      jsonb_build_object(
        'table_id',    v_table,
        'hand_number', -1,
        'pot_size',    0,
        'rake_amount', 0,
        'bbj_amount',  0,
        'bomb_pot',    jsonb_build_object('board_count', 1),
        'players',     '[]'::jsonb,
        'actions',     '[]'::jsonb),
      '[]'::jsonb);
    SET CONSTRAINTS public.zz_ca_bomb_hand_keeps_its_award_units IMMEDIATE;
    IF v_id IS NULL THEN
      RAISE EXCEPTION 'VERIFY FAILED: the atomic insert returned no id';
    END IF;
    v_accepted_nondist := true;
    RAISE EXCEPTION 'ca_verify_rollback';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'ca_verify_rollback' THEN
      RAISE EXCEPTION 'VERIFY FAILED: a folded-around bomb hand with no units was refused: % %', SQLSTATE, SQLERRM;
    END IF;
  END;

  IF NOT (v_refused AND v_accepted_with_units AND v_accepted_nondist) THEN
    RAISE EXCEPTION 'VERIFY FAILED: probes did not all run to completion (% % %)',
      v_refused, v_accepted_with_units, v_accepted_nondist;
  END IF;

  IF EXISTS (SELECT 1 FROM public.hand_history WHERE hand_number = -1) THEN
    RAISE EXCEPTION 'VERIFY FAILED: a probe row survived its rollback';
  END IF;
  IF EXISTS (SELECT 1 FROM public.bomb_pot_award_units WHERE hand_number = -1) THEN
    RAISE EXCEPTION 'VERIFY FAILED: a probe award unit survived its rollback';
  END IF;

  RAISE NOTICE 'BOMB_GUARD_ATTACHED_AND_PROVED refuses unit-less, accepts units that sum, accepts a folded-around bomb, probes rolled back';
END $verify$;

COMMIT;
