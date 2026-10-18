SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','20000000-0000-0000-0000-000000000001',false);
DO $$ DECLARE v jsonb; b record; BEGIN
 SELECT * INTO b FROM public.fixture_funded_baseline;
 v:=public.ca_player_stats_overview_v2_by_club('20000000-0000-0000-0000-000000000001',30,'UTC','chips','10000000-0000-0000-0000-000000000001');
 IF v->'overall'<>b.overall OR v->'tournaments'<>b.tournaments
 THEN RAISE EXCEPTION 'Funded Stats totals differ from the independently saved pre-host-change baseline: %',v; END IF;
 v:=public.ca_player_stats_club_comparison('20000000-0000-0000-0000-000000000001',30,'chips');
 IF v->'rows'<>b.comparison THEN RAISE EXCEPTION 'Funded club comparison wrong: %',v; END IF;
 v:=public.fixture_all_scoped_stats();
 IF v<>b.readers THEN RAISE EXCEPTION 'Funded Stats tab/evidence mismatch keys: %',
 (SELECT array_agg(key) FROM jsonb_each(v) WHERE value IS DISTINCT FROM b.readers->key); END IF;
END $$;
SELECT set_config('request.jwt.claim.sub','20000000-0000-0000-0000-000000000002',false);
DO $$ BEGIN
 IF public.ca_player_stats_shared_overview_v1('20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001',30,'UTC','chips')->'overview'
   <>(SELECT shared FROM public.fixture_funded_baseline)
 THEN RAISE EXCEPTION 'Funded shared-player Stats mismatch'; END IF;
END $$;
SELECT set_config('request.jwt.claim.sub','20000000-0000-0000-0000-000000000001',false);
SELECT public.fixture_expect_refusal($q$SELECT public.ca_player_stats_overview_v2_by_club('20000000-0000-0000-0000-000000000001',30,'UTC','chips','10000000-0000-0000-0000-000000000002')$q$);
SELECT public.fixture_expect_refusal($q$SELECT public.ca_player_stats_overview_v2_by_club('20000000-0000-0000-0000-000000000002',30,'UTC','chips','10000000-0000-0000-0000-000000000001')$q$);
RESET ROLE;
DO $$ BEGIN
 IF NOT (SELECT proconfig @> ARRAY['statement_timeout=20s','work_mem=64MB','enable_indexscan=off'] FROM pg_proc WHERE oid='public.ca_player_stats_overview_v2_by_club(uuid,integer,text,text,uuid)'::regprocedure)
 THEN RAISE EXCEPTION 'Measured complete-history aggregate read budget missing'; END IF;
 IF has_function_privilege('authenticated','public.fn_member_record_fact_club(public.ca_hand_facts)','EXECUTE')
 THEN RAISE EXCEPTION 'Internal funded witness resolver execute leaked'; END IF;
 IF (SELECT club_id FROM public.ca_hand_facts WHERE hand_id='30000000-0000-0000-0000-000000000001')<>'10000000-0000-0000-0000-000000000002'
 THEN RAISE EXCEPTION 'Stats repair rewrote physical source facts'; END IF;
END $$;
SELECT 'PASS: funded Stats, tournament entrant results, comparison, authorization and source preservation' result;
