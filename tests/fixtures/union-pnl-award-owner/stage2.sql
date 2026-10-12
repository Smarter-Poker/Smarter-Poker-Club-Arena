CREATE FUNCTION public.hx_report(p text) RETURNS jsonb LANGUAGE sql AS $$
 SELECT public.fn_union_pnl_evidence_report(public.u(p),'2026-09-21 07:00+00','2026-09-28 07:00+00') $$;
CREATE TABLE public.hx_new AS SELECT 'U'::text k,public.hx_report('U') r UNION ALL SELECT 'O',public.hx_report('O');
SELECT public.hx_expect((SELECT r->>'status'='ready' AND r->'issues'='[]'::jsonb AND r->'basis_certified'='true'::jsonb FROM public.hx_new WHERE k='U'),
 'after: the book is ready');
SELECT public.hx_expect((SELECT n.r-'status'-'issues'-'basis_certified'-'all_players_included' FROM public.hx_new n WHERE k='U')
 =(SELECT o.r-'status'-'issues'-'basis_certified'-'all_players_included' FROM public.hx_old o WHERE k='U'),
 'every other value of the report is unchanged (clubs, bases, hands, terms)');
SELECT public.hx_expect((SELECT r FROM public.hx_new WHERE k='O')=(SELECT r FROM public.hx_old WHERE k='O'),
 'a Union without resolutions gets the identical report');
-- each refusal, alone, in a rolled-back subtransaction
CREATE FUNCTION public.hx_case(p_sql text, p_reason text, p_count int, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE got jsonb;
BEGIN
 BEGIN
  EXECUTE p_sql; got:=public.hx_report('U')->'issues';
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hx_rollback',DETAIL=got::text;
 EXCEPTION WHEN raise_exception THEN
  IF SQLERRM<>'hx_rollback' THEN RAISE; END IF;
  GET STACKED DIAGNOSTICS p_sql=PG_EXCEPTION_DETAIL; got:=p_sql::jsonb;
 END;
 PERFORM public.hx_expect(got=jsonb_build_array(jsonb_build_object('count',p_count,'reason',p_reason)),p_msg||' '||got::text);
END $$;
SELECT public.hx_case($q$SELECT public.hx_award('n1','T_OK','uo1','o1','B',7,'{}','2026-09-26 10:00+00')$q$,
 'tournament_award_original_earning_owner_incomplete',1,'an award credited to another club than the resolved owner is refused');
SELECT public.hx_case($q$SELECT public.hx_award('n2','T_OK','uo2','o2','B',7,'{}','2026-09-26 10:00+00',8)$q$,
 'tournament_award_original_earning_owner_incomplete',1,'an award whose ledger credit differs is refused');
SELECT public.hx_case($q$SELECT public.hx_award('n3','T_OK','uo2','o1','B',7,'{}','2026-09-26 10:00+00')$q$,
 'tournament_award_original_earning_owner_incomplete',1,'an award whose registration is not the resolved one is refused');
SELECT public.hx_case($q$SELECT public.hx_award('n4','T_OK','uo2','o2','B',7,'{}','2026-09-26 10:00+00',NULL,'refund')$q$,
 'tournament_award_original_earning_owner_incomplete',1,'a ledger credit that is not a prize or bounty is refused');
SELECT public.hx_case($q$UPDATE public.chip_ledger SET status='pending' WHERE id=public.u('lao2')$q$,
 'tournament_award_original_earning_owner_incomplete',1,'an unposted ledger credit is refused');
SELECT public.hx_case($q$SELECT public.hx_award('n5','T_INS','ui9','i9','A',7,'{}','2026-09-26 10:00+00')$q$,
 'tournament_award_original_earning_owner_incomplete',1,'a receipt-less award without a resolution is refused as before');
SELECT public.hx_case($q$SELECT public.hx_touch('i9','T_INS','2026-09-24 11:00+00')$q$,
 'tournament_original_population_or_instrument_incomplete',1,'an unreceipted registration without a resolution is refused as before');
SELECT public.hx_case($q$INSERT INTO public.tournament_participant_funding_receipts(id,registration_id,tournament_id,user_id,asset,amount,observed_at)
 VALUES(public.u('xo1'),public.u('o1'),public.u('T_OK'),public.u('uo1'),'ticket',1,'2026-09-24 12:00+00')$q$,
 'tournament_original_population_or_instrument_incomplete',1,'a resolved registration that also shows a non-chip instrument is refused');
SET ROLE anon;
DO $$ BEGIN
 PERFORM public.fn_union_pnl_award_owner_resolved(NULL,NULL,NULL,NULL); RAISE EXCEPTION 'FAIL the browser can call the award predicate';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS the browser cannot call the award predicate'; END $$;
RESET ROLE;
DO $$ BEGIN RAISE NOTICE 'ALL PASS'; END $$;
