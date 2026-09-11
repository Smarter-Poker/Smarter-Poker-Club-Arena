-- Current full Spin source proof. Only opening wallets/reserve capital and dealt-hand topology are synthetic.
-- Actual seat-first creator and three authenticated take-seat purchases -> actual lease/begin launch -> immutable draw ->
-- interrupted played/vacated launch continuation -> actual claim and terminal finish.
-- No payment, escrow, entitlement, launch, draw or terminal receipt is seeded.
-- Adapted with exact source pins from the two prior native probes; their stale runtime is not used.
-- Disposable PostgreSQL current zero-default Spin launch composition.
-- Current 20260910034412 automatically stamps the funded row inside the draw.
-- Compose the complete hash-pinned migration before this probe; all work rolls back.
-- Real entry/reserve/journal/escrow writes, final receipt failure, exact replay,
-- and played/vacated recovery through the lease-bound launch completion RPC.
-- The final PASS exception rolls back the complete fixture.
-- @FINAL_DEAL_RUNTIME@
-- Exact tracked platform source seed omitted by the native schema-only fixture.
INSERT INTO public.ca_settle_sources(source,note) VALUES('atomic_cancel_tournament','DB caller') ON CONFLICT(source) DO NOTHING;
DO $all_guards$
BEGIN
 IF (SELECT count(*) FROM pg_trigger WHERE tgrelid='public.tournaments'::regclass AND tgenabled='O' AND tgname IN (
 'aa_guard_tournament_completing_claim','zzzz_freeze_finalized_tournament_prize_pool',
 'zzzz_tournament_pool_finalization_window_guard','zzzz_tournaments_atomic_place_completion_guard',
 'zzzzz_tournaments_atomic_final_table_deal_completion_guard','zzzzzz_tournaments_financial_certificate',
 'aaa_guard_atomic_satellite_completion'))<>7 THEN RAISE EXCEPTION 'FAIL all seven current guards must remain enabled'; END IF;
 RAISE NOTICE 'PASS all seven current Stage B completion guards are enabled';
END $all_guards$;


DO $fixture_guard$
BEGIN
  IF current_user <> 'postgres'
     OR to_regprocedure('public.fn_spin_draw_and_settle_atomic(uuid,uuid,uuid,jsonb)') IS NULL
     OR to_regprocedure('public.fn_prove_played_spin_launch_recovery(uuid)') IS NULL
     OR to_regprocedure('public.fn_complete_tournament_launch_atomic(uuid,uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'native Spin launch probe requires the disposable composed rehearsal database';
  END IF;
  IF md5(pg_get_functiondef('public.fn_spin_draw_and_settle_atomic(uuid,uuid,uuid,jsonb)'::regprocedure))
       IS DISTINCT FROM '6d2328689637d1d28c9ce9256a0d6252'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_spin_book_entry(uuid)'::regprocedure)
       IS DISTINCT FROM '604113bd4172433183cdd1d59af04e0f'
     OR (SELECT md5(prosrc) FROM pg_proc
          WHERE oid='public.fn_spin_settle_game(uuid,uuid,numeric,integer,numeric,numeric)'::regprocedure)
       IS DISTINCT FROM 'a0f5a4d8edb0c0e403d3c00a9aadaa95' THEN
    RAISE EXCEPTION 'native Spin launch money authority fingerprint changed';
  END IF;
  IF EXISTS(SELECT 1 FROM (VALUES
      ('spin_reserve_ledger','spin_reserve_row_requires_exact_journal'),
      ('chip_ledger','zz_ca_escrow_reserve_leg'),
      ('spin_bonus_pools','trg_ca_autoledger'),
      ('tournament_escrow','zz_spin_escrow_is_enforced'),
      ('spin_draw_receipts','spin_draw_receipt_is_immutable')) guards(table_name,trigger_name)
      WHERE NOT EXISTS(SELECT 1 FROM pg_trigger t
       WHERE t.tgrelid=to_regclass('public.'||guards.table_name)
         AND t.tgname=guards.trigger_name AND t.tgenabled='O')) THEN
    RAISE EXCEPTION 'native Spin launch requires enabled money and receipt guards';
  END IF;
END;
$fixture_guard$;

SET LOCAL session_replication_role=replica;

INSERT INTO auth.users(id)
SELECT md5('zero-default-spin-launch-user:' || g.i::text)::uuid
  FROM generate_series(1,3) g(i);

INSERT INTO public.profiles(id,username,display_name)
SELECT md5('zero-default-spin-launch-user:' || g.i::text)::uuid,
       'zero_default_spin_launch_' || g.i,
       'Zero Default Spin Launch ' || g.i
  FROM generate_series(1,3) g(i);

INSERT INTO public.clubs(id,name,owner_id,chip_treasury,spins_enabled)
VALUES (
  '92000000-0000-0000-0000-000000000001',
  'Zero Default Spin Launch Probe Club',
  md5('zero-default-spin-launch-user:1')::uuid,
  1000,
  true
);

INSERT INTO public.club_members(club_id,user_id,role,status,chip_balance)
SELECT '92000000-0000-0000-0000-000000000001',
       md5('zero-default-spin-launch-user:' || g.i::text)::uuid,
       CASE WHEN g.i=1 THEN 'owner' ELSE 'player' END,
       'active',
       100
  FROM generate_series(1,3) g(i);

INSERT INTO public.spin_bonus_pools(
  id,club_id,balance,total_deposited,total_drawn,spin_count,bonus_count,
  seeded_amount,ceiling_amount,highest_stake,surplus_returned,is_active,
  owner_kind,offered_max_stake,seed_returned_amount,required_seed_at_activation
) VALUES (
  '92030000-0000-0000-0000-000000000001',
  '92000000-0000-0000-0000-000000000001',
  1000,1000,0,0,0,0,10000,1,0,true,'club',1,0,0
);

INSERT INTO public.users(id,username)
 SELECT md5('zero-default-spin-launch-user:'||i)::uuid,'zero_default_native_user_'||i
 FROM generate_series(1,3) g(i);
INSERT INTO auth.sessions(id,user_id,created_at,updated_at)
 SELECT md5('full-spin-session:'||i)::uuid,md5('zero-default-spin-launch-user:'||i)::uuid,now(),now()
 FROM generate_series(1,3) g(i);
SET LOCAL session_replication_role=origin;
-- A real creator/entry RPC commits before launch begins. Flush its original
-- deferred proofs here, then restore only constraints declared initially deferred.
CREATE FUNCTION pg_temp.spin_full_request_boundary() RETURNS void LANGUAGE plpgsql AS $boundary$
DECLARE c record;
BEGIN
 SET CONSTRAINTS ALL IMMEDIATE;
 FOR c IN SELECT DISTINCT co.conname FROM pg_constraint co JOIN pg_namespace n ON n.oid=co.connamespace
  WHERE n.nspname='public' AND co.condeferrable AND co.condeferred ORDER BY co.conname LOOP
  IF EXISTS(SELECT 1 FROM pg_constraint other JOIN pg_namespace n ON n.oid=other.connamespace
   WHERE n.nspname='public' AND other.conname=c.conname AND (NOT other.condeferrable OR NOT other.condeferred))
  THEN RAISE EXCEPTION 'ambiguous constraint mode at simulated request boundary: %',c.conname; END IF;
  EXECUTE format('SET CONSTRAINTS public.%I DEFERRED',c.conname);
 END LOOP;
END $boundary$;
CREATE TEMP TABLE spin_full_game(table_id uuid PRIMARY KEY,receipt jsonb NOT NULL) ON COMMIT DROP;
GRANT SELECT,INSERT ON spin_full_game TO service_role;
GRANT SELECT ON spin_full_game TO authenticated;
CREATE FUNCTION pg_temp.spin_table_id() RETURNS uuid LANGUAGE sql STABLE
 AS $id$ SELECT table_id FROM spin_full_game $id$;
SELECT set_config('request.jwt.claims','{"role":"service_role"}',true),
 set_config('request.jwt.claim.role','service_role',true),set_config('request.jwt.claim.sub','',true);
SET LOCAL ROLE service_role;
DO $real_creator$
DECLARE r jsonb; replay jsonb; config jsonb:=jsonb_build_object(
 'club_id','92000000-0000-0000-0000-000000000001','union_id',NULL,
 'name','Current Full Spin Terminal Proof','game_type','NLH','variant','spin','tournament_type','SPIN',
 'buy_in_amount',1,'buy_in_fee',0,'guaranteed_prize',0,'starting_chips',1000,
 'max_players',3,'min_players',3,'table_size',3,'current_players',0,'status','REGISTERING',
 'blind_structure','[{"level":1,"smallBlind":10,"bigBlind":20,"ante":0,"duration":180}]'::jsonb,
 'payout_structure','[{"place":1,"percentage":100}]'::jsonb,
 'start_time',clock_timestamp()+interval '1 day','late_reg_levels',0,'late_reg_mins',0,
 'satellite_target_id',NULL,'satellite_seats',NULL,'short_description',NULL,
 'spin_multiplier',NULL,'spin_locked_tiers',NULL);
BEGIN
 r:=public.fn_create_seat_first_game_atomic('92010000-0000-0000-0000-000000000001',config);
 IF r->>'ok' IS DISTINCT FROM 'true' OR r->>'replayed' IS DISTINCT FROM 'false'
  OR r->'tournament'->>'id' IS DISTINCT FROM '92010000-0000-0000-0000-000000000001'
  OR NULLIF(r->>'table_id','') IS NULL THEN RAISE EXCEPTION 'FAIL actual Spin creator: %',r; END IF;
 INSERT INTO spin_full_game VALUES((r->>'table_id')::uuid,r);
 replay:=public.fn_create_seat_first_game_atomic('92010000-0000-0000-0000-000000000001',config);
 IF replay->>'ok' IS DISTINCT FROM 'true' OR replay->>'replayed' IS DISTINCT FROM 'true'
  OR replay->>'table_id' IS DISTINCT FROM r->>'table_id' THEN RAISE EXCEPTION 'FAIL creator replay: %',replay; END IF;
 RAISE NOTICE 'PASS actual seat-first creator commits and replays the same Spin and table';
END $real_creator$;
RESET ROLE;
SELECT pg_temp.spin_full_request_boundary();

CREATE TEMP TABLE spin_full_registration(user_id uuid PRIMARY KEY,receipt jsonb) ON COMMIT DROP;
GRANT INSERT,SELECT ON spin_full_registration TO authenticated;
SET LOCAL ROLE authenticated;
DO $real_entry$
DECLARE i integer; u uuid; r jsonb;
BEGIN
 FOR i IN 1..3 LOOP
  u:=md5('zero-default-spin-launch-user:'||i)::uuid;
  PERFORM set_config('request.jwt.claim.role','authenticated',true);
  PERFORM set_config('request.jwt.claim.sub',u::text,true);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',u,'role','authenticated',
   'session_id',md5('full-spin-session:'||i)::uuid)::text,true);
  r:=public.fn_take_seat_and_buy_in(pg_temp.spin_table_id(),i);
  IF r->>'ok' IS DISTINCT FROM 'true' OR (r->>'cost')::numeric IS DISTINCT FROM 1::numeric
   THEN RAISE EXCEPTION 'FAIL actual Spin entry %: %',i,r; END IF;
  INSERT INTO spin_full_registration VALUES(u,r);
  PERFORM pg_temp.spin_full_request_boundary();
 END LOOP;
