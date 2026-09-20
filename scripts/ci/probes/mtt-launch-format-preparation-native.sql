-- Real launch/lease/receipt authorities against structural historical inputs.
-- This is launch protocol and roster proof, not a funded purchase qualification.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL statement_timeout='30s';
DO $local$ BEGIN
 IF inet_server_addr() IS NOT NULL OR current_user<>'postgres'
    OR current_database() !~ '^r46_mtt_' THEN RAISE EXCEPTION 'owned PG17 fixture required'; END IF;
END $local$;
CREATE FUNCTION pg_temp.launch_format_assert(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
 IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'LAUNCH FORMAT FAIL: %',label; END IF;
 RAISE NOTICE 'LAUNCH FORMAT PASS: %',label;
END $$;
CREATE FUNCTION pg_temp.launch_format_money(p_id uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT jsonb_build_object(
 'treasury',(SELECT chip_treasury FROM public.clubs WHERE id='46464298-0000-4000-8000-000000000001'),
 'escrow',(SELECT to_jsonb(e) FROM public.tournament_escrow e WHERE tournament_id=p_id),
 'ledger',(SELECT coalesce(jsonb_agg(to_jsonb(l) ORDER BY l.id),'[]'::jsonb) FROM public.chip_ledger l WHERE tournament_id=p_id),
 'promise',(SELECT to_jsonb(s) FROM public.tournament_satellite_economic_snapshots s WHERE tournament_id=p_id));
$$;
SET LOCAL session_replication_role=replica;
INSERT INTO auth.users(id) VALUES('46464299-0000-4000-8000-000000000001');
INSERT INTO public.profiles(id,username,display_name) VALUES('46464299-0000-4000-8000-000000000001','native_format_owner','Native Format Owner');
INSERT INTO public.clubs(id,name,owner_id,chip_treasury) VALUES('46464298-0000-4000-8000-000000000001','Native Format Club','46464299-0000-4000-8000-000000000001',100);
INSERT INTO public.tournaments(id,club_id,name,tournament_type,variant,max_players,min_players,table_size,
 buy_in_amount,buy_in_fee,starting_chips,current_players,status,start_time,format_contract,
 blind_structure,payout_structure,synchronized_breaks)
VALUES('46464290-0000-4000-8000-000000000001','46464298-0000-4000-8000-000000000001','Native Paid Target','MTT','freezeout',100,3,9,18,2,10000,0,'REGISTERING',now()+interval '1 day','mtt-v1','[{"level":1,"smallBlind":25,"bigBlind":50,"duration":600}]','[{"place":1,"percentage":100}]',true);
INSERT INTO public.tournaments(id,name,tournament_type,variant,max_players,min_players,table_size,
 buy_in_amount,buy_in_fee,starting_chips,current_players,status,start_time,format_contract,
 blind_structure,payout_structure,synchronized_breaks)
VALUES
 ('46464200-0000-4000-8000-000000000001','Accepted MTT minimum two','MTT','freezeout',100,2,9,0,0,10000,2,'REGISTERING',now(),'mtt-v1','[{"level":1,"smallBlind":25,"bigBlind":50,"duration":600}]','[{"place":1,"percentage":100}]',true),
 ('46464200-0000-4000-8000-000000000002','Accepted HU satellite','SATELLITE','sng',2,2,2,0,0,300,2,'REGISTERING',now(),'seat-first-satellite-v1','[{"level":1,"smallBlind":5,"bigBlind":10,"duration":180}]','[{"place":1,"percentage":100}]',false),
 ('46464200-0000-4000-8000-000000000003','Future MTT format','SATELLITE','satellite',100,3,9,0,0,10000,2,'REGISTERING',now(),'mtt-v2','[{"level":1,"smallBlind":25,"bigBlind":50,"duration":300}]','[{"place":1,"percentage":100}]',true);
UPDATE public.tournaments SET club_id='46464298-0000-4000-8000-000000000001' WHERE id::text LIKE '46464200-%';
UPDATE public.tournaments SET satellite_target_id='46464290-0000-4000-8000-000000000001',satellite_seats=1
WHERE id IN ('46464200-0000-4000-8000-000000000002','46464200-0000-4000-8000-000000000003');
INSERT INTO public.engine_tournament_leases(tournament_id,instance_id,engine_version,acquired_at,heartbeat_at,lease_generation,protocol_version)
SELECT t.id,'native-format-probe','native-format-probe',now(),clock_timestamp(),'46464209-0000-4000-8000-000000000001',2
FROM public.tournaments t WHERE t.id::text LIKE '46464200-%';
SET LOCAL session_replication_role=origin;
SELECT set_config('request.jwt.claim.role','service_role',true);
SELECT set_config('request.jwt.claim.sub','46464299-0000-4000-8000-000000000001',true);
SELECT set_config('request.jwt.claims','{"role":"service_role","sub":"46464299-0000-4000-8000-000000000001"}',true);
DO $begin$
DECLARE r jsonb; t public.tournaments%ROWTYPE; requested uuid='46464208-0000-4000-8000-000000000001';
 gen uuid='46464209-0000-4000-8000-000000000001';
BEGIN
 r:=public.fn_begin_tournament_launch_atomic('46464200-0000-4000-8000-000000000001',requested,now(),gen,'spin-v1');
 PERFORM pg_temp.launch_format_assert(r->>'reason'='launch_format_mismatch' AND NOT EXISTS(SELECT 1 FROM public.tournament_launch_receipts WHERE tournament_id='46464200-0000-4000-8000-000000000001'),'expected format mismatch precedes receipt creation');
 r:=public.fn_begin_tournament_launch_atomic('46464200-0000-4000-8000-000000000003',requested,now(),gen);
 PERFORM pg_temp.launch_format_assert(r->>'reason'='launch_format_argument_required' AND NOT EXISTS(SELECT 1 FROM public.tournament_launch_receipts WHERE tournament_id='46464200-0000-4000-8000-000000000003'),'old ABI cannot begin new MTT format');
 FOR t IN SELECT * FROM public.tournaments WHERE id::text LIKE '46464200-%' ORDER BY id LOOP
  requested:=('46464208-'||substr(t.id::text,10))::uuid;
  r:=public.fn_begin_tournament_launch_atomic(t.id,requested,now(),gen,t.format_contract);
  PERFORM pg_temp.launch_format_assert((r->>'ok')::boolean AND r->>'format_contract'=t.format_contract AND r->>'lease_generation'=gen::text,'real begin returns parent format and lease: '||t.format_contract);
  r:=public.fn_begin_tournament_launch_atomic(t.id,requested,now(),gen,t.format_contract);
  PERFORM pg_temp.launch_format_assert((r->>'ok')::boolean AND (r->>'replay')::boolean AND r->>'format_contract'=t.format_contract AND (SELECT count(*) FROM public.tournament_launch_receipts WHERE tournament_id=t.id)=1,'pending begin replay preserves single receipt: '||t.format_contract);
 END LOOP;
 r:=public.fn_complete_tournament_launch_atomic('46464200-0000-4000-8000-000000000001','46464208-0000-4000-8000-000000000001',gen,'spin-v1');
 PERFORM pg_temp.launch_format_assert(r->>'reason'='launch_format_mismatch' AND (SELECT completed_at IS NULL FROM public.tournament_launch_receipts WHERE tournament_id='46464200-0000-4000-8000-000000000001'),'complete mismatch preserves pending receipt');
 r:=public.fn_complete_tournament_launch_atomic('46464200-0000-4000-8000-000000000003',requested,gen);
 PERFORM pg_temp.launch_format_assert(r->>'reason'='launch_format_argument_required','old ABI cannot complete new MTT format');
 FOR t IN SELECT * FROM public.tournaments WHERE id::text LIKE '46464200-%' ORDER BY id LOOP
  requested:=('46464208-'||substr(t.id::text,10))::uuid;
  r:=public.fn_complete_tournament_launch_atomic(t.id,requested,gen,t.format_contract);
  PERFORM pg_temp.launch_format_assert(r->>'reason'='launch_roster_unproven' AND r->>'format_contract'=t.format_contract AND (r->>'required_players')::integer=CASE WHEN t.format_contract='mtt-v2' THEN 3 ELSE 2 END,'real empty-roster refusal retains format minimum: '||t.format_contract);
 END LOOP;
 PERFORM pg_temp.launch_format_assert(NOT has_function_privilege('authenticated','public.fn_begin_tournament_launch_atomic(uuid,uuid,timestamptz,uuid,text)','EXECUTE') AND NOT has_function_privilege('anon','public.fn_complete_tournament_launch_atomic(uuid,uuid,uuid,text)','EXECUTE'),'new launch overloads stay service-only');
END $begin$;
-- A rollback-safe already-admitted free-entry roster. No money functions are
-- replaced; real status/receipt guards must accept completion and its replay.
SET LOCAL session_replication_role=replica;
INSERT INTO auth.users(id)
SELECT md5(t.id::text||':user:'||n)::uuid FROM public.tournaments t CROSS JOIN generate_series(1,2)n WHERE t.id::text LIKE '46464200-%';
INSERT INTO public.profiles(id,username,display_name)
SELECT md5(t.id::text||':user:'||n)::uuid,'format_'||md5(t.id::text||':user:'||n),'Native Format Entrant' FROM public.tournaments t CROSS JOIN generate_series(1,2)n WHERE t.id::text LIKE '46464200-%';
INSERT INTO public.tables(id,club_id,name,game_type,game_variant,max_players,current_players,status,seat_game_scope,seat_admission_key,
 starting_chips,tournament_id,lifecycle)
SELECT ('46464201-'||substr(t.id::text,10))::uuid,t.club_id,t.name,'tournament','nlh',t.table_size,2,'waiting','table:46464201-'||substr(t.id::text,10),'tournament:'||t.id::text,t.starting_chips,t.id,'live'
FROM public.tournaments t WHERE t.id::text LIKE '46464200-%';
INSERT INTO public.tournament_players(id,tournament_id,user_id,username,chips,status,table_id,seat_number,club_id)
SELECT md5(t.id::text||':entry:'||n)::uuid,t.id,md5(t.id::text||':user:'||n)::uuid,'Native Format Entrant',t.starting_chips,'playing',('46464201-'||substr(t.id::text,10))::uuid,n,t.club_id
FROM public.tournaments t CROSS JOIN generate_series(1,2)n WHERE t.id::text LIKE '46464200-%';
INSERT INTO public.table_seats(id,table_id,seat_number,user_id,stack,status,left_at,leave_pending,is_sitting_out,is_away,club_id,active_game_scope,active_parent_key)
SELECT md5(p.id::text||':seat')::uuid,p.table_id,p.seat_number,p.user_id,p.chips,'active',NULL,false,false,false,p.club_id,'table:'||p.table_id::text,'tournament:'||p.tournament_id::text
FROM public.tournament_players p WHERE p.tournament_id::text LIKE '46464200-%';
SET LOCAL session_replication_role=origin;
DO $complete$
DECLARE r jsonb; t public.tournaments%ROWTYPE; requested uuid='46464208-0000-4000-8000-000000000001';
 gen uuid='46464209-0000-4000-8000-000000000001'; before_receipt jsonb; before_money jsonb;
BEGIN
 FOR t IN SELECT * FROM public.tournaments WHERE id IN ('46464200-0000-4000-8000-000000000001','46464200-0000-4000-8000-000000000002') ORDER BY id LOOP
  requested:=('46464208-'||substr(t.id::text,10))::uuid;
  r:=public.fn_complete_tournament_launch_atomic(t.id,requested,gen,t.format_contract);
  PERFORM pg_temp.launch_format_assert((r->>'ok')::boolean AND (r->>'completed')::boolean AND r->>'format_contract'=t.format_contract,'real completion preserves accepted two-player format: '||t.format_contract||' result='||r);
  SELECT to_jsonb(x) INTO before_receipt FROM public.tournament_launch_receipts x WHERE tournament_id=t.id;
  before_money:=pg_temp.launch_format_money(t.id);
  r:=public.fn_complete_tournament_launch_atomic(t.id,requested,gen,t.format_contract);
  PERFORM pg_temp.launch_format_assert((r->>'ok')::boolean AND (r->>'replay')::boolean AND r->>'format_contract'=t.format_contract AND before_receipt=(SELECT to_jsonb(x) FROM public.tournament_launch_receipts x WHERE tournament_id=t.id),'complete replay preserves exact receipt: '||t.format_contract);
  PERFORM pg_temp.launch_format_assert(before_money=pg_temp.launch_format_money(t.id),'complete replay preserves treasury, escrow, ledger and promise: '||t.format_contract);
  IF t.format_contract='seat-first-satellite-v1' THEN
   PERFORM pg_temp.launch_format_assert((before_money->>'treasury')::numeric=80
     AND (before_money#>>'{escrow,prize_balance}')::numeric=20
     AND (before_money#>>'{promise,ticket_value}')::numeric=20
     AND (before_money#>>'{promise,funded_source_pool}')::numeric=20,
     'accepted HU receives one actual20 guarantee from treasury and freezes exact ticket promise');
  END IF;
 END LOOP;
 r:=public.fn_complete_tournament_launch_atomic('46464200-0000-4000-8000-000000000003','46464208-0000-4000-8000-000000000003',gen,'mtt-v2');
 PERFORM pg_temp.launch_format_assert(r->>'reason'='launch_roster_unproven' AND r->>'required_players'='3','future minimum three refuses two real roster seats');
END $complete$;
ROLLBACK;
SELECT 'MTT_LAUNCH_FORMAT_PREPARATION_NATIVE_PASS' AS result;
