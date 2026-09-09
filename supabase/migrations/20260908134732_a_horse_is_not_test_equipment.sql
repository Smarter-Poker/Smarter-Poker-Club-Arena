-- 20260908134732_a_horse_is_not_test_equipment.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--

-- 468 HORSES WERE BEING TREATED AS TEST EQUIPMENT, BECAUSE OF THEIR EMAIL ADDRESS.
-- (CLAUDE.md 10.5 and 10.8; Dan 2026-09-08: horses "NEED TO BE INCLUDED AND AWARDED DIAMONDS JUST
--  LIKE ANY OTHER USER WOULD BE"; docs/changelog/2026-09-08-a-horse-is-not-test-equipment.md)
--
-- Found by an assertion refusing to pass: a horse picked at random was not eligible for the daily
-- bonus, in a function whose own comment says "Horses are players (Diamond Accounting Standard
-- D22)."
--
-- `fn_ca_is_cert_account` decides who is certification equipment rather than a player. It matches:
--
--     u.email LIKE '%@horses.smarter.poker'      <- the horse fleet's own domain
--     p_user_id::text LIKE '00000000-0000-0000-0000-%'
--     an active row in ca_cert_accounts          <- the deliberate register
--
-- The first two catch horses by accident. Measured on production:
--
--     416 horses matched ONLY by their email domain
--      52 horses matched by their uuid shape
--       0 horses in ca_cert_accounts, the register that is actually meant to hold cert accounts
--       0 non-horses on the horses domain, so the domain is nothing but horses
--
-- 468 of 1,000 horses - holding 1,324,300 diamonds, 40 percent of everything the fleet owns - were
-- classified as test equipment by nothing more than the shape of their address.
--
-- ELEVEN FUNCTIONS CONSULT IT, and every one of them was treating those horses as not-players:
--
--   fn_ca_daily_bonus_eligibility  refused them the daily bonus outright
--   fn_wheel_spin, fn_diamond_game_admit   refused them the wheel and the games
--   fn_ca_duel_pairing_scan        left them out of duels
--   fn_ca_collusion_scan           LEFT THEM OUT OF THE INTEGRITY SCAN - an unwatched 47 percent
--                                  of the fleet, which is the same defect CLAUDE.md 10.8 records
--                                  being found and ruled on once already, arriving by a new route
--   fn_ca_diamond_snapshot, fn_ca_supply_snapshot, fn_ca_weekly_revenue_digest
--                                  reported their 1,324,300 diamonds as certification-harness
--                                  money rather than as money players hold
--
-- THE FIX IS THE ONE ALREADY MADE TO ITS SIBLING. `fn_ca_is_fixture_account` had the identical
-- defect this morning, matched the identical 468 horses, and was corrected by asking the profile
-- whether it is a horse. This is that correction, applied to the function that was missed - and
-- the reason it was missed is worth stating: two predicates meant the same thing and only one of
-- them was fixed, which is what having two of anything costs.
--
-- A HORSE IS A PLAYER. Certification equipment is whatever `ca_cert_accounts` says it is - a
-- deliberate register, which correctly holds no horses at all. Membership of the fleet is never
-- again inferred from an address or a uuid.
--
-- NOTHING IS TAKEN FROM ANYBODY. No balance moves. What changes is which side of the books those
-- diamonds are reported on, and whether 468 players may collect what they have earned.
--
-- One transaction.

BEGIN;

SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '5min';

CREATE OR REPLACE FUNCTION public.fn_ca_is_cert_account(p_user_id uuid)
RETURNS boolean
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $$
  -- A HORSE IS A PLAYER (CLAUDE.md 10.5), so it is never certification equipment, whatever its
  -- address looks like. This is the same correction made to fn_ca_is_fixture_account on
  -- 2026-09-08; that one was fixed and this one was not, and the two disagreed for a day.
  SELECT p_user_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = p_user_id AND COALESCE(p.is_horse, false))
    AND (
      -- The deliberate register comes first because it is the only one that means anything on
      -- purpose. The two shape tests below are inherited and stay for accounts that predate it.
      EXISTS (SELECT 1 FROM public.ca_cert_accounts c WHERE c.user_id = p_user_id AND c.active)
      OR p_user_id::text LIKE '00000000-0000-0000-0000-%'
      OR EXISTS (SELECT 1 FROM auth.users u
                  WHERE u.id = p_user_id
                    AND (u.email LIKE '%@horses.smarter.poker'
                         OR u.email LIKE '%.invalid'))
    );
