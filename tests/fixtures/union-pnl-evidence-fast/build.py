#!/usr/bin/env python3
"""Builds new/<name>.sql from preimage/<name>.sql by exact, unique text
replacements, so the reviewed change is only what is written here."""
from pathlib import Path
import sys
here = Path(__file__).resolve().parent

def patch(name, pairs, header_fix=False):
    src = (here / 'preimage' / f'{name}.sql').read_text()
    for old, new in pairs:
        n = src.count(old)
        if n != 1:
            sys.exit(f'{name}: needle found {n} times: {old[:90]!r}')
        src = src.replace(old, new)
    if header_fix:
        src = src.replace('CREATE FUNCTION public.', 'CREATE OR REPLACE FUNCTION public.', 1)
    (here / 'new' / f'{name}.sql').write_text(src)

MEMO_NOTE = """ -- UNION P&L EVIDENCE MEMO (20260928): one weekly close reaches this report
 -- through preparation (close quality), the cascade (qualified clubs, ECO,
 -- player P&L) and the invoices. Inside a union close attempt
 -- (app.accounting_close_memo='on', set only by fn_weekly_accounting_attempt_begin)
 -- the first complete report of this (union, week) is kept for the rest of
 -- the attempt; attempt_begin and attempt_end clear it and a rolled-back
 -- subtransaction forgets it with its settings. Everywhere else the report is
 -- proved on every call, exactly as before.
 IF current_setting('app.accounting_close_memo',true)='on' THEN
  v_memo_key:=p_union_id::text||'|'||p_start::text||'|'||p_end::text;
  v_memo:=NULLIF(current_setting('app.union_pnl_evidence_memo',true),'')::jsonb;
  IF v_memo ? v_memo_key THEN RETURN v_memo->v_memo_key; END IF;
 END IF;
"""

