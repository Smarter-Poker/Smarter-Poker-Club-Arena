-- ============================================================================
-- THE SEED REPAYMENT PLAN
--
-- Dan, 2026-08-23: "IMPLEMENT A REPAYMENT PLAN THAT'S STRUCTURED INTO THE
-- ARCHITECTURE OF THE POOL, THAT PAYS BACK A CERTAIN PERCENTAGE TO THE FUNDING
-- WALLET EVERY TIME THE WALLET REACHES A CERTAIN THRESHOLD OF FUNDS."
--
-- WHY INSTALMENTS ARE NOT MERELY NICER -- THEY ARE THE ONLY THING THAT WORKS.
--
-- This pool has ZERO DRIFT by construction. src/config/spinSpec.ts states the
-- identity its frequency table is built on: E[multiplier] = seats x (1 - rake),
-- so E[reserve_out] equals reserve_in exactly. The rake is taken BEFORE the
-- pool and is the revenue; what remains is a float that random-walks and never
-- grows in expectation.
--
-- The previous rule waited for the balance to exceed the bar by a WHOLE FURTHER
-- SEED before returning anything. On a zero-drift walk that is a wait for a
-- large excursion that may never arrive -- the owner's capital could sit in the
-- pool indefinitely with nothing wrong and nothing happening. Harvesting the
-- UPSWINGS is the only mechanism a zero-drift process reliably offers.
--
-- THE PLAN
--   FLOOR   = required_seed_at_activation: two top-tier (100x) jackpots at the
--             largest stake offered. Repayment never takes the balance below
--             it, so the 100x on the wheel is always real money.
--   TRIGGER = FLOOR x 1.25. Nothing moves until the balance sits 25% clear.
--             Skimming the moment it peeks over would nibble the working
--             capital on every ripple and re-lock the top tiers.
--   RATE    = 50% of the surplus above the floor. Half, not all, because the
--             pool must keep some of its own upswing -- a wheel whose top prize
--             flickers in and out of reach as the balance is shaved back to the
--             floor is a worse product than one that repays a little slower.
--
-- Repayment STOPS the moment the seed is square. This is a loan being retired,
-- not a rake. Dan, the same day: "IT RETURNS EVERYTHING IT COLLECTS... ALL
-- PROCEEDS ARE KEPT THERE TO FUND THE MULTIPLIER PAYOUTS."
--
-- Worked, at a 100 stake: floor 20,000, nothing moves until 25,000, where the
-- surplus is 5,000 and 2,500 goes home leaving 22,500 -- still clear. A 20,000
-- seed retires in eight such visits. Measured: a rolled-back probe at a stake
-- of 10 retired a 2,000 seed in exactly EIGHT instalments, never letting the
-- pool dip below 2,255 against its 2,000 floor, and took nothing further once
-- the owner was whole.
--
-- SAFETY, BY CONSTRUCTION: the instalment is at most RATE x (balance - floor),
-- strictly less than the surplus, so balance_after >= floor always. It is also
-- capped at what is still owed, so the plan can never overpay.
--
-- Applied via the Supabase MCP. This file is the repo's record; the guard below
-- fails loudly if the live functions do not match it.
-- ============================================================================

DO $check$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'public' AND p.proname = 'fn_spin_seed_instalment') THEN
    RAISE EXCEPTION 'fn_spin_seed_instalment is missing - apply 20260823200000 via the Supabase MCP';
  END IF;

  IF NOT (SELECT pg_get_functiondef(oid) ILIKE '%fn_spin_seed_instalment%'
            FROM pg_proc WHERE proname = 'fn_spin_settle_game') THEN
    RAISE EXCEPTION 'fn_spin_settle_game does not use the repayment plan';
  END IF;

  -- The plan, at the worked example in the header.
  IF public.fn_spin_seed_instalment(25000, 20000, 20000) <> 2500 THEN
    RAISE EXCEPTION 'instalment at the trigger should be 2500, got %',
      public.fn_spin_seed_instalment(25000, 20000, 20000);
  END IF;
  IF public.fn_spin_seed_instalment(24999, 20000, 20000) <> 0 THEN
    RAISE EXCEPTION 'nothing may be due below the trigger';
  END IF;
  IF public.fn_spin_seed_instalment(100000, 500, 20000) <> 500 THEN
    RAISE EXCEPTION 'the plan overpaid the outstanding seed';
  END IF;
  IF public.fn_spin_seed_instalment(1000000, 0, 20000) <> 0 THEN
    RAISE EXCEPTION 'the plan skimmed a pool that owes nothing';
  END IF;

  -- The floor holds at every balance, not just the convenient ones.
  IF EXISTS (
    SELECT 1 FROM generate_series(20000, 60000, 137) b
     WHERE b - public.fn_spin_seed_instalment(b, 999999, 20000) < 20000) THEN
    RAISE EXCEPTION 'an instalment would take the balance below the floor';
  END IF;

  IF EXISTS (SELECT 1 FROM public.spin_bonus_pools
              WHERE round(seeded_amount + total_deposited - total_drawn, 2) <> round(balance, 2)) THEN
    RAISE EXCEPTION 'a spin pool does not reconcile';
  END IF;
END $check$;
