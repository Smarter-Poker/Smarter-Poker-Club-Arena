-- @live-proof: (SELECT count(*) FROM public.tournament_tickets tk WHERE tk.status='issued' AND tk.redemption_mode='tournament_entry_only' AND tk.source_satellite_award_place IS NOT NULL AND tk.source_refund_entitlement_id IS NULL AND tk.created_at>='2026-09-01 00:00:00+00' AND tk.created_at<'2026-09-12 19:00:00+00' AND public.fn_ca_satellite_ticket_target_is_closed(tk.source_tournament_id))=0
--
-- THE STRANDED SATELLITE TICKETS ARE PAID IN CASH, PART 1 OF 5 (2026-10-12).
--
-- 20261012054804 made a closed target pay its satellite tickets in cash at
-- the moment it closes. Tickets whose target had already closed before that
-- change were stranded in ticket escrow; this pays the ones issued from
-- 2026-09-01 00:00:00+00 to 2026-09-12 19:00:00+00 through the same door,
-- fn_ca_pay_closed_target_ticket_in_cash, once each, keyed
-- ticket:<id>:closed-target-cash. Every holder is a player owed the value
-- of a satellite seat that could no longer be used; every one is paid
-- (horses exactly as humans). Nothing is taken from anybody and no other
-- balance moves: each payment is the ticket's own escrow to its holder's
-- wallet in the ticket's club.
--
-- Expected when written (05:40 UTC): exactly 190 tickets worth 14660.00.
-- Split into five parts so no part holds a wallet lock for more than a few
-- seconds while horses keep playing. A replay pays nothing: the door answers
-- a paid ticket with its first receipt and the selection is empty.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
DO $settle$
DECLARE
  v_id uuid;
  v_value numeric;
  v_r jsonb;
  v_n integer:=0;
  v_sum numeric:=0;
  v_ids uuid[]:=ARRAY[]::uuid[];
BEGIN
  IF to_regprocedure('public.fn_ca_pay_closed_target_ticket_in_cash(uuid,text)') IS NULL THEN
    RAISE EXCEPTION 'STRANDED_TICKET_CASH_DOOR_MISSING: apply 20261012054804 first';
  END IF;
  FOR v_id,v_value IN
    SELECT tk.id,tk.value FROM public.tournament_tickets tk
     WHERE tk.status='issued' AND tk.redemption_mode='tournament_entry_only' AND tk.source_satellite_award_place IS NOT NULL AND tk.source_refund_entitlement_id IS NULL AND tk.created_at>='2026-09-01 00:00:00+00' AND tk.created_at<'2026-09-12 19:00:00+00' AND public.fn_ca_satellite_ticket_target_is_closed(tk.source_tournament_id)
     ORDER BY tk.created_at,tk.id
  LOOP
    v_r:=public.fn_ca_pay_closed_target_ticket_in_cash(v_id,'stranded_ticket_settlement_20261012');
    IF COALESCE((v_r->>'ok')::boolean,false) IS NOT TRUE
       OR COALESCE((v_r->>'replayed')::boolean,false)
       OR (v_r->>'amount')::numeric IS DISTINCT FROM v_value THEN
      RAISE EXCEPTION 'STRANDED_TICKET_CASH_REFUSED: %',v_r;
    END IF;
    v_n:=v_n+1;
    v_sum:=round(v_sum+v_value,2);
    v_ids:=v_ids||v_id;
  END LOOP;
  IF v_n<>190 OR v_sum<>14660.00 THEN
    RAISE EXCEPTION 'STRANDED_TICKET_CASH_RESULT_CHANGED: paid % tickets worth %',v_n,v_sum;
  END IF;
  IF (SELECT count(*) FROM public.tournament_tickets tk
       WHERE tk.id=ANY(v_ids) AND tk.status='redeemed'
         AND tk.redeemed_at=transaction_timestamp())<>v_n
     OR (SELECT COALESCE(sum(l.amount),0)
           FROM public.chip_ledger_idem i JOIN public.chip_ledger l ON l.id=i.leg_id
          WHERE i.idempotency_key IN (
            SELECT 'ticket:'||x::text||':closed-target-cash' FROM unnest(v_ids) x)
            AND l.from_type='escrow' AND l.to_type='player_wallet'
            AND l.category='ticket_redeem')<>v_sum
     OR EXISTS (SELECT 1 FROM public.tournament_tickets tk WHERE tk.status='issued' AND tk.redemption_mode='tournament_entry_only' AND tk.source_satellite_award_place IS NOT NULL AND tk.source_refund_entitlement_id IS NULL AND tk.created_at>='2026-09-01 00:00:00+00' AND tk.created_at<'2026-09-12 19:00:00+00' AND public.fn_ca_satellite_ticket_target_is_closed(tk.source_tournament_id)) THEN
    RAISE EXCEPTION 'STRANDED_TICKET_CASH_RESULT_CHANGED: receipts disagree for % tickets worth %',v_n,v_sum;
  END IF;
  RAISE NOTICE 'stranded satellite tickets paid in cash, part 1: % tickets worth %',v_n,v_sum;
END
$settle$;
COMMIT;
