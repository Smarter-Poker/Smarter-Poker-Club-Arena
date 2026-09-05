-- 20260905171024_the_spin_ladder_charges_the_eight_percent_it_books.sql
--
-- Dan, 2026-09-05, handing this back: the SPIN_TIERS rebalance is mine to make.
--
-- THE PRODUCT CHARGED 7.874% WHILE BOOKING 8.00%.
--
-- SPIN_RAKE_RATE is 0.08, fn_spin_settle_game deducts 8%, and every report says
-- 8%. But the ladder is what a player is actually charged, and it expected
-- 2.763772x against the 2.76x that three seats at 8% imply. The 0.126 of a
-- percentage point was paid out to players in prizes and taken from the club
-- reserve, which is why spin_bonus_pools kept drifting away from its seed.
--
-- WHY NOTHING CAUGHT IT. Two guards measured it and both rounded it away:
--   - assertSpinRakeInvariant compares round2(expected) with round2(implied),
--     and 2.7638 and 2.7600 both round to 2.76;
--   - the 20260831 seed migration accepted any edge within 0.005 of 0.08,
--     which is 0.5 of a percentage point - four times the drift.
-- A guard that rounds away the quantity it exists to measure is not a guard.
-- Both are tightened here and in spinSpec.ts (exact, 1e-9 for double noise).
--
-- THE FIX, SOLVED AS AN EQUALITY RATHER THAN FITTED.
--
-- Hold every tier from 4x up at its exact frequency, then there is exactly one
-- integer solution for the bottom two rungs:
--
--     f2 + f3       =  8,740,492      (total 10,000,000 less the fixed 1,259,508)
--     2*f2 + 3*f3   = 21,411,700      (mass 27,600,000 less the fixed 6,188,300)
--   =>  f3 = 3,930,716,  f2 = 4,809,776
--
--     E[m] = 27,600,000 / 10,000,000 = 2.76 exactly
--     edge = (3 - 2.76) / 3          = 8.000000%
--
-- WHAT A PLAYER SEES. 2x moves 47.7203% -> 48.0978% and 3x 39.6848% ->
-- 39.3072%: 0.38 of a percentage point between the two bottom rungs. EVERY
-- tier a player celebrates - 4x, 5x, 10x, 25x, 50x, 100x - keeps its frequency
-- to the unit, and because the denominator is now exactly 10,000,000 their
-- probabilities read cleaner than before (9.000000% rather than 8.999911%).
-- Expected return goes from 92.126% to 92.000%.
--
-- The 500x retirement's own arithmetic is untouched: 100x still holds all
-- 1,008 units it was given, and this migration does not move any mass into or
-- out of the upper ladder.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

-- Seeded, not appended: this statement is the whole ladder, so it cannot leave
-- a retired tier behind as a live row.
DELETE FROM public.spin_tier_spec
 WHERE multiplier NOT IN (2, 3, 4, 5, 10, 25, 50, 100);

INSERT INTO public.spin_tier_spec (multiplier, freq, reserve_threshold_x) VALUES
  (2,   4809776, 0),
  (3,   3930716, 0),
  (4,    900000, 0),
  (5,    250000, 0),
  (10,   100000, 0),
  (25,     7500, 0),
  (50,     1000, 0),
  (100,    1008, 1.5)
ON CONFLICT (multiplier) DO UPDATE
  SET freq = EXCLUDED.freq,
      reserve_threshold_x = EXCLUDED.reserve_threshold_x;

COMMENT ON TABLE public.spin_tier_spec IS
  'The published Spin multiplier ladder, mirrored from src/config/spinSpec.ts. '
  'Frequencies are per SPIN_FREQ_DENOMINATOR (10,000,000). Read-only reference '
  'data: fn_spin_fairness_check measures the live draw against it.';

-- The arithmetic that IS the product. Held to the unit, and the edge held
-- EXACTLY rather than to within half a percentage point - the old tolerance of
-- 0.005 is what let a 7.874% product pass as 8% for weeks.
DO $ladder$
DECLARE
  v_freq  bigint;
  v_units bigint;
  v_ev    numeric;
  v_edge  numeric;
BEGIN
  SELECT sum(freq), sum(multiplier::bigint * freq)
    INTO v_freq, v_units
    FROM public.spin_tier_spec;

  IF v_freq <> 10000000 THEN
    RAISE EXCEPTION 'spin_tier_spec total frequency is %, expected 10000000', v_freq;
  END IF;

  IF v_units <> 27600000 THEN
    RAISE EXCEPTION 'spin_tier_spec weighted units are %, expected 27600000 -- '
                    'moving mass between tiers must hold this total or the '
                    'house edge changes as a side effect', v_units;
  END IF;

  v_ev   := v_units::numeric / v_freq::numeric;
  v_edge := (3::numeric - v_ev) / 3::numeric;

  -- E[multiplier] = seats x (1 - rake_rate); at 3 seats this is an EQUALITY
  -- satisfied at 8% and at no other rate. numeric is exact here, so the
  -- comparison is exact: 27,600,000 / 10,000,000 is 2.76 and (3-2.76)/3 is
  -- 0.08 with no residue to tolerate.
  IF v_edge <> 0.08 THEN
    RAISE EXCEPTION 'spin_tier_spec implies a house edge of %, not the '
                    'booked 8%% (E[mult]=%)', v_edge, v_ev;
  END IF;

  RAISE NOTICE 'spin ladder: total %, units %, E[m] %, edge %', v_freq, v_units, v_ev, v_edge;
END
$ladder$;

COMMIT;