patch('fn_union_pnl_evidence_report', [
 ("v_cash_rake numeric; v_accepted_rake numeric;\n",
  "v_cash_rake numeric; v_accepted_rake numeric;\n v_memo_key text; v_memo jsonb; v_report jsonb; v_flows jsonb;\n"),
 (" -- Both readers wait for the original book's in-flight transactions; this\n",
  MEMO_NOTE + " -- Both readers wait for the original book's in-flight transactions; this\n"),
 # v_bad/v_resolved read only the rows the partial index
 # union_pnl_cash_outcomes_unaccepted holds (the predicate below is its
 # predicate, verbatim); the hand count moves into the one outcome pass.
 (""" SELECT count(*),
  count(*) FILTER(WHERE (o.evidence->>'status' IS DISTINCT FROM 'ready' OR o.evidence->'basis_certified' IS DISTINCT FROM 'true'::jsonb
   OR o.evidence->'all_players_included' IS DISTINCT FROM 'true'::jsonb OR o.evidence->'game_scope' IS DISTINCT FROM o.game_scope)
   AND NOT public.fn_union_pnl_cash_outcome_accepted(o)),
  count(*) FILTER(WHERE (o.evidence->>'status' IS DISTINCT FROM 'ready' OR o.evidence->'basis_certified' IS DISTINCT FROM 'true'::jsonb)
   AND public.fn_union_pnl_cash_outcome_accepted(o))
 INTO v_hands,v_bad,v_resolved FROM public.union_pnl_cash_outcomes o WHERE o.game_scope->>'game_union_id'=p_union_id::text AND o.recognized_at>=p_start AND o.recognized_at<p_end;
""",
  """ -- Only a hand outside the ready/certified/all-players/same-scope shape can
 -- be refused or resolved: count those through the partial index
 -- union_pnl_cash_outcomes_unaccepted, whose predicate is the last clause here.
 SELECT count(*) FILTER(WHERE NOT public.fn_union_pnl_cash_outcome_accepted(o)),
  count(*) FILTER(WHERE (o.evidence->>'status' IS DISTINCT FROM 'ready' OR o.evidence->'basis_certified' IS DISTINCT FROM 'true'::jsonb)
   AND public.fn_union_pnl_cash_outcome_accepted(o))
 INTO v_bad,v_resolved FROM public.union_pnl_cash_outcomes o WHERE o.game_scope->>'game_union_id'=p_union_id::text AND o.recognized_at>=p_start AND o.recognized_at<p_end
  AND (o.evidence->>'status' IS DISTINCT FROM 'ready' OR o.evidence->'basis_certified' IS DISTINCT FROM 'true'::jsonb
   OR o.evidence->'all_players_included' IS DISTINCT FROM 'true'::jsonb OR o.evidence->'game_scope' IS DISTINCT FROM o.game_scope);
"""),
 (" SELECT count(*) INTO v_bad FROM public.fn_union_pnl_original_flow_evidence(p_union_id,p_start,p_end) WHERE NOT valid;\n",
  " -- The flow proof is read once; the P&L below reuses these exact rows.\n"
  " SELECT count(*) FILTER(WHERE NOT f.valid),COALESCE(jsonb_agg(to_jsonb(f)),'[]') INTO v_bad,v_flows\n"
  "  FROM public.fn_union_pnl_original_flow_evidence(p_union_id,p_start,p_end) f;\n"),
 (""" SELECT count(*) INTO v_bad FROM public.union_pnl_inventory_events i
 JOIN public.union_pnl_transaction_frames b ON b.transaction_id=i.transaction_id
 WHERE i.source_name='tournament_players' AND b.observed_at>=p_start AND b.observed_at<p_end
  AND EXISTS(SELECT 1 FROM public.union_pnl_inventory_events t WHERE t.source_name='tournaments'
    AND t.row_id::text=COALESCE(i.after_row,i.before_row)->>'tournament_id'
    AND COALESCE(t.after_row,t.before_row)->>'union_id'=p_union_id::text)
""",
  """ -- The week's registration events, each touched tournament's Union proved
 -- once through its own events (t.row_id::text equality kept; the uuid
 -- equality only lets the index find the same rows and is never attempted on
 -- a non-canonical id). The frame test is unchanged; i.observed_at repeats it
 -- because fn_union_pnl_inventory_observe, the only writer of framed events,
 -- stamps each event with its frame's observed_at (both tables immutable), so
 -- the same rows are reached through union_pnl_inventory_events_players_observed.
 WITH touched AS MATERIALIZED (
  SELECT i.row_id,COALESCE(i.after_row,i.before_row)->>'tournament_id' tournament_id
  FROM public.union_pnl_inventory_events i
  JOIN public.union_pnl_transaction_frames b ON b.transaction_id=i.transaction_id
  WHERE i.source_name='tournament_players' AND b.observed_at>=p_start AND b.observed_at<p_end
   AND i.observed_at>=p_start AND i.observed_at<p_end
 ), union_tournaments AS MATERIALIZED (
  SELECT d.tournament_id FROM (SELECT DISTINCT tournament_id FROM touched) d
  WHERE EXISTS(SELECT 1 FROM public.union_pnl_inventory_events t WHERE t.source_name='tournaments'
    AND t.row_id=CASE WHEN d.tournament_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN d.tournament_id::uuid END
    AND t.row_id::text=d.tournament_id
    AND COALESCE(t.after_row,t.before_row)->>'union_id'=p_union_id::text)
 ), union_touched AS MATERIALIZED (
  SELECT i.row_id FROM touched i WHERE i.tournament_id IN (SELECT tournament_id FROM union_tournaments)
 ), entries AS MATERIALIZED (
  -- the two receipt tests, read once per touched registration
  SELECT r.registration_id,
   bool_or(r.asset='chips' AND public.fn_union_pnl_tournament_entry_club(r) IS NOT NULL) has_entry,
   bool_or(r.asset<>'chips' OR public.fn_union_pnl_tournament_entry_club(r) IS NULL) has_other
  FROM public.tournament_participant_funding_receipts r
  WHERE r.registration_id IN (SELECT row_id FROM union_touched)
  GROUP BY r.registration_id
 ) SELECT count(*) INTO v_bad FROM union_touched i LEFT JOIN entries e ON e.registration_id=i.row_id
 WHERE NOT COALESCE(e.has_entry,false) OR COALESCE(e.has_other,false);
"""),
 ("""  AND (NOT EXISTS(SELECT 1 FROM public.tournament_participant_funding_receipts r WHERE r.registration_id=i.row_id AND r.asset='chips' AND public.fn_union_pnl_tournament_entry_club(r) IS NOT NULL)
   OR EXISTS(SELECT 1 FROM public.tournament_participant_funding_receipts r WHERE r.registration_id=i.row_id AND (r.asset<>'chips' OR public.fn_union_pnl_tournament_entry_club(r) IS NULL)));
""", ""),
 (" WITH flows AS MATERIALIZED (SELECT * FROM public.fn_union_pnl_original_flow_evidence(p_union_id,p_start,p_end)),\n",
  " WITH flows AS MATERIALIZED (SELECT * FROM jsonb_to_recordset(v_flows)\n"
  "  AS f(ledger_id uuid,club_id uuid,user_id uuid,buyins numeric,cashouts numeric,kind text,valid boolean)),\n"),
 (""" hand_players AS MATERIALIZED (
  SELECT (p->>'earning_club_id')::uuid club_id,(p->>'user_id')::uuid user_id,(p->>'observed_stack_delta')::numeric delta
  FROM public.union_pnl_cash_outcomes o CROSS JOIN LATERAL jsonb_array_elements(COALESCE(o.evidence->'participants','[]')) p
  WHERE o.game_scope->>'game_union_id'=p_union_id::text AND o.recognized_at>=p_start AND o.recognized_at<p_end
 ), opening AS""",
  """ -- One read of the week's hands: each (club, player) delta total, and (kind 0)
 -- the hand count and accepted rake that used to cost two more reads.
 outcome_pass AS MATERIALIZED (
  SELECT x.kind,x.club_id,x.user_id,sum(x.delta) delta,count(*) hands,sum(x.rake) rake
  FROM public.union_pnl_cash_outcomes o CROSS JOIN LATERAL (
   SELECT 0 kind,NULL::uuid club_id,NULL::uuid user_id,NULL::numeric delta,(o.evidence->>'accepted_rake')::numeric rake
   UNION ALL
   SELECT 1,(p->>'earning_club_id')::uuid,(p->>'user_id')::uuid,(p->>'observed_stack_delta')::numeric,NULL::numeric
   FROM jsonb_array_elements(COALESCE(o.evidence->'participants','[]')) p) x
  WHERE o.game_scope->>'game_union_id'=p_union_id::text AND o.recognized_at>=p_start AND o.recognized_at<p_end
  GROUP BY x.kind,x.club_id,x.user_id
 ), hand_players AS (SELECT club_id,user_id,delta FROM outcome_pass WHERE kind=1), opening AS"""),
 ("  COALESCE(bool_and(cash_reconciled),true),count(*),COALESCE(sum(cash_rake),0) INTO v_clubs,v_cash_reconciled,v_rows,v_cash_rake FROM complete q;\n",
  "  COALESCE(bool_and(cash_reconciled),true),count(*),COALESCE(sum(cash_rake),0),\n"
  "  COALESCE((SELECT h.hands FROM outcome_pass h WHERE h.kind=0),0),(SELECT COALESCE(sum(h.rake),0) FROM outcome_pass h WHERE h.kind=0)\n"
  "  INTO v_clubs,v_cash_reconciled,v_rows,v_cash_rake,v_hands,v_accepted_rake FROM complete q;\n"),
 (""" SELECT COALESCE(sum((evidence->>'accepted_rake')::numeric),0) INTO v_accepted_rake FROM public.union_pnl_cash_outcomes
  WHERE game_scope->>'game_union_id'=p_union_id::text AND recognized_at>=p_start AND recognized_at<p_end;
""", ""),
 (" RETURN jsonb_build_object('report_version',1,'status',CASE WHEN v_issues='[]'::jsonb THEN 'ready' ELSE 'blocked' END,\n",
  " v_report:=jsonb_build_object('report_version',1,'status',CASE WHEN v_issues='[]'::jsonb THEN 'ready' ELSE 'blocked' END,\n"),
 ("  'all_players_included',v_issues='[]'::jsonb,'tournament_basis','original_realized_settlement_deferred_while_open');\nEND $function$",
  "  'all_players_included',v_issues='[]'::jsonb,'tournament_basis','original_realized_settlement_deferred_while_open');\n"
  " IF v_memo_key IS NOT NULL THEN\n"
  "  PERFORM set_config('app.union_pnl_evidence_memo',(COALESCE(NULLIF(current_setting('app.union_pnl_evidence_memo',true),'')::jsonb,'{}')\n"
  "   ||jsonb_build_object(v_memo_key,v_report))::text,true);\n"
  " END IF;\n"
  " RETURN v_report;\nEND $function$"),
])

