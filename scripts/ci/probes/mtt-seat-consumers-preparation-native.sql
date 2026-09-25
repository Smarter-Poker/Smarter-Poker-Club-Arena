-- Recorded-format physical-seat qualification against the actual captured
-- consumers. Structural historical fixtures are seeded under replica mode;
-- all behavior assertions run in origin mode and the transaction rolls back.
-- This does not prove funded human/horse entry, refund settlement, or ABI races.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL statement_timeout='30s';
DO $local$ BEGIN
 IF inet_server_addr() IS NOT NULL OR current_user<>'postgres'
    OR current_database() !~ '^r46_mtt_' THEN
  RAISE EXCEPTION 'owned PG17 fixture required';
 END IF;
END $local$;
CREATE FUNCTION pg_temp.seat_assert(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
 IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'SEAT CONSUMER FAIL: %',label; END IF;
 RAISE NOTICE 'SEAT CONSUMER PASS: %',label;
END $$;
-- The preparation intentionally retains the installed NOT NULL column until
-- activation. Initialize the future nullable shape only inside this rolled-
-- back local fixture; no application function or financial guard is replaced.
ALTER TABLE public.tournaments ALTER COLUMN max_players DROP NOT NULL;
SET LOCAL session_replication_role=replica;
INSERT INTO public.tournaments(id,name,tournament_type,variant,max_players,min_players,table_size,
 buy_in_amount,buy_in_fee,starting_chips,current_players,status,start_time,format_contract,game_type)
VALUES
 ('46464400-0000-4000-8000-000000000001','Unlimited MTT','MTT','freezeout',NULL,3,9,0,0,1000,17,'REGISTERING',now()+interval '1 hour','mtt-v2','nlh'),
 ('46464400-0000-4000-8000-000000000002','Recorded MTT stale HU labels','MTT','sng',2,3,9,0,0,1000,17,'REGISTERING',now()+interval '1 hour','mtt-v1','nlh'),
 ('46464400-0000-4000-8000-000000000003','Funded legacy satellite','SATELLITE','sng',2,2,2,0,0,1000,0,'REGISTERING',now()+interval '1 hour','seat-first-satellite-v1','nlh'),
 ('46464400-0000-4000-8000-000000000004','Fixed HU SNG','SNG','sng',2,2,2,0,0,1000,0,'REGISTERING',now()+interval '1 hour','sng-v1','nlh'),
 ('46464400-0000-4000-8000-000000000005','Fixed six seat SNG','SNG','sng',6,6,6,0,0,1000,0,'REGISTERING',now()+interval '1 hour','sng-v1','nlh'),
 ('46464400-0000-4000-8000-000000000006','Fixed Spin','SPIN','spin',3,3,3,0,0,1000,0,'REGISTERING',now()+interval '1 hour','spin-v1','nlh'),
 ('46464400-0000-4000-8000-000000000007','Unproven live','MTT','freezeout',NULL,3,9,0,0,1000,0,'REGISTERING',now()+interval '1 hour',NULL,'nlh'),
 ('46464400-0000-4000-8000-000000000008','Unproven completed history','MTT','freezeout',NULL,3,9,0,0,1000,0,'COMPLETED',now()-interval '1 hour',NULL,'nlh'),
 ('46464400-0000-4000-8000-000000000009','Unproven completing history','MTT','freezeout',NULL,3,9,0,0,1000,0,'COMPLETING',now()-interval '1 hour',NULL,'nlh'),
 ('46464400-0000-4000-8000-000000000010','Unlimited PLO6','MTT','freezeout',NULL,3,10,0,0,1000,0,'REGISTERING',now()+interval '1 hour','mtt-v2','plo6'),
 ('46464400-0000-4000-8000-000000000011','Unlimited PLO5','MTT','freezeout',NULL,3,10,0,0,1000,0,'REGISTERING',now()+interval '1 hour','mtt-v2','plo5'),
 ('46464400-0000-4000-8000-000000000012','Running MTT physical capacity','MTT','sng',2,3,9,0,0,1000,0,'RUNNING',now()-interval '1 hour','mtt-v1','nlh'),
 ('46464400-0000-4000-8000-000000000013','Unproven running row','MTT','freezeout',NULL,3,9,0,0,1000,0,'RUNNING',now()-interval '1 hour',NULL,'nlh');
INSERT INTO public.tables(id,tournament_id,name,game_type,game_variant,max_players,current_players,status)
SELECT ('46464401-0000-4000-8000-'||right(t.id::text,12))::uuid,t.id,t.name||' table','tournament',t.game_type,
 t.table_size,0,CASE WHEN t.status='RUNNING' THEN 'running' ELSE 'waiting' END
FROM public.tournaments t WHERE t.id::text LIKE '46464400-%';
-- A paid entrant's cached chair assignment may be temporarily absent while
-- its MTT is managed. The old NULL/<=2 heuristic must not clear that assignment.
INSERT INTO public.tournament_players(tournament_id,user_id,username,chips,status,table_id,seat_number)
SELECT t.id,'46464402-0000-4000-8000-000000000001','fixture entrant',1000,'registered',
 ('46464401-0000-4000-8000-'||right(t.id::text,12))::uuid,1
FROM public.tournaments t WHERE t.id IN
 ('46464400-0000-4000-8000-000000000001','46464400-0000-4000-8000-000000000002');
SET LOCAL session_replication_role=origin;
SELECT set_config('request.jwt.claim.role','service_role',true);
SELECT set_config('request.jwt.claims','{"role":"service_role"}',true);
SELECT set_config('app.money_path','fn_assign_tournament_player_seat_atomic',true);
CREATE TEMP TABLE seat_parent_before AS SELECT to_jsonb(t) original
 FROM public.tournaments t WHERE t.id::text LIKE '46464400-%';
CREATE TEMP TABLE seat_entrant_before AS SELECT to_jsonb(tp) original
 FROM public.tournament_players tp WHERE tp.tournament_id::text LIKE '46464400-%';
CREATE TEMP TABLE consumer_seat_probe(table_id uuid,left_at timestamptz,stack numeric,seat_number integer);
CREATE TRIGGER actual_seat_creation BEFORE INSERT ON consumer_seat_probe
 FOR EACH ROW EXECUTE FUNCTION public.fn_ca_guard_seat_creation();

-- Direct regression first: before064 the actual guard mistakes NULL/2-cap MTTs
-- for heads-up products and rejects a legitimate non-starting tournament stack.
INSERT INTO consumer_seat_probe VALUES('46464401-0000-4000-8000-000000000001',NULL,77,1);
INSERT INTO consumer_seat_probe VALUES('46464401-0000-4000-8000-000000000002',NULL,77,1);
SELECT pg_temp.seat_assert((SELECT count(*) FROM consumer_seat_probe)=2,
 'actual seat guard accepts MTT stack without fixed starting-stack equality');
DO $consumers$
DECLARE n integer; id uuid; refused boolean; result jsonb; actual integer;
BEGIN
 FOR n IN 3..6 LOOP
  id:=('46464400-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;
  IF n<>5 THEN
   refused:=false;
   BEGIN
    INSERT INTO consumer_seat_probe VALUES(
     ('46464401-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,NULL,77,1);
   EXCEPTION WHEN check_violation THEN
    IF SQLERRM NOT LIKE 'SEAT_FIRST_STACK_MUST_EQUAL_STARTING_CHIPS:%' THEN RAISE; END IF;
    refused:=true;
   END;
   PERFORM pg_temp.seat_assert(refused,'funded fixed seat still requires starting stack: '||n);
  END IF;
  INSERT INTO consumer_seat_probe VALUES(
   ('46464401-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,NULL,1000,1);
 END LOOP;
 FOR n IN 1..13 LOOP
  id:=('46464400-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;
  IF n BETWEEN 7 AND 9 OR n=13 THEN
   refused:=false;
   BEGIN PERFORM public.fn_ca_tournament_seat_cap(id);
   EXCEPTION WHEN object_not_in_prerequisite_state THEN
    IF SQLERRM<>'TOURNAMENT_FORMAT_NOT_PROVEN' THEN RAISE; END IF;refused:=true;
   END;
   PERFORM pg_temp.seat_assert(refused,'unknown row cannot provide physical capacity: '||n);
  ELSE
   actual:=public.fn_ca_tournament_seat_cap(id);
   PERFORM pg_temp.seat_assert(actual=CASE n WHEN 3 THEN 2 WHEN 4 THEN 2 WHEN 5 THEN 6
    WHEN 6 THEN 3 WHEN 10 THEN 7 ELSE 9 END,'recorded format supplies real chair/deck cap: '||n);
  END IF;
 END LOOP;
 FOR n IN 7..9 LOOP
  id:=('46464400-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;
  refused:=false;
  BEGIN PERFORM public.fn_ca_tournament_recorded_seat_first(id,false);
  EXCEPTION WHEN object_not_in_prerequisite_state THEN
   IF SQLERRM<>'TOURNAMENT_FORMAT_NOT_PROVEN' THEN RAISE; END IF;refused:=true;
  END;
  PERFORM pg_temp.seat_assert(refused,'unknown live/terminal history never grants seat creation: '||n);
  IF n=7 THEN
   refused:=false;
   BEGIN PERFORM public.fn_ca_tournament_recorded_seat_first(id,true);
   EXCEPTION WHEN object_not_in_prerequisite_state THEN refused:=true;END;
   PERFORM pg_temp.seat_assert(refused,'cleanup does not silently classify unknown live row');
  ELSE
   PERFORM pg_temp.seat_assert(public.fn_ca_tournament_recorded_seat_first(id,true) IS FALSE,
    'NULL terminal/COMPLETING history skips only fixed-format bookkeeping: '||n);
  END IF;
 END LOOP;
 PERFORM pg_temp.seat_assert((SELECT array_agg(right(board.id::text,12) ORDER BY board.id)
  FROM public.fn_seat_first_boards_ready() board WHERE board.id::text LIKE '46464400-%')=
  ARRAY['000000000003','000000000004','000000000006'],
  'actual ready-board projection includes only fixed HU/Spin formats');
 PERFORM public.fn_sync_seat_first_player_count('46464400-0000-4000-8000-000000000001');
 PERFORM public.fn_sync_seat_first_player_count('46464400-0000-4000-8000-000000000002');
 PERFORM pg_temp.seat_assert((SELECT count(*) FROM public.tournaments t
  WHERE t.id IN ('46464400-0000-4000-8000-000000000001','46464400-0000-4000-8000-000000000002')
   AND t.current_players=17)=2,'actual count sync cannot replace MTT entrants with one table seat count');
 PERFORM public.fn_release_phantom_seat_claims();
 PERFORM pg_temp.seat_assert(NOT EXISTS(SELECT 1 FROM seat_entrant_before b
  FULL JOIN (SELECT to_jsonb(tp) original FROM public.tournament_players tp
   WHERE tp.tournament_id::text LIKE '46464400-%') a USING(original)
  WHERE a.original IS NULL OR b.original IS NULL),'actual phantom release preserves both MTT assignments');
 result:=public.fn_ensure_late_registration_capacity('46464400-0000-4000-8000-000000000001',1);
 PERFORM pg_temp.seat_assert(result->>'reason'='tournament_not_running',
  'expansion preserves existing non-running refusal');
 result:=public.fn_ensure_late_registration_capacity('46464400-0000-4000-8000-000000000012',0);
 PERFORM pg_temp.seat_assert(result->>'reason'='capacity_sufficient'
  AND (result->>'live_capacity')::integer=9,
  'actual running expansion measures nine physical chairs independent of stale field cap');
 refused:=false;
 BEGIN PERFORM public.fn_ensure_late_registration_capacity('46464400-0000-4000-8000-000000000013',0);
 EXCEPTION WHEN object_not_in_prerequisite_state THEN
  IF SQLERRM<>'TOURNAMENT_FORMAT_NOT_PROVEN' THEN RAISE; END IF;refused:=true;
 END;
 PERFORM pg_temp.seat_assert(refused,'actual expansion refuses unproven running format before effects');
 PERFORM pg_temp.seat_assert(NOT has_function_privilege('service_role',
  'public.fn_ca_tournament_recorded_seat_first(uuid,boolean)','EXECUTE')
  AND NOT has_function_privilege('authenticated',
  'public.fn_ca_tournament_recorded_seat_first(uuid,boolean)','EXECUTE'),
  'recorded-seat helper remains internal');
 PERFORM pg_temp.seat_assert(NOT EXISTS(SELECT 1 FROM seat_parent_before b
  FULL JOIN (SELECT to_jsonb(t) original FROM public.tournaments t
   WHERE t.id::text LIKE '46464400-%') a USING(original)
  WHERE a.original IS NULL OR b.original IS NULL),'all parent terms remain unchanged');
END $consumers$;
ROLLBACK;
SELECT 'MTT_SEAT_CONSUMERS_PREPARATION_NATIVE_PASS' AS result;