$$;

COMMENT ON FUNCTION public.fn_ca_is_cert_account(uuid) IS
  'True for a certification account. NEVER true for a horse: a horse is a player (CLAUDE.md 10.5) and the fleet shares an email domain, which used to classify 468 of them as test equipment - refusing them the daily bonus, the wheel and the games, leaving them out of the collusion scan, and reporting 1,324,300 of their diamonds as harness money. Cert accounts are what ca_cert_accounts says they are.';

-- ---------------------------------------------------------------------------
-- Assertions.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_horses integer; v_flagged integer; v_elig integer; v_cert integer; v_unexplained numeric;
        v_before numeric; v_after numeric;
BEGIN
  SELECT count(*), count(*) FILTER (WHERE public.fn_ca_is_cert_account(id))
    INTO v_horses, v_flagged FROM public.profiles WHERE is_horse;
  IF v_flagged <> 0 THEN
    RAISE EXCEPTION '% of % horses are still classified as certification equipment', v_flagged, v_horses;
  END IF;

  -- every horse can now be paid its daily bonus, which is what started this
  SELECT count(*) INTO v_elig FROM public.profiles
   WHERE is_horse AND public.fn_ca_daily_bonus_eligibility(id) = 'ok';
  IF v_elig <> v_horses THEN
    RAISE EXCEPTION 'only % of % horses are eligible for the daily bonus', v_elig, v_horses;
  END IF;

  -- AND THE REGISTER STILL WORKS FOR WHAT IT IS FOR. Widening this would be worse than the bug:
  -- a real certification account must still read as one.
  SELECT count(*) INTO v_cert FROM public.ca_cert_accounts c WHERE c.active;
  IF v_cert > 0 AND NOT EXISTS (
       SELECT 1 FROM public.ca_cert_accounts c
        WHERE c.active AND public.fn_ca_is_cert_account(c.user_id)) THEN
    RAISE EXCEPTION 'no active certification account reads as one any more';
  END IF;
  IF public.fn_ca_is_cert_account('00000000-0000-0000-0000-000000000abc') IS NOT TRUE THEN
    RAISE EXCEPTION 'the structured-uuid harness no longer reads as certification equipment';
  END IF;
  IF public.fn_ca_is_cert_account(NULL) IS NOT FALSE THEN
    RAISE EXCEPTION 'a null caller reads as certification equipment';
  END IF;

  -- the two predicates that mean the same thing now agree, which is why this was missed
  IF EXISTS (SELECT 1 FROM public.profiles p WHERE p.is_horse
              AND (public.fn_ca_is_cert_account(p.id) OR public.fn_ca_is_fixture_account(p.id))) THEN
    RAISE EXCEPTION 'the two harness predicates still disagree about horses';
  END IF;

  -- THE DEPLOY GATE MUST NOT TRIP ON THIS. 1,324,300 diamonds move from the harness column to the
  -- player column in the reporting, and a gate that reads that as money appearing from nowhere
  -- would be switched off by the next person to see it.
  SELECT public.fn_ca_diamond_snapshot() INTO v_unexplained;
  IF v_unexplained IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'the deploy gate reports % unexplained after a reclassification that moved no money', v_unexplained;
  END IF;

  IF (SELECT public.fn_ca_mint_supply('diamonds'))
     <> (SELECT COALESCE(sum(diamonds), 0) FROM public.profiles) + public.fn_ca_diamond_offledger_float() THEN
    RAISE EXCEPTION 'players + float <> register after a change that moves no money';
  END IF;

  RAISE NOTICE 'all % horses are players again; % active certification account(s) unaffected', v_horses, v_cert;
END $$;

COMMIT;