END $real_entry$;
RESET ROLE;
DO $funding$
DECLARE facts jsonb;
BEGIN
 facts:=jsonb_build_object(
  'wallets_exact',(SELECT count(*)=3 FROM public.club_members WHERE club_id='92000000-0000-0000-0000-000000000001' AND chip_balance=99),
  'escrow',(SELECT jsonb_build_object('gross_in',gross_in,'prize_balance',prize_balance,'fee_balance',fee_balance,
    'reserve_out',reserve_out,'reserve_in',reserve_in,'fee_entries_in',fee_entries_in) FROM public.tournament_escrow
    WHERE tournament_id='92010000-0000-0000-0000-000000000001'),
  'entitlements_exact',(SELECT count(*)=3 FROM public.tournament_refund_entitlements WHERE tournament_id='92010000-0000-0000-0000-000000000001'
   AND entitlement_kind='wallet_charge' AND gross=1 AND refund_prize=1 AND refund_fee=0 AND source_ledger_id IS NOT NULL),
  'source_journals_exact',(SELECT count(*)=3 FROM public.chip_ledger WHERE tournament_id='92010000-0000-0000-0000-000000000001' AND category='tournament_buyin' AND amount=1),
  'paid_seats_exact',(SELECT count(*)=3 FROM public.table_seats WHERE table_id=pg_temp.spin_table_id() AND left_at IS NULL AND stack=1000),
  'paid_roster_exact',(SELECT count(*)=3 FROM public.tournament_players WHERE tournament_id='92010000-0000-0000-0000-000000000001'
    AND status='playing' AND chips=1000 AND table_id=pg_temp.spin_table_id()),
  'reserve',(SELECT jsonb_agg(jsonb_build_object('kind',kind,'amount',amount) ORDER BY kind) FROM public.spin_reserve_ledger
    WHERE tournament_id='92010000-0000-0000-0000-000000000001'),
  'spin_journals',(SELECT jsonb_agg(jsonb_build_object('category',category,'amount',amount) ORDER BY category) FROM public.chip_ledger
    WHERE tournament_id='92010000-0000-0000-0000-000000000001' AND category IN ('spin_entry','spin_prize')),
  'rake',(SELECT jsonb_agg(rake_amount ORDER BY id) FROM public.rake_records WHERE tournament_id='92010000-0000-0000-0000-000000000001'));
 IF facts->>'wallets_exact' IS DISTINCT FROM 'true'
  OR facts->>'entitlements_exact' IS DISTINCT FROM 'true'
  OR facts->>'source_journals_exact' IS DISTINCT FROM 'true'
  OR facts->>'paid_seats_exact' IS DISTINCT FROM 'true'
  OR facts->>'paid_roster_exact' IS DISTINCT FROM 'true'
  OR facts->'escrow' IS DISTINCT FROM '{"gross_in":3,"prize_balance":0,"fee_balance":0.24,"reserve_out":2.76,"reserve_in":0,"fee_entries_in":0.24}'::jsonb
  OR facts->'reserve' IS DISTINCT FROM '[{"kind":"contribution","amount":2.76}]'::jsonb
  OR facts->'spin_journals' IS DISTINCT FROM '[{"category":"spin_entry","amount":2.76}]'::jsonb
  OR facts->'rake' IS DISTINCT FROM '[0.24]'::jsonb
  OR EXISTS(SELECT 1 FROM public.spin_draw_receipts WHERE tournament_id='92010000-0000-0000-0000-000000000001')
 THEN RAISE EXCEPTION 'FAIL actual three-seat purchase/entry booking facts: %',facts; END IF;
 RAISE NOTICE 'SPIN_ENTRY_FACTS %',facts;
 RAISE NOTICE 'PASS three actual seat purchases fund three wallets and 3000 play chips; third seat books 2.76 reserve contribution and 0.24 fee before draw';
