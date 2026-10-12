-- After #5552 and #5554 and the opening resolution writer: what still refuses the book.
CREATE FUNCTION public.hx_expect(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'FAIL %',p_msg; END IF; RAISE NOTICE 'PASS %',p_msg; END $$;
SELECT public.hx_expect((public.fn_union_pnl_resolve_opening_registrations(public.u('U'),'2026-09-21 07:00+00',
 'Opening basis 2026-09-21: pre-capture entries re-proved from the posted chip ledger',true)->>'resolved_now')::int=3,'the opening writer resolves o1, o2 and f1');
CREATE TABLE public.hx_old AS SELECT public.fn_union_pnl_evidence_report(public.u('U'),'2026-09-21 07:00+00','2026-09-28 07:00+00') r;
CREATE TABLE public.hx_old_flows AS SELECT * FROM public.fn_union_pnl_original_flow_evidence(public.u('U'),'2026-09-21 07:00+00','2026-09-28 07:00+00');
SELECT public.hx_expect((SELECT r->'issues' FROM public.hx_old)=jsonb_build_array(
  jsonb_build_object('count',2,'reason','accepted_cash_original_scope_missing'),
  jsonb_build_object('count',3,'reason','original_money_flow_basis_incomplete'),
  jsonb_build_object('count',4,'reason','tournament_original_population_or_instrument_incomplete'),
  jsonb_build_object('count',1,'reason','tournament_award_original_earning_owner_incomplete'),
  'accepted_cash_rake_does_not_match_original_earning_and_bank_basis','accepted_cash_deltas_do_not_reconcile_original_flows_and_boundaries'),
 'before: the two unlinked hands, the two cash-outs (moved seat, table_cashout), the unapplied add-on refund, the satellite entries and award, and the rake and cash reconciliation refuse the book '
 ||(SELECT r->>'issues' FROM public.hx_old));
