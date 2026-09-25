-- Actual service read RPCs against captured source. Future ABI/nullable input
-- is seeded only in this private rolled-back fixture, not by an activation.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL statement_timeout='30s';
DO $local$ BEGIN
 IF inet_server_addr() IS NOT NULL OR current_user<>'postgres'
    OR current_database() !~ '^r46_mtt_' THEN RAISE EXCEPTION 'owned PG17 fixture required';END IF;
END $local$;
CREATE FUNCTION pg_temp.read_capacity_assert(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
 IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'READ CAPACITY FAIL: %',label;END IF;
 RAISE NOTICE 'READ CAPACITY PASS: %',label;
END $$;
-- Preparation065 already replaced the old NOT NULL rule with the recorded
-- format/capacity CHECK. This composed probe preserves that actual constraint.
SET LOCAL session_replication_role=replica;
-- The composed preparation now owns capacity validity. An unqualified NULL
-- capacity row cannot exist under that CHECK, even in a legacy import. Exercise
-- its real refusal rather than removing the constraint to seed impossible data.
DO $invalid_capacity$
DECLARE refused boolean:=false; violated text;
BEGIN
 BEGIN
  INSERT INTO public.tournaments(id,name,tournament_type,variant,max_players,min_players,
    table_size,status,format_contract,buy_in_amount,buy_in_fee,start_time)
  VALUES('46467100-0000-4000-8000-000000000017','Invalid unqualified capacity',
    'MTT','freezeout',NULL,3,9,'REGISTERING',NULL,0,0,now()+interval '15 minutes');
 EXCEPTION WHEN check_violation THEN
  GET STACKED DIAGNOSTICS violated=CONSTRAINT_NAME;
  IF violated<>'tournaments_recorded_entry_capacity' THEN RAISE;END IF;
  refused:=true;
 END;
 PERFORM pg_temp.read_capacity_assert(refused AND NOT EXISTS(SELECT 1 FROM public.tournaments
  WHERE id='46467100-0000-4000-8000-000000000017'),
  'composed capacity authority refuses unqualified NULL capacity before reads');
END $invalid_capacity$;
INSERT INTO public.tournaments(id,name,tournament_type,variant,max_players,min_players,table_size,
 buy_in_amount,buy_in_fee,guaranteed_prize,starting_chips,current_players,status,start_time,format_contract)
SELECT ('46467100-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'Read capacity '||n,
 kind,variant,cap,CASE WHEN format='seat-first-satellite-v1' THEN 2 ELSE 3 END,
 CASE WHEN format='seat-first-satellite-v1' THEN 2 WHEN format='spin-v1' THEN 3 ELSE 9 END,
 buy_in,0,guarantee,1000,entrants,'REGISTERING',now()+interval '15 minutes',format
FROM (VALUES
 (1,'MTT','freezeout','mtt-v1',3,3,0,0),
 (2,'MTT','freezeout','mtt-v2',NULL,4,0,0),
 (3,'SNG','sng','sng-v1',3,3,0,0),
 (4,'SPIN','spin','spin-v1',3,3,0,0),
 (5,'SATELLITE','sng','seat-first-satellite-v1',2,2,0,0),
 (6,'MTT','freezeout',NULL,3,3,0,0),
 (7,'SNG','sng','sng-v1',3,2,0,0),
 (8,'MTT','freezeout',NULL,3,2,0,0),
 (11,'MTT','freezeout','mtt-v1',3,3,10,100),
 (12,'MTT','freezeout','mtt-v2',NULL,4,10,100),
 (13,'SNG','sng','sng-v1',6,3,10,100),
 (14,'SPIN','spin','spin-v1',3,2,10,100),
 (15,'SATELLITE','sng','seat-first-satellite-v1',2,1,10,100),
 (16,'MTT','freezeout',NULL,3,2,10,100)
) input(n,kind,variant,format,cap,entrants,buy_in,guarantee);
INSERT INTO public.tournaments(id,name,tournament_type,variant,max_players,min_players,table_size,
 buy_in_amount,buy_in_fee,starting_chips,current_players,status,start_time,started_at,format_contract,
 on_break,break_ends_at,addon_period_ends_at)
SELECT ('46467100-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'Progress metric '||n,
 kind,variant,cap,CASE WHEN format='seat-first-satellite-v1' THEN 2 ELSE 3 END,9,
 5,0,1000,1,'RUNNING',now()-interval '1 hour',now()-make_interval(mins=>age_minutes),format,
 on_break,CASE WHEN break_minutes IS NOT NULL THEN now()+make_interval(mins=>break_minutes) ELSE NULL END,
 CASE WHEN recent_addon THEN now() ELSE NULL END
FROM (VALUES
 (21,'MTT','freezeout','mtt-v1',100,false,NULL,false,60),
 (22,'MTT','freezeout','mtt-v2',NULL,false,NULL,false,60),
 (23,'SATELLITE','sng','seat-first-satellite-v1',2,false,NULL,false,60),
 (24,'SPIN','spin','spin-v1',3,false,NULL,false,60),
 (25,'SNG','sng','sng-v1',6,false,NULL,false,60),
 (26,'MTT','freezeout',NULL,100,false,NULL,false,60),
 (27,'MTT','freezeout','mtt-v2',NULL,true,-30,false,60),
 (28,'MTT','freezeout','mtt-v1',100,true,20,false,60),
 (29,'MTT','freezeout','mtt-v1',100,false,NULL,true,60),
 (30,'MTT','freezeout','mtt-v1',100,false,NULL,false,5)
) input(n,kind,variant,format,cap,on_break,break_minutes,recent_addon,age_minutes);
SET LOCAL session_replication_role=origin;
CREATE TEMP TABLE capacity_parents_before AS SELECT to_jsonb(t) original
 FROM public.tournaments t WHERE t.id::text LIKE '46467100-%';
SELECT set_config('request.jwt.claim.role','service_role',true);
SELECT set_config('request.jwt.claims','{"role":"service_role"}',true);
SET SESSION AUTHORIZATION service_role;
DO $legacy$
DECLARE r record;
BEGIN
 PERFORM pg_temp.read_capacity_assert(session_user='service_role' AND current_user='service_role',
  'actual service session executes the existing read RPCs');
 PERFORM pg_temp.read_capacity_assert((SELECT array_agg(right(tournament_id::text,12) ORDER BY tournament_id)
  FROM public.fn_freeroll_fill_targets(NULL))=ARRAY['000000000007','000000000008'],
  'legacy freeroll projection preserves full-field exclusions and bounded open rows');
 FOR r IN SELECT * FROM public.fn_freeroll_fill_targets(NULL) LOOP
  PERFORM pg_temp.read_capacity_assert(r.max_players=3,'legacy open row keeps its numeric cap: '||r.tournament_id);
 END LOOP;
 PERFORM pg_temp.read_capacity_assert((SELECT array_agg(right(tournament_id::text,12) ORDER BY tournament_id)
  FROM public.fn_overlay_at_risk(NULL))=ARRAY['000000000011','000000000012','000000000013',
    '000000000014','000000000015','000000000016'],
  'legacy overlay emits every expected candidate and no unrelated rows');
 FOR r IN SELECT * FROM public.fn_overlay_at_risk(NULL) LOOP
  PERFORM pg_temp.read_capacity_assert(r.entries_needed=10 AND r.shortfall=CASE right(r.tournament_id::text,2)::integer
    WHEN 11 THEN 0 WHEN 12 THEN 0 WHEN 13 THEN 3 WHEN 14 THEN 1 WHEN 15 THEN 1 WHEN 16 THEN 1 END
    AND r.max_players=CASE right(r.tournament_id::text,2)::integer
    WHEN 11 THEN 3 WHEN 12 THEN 0 WHEN 13 THEN 6 WHEN 14 THEN 3 WHEN 15 THEN 2 WHEN 16 THEN 3 END,
    'legacy overlay keeps actual field capacity: '||r.tournament_id);
 END LOOP;
 SELECT * INTO STRICT r FROM public.fn_tournament_progress_metrics(15,10);
 PERFORM pg_temp.read_capacity_assert(r.stalled_running=2 AND r.overdue_breaks=1,
  'metrics use recorded MTTs including NULL caps while preserving break/addon grace');
END $legacy$;
RESET SESSION AUTHORIZATION;
SET LOCAL session_replication_role=replica;
UPDATE public.ca_mtt_admission_contract SET abi='unlimited-mtt-v2' WHERE singleton;
SET LOCAL session_replication_role=origin;
SET SESSION AUTHORIZATION service_role;
DO $future$
DECLARE r record;
BEGIN
 PERFORM pg_temp.read_capacity_assert((SELECT array_agg(right(tournament_id::text,12) ORDER BY tournament_id)
  FROM public.fn_freeroll_fill_targets(NULL))=ARRAY['000000000001','000000000002','000000000007','000000000008'],
  'future freeroll projection includes full old numeric and new NULL MTTs only');
 PERFORM pg_temp.read_capacity_assert((SELECT count(*) FROM public.fn_freeroll_fill_targets(NULL)
  WHERE tournament_id IN ('46467100-0000-4000-8000-000000000001','46467100-0000-4000-8000-000000000002')
    AND max_players IS NULL)=2,'both recorded MTT generations project unlimited capacity');
 PERFORM pg_temp.read_capacity_assert((SELECT count(*) FROM public.fn_freeroll_fill_targets(NULL)
  WHERE tournament_id IN ('46467100-0000-4000-8000-000000000007','46467100-0000-4000-8000-000000000008')
    AND max_players=3)=2,'fixed SNG and unknown live row remain bounded');
 PERFORM pg_temp.read_capacity_assert((SELECT array_agg(right(tournament_id::text,12) ORDER BY tournament_id)
  FROM public.fn_overlay_at_risk(NULL))=ARRAY['000000000011','000000000012','000000000013',
    '000000000014','000000000015','000000000016'],
  'future overlay preserves the exact economic candidate set');
 FOR r IN SELECT * FROM public.fn_overlay_at_risk(NULL) LOOP
  PERFORM pg_temp.read_capacity_assert(r.entries_needed=10 AND r.shortfall=CASE right(r.tournament_id::text,2)::integer
    WHEN 11 THEN 7 WHEN 12 THEN 6 WHEN 13 THEN 3 WHEN 14 THEN 1 WHEN 15 THEN 1 WHEN 16 THEN 1 END
    AND r.max_players IS NOT DISTINCT FROM CASE right(r.tournament_id::text,2)::integer
    WHEN 11 THEN NULL WHEN 12 THEN NULL WHEN 13 THEN 6 WHEN 14 THEN 3 WHEN 15 THEN 2 WHEN 16 THEN 3 END,
    'future overlay removes only the recorded MTT capacity ceiling: '||r.tournament_id);
 END LOOP;
 SELECT * INTO STRICT r FROM public.fn_tournament_progress_metrics(15,10);
 PERFORM pg_temp.read_capacity_assert(r.stalled_running=2 AND r.overdue_breaks=1,
  'metrics do not reclassify legacy HU/Spin/SNG/unknown after ABI change');
END $future$;
RESET SESSION AUTHORIZATION;
SELECT set_config('request.jwt.claim.role','authenticated',true);
SELECT set_config('request.jwt.claims','{"role":"authenticated"}',true);
SET SESSION AUTHORIZATION authenticated;
DO $authenticated$
DECLARE statement text; refused boolean;
BEGIN
 FOREACH statement IN ARRAY ARRAY['SELECT * FROM public.fn_freeroll_fill_targets(NULL::uuid)',
  'SELECT * FROM public.fn_overlay_at_risk(NULL::uuid)','SELECT * FROM public.fn_tournament_progress_metrics(15,10)',
  'SELECT public.fn_ca_read_mtt_admission_contract()'] LOOP
  refused:=false;BEGIN EXECUTE statement;EXCEPTION WHEN insufficient_privilege THEN refused:=true;END;
  PERFORM pg_temp.read_capacity_assert(refused,'authenticated caller cannot execute service/private authority: '||statement);
 END LOOP;
END $authenticated$;
RESET SESSION AUTHORIZATION;
SELECT set_config('request.jwt.claim.role','anon',true);
SELECT set_config('request.jwt.claims','{"role":"anon"}',true);
SET SESSION AUTHORIZATION anon;
DO $anonymous$
DECLARE statement text; refused boolean;
BEGIN
 FOREACH statement IN ARRAY ARRAY['SELECT * FROM public.fn_freeroll_fill_targets(NULL::uuid)',
  'SELECT * FROM public.fn_overlay_at_risk(NULL::uuid)','SELECT * FROM public.fn_tournament_progress_metrics(15,10)',
  'SELECT public.fn_ca_read_mtt_admission_contract()'] LOOP
  refused:=false;BEGIN EXECUTE statement;EXCEPTION WHEN insufficient_privilege THEN refused:=true;END;
  PERFORM pg_temp.read_capacity_assert(refused,'anonymous caller cannot execute service/private authority: '||statement);
 END LOOP;
END $anonymous$;
RESET SESSION AUTHORIZATION;
SELECT pg_temp.read_capacity_assert(NOT has_function_privilege('service_role','public.fn_ca_read_mtt_admission_contract()','EXECUTE'),
 'service role cannot call private ABI reader directly');
SET LOCAL session_replication_role=replica;
DELETE FROM public.ca_mtt_admission_contract;
SET LOCAL session_replication_role=origin;
SELECT set_config('request.jwt.claim.role','service_role',true);
SELECT set_config('request.jwt.claims','{"role":"service_role"}',true);
SET SESSION AUTHORIZATION service_role;
DO $missing_abi$
DECLARE statement text; refused boolean;
BEGIN
 FOREACH statement IN ARRAY ARRAY['SELECT * FROM public.fn_freeroll_fill_targets(NULL::uuid)',
  'SELECT * FROM public.fn_overlay_at_risk(NULL::uuid)'] LOOP
  refused:=false;
  BEGIN EXECUTE statement;EXCEPTION WHEN object_not_in_prerequisite_state THEN
   IF SQLERRM<>'MTT_ADMISSION_CONTRACT_MISSING_OR_UNKNOWN' THEN RAISE;END IF;refused:=true;
  END;
  PERFORM pg_temp.read_capacity_assert(refused,'missing ABI refuses capacity-dependent projection: '||statement);
 END LOOP;
END $missing_abi$;
RESET SESSION AUTHORIZATION;
SELECT pg_temp.read_capacity_assert(NOT EXISTS(SELECT 1 FROM capacity_parents_before b
 FULL JOIN (SELECT to_jsonb(t) original FROM public.tournaments t WHERE t.id::text LIKE '46467100-%') a USING(original)
 WHERE a.original IS NULL OR b.original IS NULL),'all read RPCs leave parent terms unchanged');
-- SQL may leave the materialized ABI reader unevaluated when there are no
-- candidates. No affected capacity can then be emitted. Retain the observed
-- empty result or exact refusal without claiming unconditional evaluation.
-- All fixture rows are removed only inside the final rollback.
SET LOCAL session_replication_role=replica;
DELETE FROM public.tournaments WHERE id::text LIKE '46467100-%';
SET LOCAL session_replication_role=origin;
SET SESSION AUTHORIZATION service_role;
DO $empty_missing_abi$
DECLARE statement text; refused boolean; rows_seen bigint;
BEGIN
 FOREACH statement IN ARRAY ARRAY['SELECT * FROM public.fn_freeroll_fill_targets(NULL::uuid)',
  'SELECT * FROM public.fn_overlay_at_risk(NULL::uuid)'] LOOP
  refused:=false;rows_seen:=NULL;
  BEGIN EXECUTE 'SELECT count(*) FROM ('||statement||') empty_projection' INTO rows_seen;
  EXCEPTION WHEN object_not_in_prerequisite_state THEN
   IF SQLERRM<>'MTT_ADMISSION_CONTRACT_MISSING_OR_UNKNOWN' THEN RAISE;END IF;refused:=true;
  END;
  PERFORM pg_temp.read_capacity_assert(refused OR rows_seen=0,
   'missing ABI with no candidates '||CASE WHEN refused THEN 'refuses explicitly' ELSE 'returns zero rows' END||': '||statement);
 END LOOP;
END $empty_missing_abi$;
RESET SESSION AUTHORIZATION;
ROLLBACK;
SELECT 'MTT_READ_CAPACITY_PREPARATION_NATIVE_PASS';