END $funding$;
CREATE FUNCTION pg_temp.spin_replay_state(p_tournament_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SET search_path TO 'public','pg_temp'
AS $state$
  SELECT jsonb_build_object(
    'pool',(SELECT jsonb_build_object(
      'balance',p.balance,'total_deposited',p.total_deposited,
      'total_drawn',p.total_drawn,'spin_count',p.spin_count,
      'bonus_count',p.bonus_count,'seeded_amount',p.seeded_amount,
      'seed_returned_amount',p.seed_returned_amount)
      FROM public.spin_bonus_pools p
      WHERE p.id='92030000-0000-0000-0000-000000000001'),
    'reserve',(SELECT jsonb_agg(to_jsonb(r) ORDER BY r.kind,r.id)
      FROM public.spin_reserve_ledger r WHERE r.tournament_id=p_tournament_id),
    'journal',(SELECT jsonb_agg(to_jsonb(l) ORDER BY l.category,l.id)
      FROM public.chip_ledger l WHERE l.tournament_id=p_tournament_id
        AND l.category IN ('spin_entry','spin_prize')),
    'rake',(SELECT jsonb_agg(to_jsonb(rr) ORDER BY rr.id)
      FROM public.rake_records rr WHERE rr.tournament_id=p_tournament_id),
    'escrow',(SELECT to_jsonb(e) FROM public.tournament_escrow e
      WHERE e.tournament_id=p_tournament_id),
    'contract',(SELECT jsonb_build_object(
      'spin_multiplier',t.spin_multiplier,'prize_pool',t.prize_pool,
      'spin_locked_tiers',t.spin_locked_tiers,
      'blind_structure',t.blind_structure,'payout_structure',t.payout_structure,
      'is_premium_spin',t.is_premium_spin)
      FROM public.tournaments t WHERE t.id=p_tournament_id));
$state$;

SET LOCAL session_replication_role=origin;
SELECT set_config('request.jwt.claims','{"role":"service_role"}',true),
 set_config('request.jwt.claim.sub','',true),set_config('request.jwt.claim.role','service_role',true),
 set_config('app.smarter_data_actor','',true),set_config('app.smarter_manager_request_fenced','',true),
 set_config('app.smarter_tournament_id','',true),set_config('app.smarter_tournament_lease_generation','',true);
SET LOCAL ROLE service_role;
SELECT set_config('request.headers','{"x-smarter-data-actor":"service","x-smarter-data-protocol":"1"}',true),
 set_config('request.method','POST',true),set_config('request.path','rpc/claim_tournament_lease_v2',true);
SELECT smarter_private.fn_smarter_data_api_pre_request();
SELECT public.claim_tournament_lease_v2('92010000-0000-0000-0000-000000000001',
 'native-full-spin','native-current-spin-proof','92050000-0000-4000-8000-000000000001',30);
DO $begin_launch$
DECLARE r jsonb;
BEGIN
 r:=public.fn_begin_tournament_launch_atomic('92010000-0000-0000-0000-000000000001',
  '92040000-0000-4000-8000-000000000001',now()-interval '3 hours','92050000-0000-4000-8000-000000000001');
 IF r->>'ok' IS DISTINCT FROM 'true' OR r->>'claimed' IS DISTINCT FROM 'true'
  THEN RAISE EXCEPTION 'FAIL actual lease-bound begin launch: %',r; END IF;
END $begin_launch$;
RESET ROLE;
DO $launch_receipt$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.tournament_launch_receipts WHERE tournament_id='92010000-0000-0000-0000-000000000001'
  AND launch_id='92040000-0000-4000-8000-000000000001' AND lease_generation='92050000-0000-4000-8000-000000000001' AND completed_at IS NULL)
 THEN RAISE EXCEPTION 'FAIL canonical begin launch omitted the immutable receipt'; END IF;
 RAISE NOTICE 'PASS actual lease claim and begin launch own the three-hour interrupted Spin';
END $launch_receipt$;

DO $zero_default$ BEGIN
 IF (SELECT spin_multiplier FROM public.tournaments
     WHERE id='92010000-0000-0000-0000-000000000001') IS DISTINCT FROM 0::numeric
  OR current_setting('session_replication_role') <> 'origin' THEN
  RAISE EXCEPTION 'FAIL fresh Spin must use the real zero default with native guards';
 END IF;
END $zero_default$;
DO $notice$ BEGIN RAISE NOTICE 'PASS Spin zero_default'; END $notice$;

CREATE FUNCTION pg_temp.native_spin_rules() RETURNS jsonb LANGUAGE sql AS $rules$
 SELECT jsonb_build_object('version',1,'buy_in',1,'seats',3,'rake_rate',0.08,
  'starting_chips',1000,'tiers',jsonb_agg(jsonb_build_object(
   'multiplier',multiplier,'freq',freq,'reserveThresholdX',0,
   'blind_structure',(SELECT jsonb_agg(jsonb_build_object('level',i,'smallBlind',i*10,
    'bigBlind',i*20,'ante',0,'duration',180) || CASE WHEN i=12 THEN
     jsonb_build_object('spinContinuation',jsonb_build_object('version',1,'anchorLevel',12,
      'anchorBigBlind',240,'growth',1.4,'roundBigTo',10)) ELSE '{}'::jsonb END ORDER BY i)
      FROM generate_series(1,12) g(i)),
   'payout_structure',CASE WHEN multiplier=10 THEN
    jsonb_build_array(jsonb_build_object('place',1,'percentage',80),
                     jsonb_build_object('place',2,'percentage',20))
    ELSE jsonb_build_array(jsonb_build_object('place',1,'percentage',100)) END)
   ORDER BY multiplier)) FROM (VALUES (2,181),(10,19)) tiers(multiplier,freq);
$rules$;

CREATE FUNCTION pg_temp.native_spin_call(rules jsonb DEFAULT pg_temp.native_spin_rules())
RETURNS jsonb LANGUAGE sql AS $call$
 SELECT public.fn_spin_draw_and_settle_atomic(
  '92010000-0000-0000-0000-000000000001','92040000-0000-4000-8000-000000000001',
  '92050000-0000-4000-8000-000000000001',rules);
$call$;

CREATE FUNCTION pg_temp.native_spin_state() RETURNS jsonb LANGUAGE sql AS $snapshot$
 SELECT jsonb_build_array(
  pg_temp.spin_replay_state('92010000-0000-0000-0000-000000000001'),
  (SELECT to_jsonb(r) FROM public.spin_draw_receipts r
   WHERE tournament_id='92010000-0000-0000-0000-000000000001'));
$snapshot$;

CREATE FUNCTION pg_temp.spin_full_state() RETURNS jsonb LANGUAGE plpgsql AS $state$
DECLARE t record; rows jsonb; result jsonb:='{}';
BEGIN
 FOR t IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relkind IN ('r','p') ORDER BY c.relname LOOP
  EXECUTE format('SELECT jsonb_agg(to_jsonb(x) ORDER BY to_jsonb(x)::text) FROM public.%I x',t.relname) INTO rows;
  result:=result||jsonb_build_object(t.relname,rows);
 END LOOP;
 RETURN result;
END $state$;
CREATE FUNCTION pg_temp.spin_full_cancel_refused(label text) RETURNS void LANGUAGE plpgsql AS $refusal$
DECLARE before_state jsonb:=pg_temp.spin_full_state(); refused boolean:=false;
BEGIN
 BEGIN PERFORM public.atomic_cancel_tournament('92010000-0000-0000-0000-000000000001',NULL);
 EXCEPTION WHEN SQLSTATE '55000' THEN
  IF SQLERRM<>'Tournament has started or committed awards; resume or settle it instead of cancelling' THEN RAISE; END IF;
  refused:=true;
 END;
 IF NOT refused OR pg_temp.spin_full_state() IS DISTINCT FROM before_state
 THEN RAISE EXCEPTION 'FAIL %: cancellation was admitted or changed state',label; END IF;
 RAISE NOTICE 'PASS %',label;
END $refusal$;

-- A positive projection without a funded draw remains invalid, with no money.
SAVEPOINT projected_without_funding;
SET LOCAL session_replication_role=replica;
UPDATE public.tournaments SET spin_multiplier=2
 WHERE id='92010000-0000-0000-0000-000000000001';
SET LOCAL session_replication_role=origin;
DO $positive_unfunded$
DECLARE before_state jsonb:=pg_temp.native_spin_state(); result jsonb;
BEGIN
 result:=pg_temp.native_spin_call();
 IF result->>'ok' IS DISTINCT FROM 'false'
  OR result->>'reason' IS DISTINCT FROM 'projected_spin_draw_has_no_funding_proof'
  OR pg_temp.native_spin_state() IS DISTINCT FROM before_state THEN
  RAISE EXCEPTION 'FAIL positive unfunded Spin projection was accepted: %',result;
 END IF;
END $positive_unfunded$;
DO $notice$ BEGIN RAISE NOTICE 'PASS Spin positive_unfunded'; END $notice$;
ROLLBACK TO SAVEPOINT projected_without_funding;

