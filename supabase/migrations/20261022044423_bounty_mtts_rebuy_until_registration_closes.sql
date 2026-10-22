-- 20261022044423_bounty_mtts_rebuy_until_registration_closes.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Dan, 2026-10-21, verbatim: "NO BOUNTY OR MYSTERY BOUNTY TOURNAMENT SHOULD BE
-- A FREEZEOUT, THEY SHOULD ALL HAVE REBUY TILL THE END OF REGISTRATION."
--
-- READ FROM PRODUCTION BEFORE THIS RAN (2026-10-22 04:30 UTC). Of the paid
-- bounty, PKO and mystery bounty MTTs still taking registrations, the Midway
-- Union's events from 2026-10-24 on were rebuy events (their schedule rows
-- were given rebuys by 20261020194921), but every one spawned before that and
-- EVERY Diamond Arena bounty event, all days, was a freezeout: the arena's
-- schedule rows never received the rebuy keys, and the Diamond door's
-- defaults leave max_rebuys = 0, which fn_open_tournament_rebuy_decisions
-- reads as "no rebuys at all". The 2K GTD Midweek Mystery Dan was eliminated
-- from (62a7c3b1) was one of them.
--
-- THE ROOT FIX. One BEFORE INSERT / UPDATE trigger makes the rule part of the
-- row itself, whatever door creates it (the engine spawner, the Diamond spawn
-- door, fn_create_tournament, an operator edit): a paid bounty MTT that has
-- not started is a rebuy and re-entry event, its rebuy window is its
-- late-registration window (rebuy_levels = late_reg_levels), the rebuy costs
-- the entry total for the starting stack unless the event already set its
-- own, and there is no count cap (0 is normalised to NULL). Satellites,
-- Sit & Gos, Spins and freerolls are left exactly as they were. The engine
-- spawner applies the same rule before it writes (bountyRebuyPolicy.ts), so
-- the two never disagree.
--
-- THE EVENTS ALREADY ON THE BOARD. Every paid bounty MTT still REGISTERING or
-- ANNOUNCED is brought under the rule here. Adding a rebuy option takes
-- nothing from any registered player: no entry price, stack, guarantee,
-- payout, bounty, wallet or escrow is changed. Running events keep the
-- contract they started with.
--
-- @live-proof: (SELECT count(*) = 0 FROM public.tournaments t WHERE (COALESCE(t.is_bounty,false) OR COALESCE(t.is_pko,false) OR COALESCE(t.is_mystery_bounty,false)) AND upper(COALESCE(t.tournament_type,'MTT')) = 'MTT' AND lower(COALESCE(t.variant,'')) <> 'satellite' AND t.satellite_target_id IS NULL AND upper(COALESCE(t.status,'')) IN ('REGISTERING','ANNOUNCED') AND COALESCE(t.buy_in_amount,0) + COALESCE(t.buy_in_fee,0) > 0 AND NOT (COALESCE(t.is_rebuy,false) AND COALESCE(t.max_rebuys,1) > 0 AND (COALESCE(t.late_reg_levels,0) = 0 OR t.rebuy_levels = t.late_reg_levels)))

BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.fn_ca_bounty_mtt_rebuys_until_registration_closes()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_total numeric;
BEGIN
  IF NOT (COALESCE(NEW.is_bounty, false) OR COALESCE(NEW.is_pko, false)
          OR COALESCE(NEW.is_mystery_bounty, false)) THEN
    RETURN NEW;
  END IF;
  IF upper(COALESCE(NEW.tournament_type, 'MTT')) <> 'MTT'
     OR lower(COALESCE(NEW.variant, '')) = 'satellite'
     OR NEW.satellite_target_id IS NOT NULL THEN
    RETURN NEW;
  END IF;
  -- A game that has started keeps the contract it started with.
  IF upper(COALESCE(NEW.status, 'REGISTERING')) NOT IN ('REGISTERING', 'ANNOUNCED') THEN
    RETURN NEW;
  END IF;
  v_total := COALESCE(NEW.buy_in_amount, 0) + COALESCE(NEW.buy_in_fee, 0);
  -- A freeroll keeps its Free Buy rules (fn_freerolls_are_free_buy).
  IF v_total <= 0 THEN
    RETURN NEW;
  END IF;

  NEW.is_rebuy := true;
  NEW.is_reentry := true;
  IF COALESCE(NEW.rebuy_cost, 0) <= 0 THEN
    NEW.rebuy_cost := v_total;
  END IF;
  IF COALESCE(NEW.rebuy_chips, 0) <= 0 THEN
    NEW.rebuy_chips := COALESCE(NULLIF(NEW.starting_chips, 0), 10000);
  END IF;
  IF COALESCE(NEW.late_reg_levels, 0) > 0 THEN
    NEW.rebuy_levels := NEW.late_reg_levels;
  ELSIF COALESCE(NEW.rebuy_levels, 0) <= 0 THEN
    NEW.rebuy_levels := 6;
  END IF;
  IF COALESCE(NEW.max_rebuys, 0) <= 0 THEN
    NEW.max_rebuys := NULL;
  END IF;
  IF COALESCE(NEW.max_reentries, 0) <= 0 THEN
    NEW.max_reentries := NULL;
  END IF;
  RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION public.fn_ca_bounty_mtt_rebuys_until_registration_closes() IS
  'Dan 2026-10-21: no bounty, PKO or mystery bounty MTT is a freezeout; a paid pre-start bounty MTT rebuys until registration closes.';

