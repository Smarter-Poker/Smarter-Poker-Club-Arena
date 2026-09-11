-- 20260911110907_a_satellite_never_feeds_a_target_its_finish_refuses.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- The one satellite settlement authority, fn_settle_satellite_tournament
-- (core fn_settle_satellite_tournament_pre_money_path_gate, 20260909165629),
-- refuses every target whose entry is not a plain prize + fee split:
--
--   IF v_target.is_bounty IS DISTINCT FROM false OR v_target.is_pko ... OR
--      is_mystery_bounty ... OR is_premium_spin ... OR variant 'spin' OR
--      tournament_type 'SPIN' THEN
--     RAISE 'satellite % target % uses an unsupported bounty or Spin entry split'
--
-- That refusal is deliberate and correct: the path that delivered seats before
-- it booked the whole 67.50 buy-in as prize and seeded a 35.00 bounty head
-- with no money behind it (trg_seed_bounty_head), which is why the two
-- Sunday Funday High Roller PKOs of 2026-09-07 (3f19bd70, a21c0cb6) show bounty
-- pools of 2310.00 and 5425.00, bounty_in 0.00 and 0.00 paid.
--
-- Nothing refused the satellite at CREATION. The heads-up satellite feeder
-- (TournamentRecurringService.ensureSatelliteHeadsUps) picks the dearest open
-- events without reading a single bounty flag, so from 03:01 UTC on
-- 2026-09-11 it opened a heads-up satellite into both new Sunday Funday High
-- Roller PKOs (e9541c66, 8171f9f6) every time the last one filled. Every one
-- was played to a winner and then refused at the finish, and the engine
-- retried each of them every few seconds, taking the platform-wide settlement
-- lane and hand-settlement barrier each time.
--
-- This makes creation and settlement agree, at the one place every creation
-- path passes through (the engine feeder via fn_create_seat_first_game_atomic,
-- the club Create Tournament modal, auto satellite generation, schedules):
--
--   1. fn_satellite_target_is_deliverable(target) - the settlement authority's
--      own admission predicate, unknown flags included (NULL is refused there,
--      so it is refused here).
--   2. A satellite row may not be inserted, or re-pointed, at a target that
--      predicate refuses.
--   3. A tournament that live satellites feed may not take a bounty, PKO,
--      mystery-bounty or Spin contract (before its first entry the contract is
--      otherwise still editable).
--
-- Existing rows are untouched: the trigger fires only on INSERT, on a change
-- of target, or on a change of the target's own entry flags, so the in-flight
-- satellites of 2026-09-11 can still be settled or cancelled.
--
-- When the settlement authority learns to deliver a bounty seat (prize,
-- bounty and fee as three funded rails, the head seeded at exactly the bounty
-- slice), the predicate below and satelliteTargetIsDeliverable in the engine
-- change with it, in the same change.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).
-- CREATE TRIGGER takes SHARE ROW EXCLUSIVE on public.tournaments: apply it once,
-- outside the :50-:03 break window, with the short lock_timeout below.

BEGIN;
SET LOCAL lock_timeout = '3s';

