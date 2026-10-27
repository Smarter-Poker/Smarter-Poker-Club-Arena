\set ON_ERROR_STOP on
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('fixture.uid',true),'')::uuid $$;
CREATE FUNCTION public.fn_caller_is_engine() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT coalesce(current_setting('fixture.engine',true),'true')::boolean $$;
CREATE FUNCTION public.fn_is_platform_admin() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
CREATE TABLE public.clubs(id uuid PRIMARY KEY);
CREATE TABLE public.union_clubs(club_id uuid);
CREATE TABLE public.rake_records(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,club_id uuid REFERENCES public.clubs(id) ON DELETE SET NULL,created_at timestamptz NOT NULL,rake_amount numeric NOT NULL);
CREATE INDEX idx_rake_records_union_signed_window ON public.rake_records(club_id,created_at) INCLUDE(rake_amount);
CREATE INDEX idx_rake_records_date ON public.rake_records(created_at);
CREATE TABLE public.club_rake_rollup_complete(club_id uuid,day date,PRIMARY KEY(club_id,day));
CREATE TABLE public.financial_alerts(severity text,source text,message text,context jsonb);
CREATE TABLE public.fixture_calls(club_id uuid,day date);
CREATE FUNCTION public.fn_club_rake_rollup_day(p_club uuid,p_day date) RETURNS integer LANGUAGE plpgsql AS $$
BEGIN
  IF p_club='00000000-0000-0000-0000-000000000003'::uuid THEN RAISE EXCEPTION 'fixture_rollup_failure'; END IF;
  INSERT INTO fixture_calls VALUES(p_club,p_day);
  INSERT INTO club_rake_rollup_complete VALUES(p_club,p_day);
  RETURN 7;
END $$;
CREATE FUNCTION public.fn_club_table_daily_catchup(p_days integer) RETURNS jsonb LANGUAGE sql AS $$ SELECT jsonb_build_object('success',true,'days',p_days) $$;
INSERT INTO clubs SELECT ('00000000-0000-0000-0000-'||lpad(g::text,12,'0'))::uuid FROM generate_series(1,7)g;
-- Recent positive/zero/negative and the exact inclusive oldest source boundary.
INSERT INTO rake_records(club_id,created_at,rake_amount)
SELECT ('00000000-0000-0000-0000-'||lpad(c::text,12,'0'))::uuid,
       CASE WHEN c=4 THEN (current_date-4)::timestamptz ELSE (current_date-1)::timestamptz END,
       CASE WHEN c=2 THEN 0 WHEN c=3 THEN -1 ELSE 1 END
FROM generate_series(1,4)c CROSS JOIN generate_series(1,5000)g;
INSERT INTO rake_records(club_id,created_at,rake_amount) VALUES
('00000000-0000-0000-0000-000000000005',(current_date-4)::timestamptz-interval '1 microsecond',9),
(NULL,now(),9),
('00000000-0000-0000-0000-000000000007',now(),9);
DELETE FROM clubs WHERE id='00000000-0000-0000-0000-000000000007';
INSERT INTO union_clubs VALUES('00000000-0000-0000-0000-000000000006');
DO $$ BEGIN
  BEGIN
    INSERT INTO rake_records(club_id,created_at,rake_amount) VALUES('00000000-0000-0000-0000-000000000099',now(),1);
    RAISE EXCEPTION 'nonexistent club was accepted';
  EXCEPTION WHEN foreign_key_violation THEN NULL; END;
  IF EXISTS(SELECT 1 FROM rake_records WHERE club_id='00000000-0000-0000-0000-000000000007') THEN RAISE EXCEPTION 'deleted club was retained'; END IF;
END $$;
ANALYZE clubs;
ANALYZE rake_records;
CREATE FUNCTION public.fixture_case(p_days integer) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE result jsonb; calls jsonb; marks jsonb; alerts jsonb;
BEGIN
  TRUNCATE fixture_calls,club_rake_rollup_complete,financial_alerts;
  INSERT INTO club_rake_rollup_complete VALUES('00000000-0000-0000-0000-000000000001',current_date-1);
  result:=public.fn_club_rake_rollup_catchup(p_days);
  SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY club_id,day),'[]') INTO calls FROM fixture_calls c;
  SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY club_id,day),'[]') INTO marks FROM club_rake_rollup_complete c;
  SELECT coalesce(jsonb_agg(jsonb_build_object('severity',severity,'source',source,'message',message,'context',context-'ran_at') ORDER BY source),'[]') INTO alerts FROM financial_alerts;
  RETURN jsonb_build_object('result',result-'ran_at','calls',calls,'marks',marks,'alerts',alerts);