-- Named to fire after the a2_ satellite-target guard and before every
-- structure guard (fn_poker_guard_arena_structure, trg_whole_dollar_buyin, the
-- zz_ Free Buy rule), so each of them validates the normalised row.
DROP TRIGGER IF EXISTS a3_bounty_mtt_rebuys_until_registration_closes ON public.tournaments;
CREATE TRIGGER a3_bounty_mtt_rebuys_until_registration_closes
  BEFORE INSERT OR UPDATE OF is_bounty, is_pko, is_mystery_bounty, tournament_type, variant,
    satellite_target_id, is_rebuy, is_reentry, rebuy_cost, rebuy_chips, rebuy_levels,
    max_rebuys, max_reentries, late_reg_levels, buy_in_amount, buy_in_fee
  ON public.tournaments
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_ca_bounty_mtt_rebuys_until_registration_closes();

INSERT INTO public.ca_declared_money_triggers(table_name,trigger_name,note)
VALUES ('tournaments','a3_bounty_mtt_rebuys_until_registration_closes',
  'Dan 2026-10-21: a paid pre-start bounty, PKO or mystery bounty MTT is never a freezeout; sets is_rebuy and is_reentry, rebuy_levels = late_reg_levels, rebuy cost and chips defaults and no count cap. Moves no money.')
ON CONFLICT DO NOTHING;

-- A registered event's contract is guarded by fn_guard_managed_game_lifecycle.
-- Root may GRANT a pre-start bounty event its rebuy (and only the rebuy keys),
-- in this transaction, the same narrow way 20261021222049 let it lock the
-- level clock. Every other protected field still runs through the guard.
DO $guard$
DECLARE
  d text;
  anchor constant text := '        -- Root may correct only the known literal-eight Diamond clock';
  clause constant text :=
'        -- Root may give a pre-start bounty event its rebuy (Dan 2026-10-21: no
        -- bounty or mystery bounty tournament is a freezeout). Only the rebuy
        -- keys, only toward a rebuy; every other protected field runs below.
        CONTINUE WHEN v_key IN (''is_rebuy'', ''is_reentry'', ''rebuy_cost'', ''rebuy_chips'', ''rebuy_levels'', ''max_rebuys'', ''max_reentries'')
          AND current_user = ''postgres''
          AND COALESCE(current_setting(''app.bounty_rebuy_rule'', true), '''') = ''on''
          AND COALESCE(NEW.is_rebuy, false)
          AND upper(COALESCE(OLD.status, '''')) IN (''ANNOUNCED'', ''REGISTERING'');
';
BEGIN
  d := pg_get_functiondef('public.fn_guard_managed_game_lifecycle()'::regprocedure);
  IF position('Root may give a pre-start bounty event its rebuy' IN d) > 0 THEN RETURN; END IF;
  IF position(anchor IN d) = 0 THEN
    RAISE EXCEPTION 'fn_guard_managed_game_lifecycle changed shape; bounty rebuy exception not installed';
  END IF;
  EXECUTE replace(d, anchor, clause || anchor);
END
$guard$;

SELECT set_config('app.bounty_rebuy_rule', 'on', true);

-- The events already on the board: touching is_rebuy fires the trigger,
-- which writes the whole rule.
UPDATE public.tournaments t
   SET is_rebuy = true
 WHERE (COALESCE(t.is_bounty, false) OR COALESCE(t.is_pko, false)
        OR COALESCE(t.is_mystery_bounty, false))
   AND upper(COALESCE(t.tournament_type, 'MTT')) = 'MTT'
   AND lower(COALESCE(t.variant, '')) <> 'satellite'
   AND t.satellite_target_id IS NULL
   AND upper(COALESCE(t.status, '')) IN ('REGISTERING', 'ANNOUNCED')
   AND COALESCE(t.buy_in_amount, 0) + COALESCE(t.buy_in_fee, 0) > 0;

DO $assert$
DECLARE
  v_left integer;
BEGIN
  SELECT count(*) INTO v_left
    FROM public.tournaments t
   WHERE (COALESCE(t.is_bounty, false) OR COALESCE(t.is_pko, false)
          OR COALESCE(t.is_mystery_bounty, false))
     AND upper(COALESCE(t.tournament_type, 'MTT')) = 'MTT'
     AND lower(COALESCE(t.variant, '')) <> 'satellite'
     AND t.satellite_target_id IS NULL
     AND upper(COALESCE(t.status, '')) IN ('REGISTERING', 'ANNOUNCED')
     AND COALESCE(t.buy_in_amount, 0) + COALESCE(t.buy_in_fee, 0) > 0
     AND NOT (COALESCE(t.is_rebuy, false)
              AND COALESCE(t.max_rebuys, 1) > 0
              AND (COALESCE(t.late_reg_levels, 0) = 0 OR t.rebuy_levels = t.late_reg_levels));
  IF v_left <> 0 THEN
    RAISE EXCEPTION 'bounty MTTs still freezeouts after the rule: %', v_left;
  END IF;
END
$assert$;

COMMIT;
