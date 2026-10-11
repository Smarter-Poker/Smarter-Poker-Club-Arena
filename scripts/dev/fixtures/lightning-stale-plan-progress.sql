-- Deterministic plan-to-barrier race on real matcher/formation functions.
-- Fixture-only injections and synthetic state roll back together.
BEGIN;
CREATE TEMP TABLE stale_progress_sources AS
SELECT oid, pg_get_functiondef(oid) AS source FROM pg_proc WHERE oid IN (
 'public.fn_lightning_match_and_form(uuid,timestamp with time zone,uuid[],integer,uuid,jsonb)'::regprocedure,
 'public.fn_lightning_match_plan(uuid,timestamp with time zone,uuid[],text,integer,jsonb)'::regprocedure,
 'public.fn_lightning_form_hand(uuid,uuid[],smallint,smallint,uuid,interval,interval,timestamp with time zone,text,uuid,jsonb)'::regprocedure);
CREATE TEMP TABLE stale_progress_attempts(players uuid[]);
DO $inject$
DECLARE p record; injection text;
BEGIN
 FOR p IN SELECT oid, source FROM pg_temp.stale_progress_sources WHERE oid<>'public.fn_lightning_match_and_form(uuid,timestamp with time zone,uuid[],integer,uuid,jsonb)'::regprocedure LOOP
  IF p.oid='public.fn_lightning_match_plan(uuid,timestamp with time zone,uuid[],text,integer,jsonb)'::regprocedure THEN
   injection:=E'BEGIN\n  IF current_setting(''lc.stale_progress'',true)=''on'' THEN\n    PERFORM set_config(''lc.stale_plan_count'', ((current_setting(''lc.stale_plan_count'',true))::integer+1)::text,true);\n    IF current_setting(''lc.stale_plan_count'')::integer>1 THEN PERFORM pg_sleep(1.6); END IF;\n  END IF;';
  ELSE
   injection:=E'BEGIN\n  IF current_setting(''lc.stale_progress'',true)=''on'' THEN\n    INSERT INTO pg_temp.stale_progress_attempts VALUES (p_players);\n    IF (SELECT count(*) FROM pg_temp.stale_progress_attempts)=1 THEN\n      UPDATE public.lightning_pool_session SET state=''sit_out'' WHERE cluster_id=p_cluster_id AND player_id=p_players[1] AND exited_at IS NULL;\n    END IF;\n  END IF;';
  END IF;
  EXECUTE overlay(p.source placing injection from strpos(p.source,E'BEGIN\n') for 5);
 END LOOP;
END $inject$;
DO $proof$
DECLARE original text; old text; patched text; c uuid; r jsonb; req uuid; replay jsonb; n integer; mode text;
BEGIN
 SELECT source INTO patched FROM pg_temp.stale_progress_sources WHERE oid='public.fn_lightning_match_and_form(uuid,timestamp with time zone,uuid[],integer,uuid,jsonb)'::regprocedure;
 old:=E'        v_retry := true;\n        EXIT;';
 original:=replace(patched,E'        v_retry := true;\n        -- STALE GROUPS KEEP DISJOINT PROGRESS. The real barrier revalidates\n        -- every remaining group; no failed group is formed or reordered.\n        IF (v_r ->> ''reason'') = ''insufficient_legal_candidates'' THEN\n          CONTINUE;\n        END IF;\n        EXIT;',old);
 IF original=patched THEN RAISE EXCEPTION 'progress regression requires actual patched owner'; END IF;
 FOREACH mode IN ARRAY ARRAY['before','after'] LOOP
  EXECUTE CASE WHEN mode='before' THEN original ELSE patched END;
  PERFORM set_config('lc.stale_progress','off',true);
  c:=lc.build('DP-'||mode,'stale',9,150,1,'nlh','{"pass_interval_ms":2000,"pass_time_budget_ms":1500}'::jsonb);
  TRUNCATE pg_temp.stale_progress_attempts;
  PERFORM set_config('lc.stale_plan_count','0',true);
  req:=gen_random_uuid();
  PERFORM set_config('lc.stale_progress','on',true);
  r:=public.fn_lightning_match_and_form(c,clock_timestamp(),NULL,32,req,NULL);
  SELECT count(*) INTO n FROM pg_temp.stale_progress_attempts;
  RAISE NOTICE 'STALE_GROUP_% response=% barrier_attempts=%',upper(mode),r,n;
  IF r->'retries'->0->>'reason'<>'insufficient_legal_candidates' THEN RAISE EXCEPTION 'real stale candidate refusal not exercised'; END IF;
  IF mode='before' THEN
   IF NOT lc.pass_starved(r) OR n<>1 OR (r->>'formed')::integer<>0 THEN RAISE EXCEPTION 'original discarded-plan starvation not reproduced'; END IF;
  ELSE
   IF lc.pass_starved(r) OR n<2 OR (r->>'formed')::integer<1 THEN RAISE EXCEPTION 'remaining disjoint plan did not progress'; END IF;
   IF EXISTS (SELECT 1 FROM public.lightning_reservation x JOIN public.lightning_pool_session s ON s.cluster_id=x.cluster_id AND s.player_id=x.player_id WHERE x.cluster_id=c AND s.state='sit_out' AND x.state IN ('pending','committed')) THEN RAISE EXCEPTION 'stale candidate bypassed authoritative validation'; END IF;
   replay:=public.fn_lightning_match_and_form(c,clock_timestamp(),NULL,32,req,NULL);
   IF replay IS DISTINCT FROM r||jsonb_build_object('replayed',true) OR (SELECT count(*) FROM pg_temp.stale_progress_attempts)<>n THEN RAISE EXCEPTION 'progress pass replay changed effects'; END IF;
  END IF;
 END LOOP;
END $proof$;
ROLLBACK;
