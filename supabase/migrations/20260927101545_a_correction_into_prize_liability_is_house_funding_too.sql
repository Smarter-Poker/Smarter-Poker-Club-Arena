-- A CORRECTION INTO PRIZE_LIABILITY IS HOUSE FUNDING TOO (2026-09-27)
--
-- THE DEFECT. fn_tournament_conservation_delta's funded_overlay term only
-- recognises a chip_ledger leg as house funding when category='overlay'. On
-- 2026-09-09, migration 20260909060341_bubble_protection_is_funded_by_the_house_not_the_winner
-- correctly paid two Sunday $200 Deep Stack winners (a449e853-4ee1-4e36-bd38-
-- 8fe904664d7c, f7412940-5644-4194-8d57-4a97c182bf04) the 180.00 the published
-- structure and bubble protection had double-promised, funded from the host
-- club treasury and the union rake wallet respectively into prize_liability -
-- exactly the shape an overlay funds a guarantee shortfall. That leg was
-- correctly tagged category='correction' (CLAUDE.md 10.9 backpay, not a
-- guarantee), but the conservation check's house-funding recognition never
-- looked for 'correction', so it has flagged both fully-settled events as
-- "Tournament paid out money it never collected" (delta -180.00 exactly, both
-- tournaments, to the cent) on every run of fn_tournament_money_conservation
-- since - 14 fresh financial_alerts rows in the last 24h alone (id 12925ad3,
-- 268aca2f, and their predecessors going back to the payout).
--
-- READ, NOT ASSUMED. Confirmed live: chip_ledger carries exactly one
-- category='correction', to_type='prize_liability' row per tournament -
-- 0b2c2ab0 (club_treasury -> a449e853, 180.00, idempotency key
-- ...:bubble_protection_backpay) and 6f24a8eb (union_bank -> f7412940, 180.00,
-- same key pattern). fn_settle_tournament_obligation's own guard already
-- proved each paid exactly 180.00 against the full entitlement named in the
-- 2026-09-09 migration's CLAUDE.md 10.9 paragraph. Every other 'correction'
-- row into prize_liability in the whole table (there is exactly one more,
-- 0ec5d7b2, from_type='settlement_suspense', an already-resolved 2026-09-07
-- spin escrow shortfall) is NOT from a house treasury bank, so this fix scopes
-- to from_type IN ('club_treasury','union_bank') rather than the bare
-- category, matching every existing 'overlay' row's from_type exactly (both
-- are club_treasury or union_bank, never anything else) and leaving the
-- settlement_suspense row's classification untouched either way.
--
-- THE FIX. Widen the funded_overlay term to also sum category='correction'
-- legs from a house treasury bank into this tournament's prize_liability.
-- This is a read-only STABLE function with no side effects; no chips move, no
-- migration payment, nothing to settle beyond marking the now-explained
-- financial_alerts rows resolved (done in the same transaction below, since
-- the evidence proving them a false positive is exactly this fix).
--
-- HARDENING: tests/a-correction-into-prize-liability-is-house-funding-too.law.test.ts
-- pins the fix (red on the pre-fix function body, green after) and
-- tests/the-two-conservation-checks-agree-on-a-seat.law.test.ts's sibling
-- suite is unaffected (no satellite/ticket terms changed).
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '20s';

DO $guard$
BEGIN
  IF md5(pg_get_functiondef('public.fn_tournament_conservation_delta(uuid)'::regprocedure))
      IS DISTINCT FROM '0d3b61282e592f3f938e77dcb1bf4a98' THEN
    RAISE EXCEPTION 'fn_tournament_conservation_delta changed since this migration was written; re-review required';
  END IF;