CREATE FUNCTION pg_temp.native_spin_final_receipt_fault() RETURNS trigger LANGUAGE plpgsql AS $fault$
BEGIN
 IF NEW.tournament_id='92010000-0000-0000-0000-000000000001' THEN
  IF NEW.receipt->>'ok' IS DISTINCT FROM 'true'
   OR (SELECT count(*) FROM public.spin_reserve_ledger WHERE tournament_id=NEW.tournament_id)<>2
   OR (SELECT count(*) FROM public.chip_ledger WHERE tournament_id=NEW.tournament_id
       AND category IN ('spin_entry','spin_prize'))<>2
   OR (SELECT count(*) FROM public.rake_records WHERE tournament_id=NEW.tournament_id)<>1
   OR NOT EXISTS(SELECT 1 FROM public.tournament_escrow e WHERE e.tournament_id=NEW.tournament_id
       AND reserve_out=2.76 AND reserve_in=(NEW.receipt->>'prize_pool')::numeric
       AND fee_entries_in=.24 AND prize_balance=(NEW.receipt->>'prize_pool')::numeric) THEN
    RAISE EXCEPTION 'FAIL immutable receipt fault did not follow exact native money writes';
  END IF;
  RAISE EXCEPTION 'expected final immutable receipt fault' USING ERRCODE='ZX002';
 END IF;
 RETURN NEW;
END;
$fault$;
CREATE TRIGGER native_spin_final_receipt_fault AFTER INSERT ON public.spin_draw_receipts
FOR EACH ROW EXECUTE FUNCTION pg_temp.native_spin_final_receipt_fault();

DO $rollback$
DECLARE before_state jsonb:=pg_temp.spin_full_state(); refused boolean:=false; v_result jsonb;
BEGIN
 BEGIN v_result:=pg_temp.native_spin_call(); EXCEPTION WHEN SQLSTATE 'ZX002' THEN refused:=true; END;
 IF NOT refused OR pg_temp.spin_full_state() IS DISTINCT FROM before_state THEN
  RAISE EXCEPTION 'FAIL immutable Spin receipt failure retained partial money or receipt: %',v_result;
 END IF;
END;
$rollback$;
DO $notice$ BEGIN RAISE NOTICE 'PASS Spin rollback'; END $notice$;
DROP TRIGGER native_spin_final_receipt_fault ON public.spin_draw_receipts;
DROP FUNCTION pg_temp.native_spin_final_receipt_fault();

-- Fail after the current wrapper has written money, receipt AND the row stamp.
CREATE FUNCTION pg_temp.native_spin_projection_fault() RETURNS trigger
LANGUAGE plpgsql AS $fault$
DECLARE receipt jsonb;
BEGIN
 IF NEW.id='92010000-0000-0000-0000-000000000001'
  AND COALESCE(OLD.spin_multiplier,0)=0 AND NEW.spin_multiplier>0 THEN
  SELECT r.receipt INTO receipt FROM public.spin_draw_receipts r
   WHERE r.tournament_id=NEW.id;
  IF receipt->>'ok' IS DISTINCT FROM 'true'
   OR receipt->>'rule_provenance' IS DISTINCT FROM 'at_draw'
   OR NEW.spin_multiplier IS DISTINCT FROM (receipt->>'multiplier')::numeric
   OR NEW.prize_pool IS DISTINCT FROM (receipt->>'prize_pool')::numeric
   OR NEW.blind_structure::jsonb IS DISTINCT FROM receipt->'blind_structure'
   OR NEW.payout_structure::jsonb IS DISTINCT FROM receipt->'payout_structure'
   OR NEW.spin_locked_tiers IS DISTINCT FROM receipt->'locked'
   OR NEW.is_premium_spin IS DISTINCT FROM OLD.is_premium_spin
   OR (SELECT count(*) FROM public.spin_reserve_ledger WHERE tournament_id=NEW.id)<>2
   OR (SELECT count(*) FROM public.chip_ledger WHERE tournament_id=NEW.id
       AND category IN ('spin_entry','spin_prize'))<>2
   OR (SELECT count(*) FROM public.rake_records WHERE tournament_id=NEW.id)<>1
   OR NOT EXISTS(SELECT 1 FROM public.tournament_escrow WHERE tournament_id=NEW.id
      AND reserve_out=2.76 AND reserve_in=NEW.prize_pool
      AND fee_entries_in=.24 AND prize_balance=NEW.prize_pool) THEN
    RAISE EXCEPTION 'FAIL row-stamp fault was reached without the exact native funded contract';
  END IF;
  RAISE EXCEPTION 'expected final Spin row-stamp fault' USING ERRCODE='ZX003';
 END IF;
 RETURN NEW;
END $fault$;
CREATE TRIGGER native_spin_projection_fault AFTER UPDATE ON public.tournaments
FOR EACH ROW EXECUTE FUNCTION pg_temp.native_spin_projection_fault();
DO $projection_rollback$
DECLARE before_state jsonb:=pg_temp.spin_full_state(); refused boolean:=false;
BEGIN
 BEGIN PERFORM pg_temp.native_spin_call(); EXCEPTION WHEN SQLSTATE 'ZX003' THEN refused:=true; END;
 IF NOT refused OR pg_temp.spin_full_state() IS DISTINCT FROM before_state THEN
  RAISE EXCEPTION 'FAIL late Spin row-stamp failure retained partial money, receipt or projection';
 END IF;
END $projection_rollback$;
DO $notice$ BEGIN RAISE NOTICE 'PASS Spin projection_rollback'; END $notice$;
DROP TRIGGER native_spin_projection_fault ON public.tournaments;
DROP FUNCTION pg_temp.native_spin_projection_fault();

CREATE TEMP TABLE native_spin_result(receipt jsonb NOT NULL, durable_state jsonb NOT NULL);
DO $native$
DECLARE first_receipt jsonb; replay_receipt jsonb; before_state jsonb; refused boolean:=false;
BEGIN
 first_receipt:=pg_temp.native_spin_call();
 IF first_receipt->>'ok' IS DISTINCT FROM 'true' OR first_receipt->>'replay' IS DISTINCT FROM 'false'
  OR (first_receipt->>'multiplier')::numeric NOT IN (2,10)
  OR (first_receipt->>'prize_pool')::numeric IS DISTINCT FROM (first_receipt->>'multiplier')::numeric
  OR (first_receipt->>'house_rake')::numeric IS DISTINCT FROM .24
  OR (first_receipt->>'operator_shortfall')::numeric IS DISTINCT FROM 0
  OR (first_receipt->>'pool_covered')::numeric IS DISTINCT FROM (first_receipt->>'prize_pool')::numeric
  OR NOT EXISTS(SELECT 1 FROM public.spin_bonus_pools
     WHERE id='92030000-0000-0000-0000-000000000001'
       AND balance=1002.76-(first_receipt->>'prize_pool')::numeric
       AND total_deposited=1002.76 AND total_drawn=(first_receipt->>'prize_pool')::numeric
       AND spin_count=1)
  OR (SELECT count(*) FROM public.spin_draw_receipts WHERE tournament_id='92010000-0000-0000-0000-000000000001')<>1 THEN
  RAISE EXCEPTION 'FAIL funded immutable Spin receipt: %',first_receipt;
 END IF;
 before_state:=pg_temp.native_spin_state();
 replay_receipt:=pg_temp.native_spin_call(jsonb_set(pg_temp.native_spin_rules(),'{starting_chips}','999'));
 IF replay_receipt IS DISTINCT FROM first_receipt||'{"replay":true}'::jsonb
  OR pg_temp.native_spin_state() IS DISTINCT FROM before_state THEN
  RAISE EXCEPTION 'FAIL response-loss retry changed funded receipt or financial state';
 END IF;
 IF (public.fn_spin_draw_and_settle_atomic(
  '92010000-0000-0000-0000-000000000001','92040000-0000-4000-8000-000000000001',
  '92050000-0000-4000-8000-000000000099',pg_temp.native_spin_rules())->>'reason') IS DISTINCT FROM 'launch_lease_lost'
  OR pg_temp.native_spin_state() IS DISTINCT FROM before_state THEN
  RAISE EXCEPTION 'FAIL stale owner used the immutable receipt';
 END IF;
 BEGIN DELETE FROM public.spin_draw_receipts WHERE tournament_id='92010000-0000-0000-0000-000000000001';
 EXCEPTION WHEN check_violation THEN refused:=true; END;
 IF NOT refused OR pg_temp.native_spin_state() IS DISTINCT FROM before_state THEN
  RAISE EXCEPTION 'FAIL privileged receipt mutation was accepted';
 END IF;
 INSERT INTO native_spin_result VALUES(first_receipt,before_state);