END $$;
CREATE TABLE fixture_expected(p_days integer,report jsonb);

CREATE OR REPLACE FUNCTION public.fn_club_rake_rollup_catchup(p_days integer DEFAULT 3)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '600s'
AS $function$
DECLARE
  rec record; d date;
  v_days int := 0; v_rows int := 0; v_fail int := 0; v_gaps int := 0;
  v_ctd jsonb;
BEGIN
  IF NOT public.fn_caller_is_engine() AND (auth.uid() IS NULL OR ( NOT public.fn_is_platform_admin())) THEN
    RAISE EXCEPTION 'not_authorised';
  END IF;

  FOR rec IN
    SELECT DISTINCT club_id FROM union_clubs
    UNION
    SELECT DISTINCT r.club_id FROM rake_records r
     WHERE r.club_id IS NOT NULL
       AND r.created_at >= current_date - GREATEST(p_days,1) - 1
  LOOP
    FOR d IN
      SELECT gs::date FROM generate_series(
               current_date - GREATEST(p_days,1), current_date - 1, interval '1 day') gs
    LOOP
      IF EXISTS (SELECT 1 FROM club_rake_rollup_complete
                  WHERE club_id = rec.club_id AND day = d) THEN
        CONTINUE;
      END IF;
      BEGIN
        v_rows := v_rows + public.fn_club_rake_rollup_day(rec.club_id, d);
        v_days := v_days + 1;
      EXCEPTION WHEN OTHERS THEN
        v_fail := v_fail + 1;
      END;
    END LOOP;
  END LOOP;

  SELECT count(*) INTO v_gaps
    FROM (SELECT DISTINCT club_id AS cid FROM rake_records
           WHERE created_at >= current_date - GREATEST(p_days,1) - 1
             AND club_id IS NOT NULL) src
    CROSS JOIN generate_series(current_date - GREATEST(p_days,1),
                               current_date - 1, interval '1 day') g
   WHERE NOT EXISTS (SELECT 1 FROM club_rake_rollup_complete rc
                      WHERE rc.club_id = src.cid AND rc.day = g::date);

  IF v_gaps > 0 THEN
    INSERT INTO financial_alerts (severity, source, message, context)
    VALUES ('warning', 'fn_club_rake_rollup_catchup',
            'Club rake rollup has uncovered days - the live downline view is falling back to full scans',
            jsonb_build_object('gap_club_days', v_gaps, 'lookback_days', p_days,
                               'failures', v_fail, 'ran_at', now()));
  END IF;

  -- Club Data screen rollup. Additive; never allowed to break the above.
  BEGIN
    v_ctd := public.fn_club_table_daily_catchup(2);
  EXCEPTION WHEN OTHERS THEN
    v_ctd := jsonb_build_object('success', false, 'error', SQLERRM);
  END;

  RETURN jsonb_build_object('days_built', v_days, 'rows', v_rows,
                            'failures', v_fail, 'remaining_gaps', v_gaps,
                            'club_table_daily', v_ctd,
                            'ran_at', now());
END $function$;

