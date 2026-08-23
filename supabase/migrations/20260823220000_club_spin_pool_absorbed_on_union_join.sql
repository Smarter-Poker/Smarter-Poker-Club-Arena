-- ============================================================================
-- WHEN A CLUB JOINS A UNION, ITS SPINS WALLET MUST DISAPPEAR
--
-- Dan, 2026-08-23: "IF A CLUB JOINS A UNION, THAT WALLET MUST DISAPPEAR."
--
-- THE SILENT FAULT THIS CLOSES.
--
-- fn_spin_reserve_owner resolves COALESCE(clubs.union_id, club_id). The instant
-- clubs.union_id is written, every lookup for that club starts resolving to the
-- UNION -- and the club's own spin_bonus_pools row, keyed on its club id,
-- becomes unreachable through every code path in the platform. Not deleted,
-- not flagged, just orphaned, with:
--
--   * its BALANCE stranded: real chips players contributed, backing nothing
--     and payable to nobody;
--   * its outstanding SEED never repayable, because the repayment plan is only
--     reachable through the owner lookup that now points elsewhere;
--   * is_active still true, so it still reads as a live board.
--
-- Neither join path (union-application.js approve, manage-union.js add_club)
-- knew the Spin pool existed. This is a TRIGGER rather than a patch to both,
-- because a third join path added later would reintroduce the leak, and
-- because the money must move in the SAME TRANSACTION as the join -- a club
-- half-joined with its float in limbo is the worst of both states.
--
-- WHERE THE MONEY GOES, AND WHY
--   THE SEED goes back to the CLUB. It is the club's own capital, lent to its
--   own pool; joining a union is not a reason to forfeit it.
--   THE REST goes to the UNION's pool. That is not the club's money -- it is
--   accumulated player contributions, the float multipliers are paid from. The
--   union now runs Spins for these players, so the float follows them. It
--   arrives as a 'merge', a ledger kind that had existed unused since the pool
--   was first built.
--
-- ONE GUESS, MADE DELIBERATELY. If the seed has no recorded source wallet the
-- repayment plan normally refuses to move it, because guessing which ENTITY
-- owns money is not a machine's job. Here the entity is not in doubt -- it is
-- this club -- only which of its own wallets. Sending it to chip_treasury and
-- saying so in the ledger beats letting it dissolve into a union that never
-- paid for it.
--
-- Applied via the Supabase MCP, including a backfill for any club that had
-- already joined while holding a pool. Verified by a rolled-back probe: seed
-- home, float to the union, club wallet emptied and switched off, owner lookup
-- moved, and the platform total conserved to the chip.
-- ============================================================================

DO $check$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname='public' AND p.proname='fn_spin_absorb_club_pool_into_union') THEN
    RAISE EXCEPTION 'fn_spin_absorb_club_pool_into_union is missing - apply 20260823220000 via the Supabase MCP';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgname='trg_spin_pool_follows_union_membership' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'the union-join trigger is missing - a club could join a union and strand its Spins wallet';
  END IF;

  -- No club inside a union may still hold a live Spins wallet.
  IF EXISTS (
    SELECT 1 FROM public.spin_bonus_pools sbp JOIN public.clubs cl ON cl.id = sbp.club_id
     WHERE cl.union_id IS NOT NULL AND cl.union_id <> sbp.club_id
       AND (sbp.balance <> 0 OR sbp.seeded_amount <> 0 OR sbp.is_active)) THEN
    RAISE EXCEPTION 'a club inside a union still holds a Spins wallet';
  END IF;

  IF EXISTS (SELECT 1 FROM public.spin_bonus_pools
              WHERE round(seeded_amount + total_deposited - total_drawn, 2) <> round(balance, 2)) THEN
    RAISE EXCEPTION 'a spin pool does not reconcile';
  END IF;
END $check$;