END;
$native$;
DO $notice$ BEGIN RAISE NOTICE 'PASS Spin native'; END $notice$;


-- The atomic SQL authority must stamp every contract field itself.
-- No client/engine UPDATE is allowed to make this acceptance assertion pass.
DO $automatic_projection$
DECLARE receipt jsonb;
BEGIN
 SELECT r.receipt INTO receipt FROM native_spin_result r;
 IF receipt->>'rule_provenance' IS DISTINCT FROM 'at_draw'
  OR NOT EXISTS(SELECT 1 FROM public.tournaments t
   WHERE t.id='92010000-0000-0000-0000-000000000001'
    AND t.spin_multiplier=(receipt->>'multiplier')::numeric
    AND t.prize_pool=(receipt->>'prize_pool')::numeric
    AND t.spin_locked_tiers IS NOT DISTINCT FROM receipt->'locked'
    AND t.blind_structure::jsonb=receipt->'blind_structure'
    AND t.payout_structure::jsonb=receipt->'payout_structure') THEN
  RAISE EXCEPTION 'FAIL atomic draw omitted its at_draw row projection';
 END IF;
END $automatic_projection$;
DO $notice$ BEGIN RAISE NOTICE 'PASS Spin automatic_projection'; END $notice$;
SELECT pg_temp.spin_full_cancel_refused('committed draw refuses cancellation before any persisted hand');
SET LOCAL session_replication_role=replica;

UPDATE public.table_seats
   SET stack=CASE seat_number WHEN 1 THEN 0 WHEN 2 THEN 1000 ELSE 2000 END
 WHERE table_id=pg_temp.spin_table_id();
UPDATE public.tournament_players
   SET chips=CASE seat_number WHEN 1 THEN 0 WHEN 2 THEN 1000 ELSE 2000 END
 WHERE tournament_id='92010000-0000-0000-0000-000000000001';

UPDATE public.table_seats
   SET left_at=transaction_timestamp(),status='left'
 WHERE table_id=pg_temp.spin_table_id()
   AND seat_number=1;
UPDATE public.tournament_players
   SET status='eliminated',table_id=NULL,seat_number=NULL,
       eliminated_at=transaction_timestamp()
 WHERE tournament_id='92010000-0000-0000-0000-000000000001'
   AND user_id=md5('zero-default-spin-launch-user:1')::uuid;
UPDATE public.tables
   SET current_players=2
 WHERE id=pg_temp.spin_table_id();

INSERT INTO public.hand_history(
  id,table_id,tournament_id,hand_number,game_variant,pot_size,players,actions,
  started_at,ended_at
) VALUES (
  '92060000-0000-4000-8000-000000000001',
  pg_temp.spin_table_id(),
  '92010000-0000-0000-0000-000000000001',
  992000001,'nlh',3000,'[]','[]',
  transaction_timestamp(),transaction_timestamp()
);

SET LOCAL session_replication_role=origin;

DO $positive_preflight$
DECLARE
  v_proof jsonb;
BEGIN
  v_proof := public.fn_prove_played_spin_launch_recovery(
    '92010000-0000-0000-0000-000000000001'
  );
  IF v_proof->>'ok' IS DISTINCT FROM 'true'
     OR v_proof->>'recovery_mode' IS DISTINCT FROM 'played_vacated_spin'
     OR (v_proof->>'original_field')::integer <> 3
     OR (v_proof->>'active_field')::integer <> 2
     OR (v_proof->>'paid_users')::integer <> 3
     OR (v_proof->>'entitlement_users')::integer <> 3
     OR (v_proof->>'live_seats')::integer <> 2
     OR (v_proof->>'hand_count')::integer < 1
     OR (v_proof->>'funding_floor')::numeric <> 3000
     OR (v_proof->>'roster_chips')::numeric <> 3000
     OR (v_proof->>'seat_chips')::numeric <> 3000
     OR jsonb_array_length(v_proof->'original_player_ids') <> 3
     OR jsonb_array_length(v_proof->'active_player_ids') <> 2 THEN
    RAISE EXCEPTION 'FAIL played Spin preflight was not exact: %',v_proof;
  END IF;
END;
$positive_preflight$;
DO $notice$ BEGIN RAISE NOTICE 'PASS Spin positive_preflight'; END $notice$;

SELECT pg_temp.spin_full_cancel_refused('played and vacated late Spin refuses cancellation before launch continuation');
DO $played_replay$
DECLARE before_state jsonb:=pg_temp.native_spin_state(); first_receipt jsonb; replay_receipt jsonb;
BEGIN
 SELECT receipt INTO first_receipt FROM native_spin_result;
 replay_receipt:=pg_temp.native_spin_call(NULL);
 IF replay_receipt IS DISTINCT FROM first_receipt||'{"replay":true}'::jsonb
  OR pg_temp.native_spin_state() IS DISTINCT FROM before_state THEN
  RAISE EXCEPTION 'FAIL played/vacated immutable launch replay changed the receipt or money';
 END IF;
END;
$played_replay$;
DO $notice$ BEGIN RAISE NOTICE 'PASS Spin played_replay'; END $notice$;

SAVEPOINT native_missing_hand;
SET LOCAL session_replication_role=replica;
DELETE FROM public.hand_history WHERE id='92060000-0000-4000-8000-000000000001';
SET LOCAL session_replication_role=origin;
DO $no_hand$
DECLARE before_state jsonb:=pg_temp.native_spin_state();
BEGIN
 IF (pg_temp.native_spin_call(NULL)->>'reason') IS DISTINCT FROM 'spin_field_unproven'
  OR pg_temp.native_spin_state() IS DISTINCT FROM before_state THEN
  RAISE EXCEPTION 'FAIL immutable launch replay accepted a vacated field without a persisted hand';
 END IF;
END;
$no_hand$;
DO $notice$ BEGIN RAISE NOTICE 'PASS Spin no_hand'; END $notice$;
ROLLBACK TO SAVEPOINT native_missing_hand;

SAVEPOINT native_underfunded;
SET LOCAL session_replication_role=replica;
UPDATE public.tournament_players SET chips=999 WHERE tournament_id='92010000-0000-0000-0000-000000000001'
 AND user_id=md5('zero-default-spin-launch-user:2')::uuid;
UPDATE public.table_seats SET stack=999 WHERE table_id=pg_temp.spin_table_id()
 AND user_id=md5('zero-default-spin-launch-user:2')::uuid;
SET LOCAL session_replication_role=origin;
DO $unfunded$
DECLARE before_state jsonb:=pg_temp.native_spin_state();
BEGIN
 IF (pg_temp.native_spin_call(NULL)->>'reason') IS DISTINCT FROM 'spin_field_unproven'
  OR pg_temp.native_spin_state() IS DISTINCT FROM before_state THEN
  RAISE EXCEPTION 'FAIL immutable launch replay accepted a short starting-stack total';
 END IF;
END;
$unfunded$;
DO $notice$ BEGIN RAISE NOTICE 'PASS Spin unfunded'; END $notice$;
ROLLBACK TO SAVEPOINT native_underfunded;

SAVEPOINT decided;
SET LOCAL session_replication_role=replica;
UPDATE public.table_seats
   SET left_at=transaction_timestamp(),status='left',stack=0
 WHERE table_id=pg_temp.spin_table_id()
   AND user_id=md5('zero-default-spin-launch-user:2')::uuid;
UPDATE public.tournament_players
   SET status='eliminated',table_id=NULL,seat_number=NULL,chips=0,
       eliminated_at=transaction_timestamp()
 WHERE tournament_id='92010000-0000-0000-0000-000000000001'
   AND user_id=md5('zero-default-spin-launch-user:2')::uuid;
UPDATE public.tournament_players SET chips=3000
 WHERE tournament_id='92010000-0000-0000-0000-000000000001'
   AND user_id=md5('zero-default-spin-launch-user:3')::uuid;
UPDATE public.table_seats SET stack=3000
 WHERE table_id=pg_temp.spin_table_id()
   AND user_id=md5('zero-default-spin-launch-user:3')::uuid;
UPDATE public.tables SET current_players=1
 WHERE id=pg_temp.spin_table_id();
