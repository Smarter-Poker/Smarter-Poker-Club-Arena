DO $$ DECLARE j jsonb;BEGIN
 j:=fn_club_bomb_pot_report_v2('00000000-0000-4000-8000-000000000003',7);
 IF (j->>'window_end')::date-(j->>'window_start')::date<>6 OR (j->>'window_days')::integer<>7 THEN RAISE EXCEPTION 'UTC calendar window wrong: %',j; END IF;
 IF EXISTS(SELECT 1 FROM rollup_calls WHERE day<>(now() AT TIME ZONE 'UTC')::date-3) OR (SELECT count(*) FROM rollup_calls)<>1 THEN RAISE EXCEPTION 'Catchup scans empty days or another club'; END IF;
 IF (SELECT sum((x->>'total_pot')::numeric) FROM jsonb_array_elements(j->'rows') x)<>20 THEN RAISE EXCEPTION 'Boundary day or live hand totals incorrect: %',j; END IF;
 TRUNCATE rollup_calls;
 PERFORM fn_club_bomb_pot_report_v2('00000000-0000-4000-8000-000000000004',30);
 IF EXISTS(SELECT 1 FROM rollup_calls) THEN RAISE EXCEPTION 'Empty hosted club still calls rollups'; END IF;
 IF (SELECT hash FROM bomb_archive_before) IS DISTINCT FROM (SELECT md5(string_agg(to_jsonb(d)::text,',' ORDER BY club_id,day,table_id)) FROM ca_club_bomb_pot_daily d) THEN RAISE EXCEPTION 'Sealed history rewritten'; END IF;
 PERFORM set_config('app.user_id','00000000-0000-4000-8000-000000000009',true);
 BEGIN PERFORM fn_club_bomb_pot_report_v2('00000000-0000-4000-8000-000000000003',7);RAISE EXCEPTION 'Unauthorized bomb read allowed';EXCEPTION WHEN insufficient_privilege THEN NULL;END;
END $$;
