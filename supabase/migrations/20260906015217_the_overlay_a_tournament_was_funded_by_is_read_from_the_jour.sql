-- THE OVERLAY A TOURNAMENT WAS FUNDED BY IS READ FROM THE JOURNAL.
--
-- 246 open warnings, every one of them saying a tournament "paid out money it
-- never collected", and every one of them wrong. The money was collected. The
-- check was reading the wrong book.
--
-- WHAT THE BOARD SAID. In the seven days to 2026-09-06 the conservation check
-- flagged 38 of 110 bounty events, 27 of 64 mystery bounty, 26 of 54
-- progressive bounty and 19 of 36 satellites - 15,148 chips of apparently
-- unfunded payout. Not one SNG (0 of 25,708) and almost no freezeout (8 of
-- 196). A defect that sorts that cleanly by format is not a defect in the
-- money; it is a term missing from the arithmetic.
--
-- WHAT ACTUALLY HAPPENED, read from the rows. Take Late Night PKO (PLO4),
-- cbea992a: 26 entries at 18.00 + 2.00, so 520.00 collected, 52.00 of rake,
-- 260.00 carved into the bounty pool and 208.00 left for the prize pool. Its
-- advertised guarantee is 450.00. At lock, fn_ca_fund_overlay_on_lock took the
-- 242.00 shortfall out of the union bank, wrote
--
--   union_bank -> prize_liability   242.00   category 'overlay'
--
-- into chip_ledger, and raised the pool to 450.00. The chips exist, they came
-- from a named bank, and the journal says so. The conservation delta came out
-- at -242.00 anyway, because its funded_overlay term reads
-- public.tournament_guarantee_overlays - a table that only the OTHER funding
-- path, fn_apply_prize_guarantee, ever writes.
--
-- Two funders, one book each, and the check only knew about one of them.
--
-- THE RULE. Under the Chip Accounting Standard chip_ledger is the record of
-- truth. A check that disagrees with the journal is the thing that is wrong.
-- So funded_overlay becomes GREATEST(journal, side table): the journal first,
-- the legacy table for the 227 older events that predate the leg, and never
-- the sum - measured across the whole history, 227 events carry only the table
-- row, 187 carry only the journal leg, and ZERO carry both, so nothing here can
-- double-count.
--
-- MEASURED, in a read that committed nothing. Over the 36 hours to 2026-09-06
-- 01:45 UTC there were 49 short events - 17 bounty, 12 progressive, 10 mystery,
-- 10 satellite, -7,146.00 chips between them. With the journal term in place
-- the residual is 0.00 in every one of the four families, 49 of 49 explained
-- to the cent.
--
-- NOTHING IS SILENCED. An overlay that was never funded still has no leg and no
-- row, so it still shows as short - which is what fn_ca_fund_overlay_on_lock's
-- own 'overlay_unfunded' critical is for. This teaches the check to read the
-- funding that DID happen; it does not teach it to forgive funding that did not.

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_tournament_conservation_delta(p_tournament_id uuid)
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH m AS (
    SELECT t.id, t.ended_at,
      COALESCE((SELECT sum(w.amount) FROM public.wallet_transactions w
         WHERE w.related_entity_id = t.id AND w.type = 'debit'
           AND w.category IN ('tournament_buyin','rebuy','addon')), 0) AS money_in,
      COALESCE((SELECT sum(w.amount) FROM public.wallet_transactions w
         WHERE w.related_entity_id = t.id AND w.type = 'credit'
           AND w.category = 'refund'), 0) AS refunds,
      COALESCE((SELECT sum(w.amount) FROM public.wallet_transactions w
         WHERE w.related_entity_id = t.id AND w.type = 'credit'
           AND w.category = 'prize'), 0) AS prizes,
      COALESCE((SELECT sum(w.amount) FROM public.wallet_transactions w
         WHERE w.related_entity_id = t.id AND w.type = 'credit'
           AND w.category = 'bounty'), 0) AS bounties,
      COALESCE((SELECT sum(r.rake_amount) FROM public.rake_records r
         WHERE r.tournament_id = t.id AND r.is_tournament), 0) AS rake,

      -- THE OVERLAY, FROM THE JOURNAL FIRST (2026-09-06). Two paths fund a
      -- guarantee and they keep different books: fn_apply_prize_guarantee
      -- writes a tournament_guarantee_overlays row, and the lock trigger
      -- fn_ca_fund_overlay_on_lock writes a chip_ledger leg
      -- (union_bank|club_treasury -> prize_liability, category 'overlay').
      -- The journal is the record of truth, so it is read first; the side
      -- table carries the 227 events older than the leg. GREATEST, never the
      -- sum: no event in the whole history has both, and if one ever does,
      -- they are two records of ONE funding, not two fundings.
      GREATEST(
        COALESCE((SELECT sum(l.amount) FROM public.chip_ledger l
           WHERE l.tournament_id = t.id
             AND l.category = 'overlay'
             AND l.to_type = 'prize_liability'), 0),
        COALESCE((SELECT o.amount FROM public.tournament_guarantee_overlays o
           WHERE o.tournament_id = t.id), 0)
      ) AS funded_overlay,

      -- ACKNOWLEDGED PRE-FUNDING MINTING. Replaces the 2026-08-27T12:00:00Z
      -- date literal that used to live here: same intent, but one auditable row
      -- per event carrying the exact amount instead of a comparison that
      -- silently forgave whatever fell the right side of it. An event with no
      -- baseline row is offset by nothing.
      COALESCE((SELECT b.amount FROM public.tournament_conservation_baseline b
         WHERE b.tournament_id = t.id), 0) AS acknowledged,

      -- A SEAT ARRIVING. The target's pool and rake were both credited by
      -- fn_award_satellite_seat with no wallet debit anywhere, so without this
      -- term the target is charged for a prize it was funded to pay. The seat
      -- names its target in metadata because the payout row belongs to the
      -- SATELLITE that paid it.
      COALESCE((SELECT sum(sp.amount) FROM public.tournament_payouts sp
         WHERE sp.source = 'satellite_seat'
           AND sp.metadata->>'satellite_target_id' = t.id::text), 0) AS seat_income,

      -- A SEAT LEAVING. The satellite really did pay this out; it simply paid
      -- it in a seat rather than in chips, so no 'prize' credit exists to find.
      COALESCE((SELECT sum(sp.amount) FROM public.tournament_payouts sp
         WHERE sp.source = 'satellite_seat'
           AND sp.tournament_id = t.id), 0) AS seat_paid_out
    FROM public.tournaments t WHERE t.id = p_tournament_id
  )
  SELECT round(
      m.money_in - m.refunds - m.rake - m.prizes - m.bounties
    + m.funded_overlay
    + m.acknowledged
    + m.seat_income
    - m.seat_paid_out
  , 2)
  FROM m;