SET LOCAL session_replication_role=origin;
DO $decided_refused$
BEGIN
  IF COALESCE((public.fn_prove_played_spin_launch_recovery(
       '92010000-0000-0000-0000-000000000001')->>'ok')::boolean,false) THEN
    RAISE EXCEPTION 'FAIL played Spin recovery accepted a decided one-player game';
  END IF;
END;
$decided_refused$;
DO $notice$ BEGIN RAISE NOTICE 'PASS Spin decided_refused'; END $notice$;
ROLLBACK TO SAVEPOINT decided;
SELECT pg_temp.spin_full_cancel_refused('restored valid two-survivor recovery still refuses cancellation');
DO $complete_launch$
DECLARE before_state jsonb:=pg_temp.native_spin_state(); completed jsonb;
BEGIN
 completed:=public.fn_complete_tournament_launch_atomic(
  '92010000-0000-0000-0000-000000000001','92040000-0000-4000-8000-000000000001',
  '92050000-0000-4000-8000-000000000001');
 IF completed->>'ok' IS DISTINCT FROM 'true'
  OR (SELECT status FROM public.tournaments WHERE id='92010000-0000-0000-0000-000000000001')<>'RUNNING'
  OR (SELECT completed_at FROM public.tournament_launch_receipts
      WHERE tournament_id='92010000-0000-0000-0000-000000000001') IS NULL
  OR pg_temp.native_spin_state() IS DISTINCT FROM before_state THEN
  RAISE EXCEPTION 'FAIL lease-bound played Spin completion changed money or refused valid recovery: %',completed;
 END IF;
END;
$complete_launch$;
DO $notice$ BEGIN RAISE NOTICE 'PASS Spin complete_launch'; END $notice$;

SELECT pg_temp.spin_full_cancel_refused('RUNNING played Spin resumes and cannot cancel');
DO $launch_replay$
DECLARE before_state jsonb:=pg_temp.spin_full_state(); r jsonb; original_draw jsonb;
BEGIN
 r:=public.fn_complete_tournament_launch_atomic('92010000-0000-0000-0000-000000000001',
  '92040000-0000-4000-8000-000000000001','92050000-0000-4000-8000-000000000001');
 IF r->>'ok' IS DISTINCT FROM 'true' OR r->>'replay' IS DISTINCT FROM 'true'
  OR pg_temp.spin_full_state() IS DISTINCT FROM before_state THEN RAISE EXCEPTION 'FAIL immutable launch replay: %',r; END IF;
 SELECT receipt INTO original_draw FROM native_spin_result;
 IF (SELECT receipt FROM public.spin_draw_receipts WHERE tournament_id='92010000-0000-0000-0000-000000000001') IS DISTINCT FROM original_draw
 THEN RAISE EXCEPTION 'FAIL played launch continuation redrew its immutable funded prize'; END IF;
 RAISE NOTICE 'PASS played recovery and launch replay preserve the exact funded draw and all financial rows';
END $launch_replay$;
-- Accepted final-hand fixture: the remaining player busts; 3000 chips stay with the champion.
SET LOCAL session_replication_role=replica;
UPDATE public.tournament_players SET
 chips=CASE WHEN user_id=md5('zero-default-spin-launch-user:3')::uuid THEN 3000 ELSE 0 END,
 status=CASE WHEN user_id=md5('zero-default-spin-launch-user:3')::uuid THEN 'playing' ELSE 'eliminated' END,
 position=CASE WHEN user_id=md5('zero-default-spin-launch-user:1')::uuid THEN 3 WHEN user_id=md5('zero-default-spin-launch-user:2')::uuid THEN 2 ELSE NULL END,
 elimination_sequence=CASE WHEN user_id=md5('zero-default-spin-launch-user:1')::uuid THEN 1 WHEN user_id=md5('zero-default-spin-launch-user:2')::uuid THEN 2 ELSE NULL END,
 eliminated_at=CASE WHEN user_id=md5('zero-default-spin-launch-user:3')::uuid THEN NULL ELSE now() END
 WHERE tournament_id='92010000-0000-0000-0000-000000000001';
UPDATE public.table_seats SET stack=CASE WHEN seat_number=3 THEN 3000 ELSE 0 END
 WHERE table_id=pg_temp.spin_table_id();
UPDATE public.tournaments SET current_players=1
 WHERE id='92010000-0000-0000-0000-000000000001';
SET LOCAL session_replication_role=origin;

-- Derive the acceptance oracle from the immutable funded draw contract.
-- The current cash calculator must independently agree with every recipient.
CREATE TEMP TABLE native_spin_expected_payouts ON COMMIT DROP AS
SELECT (a->>'place')::integer AS place,tp.user_id,
 round((r.receipt->>'prize_pool')::numeric*(a->>'percentage')::numeric/100,2) AS amount
FROM native_spin_result r CROSS JOIN LATERAL jsonb_array_elements(r.receipt->'payout_structure') a
JOIN public.tournament_players tp ON tp.tournament_id='92010000-0000-0000-0000-000000000001'
 AND CASE WHEN tp.status='playing' THEN 1 ELSE tp.position END=(a->>'place')::integer;
DO $funded_contract$
BEGIN
 IF (SELECT sum(amount) FROM native_spin_expected_payouts) IS DISTINCT FROM
      (SELECT (receipt->>'prize_pool')::numeric FROM native_spin_result)
  OR EXISTS(SELECT 1 FROM native_spin_expected_payouts WHERE amount<=0)
  OR EXISTS(SELECT place,amount FROM native_spin_expected_payouts
    EXCEPT ALL SELECT place,amount FROM public.fn_ca_tournament_place_amounts('92010000-0000-0000-0000-000000000001'))
  OR EXISTS(SELECT place,amount FROM public.fn_ca_tournament_place_amounts('92010000-0000-0000-0000-000000000001')
    EXCEPT ALL SELECT place,amount FROM native_spin_expected_payouts)
 THEN RAISE EXCEPTION 'FAIL native cash calculator differs from the funded immutable draw ladder'; END IF;
END $funded_contract$;
DO $notice$ BEGIN RAISE NOTICE 'PASS terminal funded_contract'; END $notice$;

-- Observe real capability rows without authorizing any seat ourselves.
CREATE TEMP TABLE native_spin_terminal_expected_seats ON COMMIT DROP AS
SELECT s.id AS seat_id,s.user_id,t.tournament_id
FROM public.table_seats s JOIN public.tables t ON t.id=s.table_id
WHERE t.tournament_id='92010000-0000-0000-0000-000000000001' AND s.left_at IS NULL;
CREATE TEMP TABLE native_spin_terminal_authority_events (
 action text NOT NULL, capability jsonb NOT NULL
) ON COMMIT DROP;
CREATE FUNCTION pg_temp.spin_terminal_authority_observer() RETURNS trigger
LANGUAGE plpgsql AS $observer$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.tournament_id='92010000-0000-0000-0000-000000000001' THEN
   INSERT INTO native_spin_terminal_authority_events VALUES ('INSERT',to_jsonb(NEW));
  END IF;
  RETURN NEW;
 END IF;
 IF OLD.tournament_id='92010000-0000-0000-0000-000000000001' THEN
  INSERT INTO native_spin_terminal_authority_events VALUES ('DELETE',to_jsonb(OLD));
 END IF;
 RETURN OLD;
END $observer$;
CREATE TRIGGER native_spin_terminal_authority_observer
AFTER INSERT OR DELETE ON public.tournament_seat_exit_authorizations
FOR EACH ROW EXECUTE FUNCTION pg_temp.spin_terminal_authority_observer();

