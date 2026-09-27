-- 20260927150903_a_reviewed_void_overlay_return_is_not_pool_money.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- ===========================================================================
--  A REVIEWED VOID'S OVERLAY RETURN IS NOT POOL MONEY
-- ===========================================================================
--
-- The reviewed void of the two retired mixed-custody events (615783bf and
-- 5a387a75, applied 2026-09-27 14:31/14:32 UTC through
-- smarter_private.f06_void_retired_mixed_custody_event) returned each
-- guarantee overlay to its funder: 250.00 to club 2a1132b9's treasury and
-- 100.00 to the union bank, each as one 'reversal' leg out of prize_liability
-- (idempotency 'tourney:<id>:void:overlay-return', metadata kind
-- 'reviewed_void_overlay_return'), and the maintained escrow closed at exact
-- zero. The books are neutral: overlay in = reversal out, add-ons in = refunds
-- out, wallet by wallet.
--
-- Two readers do not know the reversal leg, and both read the returned overlay
-- as money the event still holds:
--   * public.fn_ca_tournament_escrow_chips (the escrow shadow):
--     overlay_in 250.00 / 100.00, so fn_ca_escrow_balance_drift raised
--     "settlement_error drift -250.00 / -100.00" at 14:35 UTC;
--   * public.fn_tournament_conservation_delta: +250.00 / +100.00, which the
--     hourly fn_tournament_money_conservation reads for every COMPLETED or
--     CANCELLED event.
-- Both now subtract that one leg from the overlay they count. Nothing else
-- changes; every other event reads exactly as before (no other path writes
-- a reviewed-void overlay return). Both reads use
-- idx_chip_ledger_tournament_category. No money moves.
--
-- Law: tests/a-reviewed-void-overlay-return-is-not-pool-money.law.test.ts
--
-- @live-proof: (SELECT overlay_in FROM public.fn_ca_tournament_escrow_chips('615783bf-15e3-40b7-9368-75f21b6ac53b')) = 0
-- @live-proof: public.fn_tournament_conservation_delta('5a387a75-754a-416e-8fee-b85b15fc2702') = 0

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $pre$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = 'public.fn_ca_tournament_escrow_chips(uuid)'::regprocedure
       AND md5(p.prosrc) = '6d76d2f0946ba93475ea5e9e185f027f'
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.proacl::text = '{postgres=X/postgres,service_role=X/postgres}'
       AND p.proconfig::text = '{search_path=public}'
       AND p.prosecdef
       AND p.provolatile = 's') THEN
    RAISE EXCEPTION 'PREIMAGE: fn_ca_tournament_escrow_chips is not the definition read 2026-09-27';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = 'public.fn_tournament_conservation_delta(uuid)'::regprocedure
       AND md5(p.prosrc) = 'ac92ee4f3f1a5e7aca3b9bd3cbe9ef34'
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.proacl::text = '{postgres=X/postgres,service_role=X/postgres}'
       AND p.proconfig::text = '{search_path=public}'
       AND p.prosecdef
       AND p.provolatile = 's') THEN
    RAISE EXCEPTION 'PREIMAGE: fn_tournament_conservation_delta is not the definition read 2026-09-27';
  END IF;
END
$pre$;

