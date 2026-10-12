-- A union flow proof probes only the rows it can use.
--
-- Midway's weekly close (union fade0000, book 2026-09-21..28) could not
-- finish inside its 40-minute scope budget. Measured on 2026-10-01 with
-- auto_explain on the canonical scheduler run:
-- fn_union_pnl_original_flow_evidence alone took 808 s, of which 242 s was
-- fn_union_pnl_tournament_returns(NULL,NULL,start,end). The week has 80,268
-- original flows (15,265 cash, 65,003 tournament, 4,047 cash-outs), and under
-- the database's current read latency every random probe costs 2-10 ms:
--
-- 1. The tournament-return join read EVERY credit receipt ever written
--    (130k rows, seq scan on a generic plan) and probed its transaction frame
--    to test the week window, before joining to this week's ledgers.
-- 2. The cash funding and tournament entry LEFT JOINs, and the moved-seat
--    lateral's inventory read, ran for every flow: conditions on the flow
--    alone (q.tournament_id, the ledger's from/to type) were applied as join
--    filters AFTER the inner probe, so 80k flows paid for probes only 4-65k
--    of them can match.
--
-- Same predicates, same results; only where they are evaluated moves:
-- * the return join is a per-flow lateral keyed by the flow's own ledger
--   (credit receipts by their unique ledger_id, refund tranches by
--   credit_ledger_id), carrying fn_union_pnl_tournament_returns' two branches
--   verbatim with p_tournament = the flow's tournament, p_registration NULL
--   and the same frame window; the function itself is unchanged.
-- * the funding/entry joins are laterals whose flow-only conditions become
--   one-time filters (OFFSET 0 keeps the planner from flattening them back).
-- * the moved-seat inventory read carries the flow-only conditions of its own
--   WHERE clause, so a tournament flow or an ordinary cash-out never reads it.
--
-- @live-proof: position('One-time filter (20261001)' in pg_get_functiondef('public.fn_union_pnl_original_flow_evidence(uuid,timestamptz,timestamptz)'::regprocedure)) > 0
-- Preimage-guarded: refuses unless the live function is exactly the version
-- 20260929093858 installed.
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $mig$
DECLARE s regprocedure:='public.fn_union_pnl_original_flow_evidence(uuid,timestamptz,timestamptz)'::regprocedure;
 d text; x text; pairs text[][]; i int;
BEGIN
 d:=pg_get_functiondef(s);
 IF md5(d)<>'e3fa192a9ce146e637eafa48f76be689' THEN RAISE EXCEPTION 'flow evidence preimage %',md5(d); END IF;
 pairs:=ARRAY[
  ARRAY[$n$  LEFT JOIN public.cash_participant_funding_receipts f ON f.source_ledger_id=q.ledger_id AND q.tournament_id IS NULL
$n$,
$n$  -- One-time filter (20261001): a probe only for the flows that can match.
  LEFT JOIN LATERAL (SELECT f.* FROM public.cash_participant_funding_receipts f
   WHERE q.tournament_id IS NULL AND f.source_ledger_id=q.ledger_id OFFSET 0) f ON true
$n$],
  ARRAY[$n$  LEFT JOIN public.tournament_participant_funding_receipts e ON e.ledger_id=q.ledger_id AND e.asset='chips' AND q.tournament_id=e.tournament_id
$n$,
$n$  LEFT JOIN LATERAL (SELECT e.* FROM public.tournament_participant_funding_receipts e
   WHERE q.tournament_id IS NOT NULL AND e.ledger_id=q.ledger_id AND e.asset='chips' AND q.tournament_id=e.tournament_id OFFSET 0) e ON true
$n$],
  ARRAY[$n$  LEFT JOIN public.fn_union_pnl_tournament_returns(NULL,NULL,p_start,p_end) c ON c.ledger_id=q.ledger_id AND q.tournament_id=c.tournament_id
$n$,
$n$  -- fn_union_pnl_tournament_returns(q.tournament_id,NULL,p_start,p_end) for
  -- this flow's ledger only: its two branches verbatim, keyed by the ledger.
  LEFT JOIN LATERAL (
   SELECT c.ledger_id,c.tournament_id,c.user_id,c.credited_club_id,c.amount
   FROM public.tournament_accounting_credit_receipts c
   JOIN public.union_pnl_transaction_frames b ON b.transaction_id=c.transaction_id
   WHERE q.tournament_id IS NOT NULL AND c.ledger_id=q.ledger_id AND c.tournament_id=q.tournament_id
    AND b.observed_at>=p_start AND b.observed_at<p_end
   UNION ALL
   SELECT t.credit_ledger_id,t.tournament_id,t.user_id,t.source_wallet_club_id,t.amount_paid_now
   FROM public.tournament_refund_tranches t
   JOIN public.tournament_participant_funding_receipts r ON r.entitlement_id=t.entitlement_id
   JOIN public.union_pnl_transaction_frames b ON b.transaction_id=t.transaction_id
   WHERE q.tournament_id IS NOT NULL AND t.credit_ledger_id=q.ledger_id AND t.tournament_id=q.tournament_id
    AND b.observed_at>=p_start AND b.observed_at<p_end
    AND NOT EXISTS(SELECT 1 FROM public.tournament_accounting_credit_receipts c2 WHERE c2.ledger_id=t.credit_ledger_id)
  ) c ON true
$n$],
  ARRAY[$n$   FROM (SELECT min(i.before_row::text)::jsonb seat,count(*) n FROM public.union_pnl_inventory_events i
     WHERE i.transaction_id=q.transaction_id AND i.source_name='table_seats'$n$,
$n$   FROM (SELECT min(i.before_row::text)::jsonb seat,count(*) n FROM public.union_pnl_inventory_events i
     WHERE q.tournament_id IS NULL AND q.l->>'from_type'='table_stack' AND q.l->>'to_type'='player_wallet'
      AND ret.owners IS DISTINCT FROM 1
      AND i.transaction_id=q.transaction_id AND i.source_name='table_seats'$n$]];
 FOR i IN 1..array_length(pairs,1) LOOP
  x:=pairs[i][1];
  IF (length(d)-length(replace(d,x,'')))/length(x)<>1 THEN RAISE EXCEPTION 'flow evidence needle % count',i; END IF;
  d:=replace(d,x,pairs[i][2]);
 END LOOP;
 EXECUTE d;
 d:=pg_get_functiondef(s);
 IF position('fn_union_pnl_tournament_returns(NULL' in d)>0 OR position('One-time filter (20261001)' in d)=0
  OR position('AND ret.owners IS DISTINCT FROM 1
      AND i.transaction_id=q.transaction_id' in d)=0 THEN
  RAISE EXCEPTION 'flow evidence postimage check failed';
 END IF;
END
$mig$;
COMMIT;
