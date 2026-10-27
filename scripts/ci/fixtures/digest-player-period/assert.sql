DO $$DECLARE v jsonb; d date; BEGIN
v:=public.fn_sp_digest_player_period('2026-10-25');
IF (select count(*) from public.sp_digest_player_day_runs)<>1 OR v#>>'{period,complete}'<>'false' OR (v#>>'{period,month,missing_days}')::int<>24 THEN RAISE EXCEPTION 'Request unexpectedly computes older history: %',v; END IF;
FOR d IN SELECT g::date FROM generate_series('2026-10-01'::date,'2026-10-24'::date,interval '1 day')g LOOP
PERFORM public.fn_sp_digest_keep_player_day(d,public.fn_sp_digest_player_totals(d)); END LOOP;
v:=public.fn_sp_digest_player_period('2026-10-25');
IF v#>>'{period,complete}' <> 'true' OR (v#>>'{period,month,hands}')::int <> 250 OR (v#>>'{period,week,hands}')::int <> 70 OR (v#>>'{period,month,players}')::int <> 1 OR (v#>>'{period,month,net}')::numeric <> 31.25 OR (v#>>'{period,month,wallet_end}')::numeric <> 100 THEN RAISE EXCEPTION 'Totals failed: %',v; END IF;
IF has_table_privilege('service_role','public.sp_digest_player_days','insert') OR NOT has_table_privilege('service_role','public.sp_digest_player_days','select') THEN RAISE EXCEPTION 'Inherited default table privileges were not removed'; END IF;
IF has_function_privilege('anon','public.fn_sp_digest_player_period(date)','execute') OR has_table_privilege('authenticated','public.sp_digest_player_days','select') THEN RAISE EXCEPTION 'Permission leak'; END IF;
RAISE NOTICE 'PASS exact migration period aggregation: day/week/month, distinct count, wallets, completion, permissions';
END$$;