CREATE OR REPLACE FUNCTION public.fn_ca_tournament_escrow_chips(p_tournament_id uuid)
 RETURNS TABLE(prize_in numeric, bounty_in numeric, fee_in numeric, overlay_in numeric, satellite_in numeric, prize_out numeric, bounty_out numeric, fee_out numeric, refund_out numeric, prize_balance numeric, bounty_balance numeric, fee_balance numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
WITH t AS (
  SELECT id,COALESCE(buy_in_amount,0) AS buy_in_amount,
         COALESCE(buy_in_fee,0) AS buy_in_fee,
         COALESCE(bounty_amount,0) AS bounty_amount,
         (COALESCE(is_bounty,false) OR COALESCE(is_pko,false)
          OR COALESCE(is_mystery_bounty,false)) AS is_b
    FROM public.tournaments WHERE id=p_tournament_id
), w AS (
  SELECT
    COALESCE(sum(amount) FILTER (WHERE type='debit'
      AND category IN ('tournament_buyin','rebuy','addon')),0) AS gross_in,
    COALESCE(sum(amount) FILTER (WHERE type='credit' AND category='prize'),0)
      - COALESCE(sum(amount) FILTER (WHERE type='debit'
          AND category IN ('prize','prize_reversal')),0) AS prize_out,
    COALESCE(sum(amount) FILTER (WHERE type='credit' AND category='bounty'),0)
      AS bounty_out,
    COALESCE(sum(amount) FILTER (WHERE type='credit'
      AND category IN ('refund','tournament_refund')),0) AS refund_out
  FROM public.wallet_transactions WHERE related_entity_id=p_tournament_id
), direct_bounty AS (
  SELECT round(COALESCE(sum(CASE
    WHEN NOT t.is_b OR lower(l.category)='addon' THEN 0
    WHEN lower(l.category)='tournament_buyin' THEN round(t.bounty_amount,2)
    ELSE public.fn_ca_unit_floor_cents(
      round(LEAST(
        GREATEST(0,round(t.bounty_amount,2)),
        round(l.amount,2)-public.fn_ca_recovery_fee_cents(
          round(round(l.amount,2)*100)::bigint,
          public.fn_ca_tournament_fee_ratio(t.buy_in_amount,t.buy_in_fee),
          public.fn_ca_tournament_unit_cents(p_tournament_id))::numeric/100
      )*100)::bigint,
      public.fn_ca_tournament_unit_cents(p_tournament_id))::numeric/100    END),0),2) AS amount
  FROM t JOIN public.chip_ledger l
    ON l.tournament_id=p_tournament_id
   AND l.from_type='player_wallet' AND l.to_type='prize_liability'
   AND l.to_entity_id=p_tournament_id
   AND lower(l.category) IN ('tournament_buyin','rebuy','addon')
), rr AS (
  SELECT
    COALESCE(sum(rake_amount),0) AS fee_in,
    COALESCE(sum(rake_amount) FILTER (
      WHERE source='fn_award_satellite_seat'),0) AS fee_sat,
    COALESCE(sum(rake_amount) FILTER (
      WHERE source='fn_award_satellite_seat'
        AND metadata->>'entry_split_version'='2'),0) AS fee_sat_split,
    COALESCE(sum(COALESCE(pot_size,0)-rake_amount) FILTER (
      WHERE source='fn_award_satellite_seat'),0) AS satellite_in
  FROM public.rake_records
  WHERE tournament_id=p_tournament_id AND is_tournament
    AND NOT (rake_amount<0 AND source IN (
      'atomic_cancel_tournament','fn_unregister_from_tournament'))
), ov AS (
  /* A REVIEWED VOID RETURNS ITS OVERLAY (2026-09-27). The void of a retired
     event (smarter_private.f06_void_retired_mixed_custody_event) sends the
     guarantee overlay back to its funder as one 'reversal' leg out of
     prize_liability, and takes it out of the maintained escrow. The shadow
     nets it too, or it reads the returned overlay as money still in the pool. */
  SELECT COALESCE(sum(a.amount),0) AS ledger_overlay,
         (SELECT COALESCE(sum(r.amount),0) FROM public.chip_ledger r
     WHERE r.tournament_id=p_tournament_id AND r.category='reversal'
       AND r.from_type='prize_liability' AND r.from_entity_id=p_tournament_id
       AND r.metadata->>'kind'='reviewed_void_overlay_return') AS returned
    FROM public.chip_ledger a
   WHERE a.to_entity_id=p_tournament_id
     AND a.to_type='prize_liability'
     AND (a.category='overlay' OR
       (a.category='correction' AND a.from_type IN ('union_bank','club_treasury')))
     AND NOT (COALESCE(a.description,'') LIKE 'auto-ledgered%'
       AND EXISTS (
         SELECT 1 FROM public.chip_ledger b
          WHERE b.to_entity_id=a.to_entity_id AND b.category='overlay'
            AND b.to_type='prize_liability' AND b.id<>a.id
            AND b.amount=a.amount
            AND COALESCE(b.description,'') NOT LIKE 'auto-ledgered%'
            AND abs(extract(epoch FROM (b.created_at-a.created_at)))<5))
), stl AS (
  SELECT COALESCE(sum(amount),0) AS moved,
    COALESCE(sum(amount) FILTER (
      WHERE metadata->>'entry_split_version'='2'),0) AS split_moved,
    COALESCE(sum((metadata->>'entry_fee')::numeric) FILTER (
      WHERE metadata->>'entry_split_version'='2'),0) AS split_fee,
    COALESCE(sum((metadata->>'entry_bounty')::numeric) FILTER (
      WHERE metadata->>'entry_split_version'='2'),0) AS split_bounty
  FROM public.chip_ledger
  WHERE to_entity_id=p_tournament_id AND to_type='prize_liability'
    AND idempotency_key LIKE 'tourney:%:seat:%:pool_transfer'
), tk AS (
  /* A TICKET ENTRY IS AN ENTRY (2026-09-10): a tournament-entry ticket
     redeemed into this event moves its value escrow -> prize_liability
     with no wallet debit and no pool transfer; the escrow triggers count
     it as an entry and so must the shadow. */
  SELECT COALESCE(sum(amount),0) AS ticket_in
    FROM public.chip_ledger
   WHERE to_entity_id=p_tournament_id AND to_type='prize_liability'
     AND from_type='escrow' AND category='ticket_redeem'
), tgo AS (
  SELECT COALESCE(sum(amount),0) AS tgo_amount
    FROM public.tournament_guarantee_overlays
   WHERE tournament_id=p_tournament_id
), sat AS (
  SELECT COALESCE(sum(p.amount),0) AS funded_awards_out
    FROM public.tournament_payouts p
    LEFT JOIN public.tournament_satellite_awards a
      ON a.payout_id=p.id
     AND a.tournament_id=p.tournament_id
     AND a.delivery_kind='ticket'
   WHERE p.tournament_id=p_tournament_id
     AND (p.source='satellite_seat'
       OR (p.source='satellite_ticket' AND a.payout_id IS NOT NULL))
), fo AS (
  SELECT COALESCE(sum(amount),0) AS fee_out
    FROM public.tournament_rake_settlements
   WHERE tournament_id=p_tournament_id AND settled_at IS NOT NULL
), exact_refunds AS (
  SELECT COALESCE(sum(amount_paid_now),0) AS total,
         COALESCE(sum(refund_prize),0) AS prize,
         COALESCE(sum(refund_bounty),0) AS bounty,
         COALESCE(sum(refund_fee),0) AS fee
    FROM public.tournament_refund_tranches
   WHERE tournament_id=p_tournament_id
), calc AS (
  SELECT
    round(w.gross_in+stl.split_moved-stl.split_fee+tk.ticket_in,2) AS gross_in,
    round(rr.fee_in,2) AS fee_in,
    round(rr.fee_in-rr.fee_sat,2) AS fee_entries,
    round(direct_bounty.amount+stl.split_bounty,2) AS bounty_in,
    round(CASE WHEN ov.ledger_overlay>0 THEN ov.ledger_overlay
      ELSE tgo.tgo_amount END-ov.returned,2) AS overlay_in,
    round(stl.moved-stl.split_moved-rr.fee_sat+rr.fee_sat_split,2)
      AS satellite_in,
    round(w.prize_out+sat.funded_awards_out,2) AS prize_out,
    round(w.bounty_out,2) AS bounty_out,
    round(fo.fee_out,2) AS fee_out,
    round(w.refund_out,2) AS refund_out,
    round(exact_refunds.total,2) AS exact_total,
    round(exact_refunds.prize,2) AS exact_prize,
    round(exact_refunds.bounty,2) AS exact_bounty,
    round(exact_refunds.fee,2) AS exact_fee
  FROM t,w,direct_bounty,rr,stl,ov,tk,tgo,sat,fo,exact_refunds
), split AS (
  SELECT c.*,round(c.gross_in-c.fee_entries-c.bounty_in,2) AS prize_in,
         round(c.refund_out-c.exact_total,2) AS legacy_refund
    FROM calc c
), apportioned AS (
  SELECT s.*,
    CASE WHEN (s.prize_in+s.satellite_in+s.bounty_in+s.fee_in)>0
      THEN round(s.legacy_refund*(s.prize_in+s.satellite_in)
        /(s.prize_in+s.satellite_in+s.bounty_in+s.fee_in),2)
      ELSE s.legacy_refund END AS legacy_prize,
    CASE WHEN (s.prize_in+s.satellite_in+s.bounty_in+s.fee_in)>0
      THEN round(s.legacy_refund*s.bounty_in
        /(s.prize_in+s.satellite_in+s.bounty_in+s.fee_in),2)
      ELSE 0 END AS legacy_bounty
  FROM split s
)
SELECT a.prize_in,a.bounty_in,a.fee_in,a.overlay_in,a.satellite_in,
       a.prize_out,a.bounty_out,a.fee_out,a.refund_out,
       round(a.prize_in+a.overlay_in+a.satellite_in-a.prize_out
         -a.legacy_prize-a.exact_prize,2) AS prize_balance,
       round(a.bounty_in-a.bounty_out-a.legacy_bounty-a.exact_bounty,2)
         AS bounty_balance,
       round(a.fee_in-a.fee_out
         -(a.legacy_refund-a.legacy_prize-a.legacy_bounty)-a.exact_fee,2)
         AS fee_balance
  FROM apportioned a;
$function$;

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

REVOKE ALL ON FUNCTION public.fn_ca_tournament_escrow_chips(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_tournament_escrow_chips(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.fn_tournament_conservation_delta(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_tournament_conservation_delta(uuid) TO service_role;

DO $post$
DECLARE r record;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = 'public.fn_ca_tournament_escrow_chips(uuid)'::regprocedure
       AND md5(p.prosrc) = '6e3889909fd0830f6b374e7ac026c1c0'
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.proacl::text = '{postgres=X/postgres,service_role=X/postgres}'
       AND p.proconfig::text = '{search_path=public}'
       AND p.prosecdef
       AND p.provolatile = 's') THEN
    RAISE EXCEPTION 'POSTIMAGE: fn_ca_tournament_escrow_chips is not the reviewed definition';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = 'public.fn_tournament_conservation_delta(uuid)'::regprocedure
       AND md5(p.prosrc) = 'ce248ae34ecb66dd36a55c50fee8d07b'
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.proacl::text = '{postgres=X/postgres,service_role=X/postgres}'
       AND p.proconfig::text = '{search_path=public}'
       AND p.prosecdef
       AND p.provolatile = 's') THEN
    RAISE EXCEPTION 'POSTIMAGE: fn_tournament_conservation_delta is not the reviewed definition';
  END IF;
  -- The two voided events now read neutral in both readers.
  FOR r IN SELECT id FROM public.tournaments
            WHERE id IN ('615783bf-15e3-40b7-9368-75f21b6ac53b', '5a387a75-754a-416e-8fee-b85b15fc2702') LOOP
    IF (SELECT overlay_in FROM public.fn_ca_tournament_escrow_chips(r.id)) <> 0
       OR (SELECT prize_balance + bounty_balance + fee_balance FROM public.fn_ca_tournament_escrow_chips(r.id)) <> 0
       OR public.fn_tournament_conservation_delta(r.id) <> 0 THEN
      RAISE EXCEPTION 'POSTIMAGE: % does not read neutral', r.id;
    END IF;
  END LOOP;
END
$post$;

COMMIT;
