-- 20260927212910_conservation_delta_seat_award_join_by_payout_id
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-09-27 21:29:10 UTC.
-- Supersedes 20260927091102 from the same pull request (#5396), which was
-- never applied: it was written against the function body of 09:11 and would
-- have dropped the reviewed-void overlay return that 20260927150903 added at
-- 15:09. This file restates the CURRENT live body (prosrc md5
-- ce248ae34ecb66dd36a55c50fee8d07b, read 2026-09-27 21:31 UTC) with exactly
-- two predicates changed.
--
-- WHAT WAS WRONG
--
-- fn_tournament_conservation_delta found a satellite payout's award row by
--     a.tournament_id = sp.tournament_id AND a.place = sp.position
-- but tournament_payouts.position is NULL on ticket-delivery payout rows. The
-- join then misses an award that exists, and COALESCE(a.delivery_kind,'seat')
-- reads the miss as "legacy direct seat, always arrived". Every unredeemed
-- ticket aimed at an event was counted as an entry into it, so
-- fn_tournament_money_conservation filed "Tournament retained money it never
-- paid out" against healthy, fully-paid events. Measured on 16 open
-- financial_alerts: e.g. Saturday Night Big Stack (fb3d92ce) +2,850.00 from
-- 72 counted seat payouts of which 57 are still-issued tickets; the target's
-- own escrow records the 15 real arrivals and closed at exact zero.
--
-- WHAT THIS CHANGES
--
-- Both award joins key on a.payout_id = sp.id. tournament_satellite_awards.
-- payout_id is UNIQUE, NOT NULL and FK-bound to tournament_payouts.id, so it
-- cannot miss on a NULL column or fan out. A payout that truly has no award
-- row (the legacy seat path, and the 2026-09-25 cash delivery) still has none
-- under the new key, so those branches read exactly as before.
--
-- MEASURED (read-only, the corrected body as a pg_temp function, 21:3x UTC):
--   * the 16 alerted events: 14 read 0.00 (they read +20.00 .. +2,850.00);
--     the two Sunday $200 Deep Stack events stay at -180.00 each - a separate,
--     real finding this change does not touch;
--   * every COMPLETED/CANCELLED event of the last 10 days with a satellite
--     payout on either side (493 events): 14 change, all from non-zero to
--     0.00; none moves from 0.00 to non-zero.
--
-- Read-only function; no money moves. Grants are restated because CREATE OR
-- REPLACE keeps them but scripts/ci/check-definer-authorization.mjs reads the
-- declaring migration.
--
-- Law: tests/a-satellite-award-is-found-by-its-payout-id.law.test.ts
--
-- @live-proof: (SELECT position('a.payout_id = sp.id' in pg_get_functiondef('public.fn_tournament_conservation_delta(uuid)'::regprocedure)) > 0 AND position('a.place = sp.position' in pg_get_functiondef('public.fn_tournament_conservation_delta(uuid)'::regprocedure)) = 0)

BEGIN;
SET LOCAL lock_timeout = '5s';

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
      )
      -- A REVIEWED VOID RETURNS ITS OVERLAY (2026-09-27): one 'reversal' leg
      -- out of prize_liability back to the funder. The event kept none of it.
      - COALESCE((SELECT sum(r.amount) FROM public.chip_ledger r
           WHERE r.tournament_id = t.id AND r.category = 'reversal'
             AND r.from_type = 'prize_liability' AND r.from_entity_id = t.id
             AND r.metadata->>'kind' = 'reviewed_void_overlay_return'), 0)
      AS funded_overlay,

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

REVOKE ALL ON FUNCTION public.fn_tournament_conservation_delta(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_tournament_conservation_delta(uuid) TO service_role;

COMMIT;
