CREATE FUNCTION public.hx_report() RETURNS jsonb LANGUAGE sql AS $$
 SELECT public.fn_union_pnl_evidence_report(public.u('U'),'2026-09-21 07:00+00','2026-09-28 07:00+00') $$;
CREATE FUNCTION public.hx_raises(p_sql text, p_state text) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE s text;
BEGIN EXECUTE p_sql; RETURN false;
EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS s=RETURNED_SQLSTATE; RETURN s=p_state; END $$;
-- the flow proof: the two cash-outs become cash returns of their original owners; every other row is unchanged
SELECT public.hx_expect((SELECT jsonb_object_agg(f.ledger_id,jsonb_build_array(f.kind,f.valid,f.club_id,f.cashouts))
  FROM public.fn_union_pnl_original_flow_evidence(public.u('U'),'2026-09-21 07:00+00','2026-09-28 07:00+00') f WHERE f.ledger_id IN (public.u('lp1out'),public.u('lp2out'),public.u('lpr1')))
 =jsonb_build_object(public.u('lp1out'),jsonb_build_array('cash_return',true,public.u('A'),109),public.u('lp2out'),jsonb_build_array('cash_return',true,public.u('B'),40.5),
  public.u('lpr1'),jsonb_build_array('cash_return',true,public.u('B'),7)),
 'a moved seat''s cash-out is owned through its move lineage; table_cashout is the cash-out category; an unapplied add-on is refunded to its funder');
SELECT public.hx_expect(NOT EXISTS(
  (SELECT * FROM public.fn_union_pnl_original_flow_evidence(public.u('U'),'2026-09-21 07:00+00','2026-09-28 07:00+00') WHERE ledger_id NOT IN (public.u('lp1out'),public.u('lp2out'),public.u('lpr1')))
  EXCEPT (SELECT * FROM public.hx_old_flows WHERE ledger_id NOT IN (public.u('lp1out'),public.u('lp2out'),public.u('lpr1'))))
 AND (SELECT count(*) FROM public.hx_old_flows)=(SELECT count(*) FROM public.fn_union_pnl_original_flow_evidence(public.u('U'),'2026-09-21 07:00+00','2026-09-28 07:00+00')),
 'every other original flow is identical, row for row');
