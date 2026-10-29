INSERT INTO public.clubs VALUES(fixture.u(1),fixture.u(10),'chips',false),(fixture.u(2),fixture.u(20),'chips',false),(fixture.u(3),NULL,'diamonds',true);
CREATE FUNCTION fixture.reset()RETURNS void LANGUAGE plpgsql AS $$BEGIN
 TRUNCATE fixture.direct_proofs,fixture.mixed_proofs,public.tournaments,public.accounting_tournament_fee_recognitions,public.tournament_rake_settlements,public.tournament_terminal_settlements,public.tournament_cancellation_receipts,public.tournament_satellite_settlements,public.accounting_tournament_fee_sources,public.rake_records,public.accounting_tournament_fee_batches,public.accounting_tournament_recognized_sources,public.tournament_refund_entitlements,fixture.net_plans;
END$$;
CREATE FUNCTION fixture.event(n integer)RETURNS void LANGUAGE plpgsql AS $$DECLARE t uuid:=fixture.u(n);r uuid:=fixture.u(100000+n);s uuid:=fixture.u(200000+n);fp text;BEGIN
 INSERT INTO public.tournaments VALUES(t,fixture.u(1),fixture.u(10));
 INSERT INTO public.rake_records(id,tournament_id,is_tournament,rake_amount,club_id,created_at,rake_method)VALUES(r,t,true,100,fixture.u(1),'2026-10-06 12:00Z','fixture');
 fp:=public.fn_accounting_tournament_fee_fingerprint((SELECT x FROM public.rake_records x WHERE id=r));
 INSERT INTO public.accounting_tournament_fee_batches VALUES(r,t,'captured',fp,100);
 INSERT INTO public.accounting_tournament_fee_sources VALUES(s,t,r,100,fixture.u(10),fixture.u(10),fixture.u(1),fixture.u(50),jsonb_build_object('player_id',fixture.u(50),'club_id',fixture.u(1),'rake_credit',100,'terms_at','2026-10-06T11:00:00Z','union_id',fixture.u(10),'coordinator_union_id',fixture.u(10),'membership',jsonb_build_object('history_id','fixture')),'2026-10-06 11:00Z');
 INSERT INTO public.accounting_tournament_recognized_sources VALUES(s,t,'2026-10-06 12:00Z','earned',100);
 INSERT INTO public.accounting_tournament_fee_recognitions VALUES(t,'2026-10-06 12:00Z','recognized',100,fixture.u(10),fixture.u(1),md5(fp));
 INSERT INTO public.tournament_rake_settlements VALUES(t,'2026-10-06 12:00Z',100,fixture.u(10),fixture.u(1));
END$$;
CREATE FUNCTION fixture.verdict(f text,club uuid DEFAULT fixture.u(1),a timestamptz DEFAULT '2026-10-05 07:00Z',b timestamptz DEFAULT '2026-10-12 07:00Z')RETURNS jsonb LANGUAGE plpgsql AS $$DECLARE v jsonb;BEGIN EXECUTE format('SELECT %s($1,$2,$3)',f)INTO v USING club,a,b;RETURN v;EXCEPTION WHEN OTHERS THEN RETURN jsonb_build_object('error',SQLERRM,'sqlstate',SQLSTATE);END$$;
