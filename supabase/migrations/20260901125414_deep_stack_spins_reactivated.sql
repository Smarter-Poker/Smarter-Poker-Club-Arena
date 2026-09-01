-- =============================================================================
-- deep_stack_spins_reactivated
-- Applied to production via Supabase MCP 2026-09-01 12:54 UTC.
--
-- Dan, 2026-09-01: "ADD IN THE SPINS AND HEADS UP TABLES" (after cash + MTT
-- verified — done: 70 cash tables, 84 weekly events, both asserted).
--
-- Deep Stack's spin board ran before the teardown: activated 2026-08-31
-- 23:03 UTC with a 20,000 repayable seed from chip_treasury at max stake
-- 100 (spin_reserve_ledger rows 'seed'/'activation'), deactivated 01:19
-- with the seed returned. This re-activates with IDENTICAL parameters via
-- the canonical fn_spin_activate — the same RPC the club UI calls — which
-- debits the seed from the club treasury (2,499,199 at time of writing),
-- books it in spin_reserve_ledger as repayable, and flips the pool active.
-- The engine's per-owner spin board (activatedSpinOwners) then spawns Deep
-- Stack spin listings on its 30s tick.
--
-- Horses stay benched (all 416 disabled, latched), so the board lists games
-- nothing fills until Dan's green light; fn_spin_expire_unfilled handles the
-- interim as designed.
-- =============================================================================
DO $$
DECLARE v_res jsonb; v_pool record;
BEGIN
  SELECT * INTO v_pool FROM spin_bonus_pools
   WHERE club_id='2a1132b9-5ba2-42e6-9f01-30a7fcffebe3' FOR UPDATE;
  IF v_pool.is_active THEN
    RAISE EXCEPTION 'Deep Stack spin pool already active; refusing to double-activate';
  END IF;

  v_res := fn_spin_activate(
    '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3',
    20000,
    100,
    'chip_treasury',
    '47965354-0e56-43ef-931c-ddaab82af765'  -- club owner, as activator
  );

  IF COALESCE(v_res->>'ok','false') <> 'true' THEN
    RAISE EXCEPTION 'fn_spin_activate refused: %', v_res;
  END IF;

  SELECT * INTO v_pool FROM spin_bonus_pools
   WHERE club_id='2a1132b9-5ba2-42e6-9f01-30a7fcffebe3';
  IF NOT v_pool.is_active OR v_pool.balance < 20000 OR v_pool.activated_at IS NULL THEN
    RAISE EXCEPTION 'pool not active after activation: active=% balance=%',
      v_pool.is_active, v_pool.balance;
  END IF;
END $$;