$function$;

-- The three events named in the header must now come out flat. If any of them
-- does not, the board moved under this migration and it must not apply.
DO $assert$
DECLARE
  v_bad int;
  v_short int;
BEGIN
  SELECT count(*) INTO v_bad FROM (VALUES
      ('cbea992a-6452-4687-9abc-469dfc99aa78'::uuid),
      ('448ab768-8eb5-4020-a9a1-971340cc2ff5'::uuid),
      ('02bb200d-6a93-42ef-b893-71bec3661021'::uuid)
    ) AS v(id)
   WHERE abs(COALESCE(public.fn_tournament_conservation_delta(v.id), 999)) > 0.05;
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'conservation delta still short on % of the 3 named events', v_bad;
  END IF;

  -- And no bounty-family event that ended in the last 36 hours may still read
  -- short. 49 of them did before this change.
  SELECT count(*) INTO v_short
    FROM public.tournaments t
   WHERE t.status IN ('COMPLETED','CANCELLED')
     AND t.ended_at > now() - interval '36 hours'
     AND COALESCE(t.variant,'') IN ('bounty','progressive_bounty','mystery_bounty','satellite')
     AND COALESCE(t.buy_in_amount,0) + COALESCE(t.buy_in_fee,0) > 0
     AND COALESCE(public.fn_tournament_conservation_delta(t.id), 0) < -0.05;
  IF v_short > 0 THEN
    RAISE EXCEPTION 'still % short bounty-family events in the last 36 hours', v_short;
  END IF;
  RAISE NOTICE 'CONSERVATION_OVERLAY_READS_THE_JOURNAL: 3 named events flat, 0 short in 36h';
END $assert$;

COMMIT;
