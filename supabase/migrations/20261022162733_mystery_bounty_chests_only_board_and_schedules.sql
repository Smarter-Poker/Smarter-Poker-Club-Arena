-- 20261022162733_mystery_bounty_chests_only_board_and_schedules.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Dan, 2026-10-22, verbatim:
--   "1, DON'T PAY ANY BOUNTIES UNTIL PLAYERS ARE 'IN THE MONEY' ALL BOUNTIES
--    ARE MYSTERY BOUNTY PRIZES ONLY. 2, CHANGE IT TO THE 50/50 HALF PAYOUT,
--    HALF BOUNTY POOL."
-- and, agreed the same morning: every knockout in the money is offered 3
-- sealed chests, picks one, wins what is inside it, and is then shown the two
-- it did not pick; those two are real prizes and go back into the pool, and
-- the next knockout's three are a fresh random draw.
--
-- READ FROM PRODUCTION FIRST (2026-10-22 16:00 UTC). Every mystery event was
-- 50/50 between a "regular" half that paid a flat head on every knockout
-- before the money and a "mystery" half sealed into chests at the money, with
-- a bounty of about 40% of the entry. The 14 mystery events still taking
-- registrations all already hold registrations (horses), so their entry
-- split stays exactly what those players paid; everything else below applies
-- to them.
--
-- 1. THE TERMS LIVE ON THE ROW (trigger a4_mystery_mtt_terms). A paid,
--    pre-start mystery MTT seals 100% of its bounty pool into chests (no
--    regular half), opens them at the money, and describes itself truthfully.
--    A NEW event also splits its entry 50/50: bounty_amount is half of the
--    entry contribution (a whole Diamond at the Diamond Arena), and the
--    advertised mystery range scales with it. Whatever door creates the event
--    (engine spawner, Diamond door, fn_create_tournament), the row is the same.
--
-- 2. NO BOUNTY BEFORE THE MONEY. fn_claim_bounty_legacy_candidate_20260907
--    records a pre-activation bust of a chests-only event as placed with NO
--    bounty obligation (its existing "a place is not a bounty" path), so
--    nothing is paid and the head stays in the pool for the chests. That is
--    the rule, not a fault, so it writes no warning alert. Events that started
--    under the old 50/50 regular/mystery terms keep them to the end.
--    fn_mystery_bounty_unrecorded_head_cents returns 0 for a chests-only
--    event for the same reason: no head is owed out of a regular half.
--
-- 3. PICK 1 OF 3. Every new award gets an offer row holding two companion
--    chests drawn at random (gen_random_uuid, a strong random source) from the
--    chests still available. They stay available: nothing reserves them, so
--    they remain in the pool and the next knockout's offer is its own fresh
--    random draw. fn_mystery_bounty_pick records the slot the designated
--    revealer chose; fn_mystery_bounty_offer shows the three prizes only once
--    the award is revealed (assigning a random slot if nobody picked). The
--    award's own chest is the prize in the slot the player picked: the chest
--    order was shuffled with a CSPRNG when the inventory was sealed, so the
--    player's prize is a uniformly random chest whichever slot is chosen -
--    exactly the odds of three random hidden chests - and every amount shown
--    is a real chest of this event. No money function changes.
--
-- 4. fn_mystery_bounty_inventory also reports regular_pool_percent, so the
--    lobby can say "no bounties before the money" only where that is true.
--
--
-- Part 3 of 3 (the events already on the board, and the schedules).
-- @live-proof: (SELECT count(*) = 0 FROM public.tournaments t WHERE COALESCE(t.is_mystery_bounty,false) AND NOT COALESCE(t.is_pko,false) AND upper(COALESCE(t.status,'')) IN ('REGISTERING','ANNOUNCED') AND COALESCE(t.mystery_bounty_stage,'pending') = 'pending' AND COALESCE(t.buy_in_amount,0) + COALESCE(t.buy_in_fee,0) > 0 AND (t.mystery_bounty_pool_percent IS DISTINCT FROM 100 OR t.mystery_bounty_regular_pool_percent IS DISTINCT FROM 0))

BEGIN;

SET LOCAL lock_timeout = '5s';

-- Part 3 of 3: the events already on the board, and the schedules.

SELECT set_config('app.mystery_terms_rule', 'on', true);

UPDATE public.tournaments t
   SET mystery_bounty_pool_percent = 100
 WHERE COALESCE(t.is_mystery_bounty, false)
   AND NOT COALESCE(t.is_pko, false)
   AND upper(COALESCE(t.tournament_type, 'MTT')) = 'MTT'
   AND lower(COALESCE(t.variant, '')) <> 'satellite'
   AND t.satellite_target_id IS NULL
   AND upper(COALESCE(t.status, '')) IN ('REGISTERING', 'ANNOUNCED')
   AND COALESCE(t.mystery_bounty_stage, 'pending') = 'pending'
   AND COALESCE(t.buy_in_amount, 0) + COALESCE(t.buy_in_fee, 0) > 0;

-- The schedules describe what their events will be.
UPDATE public.tournament_schedules s
   SET config = s.config || jsonb_build_object('shortDescription',
         '50% Of Each Entry Funds The Prize Pool And 50% Funds The Mystery Bounty Pool. '
         || 'No Bounties Are Paid Before The Money. Once The Tournament Reaches The Money, '
         || 'Every Knockout Picks 1 Of 3 Mystery Chests.'),
       updated_at = now()
 WHERE s.config->>'type' = 'mystery_bounty'
   AND s.config ? 'shortDescription';

DO $assert$
DECLARE
  v_left integer;
BEGIN
  SELECT count(*) INTO v_left
    FROM public.tournaments t
   WHERE COALESCE(t.is_mystery_bounty, false)
     AND NOT COALESCE(t.is_pko, false)
     AND upper(COALESCE(t.tournament_type, 'MTT')) = 'MTT'
     AND lower(COALESCE(t.variant, '')) <> 'satellite'
     AND t.satellite_target_id IS NULL
     AND upper(COALESCE(t.status, '')) IN ('REGISTERING', 'ANNOUNCED')
     AND COALESCE(t.mystery_bounty_stage, 'pending') = 'pending'
     AND COALESCE(t.buy_in_amount, 0) + COALESCE(t.buy_in_fee, 0) > 0
     AND (t.mystery_bounty_pool_percent IS DISTINCT FROM 100
          OR t.mystery_bounty_regular_pool_percent IS DISTINCT FROM 0
          OR t.short_description NOT LIKE '%No Bounties Are Paid Before The Money%');
  IF v_left <> 0 THEN
    RAISE EXCEPTION 'mystery events still on the old terms after the rule: %', v_left;
  END IF;
END
$assert$;

COMMIT;