-- the link writer: dry run, then apply
CREATE TABLE public.hx_dry AS SELECT public.fn_union_pnl_resolve_cash_outcome_links('2026-09-21 07:00+00','2026-09-28 07:00+00',NULL,false) r;
SELECT public.hx_expect((SELECT (r->>'candidates')::int=2 AND (r->>'proven_not_written')::int=2 AND (r->>'refused')::int=0 AND (r->>'evidence_ready')::int=2
  AND (r#>>ARRAY['by_union',public.u('U')::text,'accepted_rake'])::numeric=0.5 FROM public.hx_dry)
 AND NOT EXISTS(SELECT 1 FROM public.union_pnl_cash_outcome_link_resolutions),'link dry run: H (manifest) and H2 (seat inventory) proven, nothing written');
SELECT public.hx_expect((SELECT jsonb_object_agg(p.proof->>'roster_source',jsonb_build_array(p.proof#>>'{evidence,status}',
  (SELECT jsonb_object_agg(x->>'user_id',x->>'earning_club_id') FROM jsonb_array_elements(p.proof#>'{evidence,participants}') x)))
  FROM public.fn_union_pnl_prove_cash_outcome_links('2026-09-21 07:00+00','2026-09-28 07:00+00') p)
 =jsonb_build_object('manifest',jsonb_build_array('ready',jsonb_build_object(public.u('up1'),public.u('A'),public.u('up2'),public.u('B'))),
  'seat_inventory',jsonb_build_array('ready',jsonb_build_object(public.u('up1'),public.u('A'),public.u('up2'),public.u('B')))),
 'each player of each unlinked hand is owned by the club of its original buy-in, through the move');
SELECT public.hx_expect((SELECT (public.fn_union_pnl_resolve_cash_outcome_links('2026-09-21 07:00+00','2026-09-28 07:00+00',
  'Unlinked cash hands 2026-09-21 week: roster and scope re-proved from the manifest or seat inventory',true)->>'resolved_now')::int=2)
 AND (SELECT (public.fn_union_pnl_resolve_cash_outcome_links('2026-09-21 07:00+00','2026-09-28 07:00+00',
  'Unlinked cash hands 2026-09-21 week: roster and scope re-proved from the manifest or seat inventory',true)->>'already_resolved')::int=2),
 'the link writer writes two receipts, once');
CREATE TABLE public.hx_new AS SELECT public.hx_report() r;
SELECT public.hx_expect((SELECT r->>'status'='ready' AND r->'issues'='[]'::jsonb FROM public.hx_new),'after: the book is ready '||(SELECT r->>'issues' FROM public.hx_new));
SELECT public.hx_expect((SELECT (r->>'accepted_cash_hands')::int=2 FROM public.hx_new)
 AND (SELECT jsonb_object_agg(c->>'club_id',jsonb_build_array((c->>'cash_player_pnl')::numeric,(c->'cash_reconciled')::boolean)) FROM public.hx_new,jsonb_array_elements(r->'clubs') c
   WHERE c->>'club_id' IN (public.u('A')::text,public.u('B')::text))
  =jsonb_build_object(public.u('A'),jsonb_build_array(9,true),public.u('B'),jsonb_build_array(-9.5,true)),
 'the linked hands count for Midway: A +9, B -9.5, reconciled with their cash flows');
-- each refusal, alone, in a rolled-back subtransaction
CREATE FUNCTION public.hx_case(p_sql text, p_expect jsonb, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE got jsonb;
BEGIN
 BEGIN
  EXECUTE p_sql; got:=public.hx_report()->'issues';
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hx_rollback',DETAIL=got::text;
 EXCEPTION WHEN raise_exception THEN
  IF SQLERRM<>'hx_rollback' THEN RAISE; END IF;
  GET STACKED DIAGNOSTICS p_sql=PG_EXCEPTION_DETAIL; got:=p_sql::jsonb;
 END;
 PERFORM public.hx_expect(got=p_expect,p_msg||' '||got::text);
END $$;
SELECT public.hx_case($q$UPDATE public.cash_seat_move_receipts SET club_id=public.u('B') WHERE move_id=public.u('mv1')$q$,
 jsonb_build_array(jsonb_build_object('count',1,'reason','original_money_flow_basis_incomplete'),'accepted_cash_deltas_do_not_reconcile_original_flows_and_boundaries'),
 'a moved cash-out whose move custody is another club than its buy-in is refused');
SELECT public.hx_case($q$UPDATE public.cash_funding_application_receipts SET pending_addon_id=public.u('pa-other') WHERE funding_receipt_id=public.u('rpa1')$q$,
 jsonb_build_array(jsonb_build_object('count',1,'reason','original_money_flow_basis_incomplete')),
 'a player_funding credit whose application receipt is not the refund of that funding receipt proves nothing');
SELECT public.hx_case($q$SELECT public.hx_award('as2','T_TGT','us1','ts1','B',5,'{}','2026-09-25 12:05+00')$q$,
 jsonb_build_array(jsonb_build_object('count',1,'reason','tournament_award_original_earning_owner_incomplete')),
 'a satellite-seat award credited to another club than the satellite entry is refused');
SELECT public.hx_case($q$UPDATE public.tournament_tickets SET redeemed_at=redeemed_at+interval '1 minute' WHERE id=public.u('tk2')$q$,
 jsonb_build_array(jsonb_build_object('count',2,'reason','tournament_original_population_or_instrument_incomplete')),
 'a ticket not redeemed by this registration proves nothing');
SELECT public.hx_case($q$UPDATE public.tournament_participant_funding_receipts SET funding_club_id=public.u('A') WHERE id=public.u('rs2')$q$,
 jsonb_build_array(jsonb_build_object('count',2,'reason','tournament_original_population_or_instrument_incomplete')),
 'a satellite entry receipt that disagrees with its ledger debit proves nothing');
DO $$
DECLARE got jsonb;
BEGIN
 BEGIN
  UPDATE public.cash_hand_participant_manifests SET participants=jsonb_set(participants,'{0,stack_before}','99') WHERE id=public.u('mH');
  SELECT jsonb_object_agg(p.hand_number,CASE WHEN p.proof->>'status'='proven' THEN 'proven' ELSE p.proof->>'reason' END) INTO got
   FROM public.fn_union_pnl_prove_cash_outcome_links('2026-09-21 07:00+00','2026-09-28 07:00+00') p;
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hx_rollback',DETAIL=got::text;
 EXCEPTION WHEN raise_exception THEN
  IF SQLERRM<>'hx_rollback' THEN RAISE; END IF;
  GET STACKED DIAGNOSTICS got=PG_EXCEPTION_DETAIL;
 END;
 PERFORM public.hx_expect(got='{"5000001":"original_roster_unproven","5000002":"proven"}'::jsonb,'a manifest that disagrees with the signed stacks is refused '||got::text);
END $$;
DO $$
DECLARE got jsonb;
BEGIN
 BEGIN
  UPDATE public.union_pnl_inventory_events SET after_row=jsonb_set(after_row,'{stack}','111') WHERE source_name='table_seats' AND row_id=public.u('s2')
   AND observed_at='2026-09-22 11:05+00';
  SELECT jsonb_object_agg(p.hand_number,CASE WHEN p.proof->>'status'='proven' THEN 'proven' ELSE p.proof->>'reason' END) INTO got
   FROM public.fn_union_pnl_prove_cash_outcome_links('2026-09-21 07:00+00','2026-09-28 07:00+00') p;
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hx_rollback',DETAIL=got::text;
 EXCEPTION WHEN raise_exception THEN
  IF SQLERRM<>'hx_rollback' THEN RAISE; END IF;
  GET STACKED DIAGNOSTICS got=PG_EXCEPTION_DETAIL;
 END;
 PERFORM public.hx_expect(got='{"5000001":"proven","5000002":"seat_inventory_disagrees_with_dealt_stack"}'::jsonb,'a seat row that disagrees with the dealt stack is refused '||got::text);
END $$;
SELECT public.hx_expect(public.hx_raises('UPDATE public.union_pnl_cash_outcome_link_resolutions SET reason=reason','55000')
 AND public.hx_raises('DELETE FROM public.union_pnl_cash_outcome_link_resolutions','55000'),'link resolutions are immutable');
SET ROLE service_role;
SELECT public.hx_expect(public.hx_raises($q$INSERT INTO public.union_pnl_cash_outcome_link_resolutions SELECT * FROM public.union_pnl_cash_outcome_link_resolutions LIMIT 1$q$,'42501')
 AND public.hx_raises($q$SELECT * FROM public.fn_union_pnl_prove_cash_outcome_links('2026-09-21 07:00+00','2026-09-28 07:00+00')$q$,'42501'),
 'service_role reads link receipts and runs the writer only');
RESET ROLE;
SET ROLE anon;
SELECT public.hx_expect(public.hx_raises($q$SELECT public.fn_union_pnl_resolve_cash_outcome_links('2026-09-21 07:00+00','2026-09-28 07:00+00',NULL,false)$q$,'42501'),
 'the browser cannot run the link writer');
RESET ROLE;
DO $$ BEGIN RAISE NOTICE 'ALL PASS'; END $$;