END;
$guard$;

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
      --
      -- A CLAUDE.md 10.9 CORRECTION FROM A HOUSE BANK IS THE SAME PROMISE,
      -- KEPT LATE (2026-09-27). fn_settle_tournament_obligation's own backpay
      -- legs land here tagged category='correction' rather than 'overlay' -
      -- correctly, since they are not a guarantee - but they are the identical
      -- club_treasury|union_bank -> prize_liability shape and must be read the
      -- same way, or the very act of honouring the promise makes this check
      -- flag the tournament forever. Scoped to the two house treasury banks,
      -- not the bare category, so an unrelated correction from any other
      -- source (e.g. a suspense account) is not silently read as funding.
      GREATEST(
        COALESCE((SELECT sum(l.amount) FROM public.chip_ledger l
           WHERE l.tournament_id = t.id
             AND l.category IN ('overlay','correction')
             AND l.from_type IN ('club_treasury','union_bank')
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
      --
      -- A TICKET ARRIVES WHEN IT IS REDEEMED, NOT WHEN IT IS ISSUED
      -- (2026-09-12). The holder of an unredeemed ticket has not entered this
      -- event and owes it nothing; crediting the target on issue invents an
      -- entry. Measured: gating this side the same way as the paid side below
      -- put "Wednesday Feature" at +40.00 and "DSS Wednesday $22 NLH
      -- Deepstack" at +20.00, both of which are correctly 0.00.
      COALESCE((SELECT sum(sp.amount)
         FROM public.tournament_payouts sp
         LEFT JOIN public.tournament_satellite_awards a
                ON a.tournament_id = sp.tournament_id AND a.place = sp.position
         LEFT JOIN public.tournament_tickets k ON k.id = a.ticket_id
        WHERE sp.source IN ('satellite_seat','satellite_ticket')
          AND sp.metadata->>'satellite_target_id' = t.id::text
          -- no award row = the legacy direct-seat path, which always arrived
          AND COALESCE(a.delivery_kind, 'seat') IN ('seat','ticket')
          -- no ticket row = never a ticket; a ticket must be redeemed
          AND (k.id IS NULL OR k.status = 'redeemed')), 0) AS seat_income,

      -- A SEAT LEAVING. The satellite really did pay this out; it simply paid
      -- it in a seat rather than in chips, so no 'prize' credit exists to find.
      --
      -- A TICKET IS THAT SAME SEAT, HELD RATHER THAN TAKEN (2026-09-12), so it
      -- leaves on ISSUE. A cancelled ticket does not leave at all - its value
      -- comes back as cash and the 'prize' credit above already counts it - and
      -- a cash delivery was never a seat in the first place.
      --
      -- ... AND A CASH DELIVERY WITH NO TICKET ROW IS STILL A CASH DELIVERY
      -- (2026-09-25). The cancelled-ticket case above is one way a ticket turns
      -- into cash. The other leaves NO tournament_satellite_awards row and NO
      -- tournament_tickets row at all: fn_settle_satellite_tournament pays the
      -- place through fn_credit_and_log with the wallet reason "Satellite ticket
      -- paid in cash because target admission was definitively unavailable",
      -- and the payout row keeps source='satellite_ticket' with a NULL position.
      -- Both COALESCE defaults above then read it as the legacy direct-seat
      -- path, and the 'prize' credit counts it a second time.
      --
      -- Measured: 40 satellites, 2,320.00, every delta explained to the penny
      -- as wallet_prizes + seat_paid_out - payout_total. Over the whole 71,785
      -- event scan the extra condition touches 41 events, fixes 41, and breaks
      -- none. Keying this on recorded_by='credit_and_log' instead - the obvious
      -- first guess - would have broken 245 healthy events to fix the same 41,
      -- because for those the cancelled-ticket gate had already excluded the row
      -- and this would have subtracted it twice.
      COALESCE((SELECT sum(sp.amount)
         FROM public.tournament_payouts sp
         LEFT JOIN public.tournament_satellite_awards a
                ON a.tournament_id = sp.tournament_id AND a.place = sp.position
         LEFT JOIN public.tournament_tickets k ON k.id = a.ticket_id
        WHERE sp.source IN ('satellite_seat','satellite_ticket')
          AND sp.tournament_id = t.id
          AND COALESCE(a.delivery_kind, 'seat') IN ('seat','ticket')
          AND COALESCE(k.status, 'issued') IN ('issued','redeemed')
          AND NOT (
            k.id IS NULL
            AND EXISTS (SELECT 1 FROM public.wallet_transactions w
                         WHERE w.related_entity_id = t.id
                           AND w.type = 'credit' AND w.category = 'prize'
                           AND w.user_id = sp.user_id
                           AND w.amount  = sp.amount)
          )), 0) AS seat_paid_out
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

-- Both events are already fully explained and correctly paid; nothing else
-- moves. Resolve the now-understood rows rather than leave a correct fix
-- sitting next to an unresolved alert (CLAUDE.md 10.11: the record is part
-- of the fix).
UPDATE public.financial_alerts
SET resolved = true, resolved_at = now(),
    resolution = 'False positive: fn_tournament_conservation_delta did not recognise the'
      || ' 2026-09-09 CLAUDE.md 10.9 bubble-protection backpay (chip_ledger'
      || ' category=correction, club_treasury/union_bank -> prize_liability,'
      || ' 180.00) as house funding, only category=overlay. The 180.00 was'
      || ' already correctly paid in full on 2026-09-09; this migration widens'
      || ' the recognition and the alert does not recur. No money moves.'
WHERE resolved = false
  AND context->>'tournament_id' IN ('a449e853-4ee1-4e36-bd38-8fe904664d7c','f7412940-5644-4194-8d57-4a97c182bf04')
  AND message = 'Tournament paid out money it never collected: Sunday $200 Deep Stack';

DO $verify$
DECLARE v_a numeric; v_b numeric;
BEGIN
  v_a := public.fn_tournament_conservation_delta('a449e853-4ee1-4e36-bd38-8fe904664d7c');
  v_b := public.fn_tournament_conservation_delta('f7412940-5644-4194-8d57-4a97c182bf04');
  IF v_a <> 0 OR v_b <> 0 THEN
    RAISE EXCEPTION 'expected both deltas to resolve to 0.00 after the fix, got a=% b=%', v_a, v_b;
  END IF;
END;
$verify$;

COMMIT;
