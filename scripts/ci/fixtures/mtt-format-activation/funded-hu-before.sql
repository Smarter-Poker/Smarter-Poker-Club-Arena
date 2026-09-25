-- Synthetic historical HU roster/opening treasury; actual accepted launch,
-- funded overlay, economic promise and immutable receipt are NOT seeded.
BEGIN;
DO $$BEGIN
 IF current_user<>'postgres' OR inet_server_addr() IS NOT NULL
    OR current_database() !~ '^r46_mtt_isolation_[0-9a-f]{32}$'
    OR (SELECT abi FROM public.ca_mtt_admission_contract)<>'legacy-capacity-v1' THEN
  RAISE EXCEPTION 'ACTIVATION_HU_OWNED_LEGACY_INPUT_REQUIRED';
 END IF;
END $$;
CREATE SCHEMA r46_activation_hu;
REVOKE ALL ON SCHEMA r46_activation_hu FROM PUBLIC;
CREATE TABLE r46_activation_hu.accepted(receipt jsonb NOT NULL,money jsonb NOT NULL);
CREATE FUNCTION r46_activation_hu.money() RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT jsonb_build_object('treasury',(SELECT chip_treasury FROM public.clubs WHERE id='46468200-0000-4000-8000-000000000001'),
 'escrow',(SELECT to_jsonb(e) FROM public.tournament_escrow e WHERE tournament_id='46468200-0000-4000-8000-000000000003'),
 'ledger',(SELECT jsonb_agg(to_jsonb(l) ORDER BY l.id) FROM public.chip_ledger l WHERE tournament_id='46468200-0000-4000-8000-000000000003'),
 'promise',(SELECT to_jsonb(s) FROM public.tournament_satellite_economic_snapshots s WHERE tournament_id='46468200-0000-4000-8000-000000000003'));
$$;
SET LOCAL session_replication_role=replica;
INSERT INTO auth.users(id) SELECT ('46468201-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid FROM generate_series(1,3)n;
INSERT INTO public.users(id,username) SELECT id,'activation_hu_'||id::text FROM auth.users WHERE id::text LIKE '46468201-%';
INSERT INTO public.profiles(id,username) SELECT id,'activation_hu_'||id::text FROM auth.users WHERE id::text LIKE '46468201-%';
INSERT INTO public.clubs(id,name,owner_id,chip_treasury) VALUES('46468200-0000-4000-8000-000000000001','Accepted HU treasury',
 '46468201-0000-4000-8000-000000000003',100);
INSERT INTO public.tournaments(id,club_id,name,tournament_type,variant,max_players,min_players,table_size,
 buy_in_amount,buy_in_fee,starting_chips,current_players,status,start_time,format_contract,blind_structure,payout_structure,synchronized_breaks)
VALUES('46468200-0000-4000-8000-000000000002','46468200-0000-4000-8000-000000000001','Accepted HU target',
 'MTT','freezeout',100,3,9,18,2,10000,0,'REGISTERING',now()+interval '1 day','mtt-v1',
 '[{"level":1,"smallBlind":25,"bigBlind":50,"duration":600}]','[{"place":1,"percentage":100}]',true),
 ('46468200-0000-4000-8000-000000000003','46468200-0000-4000-8000-000000000001','Funded accepted HU',
 'SATELLITE','sng',2,2,2,0,0,300,2,'REGISTERING',now(),'seat-first-satellite-v1',
 '[{"level":1,"smallBlind":5,"bigBlind":10,"duration":180}]','[{"place":1,"percentage":100}]',false);
UPDATE public.tournaments SET satellite_target_id='46468200-0000-4000-8000-000000000002',satellite_seats=1
 WHERE id='46468200-0000-4000-8000-000000000003';
INSERT INTO public.engine_tournament_leases(tournament_id,instance_id,engine_version,acquired_at,heartbeat_at,lease_generation,protocol_version)
VALUES('46468200-0000-4000-8000-000000000003','activation-native','activation-native',now(),clock_timestamp(),'46468202-0000-4000-8000-000000000001',2);
INSERT INTO public.tables(id,club_id,name,game_type,game_variant,max_players,current_players,status,seat_game_scope,seat_admission_key,starting_chips,tournament_id,lifecycle)
VALUES('46468203-0000-4000-8000-000000000001','46468200-0000-4000-8000-000000000001','Accepted HU table','tournament','nlh',2,2,'waiting',
 'table:46468203-0000-4000-8000-000000000001','tournament:46468200-0000-4000-8000-000000000003',300,'46468200-0000-4000-8000-000000000003','live');
INSERT INTO public.tournament_players(id,tournament_id,user_id,username,chips,status,table_id,seat_number,club_id)
SELECT md5('activation-hu-entry:'||n)::uuid,'46468200-0000-4000-8000-000000000003',
 ('46468201-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'Accepted HU entrant',300,'playing',
 '46468203-0000-4000-8000-000000000001',n,'46468200-0000-4000-8000-000000000001' FROM generate_series(1,2)n;
INSERT INTO public.table_seats(id,table_id,seat_number,user_id,stack,status,left_at,leave_pending,is_sitting_out,is_away,club_id,active_game_scope,active_parent_key)
SELECT md5(p.id::text||':seat')::uuid,p.table_id,p.seat_number,p.user_id,300,'active',NULL,false,false,false,p.club_id,
 'table:'||p.table_id::text,'tournament:'||p.tournament_id::text FROM public.tournament_players p
 WHERE p.tournament_id='46468200-0000-4000-8000-000000000003';
SET LOCAL session_replication_role=origin;
SELECT set_config('request.jwt.claims','{"role":"service_role","sub":"46468201-0000-4000-8000-000000000003"}',true);
DO $$DECLARE r jsonb; BEGIN
 r:=public.fn_begin_tournament_launch_atomic('46468200-0000-4000-8000-000000000003','46468204-0000-4000-8000-000000000001',now(),
  '46468202-0000-4000-8000-000000000001','seat-first-satellite-v1');
 IF r->'ok' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'ACTIVATION_HU_BEGIN_FAILED: %',r; END IF;
 r:=public.fn_complete_tournament_launch_atomic('46468200-0000-4000-8000-000000000003','46468204-0000-4000-8000-000000000001',
  '46468202-0000-4000-8000-000000000001','seat-first-satellite-v1');
 IF r->'ok' IS DISTINCT FROM 'true'::jsonb OR r->'completed' IS DISTINCT FROM 'true'::jsonb THEN
  RAISE EXCEPTION 'ACTIVATION_HU_COMPLETE_FAILED: %',r; END IF;
 INSERT INTO r46_activation_hu.accepted SELECT to_jsonb(l),r46_activation_hu.money()
  FROM public.tournament_launch_receipts l WHERE tournament_id='46468200-0000-4000-8000-000000000003';
 IF NOT EXISTS(SELECT 1 FROM r46_activation_hu.accepted WHERE (money->>'treasury')::numeric=80
  AND (money#>>'{escrow,prize_balance}')::numeric=20 AND (money#>>'{promise,ticket_value}')::numeric=20
  AND (money#>>'{promise,funded_source_pool}')::numeric=20) THEN
  RAISE EXCEPTION 'ACTIVATION_HU_REAL_OVERLAY20_NOT_PROVEN'; END IF;
END $$;
COMMIT;
SELECT 'MTT_ACTIVATION_FUNDED_HU_BEFORE_PASS';
