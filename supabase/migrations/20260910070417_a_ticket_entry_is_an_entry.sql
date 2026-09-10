-- a_ticket_entry_is_an_entry
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY (2026-09-10, drift board incidents 1dee2671 and
-- 60d2d03e, one ticket, two detectors):
--
-- Ticket 0eca5537 (20.00, "Four-Table Cap Satellite Award: Tournament Entry
-- Only", club 2a1132b9) was redeemed at 05:15 into DSS Thursday $22 NLH
-- Deepstack (d04da598) through fn_ca_register_for_tournament_with_ticket_for.
-- That door writes exactly what an entry should write: a chip_ledger leg
-- escrow -> prize_liability (category ticket_redeem, 20.00), a rake_records
-- row for the 2.00 entry fee, a chip_transactions receipt of type
-- tournament_ticket_entry, and the escrow triggers booked gross_in 340.00 /
-- fee 34.00 / prize 306.00 - 17 entries of 20.00, which is what the event
-- holds. Two readers disagreed with it:
--
--   1. fn_ca_tournament_escrow (the escrow SHADOW) builds gross_in from
--      wallet debits and satellite pool transfers only. A ticket entry debits
--      no wallet and is no pool transfer, so the shadow read gross 320.00 and
--      prize 286.00, and fn_ca_escrow_balance_drift filed the 20.00 gap as
--      "a path wrote an operational row the escrow triggers do not read".
--      It was the shadow that did not read it. The shadow now counts
--      escrow -> prize_liability ticket_redeem legs as entries.
--   2. fn_ca_settlement_correctness_check section F demands that a redeemed
--      ticket have exactly one chip_transactions receipt of type
--      tournament_ticket_redeem. That is the CASH redemption door's receipt
--      (fn_redeem_tournament_ticket). An entry-only ticket is redeemed by the
--      entry door, whose receipt is tournament_ticket_entry, so every
--      entry-only ticket read as "0 receipt(s)". The check now accepts either
--      redemption receipt.
--
-- No chips moved wrongly; both incidents close with this cause, and the
-- migration asserts the shadow now agrees with the maintained escrow for
-- d04da598 and that the ticket has exactly one receipt of its value.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $body$
DECLARE
  v_def text; v_n integer; v_rows integer;
  v_e1 text := E'), tgo AS (';
  v_e1n text := E'), tk AS (\n'
             || E'  /* A TICKET ENTRY IS AN ENTRY (2026-09-10): a tournament-entry ticket\n'
             || E'     redeemed into this event moves its value escrow -> prize_liability\n'
             || E'     with no wallet debit and no pool transfer; the escrow triggers count\n'
             || E'     it as an entry and so must the shadow. */\n'
             || E'  SELECT COALESCE(sum(amount),0) AS ticket_in\n'
             || E'    FROM public.chip_ledger\n'
             || E'   WHERE to_entity_id=p_tournament_id AND to_type=''prize_liability''\n'
             || E'     AND from_type=''escrow'' AND category=''ticket_redeem''\n'
             || E'), tgo AS (';
  v_e2 text := E'    round(w.gross_in+stl.split_moved-stl.split_fee,2) AS gross_in,';
  v_e2n text := E'    round(w.gross_in+stl.split_moved-stl.split_fee+tk.ticket_in,2) AS gross_in,';
  v_e3 text := E'  FROM t,w,direct_bounty,rr,stl,ov,tgo,sat,fo,exact_refunds';
  v_e3n text := E'  FROM t,w,direct_bounty,rr,stl,ov,tk,tgo,sat,fo,exact_refunds';
  v_c1 text := E'             WHERE ct.transaction_type = CASE t.status WHEN ''redeemed''\n'
            || E'                     THEN ''tournament_ticket_redeem'' ELSE ''tournament_ticket_cancel'' END';
  v_c1n text := E'             /* A TICKET ENTRY IS AN ENTRY (2026-09-10): an entry-only ticket is\n'
             || E'                redeemed by the entry door, whose receipt is\n'
             || E'                tournament_ticket_entry; the cash door writes\n'
             || E'                tournament_ticket_redeem. Both are the one receipt. */\n'
             || E'             WHERE ct.transaction_type = ANY (CASE t.status WHEN ''redeemed''\n'
             || E'                     THEN ARRAY[''tournament_ticket_redeem'',''tournament_ticket_entry'']\n'
             || E'                     ELSE ARRAY[''tournament_ticket_cancel''] END)';
  v_maint record; v_shadow record; v_receipts integer; v_receipt_value numeric;
BEGIN
  -- 1. the escrow shadow
  SELECT pg_get_functiondef('public.fn_ca_tournament_escrow(uuid)'::regprocedure) INTO v_def;
  IF position('A TICKET ENTRY IS AN ENTRY' IN v_def) = 0 THEN
    v_n := (length(v_def) - length(replace(v_def, v_e1, ''))) / length(v_e1);
    IF v_n <> 1 THEN RAISE EXCEPTION 'escrow anchor 1 appears % times, expected 1', v_n; END IF;
    v_n := (length(v_def) - length(replace(v_def, v_e2, ''))) / length(v_e2);
    IF v_n <> 1 THEN RAISE EXCEPTION 'escrow anchor 2 appears % times, expected 1', v_n; END IF;
    v_n := (length(v_def) - length(replace(v_def, v_e3, ''))) / length(v_e3);
    IF v_n <> 1 THEN RAISE EXCEPTION 'escrow anchor 3 appears % times, expected 1', v_n; END IF;
    v_def := replace(replace(replace(v_def, v_e1, v_e1n), v_e2, v_e2n), v_e3, v_e3n);
    EXECUTE v_def;
  END IF;

  -- 2. the correctness check
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p WHERE p.proname = 'fn_ca_settlement_correctness_check';
  IF v_def IS NULL THEN RAISE EXCEPTION 'fn_ca_settlement_correctness_check is missing'; END IF;
  IF position('A TICKET ENTRY IS AN ENTRY' IN v_def) = 0 THEN
    v_n := (length(v_def) - length(replace(v_def, v_c1, ''))) / length(v_c1);
    IF v_n <> 2 THEN RAISE EXCEPTION 'check anchor appears % times, expected 2 (count and sum)', v_n; END IF;
    EXECUTE replace(v_def, v_c1, v_c1n);
  END IF;

  -- post-conditions, against the event and the ticket that were flagged
  SELECT prize_balance, bounty_balance, fee_balance INTO v_maint FROM public.tournament_escrow WHERE tournament_id = 'd04da598-d472-4521-99ff-5609403bac44';
  SELECT prize_balance, bounty_balance, fee_balance INTO v_shadow FROM public.fn_ca_tournament_escrow('d04da598-d472-4521-99ff-5609403bac44');
  IF v_maint IS NULL OR v_shadow IS NULL
     OR abs(v_maint.prize_balance - v_shadow.prize_balance) > 0.01
     OR abs(v_maint.fee_balance - v_shadow.fee_balance) > 0.01
     OR abs(v_maint.bounty_balance - v_shadow.bounty_balance) > 0.01 THEN
    RAISE EXCEPTION 'post-condition: shadow (% / % / %) still disagrees with the escrow (% / % / %) for d04da598',
      v_shadow.prize_balance, v_shadow.bounty_balance, v_shadow.fee_balance,
      v_maint.prize_balance, v_maint.bounty_balance, v_maint.fee_balance;
  END IF;
  SELECT count(*), COALESCE(sum(ct.amount), 0) INTO v_receipts, v_receipt_value
    FROM public.chip_transactions ct
   WHERE ct.transaction_type = ANY (ARRAY['tournament_ticket_redeem','tournament_ticket_entry'])
     AND ct.metadata->>'ticket_id' = '0eca5537-7e84-4f71-b641-af37b87717e1';
  IF v_receipts <> 1 OR round(v_receipt_value, 2) <> 20.00 THEN
    RAISE EXCEPTION 'post-condition: ticket 0eca5537 has % receipt(s) totalling %, expected 1 of 20.00', v_receipts, v_receipt_value;
  END IF;

  UPDATE public.ca_drift_incidents i
     SET status = 'resolved', resolved_at = now(),
         root_cause = 'fn_ca_tournament_escrow (the escrow shadow) built gross_in from wallet debits and satellite pool transfers only, so a tournament-entry ticket redeemed through fn_ca_register_for_tournament_with_ticket_for (escrow -> prize_liability, category ticket_redeem, no wallet debit) was counted by the escrow triggers and not by the shadow. Fixed in migration a_ticket_entry_is_an_entry: the shadow counts ticket_redeem legs as entries.',
         correction_ref = 'migration a_ticket_entry_is_an_entry',
         resolution = 'Detector defect; the escrow (prize 306.00 / fee 34.00 for 17 entries of 20.00) was right. The shadow agrees after the fix, asserted in the migration.'
   WHERE i.status = 'open' AND i.source = 'fn_ca_escrow_balance_drift'
     AND i.metadata->>'tournament_id' = 'd04da598-d472-4521-99ff-5609403bac44';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN RAISE EXCEPTION 'expected to resolve 1 escrow drift incident, resolved %', v_rows; END IF;

  UPDATE public.ca_drift_incidents i
     SET status = 'resolved', resolved_at = now(),
         root_cause = 'fn_ca_settlement_correctness_check section F demanded a tournament_ticket_redeem receipt (the cash redemption door) for every redeemed ticket; an entry-only ticket is redeemed by the entry door, whose receipt is tournament_ticket_entry, so it read as 0 receipts. Fixed in migration a_ticket_entry_is_an_entry: either redemption receipt counts.',
         correction_ref = 'migration a_ticket_entry_is_an_entry',
         resolution = 'Detector defect; ticket 0eca5537 has exactly one tournament_ticket_entry receipt of 20.00, asserted in the migration.'
   WHERE i.status = 'open' AND i.source = 'fn_ca_settlement_correctness_check:ticket_value'
     AND i.metadata->>'ticket_id' = '0eca5537-7e84-4f71-b641-af37b87717e1';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN RAISE EXCEPTION 'expected to resolve 1 ticket_value incident, resolved %', v_rows; END IF;
END
$body$;

COMMIT;