REVOKE ALL ON FUNCTION public.fn_club_rake_rollup_catchup(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_club_rake_rollup_catchup(integer) TO service_role;
DO $$ BEGIN
  IF md5((SELECT prosrc FROM pg_proc WHERE oid='public.fn_club_rake_rollup_catchup(integer)'::regprocedure))<>'44fcd6e3e1afb37db33498a2aac98c05' THEN RAISE EXCEPTION 'baseline is not exact installed body'; END IF;
END $$;
INSERT INTO fixture_expected SELECT d,fixture_case(d) FROM unnest(ARRAY[0,1,3,NULL]::integer[])d;
DO $$ DECLARE r jsonb; BEGIN
  SELECT report->'result' INTO r FROM fixture_expected WHERE p_days=3;
  IF (r->>'days_built')::integer<>11 OR (r->>'rows')::integer<>77 OR (r->>'failures')::integer<>3 OR (r->>'remaining_gaps')::integer<>3
     OR r->'club_table_daily'<>jsonb_build_object('success',true,'days',2) THEN RAISE EXCEPTION 'baseline boundaries are wrong: %',r; END IF;
END $$;
BEGIN;
-- Function-only follow-up: retain exact day/club coverage and all rollup calls.
-- A validated FK makes clubs + EXISTS identical to non-null rake club DISTINCT.
DO $caller_preimage$
BEGIN
  IF md5((SELECT prosrc FROM pg_proc WHERE oid = 'public.fn_club_rake_rollup_catchup(integer)'::regprocedure)) <> '44fcd6e3e1afb37db33498a2aac98c05' THEN
    RAISE EXCEPTION 'club_rake_catchup_preimage_changed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.rake_records'::regclass
                    AND confrelid = 'public.clubs'::regclass AND contype = 'f'
                    AND convalidated AND confdeltype = 'n'
                    AND conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = 'public.rake_records'::regclass AND attname = 'club_id')]::smallint[]
                    AND confkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = 'public.clubs'::regclass AND attname = 'id')]::smallint[]) THEN
    RAISE EXCEPTION 'club_rake_catchup_club_fk_unproved';
  END IF;
END $caller_preimage$;

CREATE OR REPLACE FUNCTION public.fn_club_rake_rollup_catchup(p_days integer DEFAULT 3)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '600s'
AS $function$
DECLARE
  rec record; d date;
  v_days int := 0; v_rows int := 0; v_fail int := 0; v_gaps int := 0;
  v_ctd jsonb;
BEGIN
  IF NOT public.fn_caller_is_engine() AND (auth.uid() IS NULL OR ( NOT public.fn_is_platform_admin())) THEN
    RAISE EXCEPTION 'not_authorised';
  END IF;

  FOR rec IN
    SELECT DISTINCT club_id FROM union_clubs
    UNION
    SELECT c.id AS club_id FROM public.clubs c
     WHERE EXISTS (SELECT 1 FROM public.rake_records r
                    WHERE r.club_id = c.id
                      AND r.created_at >= current_date - GREATEST(p_days,1) - 1)
  LOOP
    FOR d IN
      SELECT gs::date FROM generate_series(
               current_date - GREATEST(p_days,1), current_date - 1, interval '1 day') gs
    LOOP
      IF EXISTS (SELECT 1 FROM club_rake_rollup_complete
                  WHERE club_id = rec.club_id AND day = d) THEN
        CONTINUE;
      END IF;
      BEGIN
        v_rows := v_rows + public.fn_club_rake_rollup_day(rec.club_id, d);
        v_days := v_days + 1;
      EXCEPTION WHEN OTHERS THEN
        v_fail := v_fail + 1;
      END;
    END LOOP;
  END LOOP;

  SELECT count(*) INTO v_gaps
    FROM (SELECT c.id AS cid FROM public.clubs c
           WHERE EXISTS (SELECT 1 FROM public.rake_records r
                          WHERE r.club_id = c.id
                            AND r.created_at >= current_date - GREATEST(p_days,1) - 1)) src
    CROSS JOIN generate_series(current_date - GREATEST(p_days,1),
                               current_date - 1, interval '1 day') g
   WHERE NOT EXISTS (SELECT 1 FROM club_rake_rollup_complete rc
                      WHERE rc.club_id = src.cid AND rc.day = g::date);

  IF v_gaps > 0 THEN
    INSERT INTO financial_alerts (severity, source, message, context)
    VALUES ('warning', 'fn_club_rake_rollup_catchup',
            'Club rake rollup has uncovered days - the live downline view is falling back to full scans',
            jsonb_build_object('gap_club_days', v_gaps, 'lookback_days', p_days,
                               'failures', v_fail, 'ran_at', now()));
  END IF;

  -- Club Data screen rollup. Additive; never allowed to break the above.
  BEGIN
    v_ctd := public.fn_club_table_daily_catchup(2);
  EXCEPTION WHEN OTHERS THEN
    v_ctd := jsonb_build_object('success', false, 'error', SQLERRM);
  END;

  RETURN jsonb_build_object('days_built', v_days, 'rows', v_rows,
                            'failures', v_fail, 'remaining_gaps', v_gaps,
                            'club_table_daily', v_ctd,
                            'ran_at', now());
END $function$;