CREATE FUNCTION pg_temp.assert_spin_terminal_authority() RETURNS void
LANGUAGE plpgsql AS $assert_authority$
BEGIN
 IF (SELECT count(*) FROM native_spin_terminal_authority_events WHERE action='INSERT')<>(SELECT count(*) FROM native_spin_terminal_expected_seats)
  OR (SELECT count(*) FROM native_spin_terminal_authority_events WHERE action='DELETE')<>(SELECT count(*) FROM native_spin_terminal_expected_seats)
  OR (SELECT count(DISTINCT capability->>'token') FROM native_spin_terminal_authority_events)<>LEAST((SELECT count(*) FROM native_spin_terminal_expected_seats),1)
  OR EXISTS(SELECT 1 FROM native_spin_terminal_authority_events e
   WHERE e.capability->>'operation'<>'terminal_finish'
    OR e.capability->>'tournament_id'<>'92010000-0000-0000-0000-000000000001'
    OR NOT EXISTS(SELECT 1 FROM native_spin_terminal_expected_seats s
      WHERE s.seat_id=(e.capability->>'seat_id')::uuid
       AND s.user_id=(e.capability->>'user_id')::uuid
       AND s.tournament_id=(e.capability->>'tournament_id')::uuid))
  OR EXISTS(SELECT capability FROM native_spin_terminal_authority_events WHERE action='INSERT'
            EXCEPT ALL SELECT capability FROM native_spin_terminal_authority_events WHERE action='DELETE')
  OR EXISTS(SELECT 1 FROM public.tournament_seat_exit_authorizations
            WHERE tournament_id='92010000-0000-0000-0000-000000000001')
 THEN RAISE EXCEPTION 'FAIL exact per-seat authority rows were not minted and consumed'; END IF;
END $assert_authority$;

CREATE FUNCTION pg_temp.spin_terminal_state() RETURNS jsonb LANGUAGE sql STABLE AS $state$
SELECT jsonb_build_object(
 'all_public_rows',pg_temp.spin_full_state(),
 'launch',pg_temp.native_spin_state(),
 'authority_rows',(SELECT jsonb_agg(to_jsonb(t) ORDER BY token,seat_id)
   FROM public.tournament_seat_exit_authorizations t),
 'authority_observation',(SELECT jsonb_agg(to_jsonb(t) ORDER BY action,capability::text)
   FROM native_spin_terminal_authority_events t),
 'authority_settings',jsonb_build_array(
   COALESCE(current_setting('app.tournament_seat_exit_token',true),''),
   COALESCE(current_setting('app.tournament_seat_exit_operation',true),'')),
 'tournament',(SELECT to_jsonb(t) FROM public.tournaments t WHERE id='92010000-0000-0000-0000-000000000001'),
 'players',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.tournament_players t WHERE tournament_id='92010000-0000-0000-0000-000000000001'),
 'obligations',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.tournament_obligations t WHERE tournament_id='92010000-0000-0000-0000-000000000001'),
 'payouts',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.tournament_payouts t WHERE tournament_id='92010000-0000-0000-0000-000000000001'),
 'place_batch',(SELECT to_jsonb(t) FROM public.tournament_place_settlement_batches t WHERE tournament_id='92010000-0000-0000-0000-000000000001'),
 'terminal_receipt',(SELECT to_jsonb(t) FROM public.tournament_terminal_settlements t WHERE tournament_id='92010000-0000-0000-0000-000000000001'),
 'finish_receipt',(SELECT to_jsonb(t) FROM public.tournament_finish_receipts t WHERE tournament_id='92010000-0000-0000-0000-000000000001'),
 'wallet_transactions',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.wallet_transactions t WHERE related_entity_id='92010000-0000-0000-0000-000000000001'),
 'member_wallets',(SELECT jsonb_agg(to_jsonb(t) ORDER BY user_id) FROM public.club_members t WHERE club_id='92000000-0000-0000-0000-000000000001'),
 'club',(SELECT to_jsonb(t) FROM public.clubs t WHERE id='92000000-0000-0000-0000-000000000001'),
 'club_wallet',(SELECT to_jsonb(t) FROM public.club_wallets t WHERE club_id='92000000-0000-0000-0000-000000000001'),
 'rake',(SELECT to_jsonb(t) FROM public.tournament_rake_settlements t WHERE tournament_id='92010000-0000-0000-0000-000000000001'),
 'tables',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.tables t WHERE tournament_id='92010000-0000-0000-0000-000000000001'),
 'seats',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.table_seats t WHERE table_id=pg_temp.spin_table_id()));
$state$;

DO $claim$
DECLARE result jsonb;
BEGIN
 result:=public.fn_claim_tournament_finish('92010000-0000-0000-0000-000000000001',md5('zero-default-spin-launch-user:3')::uuid,'native-spin-terminal-probe');
 IF result->>'ok' IS DISTINCT FROM 'true' OR result->>'status' IS DISTINCT FROM 'COMPLETING' THEN
  RAISE EXCEPTION 'FAIL native Spin finish claim: %',result;
 END IF;
END $claim$;
DO $notice$ BEGIN RAISE NOTICE 'PASS terminal claim'; END $notice$;

CREATE FUNCTION pg_temp.spin_terminal_receipt_fault() RETURNS trigger LANGUAGE plpgsql AS $fault$
BEGIN
 IF NEW.tournament_id='92010000-0000-0000-0000-000000000001' THEN
  IF NOT EXISTS(SELECT 1 FROM public.tournament_escrow WHERE tournament_id=NEW.tournament_id
       AND prize_balance=0 AND bounty_balance=0 AND fee_balance=0 AND closed_at IS NOT NULL)
   OR NOT EXISTS(SELECT 1 FROM public.tournament_rake_settlements WHERE tournament_id=NEW.tournament_id
       AND amount=.24 AND settled_at IS NOT NULL AND attributed_at IS NOT NULL AND attributed_users=3)
   OR (SELECT count(*) FROM public.tournament_payouts WHERE tournament_id=NEW.tournament_id)<>(SELECT count(*) FROM native_spin_expected_payouts)
   OR (SELECT status FROM public.tournaments WHERE id=NEW.tournament_id)<>'COMPLETED'
   OR EXISTS(SELECT 1 FROM public.tables WHERE tournament_id=NEW.tournament_id AND (status<>'closed' OR lifecycle<>'closed'))
   OR EXISTS(SELECT 1 FROM public.table_seats WHERE table_id=pg_temp.spin_table_id() AND left_at IS NULL) THEN
   RAISE EXCEPTION 'FAIL final terminal receipt did not follow exact Spin money and closure: %',
    jsonb_build_object(
     'escrow',(SELECT to_jsonb(e) FROM public.tournament_escrow e WHERE tournament_id=NEW.tournament_id),
     'rake',(SELECT to_jsonb(r) FROM public.tournament_rake_settlements r WHERE tournament_id=NEW.tournament_id),
     'payout_count',(SELECT count(*) FROM public.tournament_payouts WHERE tournament_id=NEW.tournament_id),
     'status',(SELECT status FROM public.tournaments WHERE id=NEW.tournament_id),
     'spin_multiplier',(SELECT spin_multiplier FROM public.tournaments WHERE id=NEW.tournament_id),
     'tables',(SELECT jsonb_agg(jsonb_build_object('status',status,'lifecycle',lifecycle)) FROM public.tables WHERE tournament_id=NEW.tournament_id),
     'live_seats',(SELECT count(*) FROM public.table_seats WHERE table_id=pg_temp.spin_table_id() AND left_at IS NULL));
  END IF;
  PERFORM pg_temp.assert_spin_terminal_authority();
  IF current_setting('app.tournament_seat_exit_operation',true) IS DISTINCT FROM 'terminal_finish'
   OR current_setting('app.tournament_seat_exit_token',true) IS DISTINCT FROM
      (SELECT capability->>'token' FROM native_spin_terminal_authority_events LIMIT 1)
  THEN RAISE EXCEPTION 'FAIL final receipt is outside its seat authority scope'; END IF;
  RAISE EXCEPTION 'expected final native Spin terminal receipt fault' USING ERRCODE='ZX004';
 END IF;
 RETURN NEW;
END $fault$;
CREATE TRIGGER native_spin_terminal_receipt_fault AFTER INSERT ON public.tournament_terminal_settlements
FOR EACH ROW EXECUTE FUNCTION pg_temp.spin_terminal_receipt_fault();
DO $rollback$
DECLARE before_state jsonb:=pg_temp.spin_terminal_state(); refused boolean:=false;
BEGIN
 BEGIN PERFORM public.fn_complete_tournament_terminal('92010000-0000-0000-0000-000000000001',md5('zero-default-spin-launch-user:3')::uuid,'places');
 EXCEPTION WHEN SQLSTATE 'ZX004' THEN refused:=true; END;
 IF NOT refused OR pg_temp.spin_terminal_state() IS DISTINCT FROM before_state THEN
  RAISE EXCEPTION 'FAIL final native Spin terminal fault retained partial money or closure';
 END IF;
