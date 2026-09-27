-- 20260927091102_conservation_delta_seat_award_join_by_payout_id
--
-- ROOT CAUSE (CLAUDE.md 10.11/10.12): fn_tournament_money_conservation raised
-- 14 fresh "retained/paid money it never collected/paid out" alerts against
-- LIVE, healthy tournaments starting 2026-09-26 (financial_alerts ids
-- 7e64474e, 2d8cb02d, 5a088deb, 9bd7f8f3, dda954bc, 52bfd60a, 268aca2f,
-- 12925ad3, 38a22616, 30a45430, ee15360d, eaf6126a, 80d0c9bb + one more).
-- Every one is a false positive of fn_tournament_conservation_delta itself,
-- not a real shortfall or overpayment.
--
-- Traced "Six-Card Feature" (cf03a62c-3f77-43b4-82ff-c68c8b1cace1, delta
-- reported +160.00) to the exact rows. Its seat_income CTE counted 9
-- satellite_ticket/satellite_seat payout rows worth 180.00 as "arrived",
-- but 8 of those 9 (160.00) are tickets with tournament_tickets.status =
-- 'issued' -- STILL UNREDEEMED, never entered this tournament at all.
--
-- The CTE finds a payout's tournament_satellite_awards row by
--   a.tournament_id = sp.tournament_id AND a.place = sp.position
-- but tournament_payouts.position is NULL for these ticket-delivery rows
-- (a data-entry gap on that column, not a signal). When the join misses,
-- the code's own COALESCE(a.delivery_kind, 'seat') falls back to "no award
-- row = the legacy direct-seat path, which always arrived" -- which is
-- true when there really is no award row, and silently wrong when there is
-- one the join simply failed to find. Confirmed for all 8 phantom rows:
-- each has a real, unique tournament_satellite_awards row (place 1-5, on
-- the satellite side) reachable by its own payout_id, every one still
-- status='issued' with redeemed_at IS NULL.
--
-- tournament_satellite_awards.payout_id is UNIQUE, NOT NULL on all 2,084
-- live rows, and FK-constrained to tournament_payouts.id (measured on
-- production before writing this migration). It is the row's own foreign
-- key back to the exact payout that created it and can never fan out or
-- miss on a NULL column the way (tournament_id, place) vs
-- (tournament_id, position) can. Re-keying both the seat_income and
-- seat_paid_out CTEs on it fixes the phantom match without touching any
-- of the surrounding delivery_kind/ticket-status logic those CTEs already
-- encode correctly.
--
-- VERIFIED (rolled back, no committed side effects): recomputing
-- cf03a62c's delta with the corrected join is exactly 0.00 (240.00 wallet
-- buy-ins - 26.00 rake - 600.00 prizes + 366.00 overlay + 20.00 real
-- seat_income [the one genuine satellite_seat delivery] - 0.00
-- seat_paid_out = 0.00), against the current reported +160.00. The 8
-- unredeemed tickets correctly drop out of seat_income and the tournament
-- balances to the cent.
--
-- This is a detection fix only: fn_tournament_conservation_delta is a
-- read-only, SECURITY DEFINER STABLE SQL function with no side effects.
-- No chips move as a result of this migration; it only corrects what the
-- nightly conservation scan reports. The 14 open financial_alerts rows
-- this bug raised are resolved separately in application code (this
-- fleet's board, not this migration) once this fix is confirmed live.
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
      --
      -- A TICKET ARRIVES WHEN IT IS REDEEMED, NOT WHEN IT IS ISSUED
      -- (2026-09-12). The holder of an unredeemed ticket has not entered this
      -- event and owes it nothing; crediting the target on issue invents an
      -- entry. Measured: gating this side the same way as the paid side below
      -- put "Wednesday Feature" at +40.00 and "DSS Wednesday $22 NLH
      -- Deepstack" at +20.00, both of which are correctly 0.00.
      --
      -- JOIN BY payout_id, NOT (tournament_id, place) VS (tournament_id,
      -- position) (2026-09-27). tournament_payouts.position is NULL on some
      -- genuine ticket-delivery rows (a gap on that column, not a "no award"
      -- signal), which silently missed a real award row and let an
      -- UNREDEEMED ticket fall through to the "no award row = legacy seat,
      -- always arrived" default. payout_id is the award's own unique,
      -- NOT NULL, FK-constrained pointer back to the exact payout that
      -- created it, so it can never miss on a null sibling column.
      COALESCE((SELECT sum(sp.amount)
         FROM public.tournament_payouts sp
         LEFT JOIN public.tournament_satellite_awards a
                ON a.payout_id = sp.id
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
      --
      -- Re-keyed on payout_id (2026-09-27), same reasoning as seat_income
      -- above: a true cash-delivery-with-no-award-row case still has no
      -- tournament_satellite_awards row under either join, so this term is
      -- unchanged for it; a ticket/seat delivery whose payout row happens to
      -- carry a NULL position is now found correctly instead of silently
      -- falling through to the cash-delivery default.
      COALESCE((SELECT sum(sp.amount)
         FROM public.tournament_payouts sp
         LEFT JOIN public.tournament_satellite_awards a
                ON a.payout_id = sp.id
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

COMMIT;
