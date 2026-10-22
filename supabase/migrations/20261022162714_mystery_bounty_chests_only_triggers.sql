-- 20261022162714_mystery_bounty_chests_only_triggers.sql
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
-- Part 2 of 3 (the two triggers). The first combined attempt at 16:05 UTC
-- timed out twice on DROP TRIGGER IF EXISTS, whose ACCESS EXCLUSIVE queues
-- behind every reader of tournaments; a new trigger needs no drop.
-- @live-proof: (SELECT count(*) = 2 FROM pg_trigger WHERE tgname IN ('a4_mystery_mtt_terms','zz_offer_mystery_award_companions') AND NOT tgisinternal)

BEGIN;

SET LOCAL lock_timeout = '3s';

-- Part 2 of 3: the two triggers. CREATE TRIGGER takes SHARE ROW EXCLUSIVE, which
-- readers never queue behind; no DROP TRIGGER, whose ACCESS EXCLUSIVE they would.

CREATE TRIGGER a4_mystery_mtt_terms
  BEFORE INSERT OR UPDATE OF is_mystery_bounty, mystery_bounty_pool_percent,
    mystery_bounty_regular_pool_percent, mystery_bounty_activation,
    mystery_bounty_activation_value
  ON public.tournaments
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_ca_mystery_mtt_terms();

INSERT INTO public.ca_declared_money_triggers(table_name, trigger_name, note)
VALUES ('tournaments', 'a4_mystery_mtt_terms',
  'Dan 2026-10-22: a paid pre-start mystery MTT seals 100% of its bounty pool into chests opened at the money, and a new one splits its entry 50/50; sets bounty_amount at creation, the mystery pool split, activation and description. Moves no money.')
ON CONFLICT DO NOTHING;

CREATE TRIGGER zz_offer_mystery_award_companions
  AFTER INSERT ON public.tournament_bounty_awards
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_ca_offer_mystery_award_companions();

COMMIT;
