-- Received conservation alerts 15856/15857: posted house corrections were invisible.
-- Detector-only change; no wallet, ledger, obligation or alert-row mutation.
BEGIN;
SET LOCAL statement_timeout = '10s';
SET LOCAL lock_timeout = '2s';
DO $guard$
DECLARE v_hash text;
BEGIN
  SELECT md5(pg_get_functiondef('public.fn_tournament_conservation_delta(uuid)'::regprocedure)) INTO v_hash;
  IF v_hash NOT IN ('3a101e8a47822d6b1af6abd274272a36', '435c8f7eabc7d5b78b893885c91c738a') THEN
    RAISE EXCEPTION 'Unqualified conservation definition: %', v_hash;
  END IF;
END $guard$;

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
             AND l.to_type = 'prize_liability'), 0)
        -- A posted house correction funds the same liability as an overlay.
        -- Keep this separate so both existing entity/overlay indexes can be used.
        + COALESCE((SELECT sum(l.amount) FROM public.chip_ledger l
           WHERE l.to_entity_id = t.id AND l.tournament_id = t.id
             AND l.category = 'correction' AND l.status = 'posted'
             AND l.from_type IN ('union_bank', 'club_treasury')
             AND l.from_entity_id IS NOT NULL
             AND l.from_entity_id <> l.to_entity_id
             AND l.to_type = 'prize_liability'
             AND l.amount > 0 AND l.amount < 'Infinity'::numeric), 0),
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
      COALESCE((SELECT sum(sp.amount)
         FROM public.tournament_payouts sp
         LEFT JOIN public.tournament_satellite_awards a
                ON a.tournament_id = sp.tournament_id AND a.place = sp.position
         LEFT JOIN public.tournament_tickets k ON k.id = a.ticket_id
        WHERE sp.source IN ('satellite_seat','satellite_ticket')
          AND sp.tournament_id = t.id
          AND COALESCE(a.delivery_kind, 'seat') IN ('seat','ticket')
          AND COALESCE(k.status, 'issued') IN ('issued','redeemed')), 0) AS seat_paid_out
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

DO $verify$
BEGIN
  IF md5(pg_get_functiondef('public.fn_tournament_conservation_delta(uuid)'::regprocedure)) <> '435c8f7eabc7d5b78b893885c91c738a' THEN
    RAISE EXCEPTION 'Conservation correction definition differs from qualified candidate';
  END IF;
END $verify$;
COMMIT;
