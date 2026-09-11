-- Current authenticated request entry, funding provenance and late seating.
-- A caller-owned rollback transaction must install exact reviewed dependencies.
-- Never run against production. No auth function is replaced by this probe.
DO $prerequisites$
BEGIN
  IF current_user<>'postgres' OR inet_server_addr() IS NOT NULL
     OR current_database()<>'full_stage1'
     OR to_regprocedure('public.fn_register_for_tournament_request(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'current entry probe requires the owned native current composition';
  END IF;
END;
$prerequisites$;
SET LOCAL session_replication_role=replica;
INSERT INTO auth.users(id)
SELECT ('e3010000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid
FROM generate_series(1,3) i;
INSERT INTO public.users(id,username)
SELECT ('e3010000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,
       'current_entry_native_'||i FROM generate_series(1,3) i;
INSERT INTO public.profiles(id,username,display_name,is_horse)
SELECT ('e3010000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,
       'current_entry_native_'||i,'Current Entry Native '||i,false
FROM generate_series(1,3) i;
INSERT INTO auth.sessions(id,user_id,created_at,updated_at)
SELECT ('e3020000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,
       ('e3010000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,now(),now()
FROM generate_series(1,3) i;
INSERT INTO public.clubs(id,club_id,name)
SELECT ('e3030000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,
       999400+i,'Current Entry Native Club '||i FROM generate_series(1,3) i;
INSERT INTO public.unions(id,name,owner_id,slug) VALUES(
 'e3030000-0000-4000-8000-000000000001','Current Native Entry Union',
 'e3010000-0000-4000-8000-000000000001','current-native-entry-union');
INSERT INTO public.union_clubs(union_id,club_id) VALUES(
 'e3030000-0000-4000-8000-000000000001','e3030000-0000-4000-8000-000000000002');
INSERT INTO public.club_members(club_id,user_id,role,status,chip_balance,joined_at)
SELECT ('e3030000-0000-4000-8000-'||lpad(c::text,12,'0'))::uuid,
       ('e3010000-0000-4000-8000-'||lpad(u::text,12,'0'))::uuid,
       'player','active',CASE c WHEN 3 THEN 2000 ELSE 1000 END,
       now()-make_interval(days=>CASE c WHEN 3 THEN 30 WHEN 2 THEN 20 ELSE 10 END)
FROM generate_series(1,3) c CROSS JOIN generate_series(1,3) u;
INSERT INTO public.tournaments(
 id,name,buy_in_amount,buy_in_fee,starting_chips,start_time,status,
 current_players,max_players,current_level,club_id,union_id,prize_pool,total_rake,
 bounty_pool,entry_contract_locked,is_rebuy,is_reentry,rebuy_levels,
 late_reg_levels,late_reg_mins,started_at,level_started_at,table_size,
 variant,tournament_type,blind_structure)
SELECT ('e3040000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,
 'Current Entry Native '||i,90,10,1000,now()-interval '10 minutes','RUNNING',
 0,9,CASE i WHEN 3 THEN 5 ELSE 1 END,
 'e3030000-0000-4000-8000-000000000001',
 CASE i WHEN 2 THEN 'e3030000-0000-4000-8000-000000000001'::uuid END,
 0,0,0,false,false,false,5,5,0,now()-interval '10 minutes',now(),2,
 'mtt','MTT','[{"smallBlind":10,"bigBlind":20,"ante":0,"duration":180},{"smallBlind":20,"bigBlind":40,"ante":5,"duration":180}]'
FROM generate_series(1,3) i;
SET LOCAL session_replication_role=origin;

CREATE TEMP TABLE current_entry_results(name text PRIMARY KEY,value jsonb) ON COMMIT DROP;
GRANT SELECT,INSERT ON current_entry_results TO authenticated;
CREATE TEMP TABLE current_entry_checks(name text PRIMARY KEY) ON COMMIT DROP;
CREATE FUNCTION pg_temp.entry_assert(value boolean,label text) RETURNS void
LANGUAGE plpgsql AS $f$
BEGIN
 IF value IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL current entry: %',label; END IF;
 INSERT INTO current_entry_checks VALUES(label);
END;
$f$;
CREATE FUNCTION pg_temp.entry_state() RETURNS jsonb LANGUAGE plpgsql AS $f$
DECLARE result jsonb:='{}'; relation text; rows jsonb;
BEGIN
 FOREACH relation IN ARRAY ARRAY[
 'club_members','tournaments','tournament_players','tables','table_seats',
 'chip_transactions','chip_ledger','wallet_transactions','tournament_escrow',
 'rake_records','tournament_refund_entitlements','entry_purchase_idempotency_receipts',
 'tournament_capacity_table_receipts','tournament_manager_wakes'] LOOP
   EXECUTE format('SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),''[]''::jsonb) FROM public.%I t',relation) INTO rows;
   result:=result||jsonb_build_object(relation,rows);
 END LOOP;
 RETURN result;
END;
$f$;

-- Fail at the final stored response after actual wallet, pool and live-seat work.
CREATE FUNCTION pg_temp.reject_entry_receipt() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN
 IF NEW.key_domain='tournament_registration_v1'
    AND NEW.idempotency_key='e3050000-0000-4000-8000-000000000001'
    AND NEW.response IS NOT NULL THEN
   RAISE EXCEPTION 'injected current entry final receipt failure' USING ERRCODE='ZXE01';
 END IF;
 RETURN NEW;
END;
$f$;
CREATE TRIGGER zz_current_entry_receipt_fault BEFORE UPDATE OF response
ON public.entry_purchase_idempotency_receipts
FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_entry_receipt();
CREATE TEMP TABLE current_entry_before AS SELECT pg_temp.entry_state() AS value;
SELECT set_config('request.jwt.claims',jsonb_build_object(
 'sub','e3010000-0000-4000-8000-000000000001','role','authenticated',
 'session_id','e3020000-0000-4000-8000-000000000001')::text,true);
SET LOCAL ROLE authenticated;
DO $fault$
DECLARE rejected boolean:=false;
BEGIN
 BEGIN
  PERFORM public.fn_register_for_tournament_request(
   'e3040000-0000-4000-8000-000000000001','e3050000-0000-4000-8000-000000000001');
 EXCEPTION WHEN SQLSTATE 'ZXE01' THEN rejected:=true;
 END;
 IF NOT rejected THEN RAISE EXCEPTION 'current entry did not reach final receipt fault'; END IF;
END;
$fault$;
RESET ROLE;
SELECT pg_temp.entry_assert(pg_temp.entry_state()=(SELECT value FROM current_entry_before),
 'late receipt fault rolls back debit, ledger, pool, roster, newly created capacity, seat and wake');
DROP TRIGGER zz_current_entry_receipt_fault ON public.entry_purchase_idempotency_receipts;

-- Retry the same request after rollback, then read its stored immutable response.
SET LOCAL ROLE authenticated;
INSERT INTO current_entry_results VALUES('standalone',
 public.fn_register_for_tournament_request(
 'e3040000-0000-4000-8000-000000000001','e3050000-0000-4000-8000-000000000001'));
RESET ROLE;
TRUNCATE current_entry_before;
INSERT INTO current_entry_before SELECT pg_temp.entry_state();
SET LOCAL ROLE authenticated;
INSERT INTO current_entry_results VALUES('standalone_replay',
 public.fn_register_for_tournament_request(
 'e3040000-0000-4000-8000-000000000001','e3050000-0000-4000-8000-000000000001'));
RESET ROLE;
SELECT pg_temp.entry_assert(pg_temp.entry_state()=(SELECT value FROM current_entry_before),
 'standalone committed replay is a pure read of financial and seating state');
SELECT set_config('request.jwt.claims',jsonb_build_object(
 'sub','e3010000-0000-4000-8000-000000000002','role','authenticated',
 'session_id','e3020000-0000-4000-8000-000000000002')::text,true);
SET LOCAL ROLE authenticated;
INSERT INTO current_entry_results VALUES('union',
 public.fn_register_for_tournament_request(
 'e3040000-0000-4000-8000-000000000002','e3050000-0000-4000-8000-000000000002'));
RESET ROLE;
TRUNCATE current_entry_before;
INSERT INTO current_entry_before SELECT pg_temp.entry_state();
SET LOCAL ROLE authenticated;
INSERT INTO current_entry_results VALUES('union_replay',
 public.fn_register_for_tournament_request(
 'e3040000-0000-4000-8000-000000000002','e3050000-0000-4000-8000-000000000002'));
RESET ROLE;
SELECT pg_temp.entry_assert(pg_temp.entry_state()=(SELECT value FROM current_entry_before),
 'union committed replay is a pure read of financial and seating state');

DO $accepted$
DECLARE i integer; v_name text; r jsonb; event uuid; actor uuid; wallet uuid; seat uuid;
BEGIN
 FOR i IN 1..2 LOOP
  v_name:=CASE i WHEN 1 THEN 'standalone' ELSE 'union' END;
  event:=('e3040000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid;
  actor:=('e3010000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid;
  wallet:=('e3030000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid;
  SELECT value INTO STRICT r FROM current_entry_results x WHERE x.name=v_name;
  PERFORM pg_temp.entry_assert(r->>'ok'='true' AND r->>'late_registration'='true'
   AND (r->>'cost')::numeric=100 AND r->'seat'->>'ok'='true'
   AND r=(SELECT value FROM current_entry_results x WHERE x.name=v_name||'_replay'),
   v_name||' request-bound late entry returns exact stored response');
  PERFORM pg_temp.entry_assert(
   (SELECT chip_balance=900 FROM public.club_members WHERE club_id=wallet AND user_id=actor)
   AND NOT EXISTS(SELECT 1 FROM public.club_members WHERE user_id=actor AND club_id<>wallet
      AND chip_balance<>CASE WHEN club_id='e3030000-0000-4000-8000-000000000003' THEN 2000 ELSE 1000 END),
   v_name||' only resolved original club wallet is debited once');
  PERFORM pg_temp.entry_assert(
   (SELECT count(*)=1 FROM public.tournament_players p JOIN public.table_seats s
      ON s.table_id=p.table_id AND s.seat_number=p.seat_number AND s.user_id=p.user_id
     WHERE p.tournament_id=event AND p.user_id=actor AND p.club_id=wallet
      AND p.status='playing' AND p.chips=1000 AND s.stack=1000 AND s.left_at IS NULL)
   AND (SELECT count(*)=1 FROM public.tables WHERE tournament_id=event),
   v_name||' first live table and exact funded seat are created atomically');
  PERFORM pg_temp.entry_assert(
   (SELECT count(*)=1 FROM public.tables WHERE tournament_id=event
     AND game_type='tournament' AND game_variant='nlh' AND max_players=2
     AND small_blind=20 AND big_blind=40 AND ante=5 AND stakes='20/40')
   AND (SELECT count(*)=1 FROM public.tournament_capacity_table_receipts r
     JOIN public.tournament_manager_wakes w ON w.id=r.manager_wake_id
     WHERE r.tournament_id=event AND w.tournament_id=event
       AND r.manager_admitted_at IS NULL AND w.consumed_at IS NULL),
   v_name||' canonical table uses current blinds and has a pending manager receipt');
  PERFORM pg_temp.entry_assert(
   (SELECT count(*)=1 FROM public.chip_ledger WHERE tournament_id=event AND club_id=wallet
     AND from_type='player_wallet' AND from_entity_id=actor AND amount=100
     AND to_type='prize_liability' AND category='tournament_buyin')
   AND (SELECT count(*)=1 FROM public.tournament_refund_entitlements
     WHERE tournament_id=event AND user_id=actor AND refund_wallet_club_id=wallet
      AND gross=100 AND refund_prize=90 AND refund_bounty=0 AND refund_fee=10)
   AND (SELECT count(*)=1 FROM public.wallet_transactions
     WHERE related_entity_id=event AND user_id=actor AND amount=100 AND type='debit' AND balance_after=900),
   v_name||' journal, wallet receipt and refund entitlement bind one charged wallet');
  PERFORM pg_temp.entry_assert(
   (SELECT current_players=1 AND prize_pool=90 AND total_rake=10 FROM public.tournaments WHERE id=event)
   AND (SELECT prize_balance=90 AND fee_balance=10 AND bounty_balance=0
      FROM public.tournament_escrow WHERE tournament_id=event)
   AND (SELECT sum(rake_amount)=10 FROM public.rake_records WHERE tournament_id=event),
   v_name||' exact ninety prize plus ten fee equals the one hundred debit');
 END LOOP;
END;
$accepted$;


-- Fill the first table, then accept the next entrant into canonical overflow.
DO $overflow$
DECLARE i integer; event uuid:='e3040000-0000-4000-8000-000000000001';
 actor uuid; request_key uuid; r jsonb; before_state jsonb; replay jsonb;
BEGIN
 FOR i IN 2..3 LOOP
  actor:=('e3010000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid;
  request_key:=('e3050000-0000-4000-8000-'||lpad((i+2)::text,12,'0'))::uuid;
  PERFORM set_config('request.jwt.claims',jsonb_build_object(
    'sub',actor,'role','authenticated',
    'session_id',('e3020000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid)::text,true);
  SET LOCAL ROLE authenticated;
  r:=public.fn_register_for_tournament_request(event,request_key);
  RESET ROLE;
  PERFORM pg_temp.entry_assert(r->>'ok'='true' AND r->'seat'->>'ok'='true'
    AND (r->'seat'->>'opened_table')::boolean=(i=3),
    'entrant '||i||' opens capacity only when the first table is full');
  before_state:=pg_temp.entry_state();
  SET LOCAL ROLE authenticated;
  replay:=public.fn_register_for_tournament_request(event,request_key);
  RESET ROLE;
  PERFORM pg_temp.entry_assert(replay=r AND pg_temp.entry_state()=before_state,
    'entrant '||i||' replay preserves exact capacity, wallet and receipt state');
 END LOOP;
 PERFORM pg_temp.entry_assert(
  (SELECT count(*)=2 FROM public.tables WHERE tournament_id=event
    AND game_type='tournament' AND game_variant='nlh' AND max_players=2
    AND small_blind=20 AND big_blind=40 AND ante=5 AND stakes='20/40')
  AND (SELECT count(*)=2 FROM public.tournament_capacity_table_receipts WHERE tournament_id=event)
  AND (SELECT count(*)=3 AND sum(s.stack)=3000 FROM public.table_seats s
    JOIN public.tables t ON t.id=s.table_id WHERE t.tournament_id=event AND s.left_at IS NULL)
  AND (SELECT prize_balance=270 AND fee_balance=30 FROM public.tournament_escrow WHERE tournament_id=event),
  'overflow table, three paid seats and exact escrow remain one consistent entry state');
END;
$overflow$;

TRUNCATE current_entry_before;
INSERT INTO current_entry_before SELECT pg_temp.entry_state();
SELECT set_config('request.jwt.claims',jsonb_build_object(
 'sub','e3010000-0000-4000-8000-000000000003','role','authenticated',
 'session_id','e3020000-0000-4000-8000-000000000003')::text,true);
SET LOCAL ROLE authenticated;
INSERT INTO current_entry_results VALUES('closed',
 public.fn_register_for_tournament_request(
 'e3040000-0000-4000-8000-000000000003','e3050000-0000-4000-8000-000000000003'));
RESET ROLE;
SELECT pg_temp.entry_assert(
 (SELECT value->>'ok'='false' AND value->>'reason'='registration_closed'
    FROM current_entry_results WHERE name='closed')
 AND pg_temp.entry_state()=(SELECT value FROM current_entry_before),
 'closed late entry refuses without leaving funding, seat or receipt claim');
SET CONSTRAINTS ALL IMMEDIATE;
SELECT jsonb_build_object('probe','current_entry','passed',true,
 'checks',(SELECT jsonb_agg(name ORDER BY name) FROM current_entry_checks),
 'results',(SELECT jsonb_object_agg(name,value) FROM current_entry_results));