patch('fn_union_pnl_boundary', [
 ("lineage jsonb; owned uuid; owners int; initial int; value numeric; entries int; first_op text;\n",
  "lineage jsonb; owned uuid; owners int; initial int; value numeric; entries int; first_op text;\n nonchips boolean; changed boolean; returned numeric;\n"),
 ("""  FOR s IN SELECT x->'row' FROM jsonb_array_elements(COALESCE(inv#>'{population,tournament_players}','[]')) x
   WHERE x#>>'{row,tournament_id}'=t->>'id' LOOP
   SELECT count(*),count(DISTINCT public.fn_union_pnl_tournament_entry_club(r)),min(public.fn_union_pnl_tournament_entry_club(r)::text)::uuid,
    sum(amount) INTO entries,owners,owned,value
   FROM public.tournament_participant_funding_receipts r
   JOIN public.union_pnl_transaction_frames b ON b.transaction_id=r.transaction_id
   WHERE r.tournament_id=(t->>'id')::uuid AND registration_id=(s->>'id')::uuid AND b.observed_at<p_at AND asset='chips';
   IF entries=0 OR owners<>1 OR owned IS NULL OR EXISTS(SELECT 1 FROM public.tournament_participant_funding_receipts r WHERE r.tournament_id=(t->>'id')::uuid AND registration_id=(s->>'id')::uuid AND asset<>'chips') THEN
""",
  """  -- One set-based read per open tournament (it was four queries per seat,
  -- two of them full scans of every tournament credit): the same original
  -- entry, instrument, owner-change and returned-credit facts, per
  -- registration, in the population's order.
  FOR s,entries,owners,owned,value,nonchips,changed,returned IN
   WITH players AS MATERIALIZED (
    SELECT y.x->'row' s,y.o ord,(y.x#>>'{row,id}')::uuid registration_id,(y.x#>>'{row,user_id}')::uuid user_id
    FROM jsonb_array_elements(COALESCE(inv#>'{population,tournament_players}','[]')) WITH ORDINALITY y(x,o)
    WHERE y.x#>>'{row,tournament_id}'=t->>'id'
   ), credits AS MATERIALIZED (
    -- fn_union_pnl_tournament_returns(t,NULL,NULL,p_at): every credit of this
    -- tournament observed before the boundary; the registration filter that
    -- function applied per call is applied per player below.
    SELECT c.user_id,c.credited_club_id,c.amount,c.entry_receipt_ids,true same_tournament
    FROM public.tournament_accounting_credit_receipts c
    JOIN public.union_pnl_transaction_frames b ON b.transaction_id=c.transaction_id
    WHERE c.tournament_id=(t->>'id')::uuid AND b.observed_at<p_at
    UNION ALL
    SELECT r2.user_id,r2.source_wallet_club_id,r2.amount_paid_now,ARRAY[r.id],false
    FROM public.tournament_refund_tranches r2
    JOIN public.tournament_participant_funding_receipts r ON r.entitlement_id=r2.entitlement_id
    JOIN public.union_pnl_transaction_frames b ON b.transaction_id=r2.transaction_id
    WHERE r2.tournament_id=(t->>'id')::uuid AND b.observed_at<p_at
     AND NOT EXISTS(SELECT 1 FROM public.tournament_accounting_credit_receipts c WHERE c.ledger_id=r2.credit_ledger_id)
   ) SELECT p.s,e.entries,e.owners,e.owned,e.value,
    EXISTS(SELECT 1 FROM public.tournament_participant_funding_receipts r WHERE r.tournament_id=(t->>'id')::uuid AND r.registration_id=p.registration_id AND r.asset<>'chips'),
    k.changed,k.returned
   FROM players p
   CROSS JOIN LATERAL (SELECT count(*) entries,count(DISTINCT public.fn_union_pnl_tournament_entry_club(r)) owners,
     min(public.fn_union_pnl_tournament_entry_club(r)::text)::uuid owned,sum(r.amount) value
    FROM public.tournament_participant_funding_receipts r
    JOIN public.union_pnl_transaction_frames b ON b.transaction_id=r.transaction_id
    WHERE r.tournament_id=(t->>'id')::uuid AND r.registration_id=p.registration_id AND b.observed_at<p_at AND r.asset='chips') e
   CROSS JOIN LATERAL (SELECT COALESCE(bool_or(c.credited_club_id<>e.owned),false) changed,sum(c.amount) returned
    FROM credits c WHERE c.user_id=p.user_id
     AND EXISTS(SELECT 1 FROM public.tournament_participant_funding_receipts r
      WHERE r.registration_id=p.registration_id AND r.id=ANY(c.entry_receipt_ids)
       AND (NOT c.same_tournament OR r.tournament_id=(t->>'id')::uuid))) k
   ORDER BY p.ord
  LOOP
   IF entries=0 OR owners<>1 OR owned IS NULL OR nonchips THEN
"""),
 ("""   IF EXISTS(SELECT 1 FROM public.fn_union_pnl_tournament_returns((t->>'id')::uuid,(s->>'id')::uuid,NULL,p_at) c
     JOIN public.union_pnl_transaction_frames b ON b.transaction_id=c.transaction_id
     WHERE c.tournament_id=(t->>'id')::uuid AND c.user_id=(s->>'user_id')::uuid AND b.observed_at<p_at
      AND EXISTS(SELECT 1 FROM public.tournament_participant_funding_receipts r
       WHERE r.registration_id=(s->>'id')::uuid AND r.id=ANY(c.entry_receipt_ids)) AND c.credited_club_id<>owned) THEN
""", "   IF changed THEN\n"),
 ("""   SELECT value-COALESCE(sum(c.amount),0) INTO value FROM public.fn_union_pnl_tournament_returns((t->>'id')::uuid,(s->>'id')::uuid,NULL,p_at) c
    JOIN public.union_pnl_transaction_frames b ON b.transaction_id=c.transaction_id
    WHERE c.tournament_id=(t->>'id')::uuid AND c.user_id=(s->>'user_id')::uuid AND b.observed_at<p_at
      AND EXISTS(SELECT 1 FROM public.tournament_participant_funding_receipts r
       WHERE r.registration_id=(s->>'id')::uuid AND r.id=ANY(c.entry_receipt_ids));
""", "   value:=value-COALESCE(returned,0);\n"),
])

for n in ['fn_weekly_accounting_attempt_begin', 'fn_weekly_accounting_attempt_end']:
    patch(n, [(" PERFORM set_config('app.accounting_earned_plan_memo','',true);\n",
               " PERFORM set_config('app.accounting_earned_plan_memo','',true);\n PERFORM set_config('app.union_pnl_evidence_memo','',true);\n")],
          header_fix=True)
print('built', sorted(p.name for p in (here / 'new').glob('*.sql')))