REVOKE ALL ON FUNCTION public.fn_club_rake_rollup_catchup(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_club_rake_rollup_catchup(integer) TO service_role;

ROLLBACK;
DO $$ BEGIN
 IF md5((SELECT prosrc FROM pg_proc WHERE oid='public.fn_club_rake_rollup_catchup(integer)'::regprocedure))<>'44fcd6e3e1afb37db33498a2aac98c05' THEN RAISE EXCEPTION 'installation rollback did not preserve old body'; END IF;
END $$;
-- Function-only follow-up: retain exact day/club coverage and all rollup calls.
-- A validated FK makes clubs + EXISTS identical to non-null rake club DISTINCT.
DO $caller_preimage$
BEGIN
  IF md5((SELECT prosrc FROM pg_proc WHERE oid = 'public.fn_club_rake_rollup_catchup(integer)'::regprocedure)) <> '44fcd6e3e1afb37db33498a2aac98c05' THEN
    RAISE EXCEPTION 'club_rake_catchup_preimage_changed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.rake_records'::regclass
                    AND confrelid = 'public.clubs'::regclass AND contype = 'f'
                    AND convalidated AND confdeltype = 'n'
                    AND conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = 'public.rake_records'::regclass AND attname = 'club_id')]::smallint[]
                    AND confkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = 'public.clubs'::regclass AND attname = 'id')]::smallint[]) THEN
    RAISE EXCEPTION 'club_rake_catchup_club_fk_unproved';
  END IF;
END $caller_preimage$;

CREATE OR REPLACE FUNCTION public.fn_club_rake_rollup_catchup(p_days integer DEFAULT 3)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '600s'
AS $function$
DECLARE
  rec record; d date;
  v_days int := 0; v_rows int := 0; v_fail int := 0; v_gaps int := 0;
  v_ctd jsonb;
BEGIN
  IF NOT public.fn_caller_is_engine() AND (auth.uid() IS NULL OR ( NOT public.fn_is_platform_admin())) THEN
    RAISE EXCEPTION 'not_authorised';
  END IF;

  FOR rec IN
    SELECT DISTINCT club_id FROM union_clubs
    UNION
    SELECT c.id AS club_id FROM public.clubs c
     WHERE EXISTS (SELECT 1 FROM public.rake_records r
                    WHERE r.club_id = c.id
                      AND r.created_at >= current_date - GREATEST(p_days,1) - 1)
  LOOP
    FOR d IN
      SELECT gs::date FROM generate_series(
               current_date - GREATEST(p_days,1), current_date - 1, interval '1 day') gs
    LOOP
      IF EXISTS (SELECT 1 FROM club_rake_rollup_complete
                  WHERE club_id = rec.club_id AND day = d) THEN
        CONTINUE;
      END IF;
      BEGIN
        v_rows := v_rows + public.fn_club_rake_rollup_day(rec.club_id, d);
        v_days := v_days + 1;
      EXCEPTION WHEN OTHERS THEN
        v_fail := v_fail + 1;
      END;
    END LOOP;
  END LOOP;

  SELECT count(*) INTO v_gaps
    FROM (SELECT c.id AS cid FROM public.clubs c
           WHERE EXISTS (SELECT 1 FROM public.rake_records r
                          WHERE r.club_id = c.id
                            AND r.created_at >= current_date - GREATEST(p_days,1) - 1)) src
    CROSS JOIN generate_series(current_date - GREATEST(p_days,1),
                               current_date - 1, interval '1 day') g
   WHERE NOT EXISTS (SELECT 1 FROM club_rake_rollup_complete rc
                      WHERE rc.club_id = src.cid AND rc.day = g::date);

  IF v_gaps > 0 THEN
    INSERT INTO financial_alerts (severity, source, message, context)
    VALUES ('warning', 'fn_club_rake_rollup_catchup',
            'Club rake rollup has uncovered days - the live downline view is falling back to full scans',
            jsonb_build_object('gap_club_days', v_gaps, 'lookback_days', p_days,
                               'failures', v_fail, 'ran_at', now()));
  END IF;

  -- Club Data screen rollup. Additive; never allowed to break the above.
  BEGIN
    v_ctd := public.fn_club_table_daily_catchup(2);
  EXCEPTION WHEN OTHERS THEN
    v_ctd := jsonb_build_object('success', false, 'error', SQLERRM);
  END;

  RETURN jsonb_build_object('days_built', v_days, 'rows', v_rows,
                            'failures', v_fail, 'remaining_gaps', v_gaps,
                            'club_table_daily', v_ctd,
                            'ran_at', now());