CREATE OR REPLACE FUNCTION public.fn_satellite_target_is_deliverable(p_target_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  -- Mirrors the admission refusal in fn_settle_satellite_tournament_pre_money_path_gate
  -- exactly: every flag must be a known false, and neither Spin spelling.
  -- A missing target is not deliverable either (the authority refuses it).
  SELECT COALESCE((
    SELECT t.is_bounty IS FALSE
       AND t.is_pko IS FALSE
       AND t.is_mystery_bounty IS FALSE
       AND t.is_premium_spin IS FALSE
       AND lower(COALESCE(t.variant, '')) <> 'spin'
       AND upper(COALESCE(t.tournament_type, '')) <> 'SPIN'
      FROM public.tournaments t
     WHERE t.id = p_target_id
  ), false)
$function$;

CREATE OR REPLACE FUNCTION public.fn_satellite_feeds_only_a_deliverable_target()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_target uuid := COALESCE(NEW.satellite_target_id, NEW.satellite_target);
  v_old_target uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    v_old_target := COALESCE(OLD.satellite_target_id, OLD.satellite_target);
  END IF;

  -- A satellite may only be opened into, or re-pointed at, a target whose
  -- seat the settlement authority can deliver.
  IF v_target IS NOT NULL
     AND (TG_OP = 'INSERT' OR v_target IS DISTINCT FROM v_old_target)
     AND NOT public.fn_satellite_target_is_deliverable(v_target) THEN
    RAISE EXCEPTION
      'satellite % cannot feed target %: the satellite settlement authority refuses a bounty, PKO, mystery-bounty or Spin entry split',
      NEW.id, v_target
      USING ERRCODE = '22023',
            HINT = 'Pick a target whose entry is a plain buy-in plus fee.';
  END IF;

  -- A tournament live satellites feed may not become one that refuses them.
  IF TG_OP = 'UPDATE'
     AND (NEW.is_bounty, NEW.is_pko, NEW.is_mystery_bounty, NEW.is_premium_spin,
          NEW.variant, NEW.tournament_type)
         IS DISTINCT FROM
         (OLD.is_bounty, OLD.is_pko, OLD.is_mystery_bounty, OLD.is_premium_spin,
          OLD.variant, OLD.tournament_type)
     AND NOT (NEW.is_bounty IS FALSE AND NEW.is_pko IS FALSE
              AND NEW.is_mystery_bounty IS FALSE AND NEW.is_premium_spin IS FALSE
              AND lower(COALESCE(NEW.variant, '')) <> 'spin'
              AND upper(COALESCE(NEW.tournament_type, '')) <> 'SPIN')
     AND EXISTS (
       SELECT 1 FROM public.tournaments s
        WHERE COALESCE(s.satellite_target_id, s.satellite_target) = NEW.id
          AND s.id <> NEW.id
          AND upper(COALESCE(s.status, '')) NOT IN ('COMPLETED', 'CANCELLED', 'CANCELED')
     ) THEN
    RAISE EXCEPTION
      'tournament % is fed by a live satellite and cannot take a bounty, PKO, mystery-bounty or Spin entry split',
      NEW.id
      USING ERRCODE = '22023';
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_satellite_target_is_deliverable(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_satellite_target_is_deliverable(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.fn_satellite_feeds_only_a_deliverable_target() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS satellite_feeds_only_a_deliverable_target ON public.tournaments;
CREATE TRIGGER satellite_feeds_only_a_deliverable_target
  BEFORE INSERT OR UPDATE OF satellite_target_id, satellite_target,
    is_bounty, is_pko, is_mystery_bounty, is_premium_spin, variant, tournament_type
  ON public.tournaments
  FOR EACH ROW EXECUTE FUNCTION public.fn_satellite_feeds_only_a_deliverable_target();

-- Postflight: the predicate agrees with the authority on the two live PKO
-- targets and on an ordinary target, and the trigger is installed enabled.
DO $postflight$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
     WHERE t.tgrelid = 'public.tournaments'::regclass
       AND t.tgname = 'satellite_feeds_only_a_deliverable_target'
       AND t.tgenabled = 'O' AND NOT t.tgisinternal
       AND t.tgfoid = 'public.fn_satellite_feeds_only_a_deliverable_target()'::regprocedure
  ) THEN
    RAISE EXCEPTION 'satellite target guard trigger is not installed enabled';
  END IF;
  IF public.fn_satellite_target_is_deliverable('8171f9f6-1243-4d51-ac4b-9acabce110dc')
     OR public.fn_satellite_target_is_deliverable('e9541c66-1238-438f-bc7e-c01e45a45f81')
     OR public.fn_satellite_target_is_deliverable(NULL) THEN
    RAISE EXCEPTION 'the PKO targets must not be deliverable satellite targets';
  END IF;
END
$postflight$;

COMMIT;
