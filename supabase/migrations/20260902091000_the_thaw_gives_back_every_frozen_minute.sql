-- ═══════════════════════════════════════════════════════════════════════════
--  THE THAW GIVES BACK EVERY FROZEN MINUTE
--  Dan, 2026-09-01, binding
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Dan: "EVERYTHING JUST FREEZES, THEN PICKS BACK UP EXACTLY AS IT WAS BEFORE
-- THE FREEZE AND RESTART."
--
-- "Exactly as it was" is a statement about CLOCKS, not just about chips. The
-- freeze stops every movement, but a stored deadline is an absolute instant:
-- it keeps approaching while the platform stands still. Without this
-- function, a five-minute freeze silently consumes -
--
--   * the whole 60-second waitlist seat hold (the player was offered a seat,
--     shown a break screen, and loses their queue place through no act of
--     their own);
--   * the whole 60-second tournament add-on window;
--   * the entire 5-minute sit-out allowance (sit out at :53, evicted on the
--     first tick after :00, having been told your seat was safe);
--   * half of the 10-minute cashier claim-back window;
--   * five minutes of every Spin's blind level, because short formats do not
--     take the synchronized break and their level clock is wall-time;
--   * the mystery-bounty reveal window and the bust-rebuy prompt.
--
-- The thaw shifts every one of those forward by the frozen duration, so every
-- player-facing clock reads the same after the break as it did the moment the
-- break began. A deadline that was 40 seconds away at :55 is 40 seconds away
-- again at :00.
--
-- WHO CALLS IT: the engine, at the end of the break, before it resumes a
-- single table (MaintenanceBreak.end()). The engine's PostgREST role is
-- service_role, which is exactly who this is granted to.
--
-- IDEMPOTENT BY LEDGER, not by hope. The end of a break is also the moment an
-- engine is most likely to have just been replaced, so two engines could both
-- believe the thaw is theirs to run. Each freeze is thawed at most once: the
-- ledger insert keys on the freeze's start instant, and the second caller
-- conflicts and returns having done nothing.

BEGIN;

CREATE TABLE IF NOT EXISTS public.engine_maintenance_thaws (
  freeze_started_at  TIMESTAMPTZ PRIMARY KEY,
  thawed_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  frozen_seconds     NUMERIC NOT NULL,
  shifted            JSONB NOT NULL,
  thawed_by          TEXT
);

COMMENT ON TABLE public.engine_maintenance_thaws IS
  'One row per maintenance freeze that has been thawed. The primary key on the freeze start instant is what makes the thaw idempotent: two engines racing at the end of a break cannot both shift the clocks.';

ALTER TABLE public.engine_maintenance_thaws ENABLE ROW LEVEL SECURITY;
-- No policies: service_role bypasses RLS, nobody else reads or writes it.

