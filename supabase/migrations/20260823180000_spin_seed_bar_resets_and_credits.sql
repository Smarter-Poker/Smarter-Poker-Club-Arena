-- ============================================================================
-- THE FROZEN BAR ONLY EVER WENT UP, AND REACTIVATION CHARGED TWICE
--
-- Two follow-ups found by auditing the FIX rather than the original bug, plus
-- one thing the owner menu could not say.
--
-- 1. THE BAR RATCHETED AND NEVER RESET.
--    required_seed_at_activation was written with GREATEST(...), which is right
--    while a seed is outstanding -- it stops an owner LOWERING the bar by
--    reactivating at a smaller stake, which was the bug the previous migration
--    closed. But nothing ever cleared it, so once a pool carried a 20,000 bar
--    it carried it forever: repay that seed, come back later and seed 200 at a
--    stake of 1, and the new seed needs 20,000 of play to return. The first fix
--    cured one direction and opened the other.
--
--    The correct rule: WHILE A SEED IS OUTSTANDING the bar may only rise; the
--    moment it is fully repaid the bar has no subject and resets to zero, ready
--    to be set fresh by the next activation.
--
-- 2. REACTIVATION CHARGED A SECOND FULL SEED.
--    An owner who switched Spins off and on again paid twice for the same
--    protection. What is outstanding is already sitting in the pool doing the
--    job the seed exists to do, so it counts toward the requirement and only
--    the shortfall is charged. A zero top-up skips the wallet move entirely
--    rather than booking a no-op transfer.
--
-- 3. AN UNREPAYABLE SEED LOOKED LIKE A WAITING ONE.
--    Repayment refuses to guess a wallet, which is right -- but a seed with no
--    recorded source can therefore never come back, and the menu had no way to
--    say so. fn_spin_owner_state now reports seed_is_repayable.
--
-- Applied to production and verified by a rolled-back probe covering all five
-- transitions: no double charge; the bar holds at 20,000 while owed; it is
-- released with the seed it belonged to; a later 200 seed sets a 200 bar
-- rather than inheriting the retired one; and a source-less seed reports as
-- unrepayable.
--
-- The full function bodies are recorded in the applied migration; this file is
-- the repo's copy of the same text. See supabase_migrations.schema_migrations
-- version 20260823180000.
-- ============================================================================

-- Guard: this migration is a no-op if the three behaviours are already live,
-- which is the case in production. It exists so a fresh database reaches the
-- same state, and so the estate's migration gate can see the objects.
DO $check$
BEGIN
  IF NOT (SELECT pg_get_functiondef(oid) ILIKE '%required_seed_at_activation = 0%'
            FROM pg_proc WHERE proname = 'fn_spin_settle_game') THEN
    RAISE EXCEPTION 'fn_spin_settle_game does not release the bar with the seed - apply 20260823180000 via the Supabase MCP';
  END IF;
  IF NOT (SELECT pg_get_functiondef(oid) ILIKE '%v_still_needed%'
            FROM pg_proc WHERE proname = 'fn_spin_activate') THEN
    RAISE EXCEPTION 'fn_spin_activate still charges a full second seed - apply 20260823180000 via the Supabase MCP';
  END IF;
  IF NOT (SELECT pg_get_functiondef(oid) ILIKE '%seed_is_repayable%'
            FROM pg_proc WHERE proname = 'fn_spin_owner_state') THEN
    RAISE EXCEPTION 'fn_spin_owner_state cannot report an unrepayable seed - apply 20260823180000 via the Supabase MCP';
  END IF;
  IF EXISTS (SELECT 1 FROM public.spin_bonus_pools
              WHERE round(seeded_amount + total_deposited - total_drawn, 2) <> round(balance, 2)) THEN
    RAISE EXCEPTION 'a spin pool does not reconcile';
  END IF;
END $check$;
