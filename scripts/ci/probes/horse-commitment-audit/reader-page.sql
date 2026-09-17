-- PREPARED, UNEXECUTED; disposable database with exact source schema and normal
-- auth.role()/anon/authenticated/service_role provisioned by approved provider.
-- Apply reader.sql separately. Every fixture mutation rolls back. No production.
BEGIN;
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.role','service_role',true);
-- Role execution is tested before owner inserts. Unknown/empty day is honest.
DO $test$ DECLARE p jsonb; BEGIN
 p:=public.fn_horse_commitment_review_page(DATE '2020-01-01');
 IF p->>'sourceCoverage'<>'not_established' OR p->>'dayObservation'<>'missing' OR p->'rows'<>'[]'::jsonb OR p->'gtoVerified'<>'false'::jsonb THEN RAISE EXCEPTION 'empty_scope'; END IF;
END $test$;
RESET ROLE;
INSERT INTO public.horse_commitment_audit_days(day) VALUES('2020-01-01');
INSERT INTO public.horse_commitment_reviews(hand_id,horse_user_id,table_id,played_at,source_payload_hash,game_variant,format,seats,big_blind,net_contribution,returned_uncalled,committed_amount,committed_bb,eligibility,reasons)
SELECT ('30000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,'20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','2020-01-01T01:00:00.000001Z',repeat('a',64),'nlh','cash',2,1,21,0,21,21,'over_10bb',ARRAY['decision_replay_not_matched','reference_not_matched'] FROM generate_series(1,17)i;
-- Corrupt/oversized diagnostic rows are per-row sentinels, never expanded on wire.
UPDATE public.horse_commitment_reviews SET reasons=ARRAY[['nested']] WHERE hand_id='30000000-0000-4000-8000-000000000002';
UPDATE public.horse_commitment_reviews SET reasons=ARRAY[repeat('x',20000)] WHERE hand_id='30000000-0000-4000-8000-000000000003';
UPDATE public.horse_commitment_reviews SET eligibility='unknown',big_blind=1e1000::numeric WHERE hand_id='30000000-0000-4000-8000-000000000004';
INSERT INTO public.horse_commitment_audit_gaps(hand_id,played_at,reasons) VALUES('30000000-0000-4000-8000-000000000005','2020-01-01T01:00:00.000001Z',ARRAY[['nested']]);
UPDATE public.horse_commitment_reviews SET reasons=ARRAY[repeat(E'\001',159),repeat(E'\001',159),repeat(E'\001',159),repeat(E'\001',159),repeat(E'\001',159),repeat(E'\001',159),repeat(E'\001',159)] WHERE hand_id='30000000-0000-4000-8000-000000000006';
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.role','service_role',true);
DO $test$ DECLARE p jsonb;q jsonb;z jsonb;i integer; BEGIN
 p:=public.fn_horse_commitment_review_page('2020-01-01');
 IF jsonb_array_length(p->'rows')<>8 OR p->'hasMore'<>'true'::jsonb OR octet_length(p::text)>65536 THEN RAISE EXCEPTION 'first_page'; END IF;
 IF p#>>'{rows,0,status}'<>'retained_diagnostic' THEN RAISE EXCEPTION 'ordinary_row'; END IF;
 FOR i IN 1..5 LOOP IF p#>>ARRAY['rows',i::text,'status']<>'payload_unavailable' THEN RAISE EXCEPTION 'bounded_sentinel_%',i; END IF; END LOOP;
 q:=public.fn_horse_commitment_review_page('2020-01-01',(p#>>'{next,playedAt}')::timestamptz,(p#>>'{next,handId}')::uuid,(p#>>'{next,horseId}')::uuid);
 IF jsonb_array_length(q->'rows')<>8 OR q->'hasMore'<>'true'::jsonb OR q#>>'{rows,0,handId}'<>'30000000-0000-4000-8000-000000000009' THEN RAISE EXCEPTION 'second_page'; END IF;
 z:=public.fn_horse_commitment_review_page('2020-01-01',(q#>>'{next,playedAt}')::timestamptz,(q#>>'{next,handId}')::uuid,(q#>>'{next,horseId}')::uuid);
 IF jsonb_array_length(z->'rows')<>1 OR z->'hasMore'<>'false'::jsonb THEN RAISE EXCEPTION 'explicit_resume'; END IF;
 BEGIN PERFORM public.fn_horse_commitment_review_page('2020-01-01','2020-01-01T01:00Z'); RAISE EXCEPTION 'partial_cursor_accepted'; EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
 BEGIN PERFORM public.fn_horse_commitment_review_page('2020-01-01',NULL,NULL,NULL,9); RAISE EXCEPTION 'invalid_limit_accepted'; EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
 BEGIN PERFORM public.fn_horse_commitment_review_page((statement_timestamp() AT TIME ZONE 'UTC')::date); RAISE EXCEPTION 'open_day_accepted'; EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
 BEGIN PERFORM public.fn_horse_commitment_review_page('2020-01-01','2020-01-02T00:00Z','30000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001'); RAISE EXCEPTION 'outside_day_accepted'; EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
 BEGIN PERFORM * FROM public.horse_commitment_reviews LIMIT 1; RAISE EXCEPTION 'table_select_granted'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $test$;
RESET ROLE;
INSERT INTO public.horse_commitment_audit_days(day) VALUES('2020-01-02');
INSERT INTO public.horse_commitment_reviews(hand_id,horse_user_id,table_id,played_at,source_payload_hash,game_variant,format,seats,big_blind,net_contribution,returned_uncalled,committed_amount,committed_bb,eligibility,reasons)
SELECT ('31000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,'20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','2020-01-02T01:00:00.000001Z',repeat('a',64),'plo4','spin',3,1,21,0,21,21,'over_10bb',ARRAY[]::text[] FROM generate_series(1,8)i;
INSERT INTO public.horse_commitment_reviews(hand_id,horse_user_id,table_id,played_at,source_payload_hash,game_variant,format,seats,big_blind,net_contribution,returned_uncalled,committed_amount,committed_bb,eligibility,reasons)
VALUES('31000000-0000-4000-8000-000000000008','20000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001','2020-01-02T01:00:00.000001Z',repeat('a',64),'plo4','spin',3,1,21,0,21,21,'over_10bb',ARRAY[]::text[]),
('31000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000001','2020-01-02T01:00:00.000002Z',repeat('a',64),'plo4','spin',3,1,21,0,21,21,'over_10bb',ARRAY[]::text[]);
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.role','service_role',true);
SET LOCAL timezone='Pacific/Honolulu';
DO $test$ DECLARE p jsonb;q jsonb; BEGIN
 p:=public.fn_horse_commitment_review_page('2020-01-02');
 q:=public.fn_horse_commitment_review_page('2020-01-02',(p#>>'{next,playedAt}')::timestamptz,(p#>>'{next,handId}')::uuid,(p#>>'{next,horseId}')::uuid);
 IF p#>>'{next,handId}'<>'31000000-0000-4000-8000-000000000008' OR p#>>'{next,horseId}'<>'20000000-0000-4000-8000-000000000001'
  OR jsonb_array_length(q->'rows')<>2 OR q#>>'{rows,0,horseId}'<>'20000000-0000-4000-8000-000000000002'
  OR q#>>'{rows,1,playedAt}'<>'2020-01-02T01:00:00.000002Z' THEN RAISE EXCEPTION 'tuple_third_key_or_microseconds'; END IF;
END $test$;
RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.role','authenticated',true);
DO $test$ BEGIN BEGIN PERFORM public.fn_horse_commitment_review_page('2020-01-01'); RAISE EXCEPTION 'authenticated_execute'; EXCEPTION WHEN insufficient_privilege THEN NULL; END; END $test$;
RESET ROLE;
SET LOCAL ROLE anon;
SELECT set_config('request.jwt.claim.role','anon',true);
DO $test$ BEGIN BEGIN PERFORM public.fn_horse_commitment_review_page('2020-01-01'); RAISE EXCEPTION 'anon_execute'; EXCEPTION WHEN insufficient_privilege THEN NULL; END; END $test$;
RESET ROLE;
DO $test$ BEGIN
 IF has_function_privilege('anon','public.fn_horse_commitment_review_page(date,timestamptz,uuid,uuid,integer)','EXECUTE') OR has_function_privilege('authenticated','public.fn_horse_commitment_review_page(date,timestamptz,uuid,uuid,integer)','EXECUTE') THEN RAISE EXCEPTION 'rpc_acl'; END IF;
 IF has_table_privilege('service_role','public.horse_commitment_reviews','SELECT,INSERT,UPDATE,DELETE') THEN RAISE EXCEPTION 'table_acl'; END IF;
END $test$;
ROLLBACK;