END $function$;

REVOKE ALL ON FUNCTION public.fn_club_rake_rollup_catchup(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_club_rake_rollup_catchup(integer) TO service_role;

DO $assert$
DECLARE rec record; actual jsonb; p_old jsonb; p_new jsonb; n_old bigint; n_new bigint;
BEGIN
  FOR rec IN SELECT * FROM fixture_expected LOOP
    actual:=fixture_case(rec.p_days);
    IF actual IS DISTINCT FROM rec.report THEN RAISE EXCEPTION 'caller changed output/calls/markers/alerts for %: % versus %',rec.p_days,actual,rec.report; END IF;
  END LOOP;
  IF has_function_privilege('anon','public.fn_club_rake_rollup_catchup(integer)','EXECUTE')
     OR has_function_privilege('authenticated','public.fn_club_rake_rollup_catchup(integer)','EXECUTE')
     OR NOT has_function_privilege('service_role','public.fn_club_rake_rollup_catchup(integer)','EXECUTE') THEN RAISE EXCEPTION 'private caller ACL changed'; END IF;
  IF NOT (SELECT prosecdef AND proconfig@>ARRAY['search_path=public','statement_timeout=600s'] FROM pg_proc WHERE oid='public.fn_club_rake_rollup_catchup(integer)'::regprocedure) THEN RAISE EXCEPTION 'function metadata changed'; END IF;
  PERFORM set_config('fixture.engine','false',true);
  BEGIN
    PERFORM public.fn_club_rake_rollup_catchup(3);
    RAISE EXCEPTION 'unauthorized call accepted';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'not_authorised' THEN RAISE; END IF; END;
  PERFORM set_config('fixture.engine','true',true);
  -- Exact old and new source club sets under the validated FK, including signed
  -- and zero rake, NULL/deleted clubs, and the inclusive cutoff.
  IF (SELECT array_agg(cid ORDER BY cid) FROM (SELECT DISTINCT club_id cid FROM rake_records WHERE club_id IS NOT NULL AND created_at>=current_date-4)s)
     IS DISTINCT FROM
     (SELECT array_agg(c.id ORDER BY c.id) FROM clubs c WHERE EXISTS(SELECT 1 FROM rake_records r WHERE r.club_id=c.id AND r.created_at>=current_date-4)) THEN RAISE EXCEPTION 'source club set differs'; END IF;
  EXECUTE 'EXPLAIN (ANALYZE,FORMAT JSON,TIMING OFF) SELECT DISTINCT club_id FROM rake_records WHERE club_id IS NOT NULL AND created_at>=current_date-4' INTO p_old;
  EXECUTE 'EXPLAIN (ANALYZE,FORMAT JSON,TIMING OFF) SELECT c.id FROM clubs c WHERE EXISTS(SELECT 1 FROM rake_records r WHERE r.club_id=c.id AND r.created_at>=current_date-4)' INTO p_new;
  WITH RECURSIVE nodes(n) AS (SELECT p_old->0->'Plan' UNION ALL SELECT child FROM nodes CROSS JOIN LATERAL jsonb_array_elements(coalesce(n->'Plans','[]'))child)
  SELECT sum((n->>'Actual Rows')::bigint*(n->>'Actual Loops')::bigint) INTO n_old FROM nodes WHERE n->>'Relation Name'='rake_records';
  WITH RECURSIVE nodes(n) AS (SELECT p_new->0->'Plan' UNION ALL SELECT child FROM nodes CROSS JOIN LATERAL jsonb_array_elements(coalesce(n->'Plans','[]'))child)
  SELECT sum((n->>'Actual Rows')::bigint*(n->>'Actual Loops')::bigint) INTO n_new FROM nodes WHERE n->>'Relation Name'='rake_records';
  IF n_old<20000 OR n_new>10 OR n_new IS NULL OR p_new::text NOT LIKE '%idx_rake_records_union_signed_window%' THEN RAISE EXCEPTION 'source executor work not bounded: old %, new %, plan %',n_old,n_new,p_new; END IF;
  RAISE NOTICE 'source tuples: old %, new %',n_old,n_new;
END $assert$;