CREATE OR REPLACE FUNCTION public.fn_thaw_platform(
  p_freeze_started  TIMESTAMPTZ,
  p_frozen_seconds  NUMERIC,
  p_thawed_by       TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_shift    INTERVAL;
  v_counts   JSONB := '{}'::jsonb;
  v_n        INTEGER;
BEGIN
  -- Sanity: a thaw claiming more than fifteen frozen minutes is a bug or a
  -- clock skew, and shifting every deadline on the platform by a wrong number
  -- is strictly worse than shifting by nothing.
  IF p_frozen_seconds IS NULL OR p_frozen_seconds <= 0 OR p_frozen_seconds > 900 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'implausible_frozen_seconds');
  END IF;

  -- Claim this freeze. Losing the race is success, not failure: the clocks
  -- have already been given back by whoever won.
  BEGIN
    INSERT INTO public.engine_maintenance_thaws (freeze_started_at, frozen_seconds, shifted, thawed_by)
    VALUES (p_freeze_started, p_frozen_seconds, '{}'::jsonb, p_thawed_by);
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('ok', true, 'reason', 'already_thawed');
  END;

  -- The thaw's own writes must pass the freeze guard even if it is called a
  -- moment before break_ends_at. LOCAL: dies with this transaction.
  PERFORM set_config('app.freeze_bypass', 'on', TRUE);

  v_shift := make_interval(secs => p_frozen_seconds);

  -- Sit-out clocks on live seats. The whole reason a player can sit out at
  -- :53 and still own their seat at :00.
  UPDATE public.table_seats
     SET sit_out_at = sit_out_at + v_shift
   WHERE left_at IS NULL AND sit_out_at IS NOT NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('sit_out_at', v_n);

  -- Waitlist seat holds that were alive when the freeze began (including any
  -- that "expired" during it - the shift resurrects exactly the time they
  -- were owed and no more).
  UPDATE public.table_waitlist
     SET hold_expires_at = hold_expires_at + v_shift
   WHERE hold_expires_at > p_freeze_started;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('hold_expires_at', v_n);

  -- Tournament add-on windows.
  UPDATE public.tournaments
     SET addon_period_ends_at = addon_period_ends_at + v_shift
   WHERE addon_period_ends_at > p_freeze_started;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('addon_period_ends_at', v_n);

  -- Blind level clocks - ONLY for running events NOT on the synchronized
  -- break. An MTT on the :55 break has its level clock suspended by
  -- pauseForBreak and restored by resumeFromBreak; shifting it here would
  -- give that event the five minutes twice. Short formats (Spins, Heads-Up)
  -- never take the synchronized break, so their wall-time level clock ran
  -- straight through the park - this is what gives it back, and it is the
  -- fix for the 2026-08-27 incident class where Spins lost whole levels to a
  -- stop they never asked for.
  UPDATE public.tournaments
     SET level_started_at = level_started_at + v_shift
   WHERE status = 'RUNNING'
     AND COALESCE(on_break, FALSE) = FALSE
     AND level_started_at IS NOT NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('level_started_at', v_n);

  -- The cashier claim-back window (10 minutes; a freeze would eat half).
  UPDATE public.chip_transactions
     SET reversible_until = reversible_until + v_shift
   WHERE reversible_until > p_freeze_started;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('reversible_until', v_n);

  -- Mystery bounty reveal windows.
  UPDATE public.tournament_bounty_awards
     SET reveal_deadline_at = reveal_deadline_at + v_shift
   WHERE reveal_deadline_at > p_freeze_started;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('reveal_deadline_at', v_n);

  -- Bust-rebuy prompts.
  UPDATE public.tournament_players
     SET rebuy_prompt_until = rebuy_prompt_until + v_shift
   WHERE rebuy_prompt_until > p_freeze_started;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('rebuy_prompt_until', v_n);

  -- Timed bomb pots: due exactly as far after the thaw as they were before
  -- the freeze.
  UPDATE public.tables
     SET bomb_pot_next_due_at = bomb_pot_next_due_at + v_shift
   WHERE bomb_pot_next_due_at IS NOT NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('bomb_pot_next_due_at', v_n);

  -- NOT shifted, deliberately:
  --   * tournaments.break_ends_at - the synchronized break owns it and the
  --     engine's resumeFromBreak restores it;
  --   * late_reg (started_at + late_reg_mins) - registration is frozen during
  --     the break, and the hourly tournament break has consumed those same
  --     five minutes of late-reg wall time since it was built. Shifting
  --     started_at would falsify history; parity with the existing break is
  --     the honest behaviour;
  --   * ban/mute/promotion expiries - a punishment or a promotion elapsing
  --     during a break is time genuinely passing, not play being taken away.

  UPDATE public.engine_maintenance_thaws
     SET shifted = v_counts
   WHERE freeze_started_at = p_freeze_started;

  RETURN jsonb_build_object('ok', true, 'shifted', v_counts);
END;
$$;

COMMENT ON FUNCTION public.fn_thaw_platform(TIMESTAMPTZ, NUMERIC, TEXT) IS
  'Shifts every in-flight absolute deadline forward by the frozen duration, so every player-facing clock reads the same after the break as when it began. Idempotent per freeze via engine_maintenance_thaws. Called by the engine before it resumes the first table.';

REVOKE ALL ON FUNCTION public.fn_thaw_platform(TIMESTAMPTZ, NUMERIC, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_thaw_platform(TIMESTAMPTZ, NUMERIC, TEXT) TO service_role;

COMMIT;