END $rollback$;
DO $notice$ BEGIN RAISE NOTICE 'PASS terminal rollback'; END $notice$;
DROP TRIGGER native_spin_terminal_receipt_fault ON public.tournament_terminal_settlements;
DROP FUNCTION pg_temp.spin_terminal_receipt_fault();
DO $settle$
DECLARE result jsonb; replay jsonb; outcome jsonb; before_state jsonb; v_prize numeric;
BEGIN
 SELECT (receipt->>'prize_pool')::numeric INTO v_prize FROM native_spin_result;
 result:=public.fn_complete_tournament_terminal('92010000-0000-0000-0000-000000000001',md5('zero-default-spin-launch-user:3')::uuid,'places');
 IF result->>'ok' IS DISTINCT FROM 'true' OR result->>'fully_settled' IS DISTINCT FROM 'true'
  OR result->>'status' IS DISTINCT FROM 'COMPLETED'
  OR NOT EXISTS(SELECT 1 FROM public.tournament_players WHERE tournament_id='92010000-0000-0000-0000-000000000001' AND status='winner' AND position=1 AND prize=(SELECT amount FROM native_spin_expected_payouts WHERE place=1))
  OR (SELECT sum(amount) FROM public.tournament_payouts WHERE tournament_id='92010000-0000-0000-0000-000000000001') IS DISTINCT FROM v_prize
  OR (SELECT count(*) FROM public.tournament_payouts WHERE tournament_id='92010000-0000-0000-0000-000000000001')<>(SELECT count(*) FROM native_spin_expected_payouts)
  OR EXISTS(SELECT 1 FROM native_spin_expected_payouts e
    LEFT JOIN public.tournament_payouts p ON p.tournament_id='92010000-0000-0000-0000-000000000001'
     AND p.position=e.place AND p.user_id=e.user_id
    LEFT JOIN public.tournament_players tp ON tp.tournament_id=p.tournament_id AND tp.user_id=p.user_id
    WHERE p.id IS NULL OR p.amount IS DISTINCT FROM e.amount OR tp.prize IS DISTINCT FROM e.amount)
  OR EXISTS(SELECT 1 FROM public.tournament_obligations WHERE tournament_id='92010000-0000-0000-0000-000000000001' AND (amount_paid IS DISTINCT FROM amount_owed OR settled_at IS NULL)) THEN
  RAISE EXCEPTION 'FAIL current native Spin terminal settlement: %',result;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.tournament_place_settlement_batches
   WHERE tournament_id='92010000-0000-0000-0000-000000000001'
     AND contract_version=2 AND settled_at IS NOT NULL)
  OR (public.fn_ca_verify_terminal_place_batch('92010000-0000-0000-0000-000000000001',true)->>'ok') IS DISTINCT FROM 'true'
 THEN RAISE EXCEPTION 'FAIL completed Spin has no verified immutable version-2 place batch'; END IF;
 PERFORM pg_temp.assert_spin_terminal_authority();
 IF COALESCE(current_setting('app.tournament_seat_exit_token',true),'')<>''
  OR COALESCE(current_setting('app.tournament_seat_exit_operation',true),'')<>''
 THEN RAISE EXCEPTION 'FAIL terminal wrapper left capability settings behind'; END IF;
 before_state:=pg_temp.spin_terminal_state();
 replay:=public.fn_complete_tournament_terminal('92010000-0000-0000-0000-000000000001',md5('zero-default-spin-launch-user:3')::uuid,'places');
 outcome:=public.fn_resolve_tournament_terminal_outcome('92010000-0000-0000-0000-000000000001',md5('zero-default-spin-launch-user:3')::uuid,'places');
 IF replay->>'ok' IS DISTINCT FROM 'true' OR replay->>'fully_settled' IS DISTINCT FROM 'true'
  OR outcome->>'terminal_committed' IS DISTINCT FROM 'true'
  OR outcome->>'definitively_not_committed' IS DISTINCT FROM 'false'
  OR outcome->'receipt' IS DISTINCT FROM result
  OR replay IS DISTINCT FROM result
  OR pg_temp.spin_terminal_state() IS DISTINCT FROM before_state THEN
  RAISE EXCEPTION 'FAIL native Spin terminal retry or resolver changed financial state: % / %',replay,outcome;
 END IF;
END $settle$;
DO $notice$ BEGIN RAISE NOTICE 'PASS terminal settle'; END $notice$;
SET CONSTRAINTS ALL IMMEDIATE;
SELECT 'SPIN_FULL_NATIVE_EVIDENCE=' || jsonb_build_object(
 'draw_multiplier',(SELECT (receipt->>'multiplier')::numeric FROM native_spin_result),
 'approved_payout_structure',(SELECT receipt->'payout_structure' FROM native_spin_result),
 'expected_payouts',(SELECT jsonb_agg(jsonb_build_object('place',place,'amount',amount) ORDER BY place) FROM native_spin_expected_payouts),
 'tournament_status',(SELECT status FROM public.tournaments WHERE id='92010000-0000-0000-0000-000000000001'),
 'batch',(SELECT jsonb_build_object('contract_version',contract_version,'mode',mode,
   'place_count',place_count,'place_amount_owed',amount_owed,
   'bubble_enabled',bubble_contract_required,'bubble_amount_owed',bubble_amount_owed,
   'settled',settled_at IS NOT NULL,'plan_fingerprint',plan_fingerprint)
   FROM public.tournament_place_settlement_batches WHERE tournament_id='92010000-0000-0000-0000-000000000001'),
 'payout_count',(SELECT count(*) FROM public.tournament_payouts WHERE tournament_id='92010000-0000-0000-0000-000000000001'),
 'payout_total',(SELECT sum(amount) FROM public.tournament_payouts WHERE tournament_id='92010000-0000-0000-0000-000000000001'),
 'escrow',(SELECT jsonb_build_object('prize_balance',prize_balance,'bounty_balance',bounty_balance,
   'fee_balance',fee_balance,'closed',closed_at IS NOT NULL) FROM public.tournament_escrow
   WHERE tournament_id='92010000-0000-0000-0000-000000000001'),
 'rake',(SELECT jsonb_build_object('amount',amount,'settled',settled_at IS NOT NULL,
   'attributed',attributed_at IS NOT NULL,'attributed_users',attributed_users)
   FROM public.tournament_rake_settlements WHERE tournament_id='92010000-0000-0000-0000-000000000001'),
 'expected_live_seats',(SELECT count(*) FROM native_spin_terminal_expected_seats),
 'capability_insert_count',(SELECT count(*) FROM native_spin_terminal_authority_events WHERE action='INSERT'),
 'capability_delete_count',(SELECT count(*) FROM native_spin_terminal_authority_events WHERE action='DELETE'),
 'capability_token_count',(SELECT count(DISTINCT capability->>'token') FROM native_spin_terminal_authority_events),
 'capability_rows_remaining',(SELECT count(*) FROM public.tournament_seat_exit_authorizations
   WHERE tournament_id='92010000-0000-0000-0000-000000000001'),
 'capability_settings_cleared',COALESCE(current_setting('app.tournament_seat_exit_token',true),'')=''
   AND COALESCE(current_setting('app.tournament_seat_exit_operation',true),'')='',
 'deferred_constraints_forced',true
)::text;
DO $draw_is_final$
BEGIN
 IF (SELECT receipt FROM public.spin_draw_receipts WHERE tournament_id='92010000-0000-0000-0000-000000000001')
    IS DISTINCT FROM (SELECT receipt FROM native_spin_result)
  OR (SELECT count(*) FROM public.spin_reserve_ledger WHERE tournament_id='92010000-0000-0000-0000-000000000001')<>2
  OR EXISTS(SELECT 1 FROM public.tournament_cancellation_receipts WHERE tournament_id='92010000-0000-0000-0000-000000000001')
 THEN RAISE EXCEPTION 'FAIL terminal settlement redrew or cancelled its immutable Spin prize'; END IF;
 RAISE NOTICE 'PASS completed Spin retains one immutable funded draw and no cancellation';
END $draw_is_final$;

ROLLBACK;
