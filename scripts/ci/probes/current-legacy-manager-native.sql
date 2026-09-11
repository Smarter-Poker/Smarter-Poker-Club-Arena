-- Real full source satellite settlement through the current TypeScript RPC door.
-- Authenticated wallet funding is real. The final one-player hand/seat scene is
-- synthetic fixture state; no payout, transfer, entitlement or receipt is seeded.
BEGIN;
SET LOCAL statement_timeout='60s';
SET LOCAL lock_timeout='8s';

DO $prerequisites$
BEGIN
  IF current_user<>'postgres' OR inet_server_addr() IS NOT NULL
     OR to_regprocedure('public.fn_register_for_tournament_request(uuid,uuid)') IS NULL
     OR to_regprocedure('public.atomic_cancel_tournament(uuid,uuid)') IS NULL
     OR to_regprocedure('public.fn_award_satellite_seat(uuid,uuid,uuid,text,integer)') IS NULL
     OR to_regprocedure(
          'public.fn_ca_tournament_cancellation_receipt(uuid,uuid)') IS NULL
     OR to_regclass('public.tournament_cancellation_receipts') IS NULL
     OR to_regclass('public.tournament_refund_entitlements') IS NULL
     OR to_regclass('public.tournament_refund_tranches') IS NULL THEN
    RAISE EXCEPTION
      'entrant cancellation probe requires postgres and the complete installed cancellation authority';
  END IF;
END;
$prerequisites$;

-- Restore only the tracked platform source seed omitted by the schema-only rehearsal.
-- Provenance: 20260905203123, exact tuple ('atomic_cancel_tournament', 'DB caller').
INSERT INTO public.ca_settle_sources(source,note)
VALUES('atomic_cancel_tournament','DB caller') ON CONFLICT(source) DO NOTHING;

-- Only fixture construction is trigger-free. In particular, the cash entry,
-- cancellation, replay verifier, and every immutability attempt below all run
-- with session_replication_role=origin against installed production functions.
SET LOCAL session_replication_role=replica;

INSERT INTO auth.users(id)
VALUES
  ('d1000000-0000-4000-8000-000000000001'),
  ('d1000000-0000-4000-8000-000000000002'),
  ('2d1cd6c3-5700-4af9-a271-d4863fdab20d')
ON CONFLICT(id) DO NOTHING;

INSERT INTO public.users(id,username)
VALUES
  ('d1000000-0000-4000-8000-000000000001',
   'cancel_cash_entrant_probe'),
  ('d1000000-0000-4000-8000-000000000002',
   'cancel_satellite_entrant_probe'),
  ('2d1cd6c3-5700-4af9-a271-d4863fdab20d','smarterpoker')
ON CONFLICT(id) DO NOTHING;

INSERT INTO public.profiles(id,username,display_name)
VALUES
  ('d1000000-0000-4000-8000-000000000001',
   'cancel_cash_entrant_probe','Cancellation Cash Entrant'),
  ('d1000000-0000-4000-8000-000000000002',
   'cancel_satellite_entrant_probe','Cancellation Satellite Entrant')
ON CONFLICT(id) DO NOTHING;

INSERT INTO public.clubs(id,club_id,name)
VALUES
  ('d2000000-0000-4000-8000-000000000001',991001,
   'Cancellation Funding Club'),
  ('d2000000-0000-4000-8000-000000000002',991002,
   'Cancellation Fee Recipient Club');

INSERT INTO public.club_members(
  club_id,user_id,role,status,chip_balance,joined_at)
VALUES
  ('d2000000-0000-4000-8000-000000000001',
   'd1000000-0000-4000-8000-000000000001',
   'player','active',1000,clock_timestamp()-interval '2 days'),
  ('d2000000-0000-4000-8000-000000000002',
   'd1000000-0000-4000-8000-000000000001',
   'player','active',200,clock_timestamp()-interval '1 day'),
  ('d2000000-0000-4000-8000-000000000002',
   'd1000000-0000-4000-8000-000000000002',
   'player','active',300,clock_timestamp()-interval '1 day');

INSERT INTO public.tournaments(
  id,name,buy_in_amount,buy_in_fee,starting_chips,start_time,status,
  current_players,max_players,current_level,club_id,prize_pool,total_rake,
  bounty_pool,entry_contract_locked,is_rebuy,is_reentry,rebuy_levels,
  late_reg_levels,late_reg_mins)
VALUES
  ('d3000000-0000-4000-8000-000000000001',
   'Full Terminal Source Satellite',100,0,1000,
   clock_timestamp()+interval '1 day','REGISTERING',0,9,1,
   'd2000000-0000-4000-8000-000000000002',0,0,0,false,
   false,false,0,0,0),
  ('d3000000-0000-4000-8000-000000000002',
   'Cancellation Entrant Target',90,10,1000,
   clock_timestamp()+interval '1 day','REGISTERING',0,100,1,
   'd2000000-0000-4000-8000-000000000002',0,0,0,false,
   false,false,0,0,0);

INSERT INTO auth.sessions(id,user_id,created_at,updated_at)
VALUES(
  'd4000000-0000-4000-8000-000000000001',
  'd1000000-0000-4000-8000-000000000001',now(),now()),
  ('d4000000-0000-4000-8000-000000000003',
   'd1000000-0000-4000-8000-000000000002',now(),now());

UPDATE public.tournaments SET satellite_target_id='d3000000-0000-4000-8000-000000000002',
 satellite_target='d3000000-0000-4000-8000-000000000002',satellite_seats=1,
 tournament_type='SATELLITE',variant='satellite'
 WHERE id='d3000000-0000-4000-8000-000000000001';
SET LOCAL session_replication_role=origin;

-- The public production registration door creates the cash player's actual
-- wallet debit, host-club journal, immutable entitlement, target fee record,
-- escrow funding and roster row.
SELECT set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub','d1000000-0000-4000-8000-000000000001',
    'role','authenticated',
    'session_id','d4000000-0000-4000-8000-000000000001')::text,
  true);

SET LOCAL ROLE authenticated;
CREATE TEMP TABLE satellite_full_probe_results(
  name text PRIMARY KEY,
  value jsonb NOT NULL
) ON COMMIT DROP;
INSERT INTO satellite_full_probe_results(name,value)
VALUES(
  'registration',
  public.fn_register_for_tournament_request(
    'd3000000-0000-4000-8000-000000000002',
    'd4000000-0000-4000-8000-000000000002'));
RESET ROLE;
GRANT INSERT,SELECT ON satellite_full_probe_results TO service_role;

DO $cash_entry_is_exact$
DECLARE
  v_registration jsonb:=(
    SELECT value FROM satellite_full_probe_results WHERE name='registration');
BEGIN
  IF COALESCE((v_registration->>'ok')::boolean,false) IS NOT TRUE
     OR (v_registration->>'cost')::numeric IS DISTINCT FROM 100::numeric
     OR (v_registration->>'rake')::numeric IS DISTINCT FROM 10::numeric
     OR (SELECT chip_balance FROM public.club_members
          WHERE club_id='d2000000-0000-4000-8000-000000000001'
            AND user_id='d1000000-0000-4000-8000-000000000001')
          IS DISTINCT FROM 1000::numeric
     OR (SELECT chip_balance FROM public.club_members
          WHERE club_id='d2000000-0000-4000-8000-000000000002'
            AND user_id='d1000000-0000-4000-8000-000000000001')
          IS DISTINCT FROM 100::numeric
     OR (SELECT count(*) FROM public.tournament_refund_entitlements e
          WHERE e.tournament_id='d3000000-0000-4000-8000-000000000002'
            AND e.user_id='d1000000-0000-4000-8000-000000000001'
            AND e.entitlement_kind='wallet_charge'
            AND e.refund_wallet_club_id=
                  'd2000000-0000-4000-8000-000000000002'
            AND e.gross=100 AND e.refund_prize=90
            AND e.refund_bounty=0 AND e.refund_fee=10)<>1
     OR (SELECT count(*) FROM public.rake_records r
          WHERE r.tournament_id='d3000000-0000-4000-8000-000000000002'
            AND r.club_id='d2000000-0000-4000-8000-000000000002'
            AND r.rake_amount=10
            AND r.metadata->>'user_id'=
                  'd1000000-0000-4000-8000-000000000001')<>1 THEN
    RAISE EXCEPTION
      'FAIL request registration did not charge and stamp the host-club wallet: %',
      v_registration;
  END IF;
END;
$cash_entry_is_exact$;

-- Fund the source through the same request-bound entry authority used above.
SELECT set_config('request.jwt.claims',jsonb_build_object(
  'sub','d1000000-0000-4000-8000-000000000002',
  'role','authenticated',
  'session_id','d4000000-0000-4000-8000-000000000003')::text,true);
SET LOCAL ROLE authenticated;
INSERT INTO satellite_full_probe_results(name,value)
VALUES('source_registration',public.fn_register_for_tournament_request(
  'd3000000-0000-4000-8000-000000000001',
  'd4000000-0000-4000-8000-000000000004'));
RESET ROLE;
DO $source_funding$
BEGIN
  IF (SELECT (value->>'ok')::boolean FROM satellite_full_probe_results
       WHERE name='source_registration') IS DISTINCT FROM true
     OR (SELECT prize_balance FROM public.tournament_escrow
          WHERE tournament_id='d3000000-0000-4000-8000-000000000001')
           IS DISTINCT FROM 100::numeric
     OR (SELECT chip_balance FROM public.club_members
          WHERE club_id='d2000000-0000-4000-8000-000000000002'
            AND user_id='d1000000-0000-4000-8000-000000000002')
           IS DISTINCT FROM 200::numeric THEN
    RAISE EXCEPTION 'FAIL independent source registration did not fund 100 chips';
  END IF;
END;
$source_funding$;

-- Establish only the already-played final hand scene. The two authenticated
-- registration charges above remain the sole funds and entitlement sources.
SET LOCAL session_replication_role=replica;
UPDATE public.tournaments SET status='RUNNING',started_at=clock_timestamp()-interval '1 hour',
 prize_pool_finalized=true,
 entry_contract_locked=true,current_players=1
 WHERE id='d3000000-0000-4000-8000-000000000001';
INSERT INTO public.tables(id,name,tournament_id,status,lifecycle,current_players,game_type,club_id)
 VALUES('d5000000-0000-4000-8000-000000000001','Satellite Terminal Final Table',
 'd3000000-0000-4000-8000-000000000001','running','live',1,'tournament',
 'd2000000-0000-4000-8000-000000000002');
UPDATE public.tournament_players SET status='playing',chips=1000,
 table_id='d5000000-0000-4000-8000-000000000001',seat_number=1,
 club_id='d2000000-0000-4000-8000-000000000002'
 WHERE tournament_id='d3000000-0000-4000-8000-000000000001';
INSERT INTO public.table_seats(id,table_id,seat_number,user_id,stack,status,left_at,
 leave_pending,is_sitting_out,is_away,club_id)
 VALUES('d6000000-0000-4000-8000-000000000001',
 'd5000000-0000-4000-8000-000000000001',1,
 'd1000000-0000-4000-8000-000000000002',1000,'active',NULL,false,false,false,
 'd2000000-0000-4000-8000-000000000002');
SET LOCAL session_replication_role=origin;
SELECT set_config('request.jwt.claims','{"role":"service_role"}',true),
 set_config('request.jwt.claim.sub','',true),set_config('request.jwt.claim.role','service_role',true),
 set_config('app.smarter_data_actor','',true),set_config('app.smarter_manager_request_fenced','',true),
 set_config('app.smarter_tournament_id','',true),set_config('app.smarter_tournament_lease_generation','',true);

CREATE FUNCTION pg_temp.satellite_full_assert(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $assert$
BEGIN
 IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL %',label; END IF;
 RAISE NOTICE 'PASS %',label;
END $assert$;

-- Same live lease admission envelope as REQUEST_PROBE in the whole Stage B runner.
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claims','{"role":"service_role"}',true),
 set_config('request.jwt.claim.role','service_role',true),
 set_config('request.headers','{"x-smarter-data-actor":"service","x-smarter-data-protocol":"1"}',true),
 set_config('request.method','POST',true),set_config('request.path','rpc/claim_tournament_lease_v2',true);
SELECT smarter_private.fn_smarter_data_api_pre_request();
SELECT pg_temp.satellite_full_assert(granted,'actual lease authority grants the satellite source manager')
 FROM public.claim_tournament_lease_v2('d3000000-0000-4000-8000-000000000001',
 'native-satellite-stage-b','native-reviewed-source','d7000000-0000-4000-8000-000000000001',30);
RESET ROLE;

CREATE FUNCTION pg_temp.satellite_manager_request(p_path text) RETURNS void
LANGUAGE plpgsql AS $manager_request$
BEGIN
 IF current_user<>'service_role' THEN RAISE EXCEPTION 'native manager request must use service_role'; END IF;
 IF p_path NOT IN ('rpc/fn_settle_satellite_tournament','rpc/fn_resolve_satellite_settlement_outcome') THEN
  RAISE EXCEPTION 'native manager probe path differs'; END IF;
 PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true);
 PERFORM set_config('request.jwt.claim.role','service_role',true);
 PERFORM set_config('request.method','POST',true);
 PERFORM set_config('request.path',p_path,true);
 PERFORM set_config('request.headers',
  '{"x-smarter-data-actor":"tournament-manager","x-smarter-data-protocol":"2","x-smarter-tournament-id":"d3000000-0000-4000-8000-000000000001","x-smarter-tournament-lease-generation":"d7000000-0000-4000-8000-000000000001"}',true);
 -- This is the real request hook. It must read and hold the actual fresh lease.
 PERFORM smarter_private.fn_smarter_data_api_pre_request();
 IF current_setting('app.smarter_data_actor',true) IS DISTINCT FROM 'tournament-manager'
  OR current_setting('app.smarter_manager_request_fenced',true) IS DISTINCT FROM 'protocol-2'
  OR current_setting('app.smarter_tournament_id',true) IS DISTINCT FROM 'd3000000-0000-4000-8000-000000000001'
  OR current_setting('app.smarter_tournament_lease_generation',true) IS DISTINCT FROM 'd7000000-0000-4000-8000-000000000001' THEN
  RAISE EXCEPTION 'native manager pre-request did not install exact lease proof'; END IF;
END $manager_request$;

CREATE FUNCTION pg_temp.manager_satellite_settle(p_source uuid,p_winner uuid) RETURNS jsonb
LANGUAGE plpgsql AS $manager_settle$
DECLARE prior_role text:=current_setting('role'); result jsonb;
BEGIN
 PERFORM set_config('role','service_role',true);
 BEGIN
  PERFORM pg_temp.satellite_manager_request('rpc/fn_settle_satellite_tournament');
  result:=public.fn_settle_satellite_tournament(p_source,p_winner);
 EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('role',prior_role,true); RAISE;
 END;
 PERFORM set_config('role',prior_role,true);
 RETURN result;
END $manager_settle$;

CREATE FUNCTION pg_temp.manager_satellite_outcome(p_source uuid,p_winner uuid) RETURNS jsonb
LANGUAGE plpgsql AS $manager_outcome$
DECLARE prior_role text:=current_setting('role'); result jsonb;
BEGIN
 PERFORM set_config('role','service_role',true);
 BEGIN
  PERFORM pg_temp.satellite_manager_request('rpc/fn_resolve_satellite_settlement_outcome');
  result:=public.fn_resolve_satellite_settlement_outcome(p_source,p_winner);
 EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('role',prior_role,true); RAISE;
 END;
 PERFORM set_config('role',prior_role,true);
 RETURN result;
END $manager_outcome$;

CREATE FUNCTION pg_temp.satellite_manager_outside_scope(p_label text) RETURNS void
LANGUAGE plpgsql AS $outside_scope$
DECLARE prior_role text:=current_setting('role'); refused boolean:=false;
BEGIN
 IF EXISTS(SELECT 1 FROM public.tournament_satellite_terminal_authorizations) THEN
  RAISE EXCEPTION 'outside-scope proof found a surviving satellite capability'; END IF;
 PERFORM set_config('role','service_role',true);
 BEGIN
  PERFORM pg_temp.satellite_manager_request('rpc/fn_settle_satellite_tournament');
  BEGIN
   UPDATE public.tournaments SET name=name WHERE id='d3000000-0000-4000-8000-000000000002';
  EXCEPTION WHEN insufficient_privilege THEN
   IF position('TOURNAMENT_MANAGER_SCOPE' IN SQLERRM)=0 THEN RAISE; END IF;
   refused:=true;
  END;
 EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('role',prior_role,true); RAISE;
 END;
 PERFORM set_config('role',prior_role,true);
 PERFORM pg_temp.satellite_full_assert(refused,p_label);
END $outside_scope$;
SELECT pg_temp.satellite_manager_outside_scope('before source RPC the source manager cannot write the target without a capability');

SELECT pg_temp.satellite_full_assert((SELECT count(*)=7 FROM pg_trigger
 WHERE tgrelid='public.tournaments'::regclass AND tgenabled='O' AND tgname IN (
 'aa_guard_tournament_completing_claim','zzzz_freeze_finalized_tournament_prize_pool',
 'zzzz_tournament_pool_finalization_window_guard','zzzz_tournaments_atomic_place_completion_guard',
 'zzzzz_tournaments_atomic_final_table_deal_completion_guard','zzzzzz_tournaments_financial_certificate',
 'aaa_guard_atomic_satellite_completion')),'all seven Stage B guards are enabled');

CREATE TEMP TABLE satellite_full_authority_events(action text,capability jsonb) ON COMMIT DROP;
CREATE FUNCTION pg_temp.observe_satellite_full_authority() RETURNS trigger LANGUAGE plpgsql AS $observe$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.tournament_id='d3000000-0000-4000-8000-000000000001' THEN
   INSERT INTO satellite_full_authority_events VALUES('INSERT',to_jsonb(NEW)); END IF;
  RETURN NEW;
 END IF;
 IF OLD.tournament_id='d3000000-0000-4000-8000-000000000001' THEN
  INSERT INTO satellite_full_authority_events VALUES('DELETE',to_jsonb(OLD)); END IF;
 RETURN OLD;
END $observe$;
CREATE TRIGGER native_satellite_full_authority AFTER INSERT OR DELETE
 ON public.tournament_seat_exit_authorizations FOR EACH ROW
 EXECUTE FUNCTION pg_temp.observe_satellite_full_authority();

CREATE FUNCTION pg_temp.satellite_full_financial_state() RETURNS jsonb LANGUAGE plpgsql AS $state$
DECLARE t text; a jsonb; result jsonb:='{}'::jsonb;
BEGIN
 FOREACH t IN ARRAY ARRAY['tournaments','tournament_players','tables','table_seats',
 'club_members','wallet_transactions','wallet_credit_idempotency','chip_ledger','chip_ledger_idem',
 'tournament_escrow','tournament_obligations','tournament_payouts','tournament_refund_entitlements',
 'tournament_tickets','tournament_satellite_settlements','tournament_satellite_awards',
 'tournament_satellite_remainders','tournament_finish_receipts','tournament_terminal_settlements',
 'tournament_rake_settlements','rake_records','rake_attributions','agent_commissions',
 'player_stats','vip_points_carry','tournament_seat_exit_authorizations','club_wallets','union_wallets'] LOOP
  EXECUTE format('SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),''[]''::jsonb) FROM public.%I r',t) INTO a;
  result:=result||jsonb_build_object(t,a);
 END LOOP;
 IF to_regclass('public.tournament_satellite_terminal_authorizations') IS NOT NULL THEN
  EXECUTE 'SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),''[]''::jsonb) FROM public.tournament_satellite_terminal_authorizations r' INTO a;
  result:=result||jsonb_build_object('tournament_satellite_terminal_authorizations',a);
 END IF;
 RETURN result||jsonb_build_object('observed_authorities',
  (SELECT COALESCE(jsonb_agg(to_jsonb(e) ORDER BY to_jsonb(e)::text),'[]'::jsonb) FROM satellite_full_authority_events e));
END $state$;
-- Native-only adversarial calls while the real M2 publisher's source capability is open.
SET LOCAL session_replication_role=replica;
INSERT INTO public.tables(id,name,tournament_id,status,lifecycle,current_players,game_type,club_id)
 VALUES('d5000000-0000-4000-8000-000000000002','Satellite target scope negative table',
 'd3000000-0000-4000-8000-000000000002','running','live',0,'tournament',
 'd2000000-0000-4000-8000-000000000002');
SET LOCAL session_replication_role=origin;
CREATE TEMP TABLE satellite_target_scope_denials(label text PRIMARY KEY) ON COMMIT DROP;
CREATE FUNCTION pg_temp.test_active_satellite_target_scope() RETURNS trigger
LANGUAGE plpgsql AS $active_scope$
DECLARE r record; refused boolean; original_generation text;
BEGIN
 IF NEW.tournament_id<>'d3000000-0000-4000-8000-000000000001' THEN RETURN NEW; END IF;
 PERFORM pg_temp.satellite_full_assert(public.fn_ca_satellite_terminal_scope(NEW.tournament_id),
  'target plan is published inside the real source transaction capability');
 FOR r IN SELECT * FROM (VALUES
  ('unrelated tournament', $q$UPDATE public.tournaments SET name=name WHERE id='30000000-0000-0000-0000-000000000001'$q$),
  ('forged target recount before registration', $q$UPDATE public.tournaments SET current_players=current_players+1 WHERE id='d3000000-0000-4000-8000-000000000002'$q$),
  ('target unrelated column', $q$UPDATE public.tournaments SET name=name WHERE id='d3000000-0000-4000-8000-000000000002'$q$),
  ('target unplanned player', $q$INSERT INTO public.tournament_players(tournament_id,user_id,username,chips,status,is_satellite_qualifier,source_satellite_id) VALUES('d3000000-0000-4000-8000-000000000002','d1000000-0000-4000-8000-000000000001','wrong user',0,'registered',true,'d3000000-0000-4000-8000-000000000001')$q$),
  ('target wrong source', $q$INSERT INTO public.tournament_players(tournament_id,user_id,username,chips,status,is_satellite_qualifier,source_satellite_id) SELECT 'd3000000-0000-4000-8000-000000000002',user_id,username,0,'registered',true,'d3000000-0000-4000-8000-000000000002' FROM public.tournament_players WHERE tournament_id='d3000000-0000-4000-8000-000000000001'$q$),
  ('target nonzero stack', $q$INSERT INTO public.tournament_players(tournament_id,user_id,username,chips,status,is_satellite_qualifier,source_satellite_id) SELECT 'd3000000-0000-4000-8000-000000000002',user_id,username,1,'registered',true,tournament_id FROM public.tournament_players WHERE tournament_id='d3000000-0000-4000-8000-000000000001'$q$),
  ('target altered status', $q$INSERT INTO public.tournament_players(tournament_id,user_id,username,chips,status,is_satellite_qualifier,source_satellite_id) SELECT 'd3000000-0000-4000-8000-000000000002',user_id,username,0,'playing',true,tournament_id FROM public.tournament_players WHERE tournament_id='d3000000-0000-4000-8000-000000000001'$q$),
  ('target unlisted field', $q$INSERT INTO public.tournament_players(tournament_id,user_id,username,chips,status,is_satellite_qualifier,source_satellite_id,current_bounty) SELECT 'd3000000-0000-4000-8000-000000000002',user_id,username,0,'registered',true,tournament_id,1 FROM public.tournament_players WHERE tournament_id='d3000000-0000-4000-8000-000000000001'$q$),
  ('target roster update', $q$UPDATE public.tournament_players SET username=username WHERE tournament_id='d3000000-0000-4000-8000-000000000002'$q$),
  ('target roster delete', $q$DELETE FROM public.tournament_players WHERE tournament_id='d3000000-0000-4000-8000-000000000002'$q$),
  ('target table update', $q$UPDATE public.tables SET name=name WHERE id='d5000000-0000-4000-8000-000000000002'$q$),
  ('target table delete', $q$DELETE FROM public.tables WHERE id='d5000000-0000-4000-8000-000000000002'$q$),
  ('target seat insert', $q$INSERT INTO public.table_seats(table_id,seat_number,user_id,stack,status) VALUES('d5000000-0000-4000-8000-000000000002',1,'d1000000-0000-4000-8000-000000000002',0,'active')$q$),
  ('published plan update', $q$UPDATE public.tournament_satellite_manager_targets SET planned_seats=planned_seats WHERE tournament_id='d3000000-0000-4000-8000-000000000001'$q$),
  ('published plan delete', $q$DELETE FROM public.tournament_satellite_manager_targets WHERE tournament_id='d3000000-0000-4000-8000-000000000001'$q$)
 ) checks(label,command) LOOP
  refused:=false;
  BEGIN EXECUTE r.command;
  EXCEPTION WHEN insufficient_privilege THEN
   IF position('TOURNAMENT_MANAGER_SCOPE' IN SQLERRM)=0 THEN RAISE; END IF;
   refused:=true;
  END;
  PERFORM pg_temp.satellite_full_assert(refused,'active exact target authority refuses '||r.label);
  INSERT INTO satellite_target_scope_denials VALUES(r.label);
 END LOOP;
 original_generation:=current_setting('app.smarter_tournament_lease_generation',true);
 refused:=false;
 BEGIN
  PERFORM set_config('app.smarter_tournament_lease_generation','d7000000-0000-4000-8000-000000000099',true);
  INSERT INTO public.tournament_players(tournament_id,user_id,username,chips,status,is_satellite_qualifier,source_satellite_id)
   SELECT NEW.target_id,user_id,username,0,'registered',true,tournament_id FROM public.tournament_players
   WHERE tournament_id=NEW.tournament_id;
 EXCEPTION WHEN insufficient_privilege THEN
  IF position('TOURNAMENT_MANAGER_SCOPE' IN SQLERRM)=0 THEN RAISE; END IF;
  refused:=true;
 END;
 PERFORM set_config('app.smarter_tournament_lease_generation',original_generation,true);
 PERFORM pg_temp.satellite_full_assert(refused,'active exact target authority refuses a different lease generation');
 INSERT INTO satellite_target_scope_denials VALUES('different lease generation');
 RETURN NEW;
END $active_scope$;
CREATE TRIGGER native_active_satellite_target_scope AFTER INSERT ON public.tournament_satellite_manager_targets
 FOR EACH ROW EXECUTE FUNCTION pg_temp.test_active_satellite_target_scope();


-- Observe the two real target writes, including their actual nesting and money.
CREATE TEMP TABLE satellite_target_counter_events(
 before_count integer,after_count integer,before_prize numeric,after_prize numeric,
 before_fee numeric,after_fee numeric,award_count integer,depth integer) ON COMMIT DROP;
CREATE FUNCTION pg_temp.observe_real_satellite_target_count() RETURNS trigger LANGUAGE plpgsql AS $observe_count$
BEGIN
 IF NEW.id='d3000000-0000-4000-8000-000000000002'
  AND EXISTS(SELECT 1 FROM public.tournament_satellite_manager_targets WHERE target_id=NEW.id) THEN
  INSERT INTO satellite_target_counter_events
   SELECT OLD.current_players,NEW.current_players,OLD.prize_pool,NEW.prize_pool,
    OLD.total_rake,NEW.total_rake,(SELECT count(*) FROM public.tournament_satellite_awards
     WHERE tournament_id='d3000000-0000-4000-8000-000000000001' AND delivery_kind='seat'),pg_trigger_depth();
 END IF;
 RETURN NEW;
END $observe_count$;
CREATE TRIGGER native_real_satellite_target_count AFTER UPDATE OF current_players ON public.tournaments
 FOR EACH ROW EXECUTE FUNCTION pg_temp.observe_real_satellite_target_count();


CREATE FUNCTION pg_temp.assert_satellite_full_money_closed() RETURNS void LANGUAGE plpgsql AS $money$
DECLARE src constant uuid:='d3000000-0000-4000-8000-000000000001';
 target constant uuid:='d3000000-0000-4000-8000-000000000002';
 winner constant uuid:='d1000000-0000-4000-8000-000000000002';
BEGIN
 PERFORM pg_temp.satellite_full_assert(EXISTS(SELECT 1 FROM public.tournaments
  WHERE id=src AND status='COMPLETED' AND ended_at IS NOT NULL AND current_players=0),
  'source reaches real COMPLETED lifecycle');
 PERFORM pg_temp.satellite_full_assert(EXISTS(SELECT 1 FROM public.tournament_escrow
  WHERE tournament_id=src AND prize_balance=0 AND bounty_balance=0 AND fee_balance=0
   AND prize_out=100 AND closed_at IS NOT NULL
   AND close_note='atomic satellite terminal receipt: exact zero'),'source escrow closes exact zero with the receipt reason');
 PERFORM pg_temp.satellite_full_assert(EXISTS(SELECT 1 FROM public.tournament_escrow
  WHERE tournament_id=target AND prize_balance=180 AND bounty_balance=0 AND fee_balance=20)
  AND EXISTS(SELECT 1 FROM public.tournaments WHERE id=target AND current_players=2
   AND prize_pool=180 AND total_rake=20),'target retains exactly two funded entries and their 180/20 split');
 PERFORM pg_temp.satellite_full_assert((SELECT count(*)=1 FROM public.tournament_refund_entitlements
  WHERE tournament_id=target AND user_id=winner AND entitlement_kind='satellite_seat'
   AND source_satellite_id=src AND gross=100 AND refund_prize=90 AND refund_fee=10
   AND refund_bounty=0),'one immutable target entitlement is backed by the actual source transfer');
 PERFORM pg_temp.satellite_full_assert((SELECT count(*)=1 FROM public.tournament_satellite_awards
  WHERE tournament_id=src AND user_id=winner AND delivery_kind='seat' AND place=1 AND amount=100)
  AND (SELECT count(*)=1 FROM public.tournament_payouts
   WHERE tournament_id=src AND user_id=winner AND amount=100 AND source='satellite_seat')
  AND NOT EXISTS(SELECT 1 FROM public.tournament_tickets WHERE source_tournament_id=src),
  'one actual award and payout records the funded seat, with no invented ticket');
 PERFORM pg_temp.satellite_full_assert((SELECT chip_balance=200 FROM public.club_members
  WHERE club_id='d2000000-0000-4000-8000-000000000002' AND user_id=winner)
  AND NOT EXISTS(SELECT 1 FROM public.wallet_transactions WHERE related_entity_id=src AND type='credit'),
  'in-kind source award never credits or debits the winner wallet a second time');
END $money$;

-- A genuine capability and immutable header alone cannot authorize completion.
-- At the true claim transition, no payout has happened; a nested direct status
-- write must fail the new full financial verifier and leave the claim intact.
CREATE FUNCTION pg_temp.refuse_unfunded_satellite_completion() RETURNS trigger LANGUAGE plpgsql AS $unfunded$
DECLARE refused boolean:=false;
BEGIN
 IF NEW.id='d3000000-0000-4000-8000-000000000001'
   AND to_regprocedure('public.fn_ca_verify_current_satellite_terminal(uuid,uuid,boolean)') IS NOT NULL THEN
  BEGIN
   UPDATE public.tournaments SET status='COMPLETED',ended_at=transaction_timestamp(),
    current_players=0,on_break=false,break_started_at=NULL,break_ends_at=NULL WHERE id=NEW.id;
  EXCEPTION WHEN SQLSTATE 'P0404' THEN refused:=true; END;
  PERFORM pg_temp.satellite_full_assert(refused,
   'even a real header and owned capability cannot publish an unpaid satellite as completed');
 END IF;
 RETURN NULL;
END $unfunded$;
CREATE TRIGGER native_refuse_unfunded_satellite_completion AFTER UPDATE OF status ON public.tournaments
 FOR EACH ROW WHEN(NEW.status='COMPLETING' AND OLD.status IS DISTINCT FROM 'COMPLETING')
 EXECUTE FUNCTION pg_temp.refuse_unfunded_satellite_completion();

-- The M2 header is intentionally inserted before its money writes, not last.
-- Inject at the last source table-close write, after real money/escrow and the
-- COMPLETED transition, immediately before its final durable receipt verifier.
-- EXTRA NATIVE MANAGER QUALIFICATION. Scratch probe only, not a migration.
-- INSTALL ANCHOR: the seat-delivery satellite-full-terminal-native.sql variant,
-- after pg_temp.satellite_full_financial_state() and the original 16-case target
-- probe are defined, after manager protocol-2 context/lease is installed, but
-- BEFORE CREATE FUNCTION pg_temp.refuse_satellite_full_last_close().
-- FINAL ANCHOR: SELECT pg_temp.assert_manager_extra_native(); immediately after
-- END $exact_replay$; and before the original deferred-table proof.
-- Does not replace any public authority, alter an existing assertion, sleep,
-- commit, or delete a seat. Only the seven explicitly labelled seat-storage
-- corruptions temporarily use replica; their real verifier always runs origin.
-- Expiry BEFORE public M2 must refuse. Aging AFTER a locked capability was
-- issued is OBSERVED, not declared a defect: transaction ownership can remain
-- valid even when its original heartbeat is now older than 30 seconds.

DO $extra_preflight$
BEGIN
 IF current_user<>'postgres' OR inet_server_addr() IS NOT NULL
  OR current_setting('session_replication_role')<>'origin'
  OR current_setting('app.smarter_data_actor',true) IS DISTINCT FROM 'tournament-manager'
  OR current_setting('app.smarter_manager_request_fenced',true) IS DISTINCT FROM 'protocol-2'
  OR current_setting('app.smarter_tournament_id',true) IS DISTINCT FROM 'd3000000-0000-4000-8000-000000000001'
  OR to_regprocedure('pg_temp.satellite_full_financial_state()') IS NULL
  OR to_regclass('pg_temp.satellite_target_scope_denials') IS NULL THEN
  RAISE EXCEPTION 'extra manager probe requires owned native fixture, original 16-case probe, and actual manager context';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.engine_tournament_leases
  WHERE tournament_id='d3000000-0000-4000-8000-000000000001' AND protocol_version=2
   AND lease_generation=NULLIF(current_setting('app.smarter_tournament_lease_generation',true),'')::uuid
   AND heartbeat_at>=clock_timestamp()-interval '30 seconds') THEN
  RAISE EXCEPTION 'extra manager probe requires a real initially fresh source lease';
 END IF;
END $extra_preflight$;

CREATE TEMP TABLE satellite_manager_extra_cases(
 label text PRIMARY KEY,outcome text NOT NULL CHECK(outcome IN ('denied','proved','accepted_after_issuance','denied_after_issuance')),
 sqlstate text
) ON COMMIT DROP;
CREATE TEMP TABLE satellite_manager_extra_context AS SELECT
 current_setting('app.tournament_seat_exit_token',true) original_token,
 current_setting('app.tournament_seat_exit_operation',true) original_operation,
 gen_random_uuid()::text sentinel_token,'terminal_finish'::text sentinel_operation;
-- PostgreSQL represents an unknown custom GUC as NULL, but as an empty value
-- after its first subtransaction rollback. Establish the same empty context
-- before taking exact rollback snapshots; neither empty value grants authority.
SELECT set_config(name,COALESCE(current_setting(name,true),''),true)
 FROM unnest(ARRAY['app.tournament_seat_exit_token','app.tournament_seat_exit_operation',
  'app.money_path']) name;

CREATE FUNCTION pg_temp.manager_extra_catalog() RETURNS jsonb LANGUAGE sql AS $catalog$
 SELECT jsonb_build_object(
 'functions',(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.oid) FROM pg_proc p
   WHERE p.oid IN (
    to_regprocedure('public.fn_settle_satellite_tournament(uuid,uuid)'),
    to_regprocedure('public.fn_ca_satellite_terminal_scope(uuid)'),
    to_regprocedure('public.fn_ca_open_satellite_terminal_scope(uuid)'),
    to_regprocedure('public.fn_ca_close_satellite_terminal_scope(uuid,jsonb)'),
    to_regprocedure('public.fn_ca_publish_satellite_manager_target(uuid,uuid,jsonb)'),
    to_regprocedure('public.fn_ca_satellite_manager_target_write(text,text,jsonb,jsonb)'),
    to_regprocedure('public.fn_ca_satellite_manager_target_immutable()'),
    to_regprocedure('public.fn_assert_tournament_manager_write_scope(uuid)'),
    to_regprocedure('public.fn_ca_verify_current_satellite_terminal(uuid,uuid,boolean)'),
    to_regprocedure('public.fn_tournament_live_seat_exit_requires_authority()'))),
 'guards',(SELECT jsonb_agg(to_jsonb(t) ORDER BY t.oid) FROM pg_trigger t
   WHERE NOT t.tgisinternal AND t.tgname !~ '^native_' AND t.tgname !~ '^aaa_native_'
    AND t.tgrelid IN ('public.tournament_satellite_manager_targets'::regclass,
      'public.tournament_satellite_terminal_authorizations'::regclass,
      'public.tournament_seat_exit_authorizations'::regclass,'public.table_seats'::regclass)),
 'constraints',(SELECT jsonb_agg(to_jsonb(c) ORDER BY c.oid) FROM pg_constraint c
   WHERE c.conrelid IN ('public.tournament_satellite_manager_targets'::regclass,
    'public.tournament_satellite_terminal_authorizations'::regclass,
    'public.tournament_seat_exit_authorizations'::regclass)),
 'columns',(SELECT jsonb_agg(to_jsonb(a) ORDER BY a.attrelid,a.attnum) FROM pg_attribute a
   WHERE a.attnum>0 AND NOT a.attisdropped AND a.attrelid IN (
    'public.tournament_satellite_manager_targets'::regclass,
    'public.tournament_satellite_terminal_authorizations'::regclass,
    'public.tournament_seat_exit_authorizations'::regclass)));
$catalog$;
CREATE TEMP TABLE satellite_manager_extra_source AS SELECT pg_temp.manager_extra_catalog() proof;
SELECT pg_temp.satellite_full_assert(
 (SELECT jsonb_array_length(proof->'functions')=10 FROM satellite_manager_extra_source),
 'all ten tested public authorities exist before the exact source snapshot');

CREATE FUNCTION pg_temp.manager_extra_state() RETURNS jsonb LANGUAGE sql AS $state$
 SELECT pg_temp.satellite_full_financial_state()||jsonb_build_object(
 'manager_targets',(SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t.tournament_id),'[]'::jsonb)
   FROM public.tournament_satellite_manager_targets t),
 'source_lease',(SELECT to_jsonb(l) FROM public.engine_tournament_leases l
   WHERE l.tournament_id='d3000000-0000-4000-8000-000000000001'),
 'request_settings',jsonb_build_object(
  'token',current_setting('app.tournament_seat_exit_token',true),
  'operation',current_setting('app.tournament_seat_exit_operation',true),
  'generation',current_setting('app.smarter_tournament_lease_generation',true),
  'money_path',current_setting('app.money_path',true),
  'replication_role',current_setting('session_replication_role')),
 'target_counter_events',(SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb)
   FROM satellite_target_counter_events t));
$state$;

-- These use the public RPC, before any target or source capability exists.
DO $expired_public_admission$
DECLARE src constant uuid:='d3000000-0000-4000-8000-000000000001';
 winner constant uuid:='d1000000-0000-4000-8000-000000000002';
 original jsonb; r record; denied boolean; entered_rpc boolean; errcode text;
BEGIN
 FOR r IN SELECT * FROM (VALUES
  ('expired-before-public-M2','heartbeat'),('foreign-generation-before-public-M2','generation')) q(label,kind)
 LOOP
  original:=pg_temp.manager_extra_state(); denied:=false; entered_rpc:=false; errcode:=NULL;
  BEGIN
   IF r.kind='heartbeat' THEN
    UPDATE public.engine_tournament_leases SET heartbeat_at=clock_timestamp()-interval '31 seconds'
     WHERE tournament_id=src;
    IF NOT FOUND THEN RAISE EXCEPTION 'source lease fixture disappeared'; END IF;
   ELSE
    PERFORM set_config('app.smarter_tournament_lease_generation',gen_random_uuid()::text,true);
   END IF;
   entered_rpc:=true;
   PERFORM public.fn_settle_satellite_tournament(src,winner);
  EXCEPTION WHEN insufficient_privilege THEN
   IF NOT entered_rpc OR SQLERRM !~* '(lease|TOURNAMENT_MANAGER_SCOPE)' THEN RAISE; END IF;
   denied:=true; errcode:=SQLSTATE;
  END;
  PERFORM pg_temp.satellite_full_assert(denied AND original=pg_temp.manager_extra_state(),
    r.label||' refuses through actual public M2 and restores every row and setting');
  INSERT INTO satellite_manager_extra_cases VALUES(r.label,'denied',errcode);
 END LOOP;
END $expired_public_admission$;

CREATE FUNCTION pg_temp.manager_extra_active_target() RETURNS trigger LANGUAGE plpgsql AS $active$
DECLARE original jsonb; r record; command text; insert_sql text; denied boolean; reached_write boolean;
 positive boolean; observed text; errcode text; captured boolean;
BEGIN
 IF NEW.tournament_id<>'d3000000-0000-4000-8000-000000000001' THEN RETURN NEW; END IF;
 PERFORM pg_temp.satellite_full_assert(public.fn_ca_satellite_terminal_scope(NEW.tournament_id)
  AND jsonb_array_length(NEW.planned_seats)=1,'extra cases observe actual one-seat M2 publication');
 insert_sql:=format($insert$
  INSERT INTO public.tournament_players(tournament_id,user_id,username,chips,status,is_satellite_qualifier,source_satellite_id)
  SELECT %L::uuid,(x->>'user_id')::uuid,x->>'username',0,'registered',true,%L::uuid
  FROM jsonb_array_elements(%L::jsonb) x$insert$,NEW.target_id,NEW.tournament_id,NEW.planned_seats);
 original:=pg_temp.manager_extra_state(); positive:=false;
 BEGIN
  EXECUTE insert_sql; positive:=true;
  RAISE EXCEPTION 'rollback isolated legitimate target insertion' USING ERRCODE='ZX701';
 EXCEPTION WHEN SQLSTATE 'ZX701' THEN NULL;
 END;
 PERFORM pg_temp.satellite_full_assert(positive AND original=pg_temp.manager_extra_state(),
  'the exact target insert succeeds in the real scope and its isolated proof rolls back');
 INSERT INTO satellite_manager_extra_cases VALUES('exact-active-target-write','proved',NULL);

 FOR r IN SELECT * FROM (VALUES
  ('foreign-backend',format('UPDATE public.tournament_satellite_terminal_authorizations SET backend_pid=pg_backend_pid()+1 WHERE tournament_id=%L::uuid',NEW.tournament_id),true),
  ('foreign-transaction',format('UPDATE public.tournament_satellite_terminal_authorizations SET transaction_id=txid_current()+1 WHERE tournament_id=%L::uuid',NEW.tournament_id),true),
  ('foreign-created-at',format('UPDATE public.tournament_satellite_terminal_authorizations SET created_at=transaction_timestamp()-interval ''1 second'' WHERE tournament_id=%L::uuid',NEW.tournament_id),true),
  ('foreign-row-token',format('UPDATE public.tournament_satellite_terminal_authorizations SET token=gen_random_uuid() WHERE tournament_id=%L::uuid',NEW.tournament_id),true),
  ('foreign-request-token',$q$SELECT set_config('app.tournament_seat_exit_token',gen_random_uuid()::text,true)$q$,true),
  ('foreign-operation',$q$SELECT set_config('app.tournament_seat_exit_operation','terminal_finish',true)$q$,true),
  ('foreign-money-path',$q$SELECT set_config('app.money_path','native_wrong_operation',true)$q$,false)
 ) q(label,corruption,scope_must_close) LOOP
  original:=pg_temp.manager_extra_state(); denied:=false; reached_write:=false; errcode:=NULL;
  BEGIN
   EXECUTE r.corruption;
   IF r.scope_must_close THEN
    PERFORM pg_temp.satellite_full_assert(NOT public.fn_ca_satellite_terminal_scope(NEW.tournament_id),
     'source capability itself rejects '||r.label);
   END IF;
   reached_write:=true;
   EXECUTE insert_sql;
  EXCEPTION WHEN insufficient_privilege THEN
   IF NOT reached_write OR position('TOURNAMENT_MANAGER_SCOPE' IN SQLERRM)=0 THEN RAISE; END IF;
   denied:=true; errcode:=SQLSTATE;
  END;
  PERFORM pg_temp.satellite_full_assert(denied AND original=pg_temp.manager_extra_state(),
   'real target write rejects '||r.label||' with exact rollback');
  INSERT INTO satellite_manager_extra_cases VALUES(r.label,'denied',errcode);
 END LOOP;

 -- Existing 16-case probe tests no-op plan UPDATE/DELETE; these change every
 -- independently authoritative field, each through the existing immutable guard.
 FOR r IN SELECT * FROM (VALUES
  ('plan-token','token=gen_random_uuid()'),
  ('plan-generation','lease_generation=gen_random_uuid()'),
  ('plan-target',format('target_id=%L::uuid',NEW.tournament_id)),
  ('plan-source-snapshot',$q$target_before=jsonb_set(target_before,'{current_players}','999'::jsonb)$q$),
  ('plan-escrow-snapshot',$q$escrow_before=jsonb_set(escrow_before,'{prize_balance}','999'::jsonb)$q$),
  ('plan-recipient-list',$q$planned_seats='[]'::jsonb$q$)
 ) q(label,assignment) LOOP
  original:=pg_temp.manager_extra_state(); denied:=false;
  BEGIN
   EXECUTE format('UPDATE public.tournament_satellite_manager_targets SET %s WHERE tournament_id=%L::uuid',r.assignment,NEW.tournament_id);
  EXCEPTION WHEN insufficient_privilege THEN
   IF SQLERRM<>'TOURNAMENT_MANAGER_SCOPE_VIOLATION: published satellite target authority is immutable' THEN RAISE; END IF;
   denied:=true;
  END;
  PERFORM pg_temp.satellite_full_assert(denied AND original=pg_temp.manager_extra_state(),
   'published immutable target rejects '||r.label);
  INSERT INTO satellite_manager_extra_cases VALUES(r.label,'denied','42501');
 END LOOP;

 -- Do not redefine the lock/lease contract: report whether an already-issued
 -- transaction capability survives an aging heartbeat, restoring all effects.
 original:=pg_temp.manager_extra_state(); captured:=false; observed:=NULL; errcode:=NULL;
 BEGIN
  UPDATE public.engine_tournament_leases SET heartbeat_at=clock_timestamp()-interval '31 seconds'
   WHERE tournament_id=NEW.tournament_id;
  BEGIN
   EXECUTE insert_sql; observed:='accepted_after_issuance';
  EXCEPTION WHEN insufficient_privilege THEN
   IF SQLERRM !~* '(lease|TOURNAMENT_MANAGER_SCOPE)' THEN RAISE; END IF;
   observed:='denied_after_issuance'; errcode:=SQLSTATE;
  END;
  RAISE EXCEPTION 'restore active heartbeat experiment' USING ERRCODE='ZX702';
 EXCEPTION WHEN SQLSTATE 'ZX702' THEN captured:=true;
 END;
 PERFORM pg_temp.satellite_full_assert(captured AND observed IS NOT NULL
  AND original=pg_temp.manager_extra_state(),'active-plan heartbeat aging observation restores exact transaction state');
 INSERT INTO satellite_manager_extra_cases VALUES('heartbeat-aged-after-issuance',observed,errcode);
 RETURN NEW;
END $active$;
CREATE TRIGGER native_manager_extra_active_target AFTER INSERT ON public.tournament_satellite_manager_targets
 FOR EACH ROW EXECUTE FUNCTION pg_temp.manager_extra_active_target();

-- Enter only at the real funded parent-close transition after all source seats
-- were closed. The earlier intentionally unfunded completion probe still has a
-- live seat and is left entirely to its existing refusal assertion.
CREATE FUNCTION pg_temp.manager_extra_issued_seats() RETURNS trigger LANGUAGE plpgsql AS $seats$
DECLARE h public.tournament_satellite_settlements%ROWTYPE; original jsonb; issued jsonb;
 r record; denied boolean; reached_verifier boolean; result jsonb; first_seat uuid;
 seat_columns text; seat_values text; new_seat_sql text; free_chair integer;
 changed_rows integer;
BEGIN
 IF NEW.id<>'d3000000-0000-4000-8000-000000000001' OR EXISTS(
  SELECT 1 FROM public.table_seats s JOIN public.tables t ON t.id=s.table_id
   WHERE t.tournament_id=NEW.id AND s.left_at IS NULL) THEN RETURN NEW; END IF;
 SELECT * INTO STRICT h FROM public.tournament_satellite_settlements WHERE tournament_id=NEW.id;
 SELECT authorized_seats INTO STRICT issued FROM public.tournament_satellite_terminal_authorizations WHERE tournament_id=NEW.id;
 first_seat:=(issued->0->>'seat_id')::uuid;
 IF first_seat IS NULL THEN RAISE EXCEPTION 'issued-seat probe requires at least one actual issued seat'; END IF;
 SELECT n INTO free_chair FROM generate_series(1,10) n WHERE NOT EXISTS(
  SELECT 1 FROM public.table_seats occupied JOIN public.table_seats source
   ON source.id=first_seat AND occupied.table_id=source.table_id
   WHERE occupied.seat_number=n) ORDER BY n LIMIT 1;
 IF free_chair IS NULL THEN RAISE EXCEPTION 'same-user different-seat probe requires a free fixture chair'; END IF;
 SELECT string_agg(quote_ident(attname),',' ORDER BY attnum),
  string_agg('x.'||quote_ident(attname),',' ORDER BY attnum)
  INTO seat_columns,seat_values FROM pg_attribute
  WHERE attrelid='public.table_seats'::regclass AND attnum>0 AND NOT attisdropped AND attgenerated='';
 -- Preserve the issued original and every FK reference to it. Add a real row
 -- for the same user at a free chair with its own id and occupancy instead of
 -- pretending that changing an authorization's user id proves seat identity.
 -- Clone its valid parent keys and closed flags; no existing FK is orphaned.
 new_seat_sql:=format($new_seat$
  INSERT INTO public.table_seats(%s) SELECT %s FROM public.table_seats s
  CROSS JOIN LATERAL jsonb_populate_record(NULL::public.table_seats,
   to_jsonb(s)||jsonb_build_object('id',gen_random_uuid(),'occupancy_id',gen_random_uuid(),
    'seat_number',%s,'joined_at',COALESCE(s.joined_at,transaction_timestamp())+interval '1 second')) x
  WHERE s.id=%L::uuid$new_seat$,seat_columns,seat_values,free_chair,first_seat);
 original:=pg_temp.manager_extra_state();
 result:=public.fn_ca_verify_current_satellite_terminal(NEW.id,h.winner_id,true);
 PERFORM pg_temp.satellite_full_assert(result->>'ok'='true' AND original=pg_temp.manager_extra_state(),
  'real funded pending-close verifier accepts the original consumed issued set without writes');
 INSERT INTO satellite_manager_extra_cases VALUES('exact-funded-issued-set','proved',NULL);
 FOR r IN SELECT * FROM (VALUES
  ('missing-issued-seat',format($q$UPDATE public.tournament_satellite_terminal_authorizations SET authorized_seats='[]'::jsonb WHERE tournament_id=%L::uuid$q$,NEW.id)),
  ('extra-issued-seat',format('UPDATE public.tournament_satellite_terminal_authorizations SET authorized_seats=authorized_seats||(authorized_seats->0) WHERE tournament_id=%L::uuid',NEW.id)),
  ('unconsumed-issued-seat',format($q$INSERT INTO public.tournament_seat_exit_authorizations SELECT (jsonb_populate_record(NULL::public.tournament_seat_exit_authorizations,x)).* FROM jsonb_array_elements(%L::jsonb) x$q$,issued)),
  ('departed-seat-time',format('UPDATE public.table_seats SET left_at=left_at-interval ''1 second'' WHERE id=%L::uuid',first_seat)),
  ('same-user-new-seat-generation',format('UPDATE public.table_seats SET joined_at=COALESCE(joined_at,transaction_timestamp())+interval ''1 second'' WHERE id=%L::uuid',first_seat)),
  ('same-user-new-occupancy-id',format('UPDATE public.table_seats SET occupancy_id=gen_random_uuid() WHERE id=%L::uuid',first_seat)),
  ('same-user-different-seat-id',new_seat_sql)
 ) q(label,corruption) LOOP
  original:=pg_temp.manager_extra_state(); denied:=false; reached_verifier:=false;
  BEGIN
   -- Storage fault only. Restore all ordinary guards BEFORE invoking the real
   -- verifier, and require that verifier rather than the injection to refuse.
   PERFORM set_config('session_replication_role','replica',true);
   EXECUTE r.corruption;
   GET DIAGNOSTICS changed_rows=ROW_COUNT;
   IF changed_rows<>1 THEN RAISE EXCEPTION 'seat fault % must change exactly one real row',r.label; END IF;
   PERFORM set_config('session_replication_role','origin',true);
   reached_verifier:=true;
   PERFORM public.fn_ca_verify_current_satellite_terminal(NEW.id,h.winner_id,true);
  EXCEPTION WHEN SQLSTATE 'P0404' THEN
   IF NOT reached_verifier THEN RAISE; END IF;
   denied:=true;
  END;
  PERFORM pg_temp.satellite_full_assert(denied AND original=pg_temp.manager_extra_state()
   AND current_setting('session_replication_role')='origin',
   'real pending-close verifier refuses '||r.label||' and exact state rolls back');
  INSERT INTO satellite_manager_extra_cases VALUES(r.label,'denied','P0404');
 END LOOP;
 RETURN NEW;
END $seats$;
CREATE TRIGGER aaa_native_manager_extra_issued_seats BEFORE UPDATE OF status ON public.tournaments
 FOR EACH ROW WHEN(OLD.status='COMPLETING' AND NEW.status='COMPLETED')
 EXECUTE FUNCTION pg_temp.manager_extra_issued_seats();

-- Exercise restoration of a caller's pre-existing token/operation values by the
-- complete real public M2 wrapper, including its inner scope reuse. No fake
-- authorization row is issued for this sentinel and it conveys no authority.
SELECT set_config('app.tournament_seat_exit_token',sentinel_token,true),
 set_config('app.tournament_seat_exit_operation',sentinel_operation,true)
 FROM satellite_manager_extra_context;

CREATE FUNCTION pg_temp.assert_manager_extra_native() RETURNS void LANGUAGE plpgsql AS $finish$
DECLARE c record;
BEGIN
 SELECT * INTO STRICT c FROM satellite_manager_extra_context;
 PERFORM pg_temp.satellite_full_assert(current_setting('app.tournament_seat_exit_token',true)=c.sentinel_token
  AND current_setting('app.tournament_seat_exit_operation',true)=c.sentinel_operation,
  'real public M2 restores the caller token and operation after inner capability cleanup');
 INSERT INTO satellite_manager_extra_cases VALUES('nested-caller-context-restored','proved',NULL);
 PERFORM pg_temp.satellite_full_assert((SELECT count(*)=26 FROM satellite_manager_extra_cases)
  AND (SELECT count(*)=22 FROM satellite_manager_extra_cases WHERE outcome='denied')
  AND (SELECT count(*)=3 FROM satellite_manager_extra_cases WHERE outcome='proved')
  AND (SELECT count(*)=1 FROM satellite_manager_extra_cases
   WHERE outcome IN ('accepted_after_issuance','denied_after_issuance')),
  '26 extra native cases complete independently of the original 16-case count');
 PERFORM pg_temp.satellite_full_assert(pg_temp.manager_extra_catalog()=(SELECT proof FROM satellite_manager_extra_source),
  'every tested public source body, metadata, production guard and capability schema remains exact');
 PERFORM set_config('app.tournament_seat_exit_token',COALESCE(c.original_token,''),true);
 PERFORM set_config('app.tournament_seat_exit_operation',COALESCE(c.original_operation,''),true);
 RAISE NOTICE 'MANAGER_EXTRA_NATIVE_EVIDENCE=%',jsonb_build_object(
  'count',(SELECT count(*) FROM satellite_manager_extra_cases),
  'cases',(SELECT jsonb_agg(to_jsonb(t) ORDER BY label) FROM satellite_manager_extra_cases t),
  'source_catalog_unchanged',true,'normal_triggers',current_setting('session_replication_role'));
END $finish$;

CREATE FUNCTION pg_temp.refuse_satellite_full_last_close() RETURNS trigger LANGUAGE plpgsql AS $fault$
BEGIN
 IF NEW.id='d5000000-0000-4000-8000-000000000001' AND NEW.status='closed' THEN
  PERFORM pg_temp.assert_satellite_full_money_closed();
  RAISE EXCEPTION 'injected satellite final table close refusal' USING ERRCODE='PZ012';
 END IF;
 RETURN NEW;
END $fault$;
CREATE TRIGGER native_refuse_satellite_full_last_close BEFORE UPDATE ON public.tables
 FOR EACH ROW EXECUTE FUNCTION pg_temp.refuse_satellite_full_last_close();
DO $atomic_failure$
DECLARE before_state jsonb:=pg_temp.satellite_full_financial_state(); refused boolean:=false;
BEGIN
 BEGIN
  PERFORM pg_temp.manager_satellite_settle('d3000000-0000-4000-8000-000000000001',
   'd1000000-0000-4000-8000-000000000002');
 EXCEPTION WHEN SQLSTATE 'PZ012' THEN refused:=true; END;
 PERFORM pg_temp.satellite_full_assert(refused,'injected final close fault is reached after actual money and lifecycle work');
 PERFORM pg_temp.satellite_full_assert(before_state=pg_temp.satellite_full_financial_state(),
  'late close fault restores all 28 financial and seat relations plus observed capabilities');
END $atomic_failure$;
DROP TRIGGER native_refuse_satellite_full_last_close ON public.tables;

INSERT INTO satellite_full_probe_results VALUES('first_settlement',
 pg_temp.manager_satellite_settle('d3000000-0000-4000-8000-000000000001',
 'd1000000-0000-4000-8000-000000000002'));
SELECT pg_temp.assert_satellite_full_money_closed();
SELECT pg_temp.satellite_full_assert((SELECT count(*)=1 FROM satellite_full_authority_events WHERE action='INSERT')
 AND (SELECT count(*)=1 FROM satellite_full_authority_events WHERE action='DELETE')
 AND NOT EXISTS(SELECT capability FROM satellite_full_authority_events WHERE action='INSERT'
  EXCEPT ALL SELECT capability FROM satellite_full_authority_events WHERE action='DELETE')
 AND NOT EXISTS(SELECT 1 FROM satellite_full_authority_events WHERE capability->>'operation'<>'satellite_finish'
  OR capability->>'seat_id'<>'d6000000-0000-4000-8000-000000000001')
 AND NOT EXISTS(SELECT 1 FROM public.tournament_seat_exit_authorizations
  WHERE tournament_id='d3000000-0000-4000-8000-000000000001'),
 'public satellite RPC mints and consumes the exact sole live seat capability');
SELECT pg_temp.satellite_full_assert(EXISTS(SELECT 1 FROM public.tables
 WHERE id='d5000000-0000-4000-8000-000000000001' AND status='closed'
  AND lifecycle='closed' AND current_players=0 AND terminal_closed_at IS NOT NULL)
 AND EXISTS(SELECT 1 FROM public.table_seats WHERE id='d6000000-0000-4000-8000-000000000001'
  AND left_at IS NOT NULL AND status='left'),'every source seat and table durably closes');
DO $exact_replay$
DECLARE first_receipt jsonb:=(SELECT value FROM satellite_full_probe_results WHERE name='first_settlement');
 before_state jsonb:=pg_temp.satellite_full_financial_state(); replay jsonb; outcome jsonb;
BEGIN
 replay:=pg_temp.manager_satellite_settle('d3000000-0000-4000-8000-000000000001',
 'd1000000-0000-4000-8000-000000000002');
 outcome:=pg_temp.manager_satellite_outcome('d3000000-0000-4000-8000-000000000001',
 'd1000000-0000-4000-8000-000000000002');
 PERFORM pg_temp.satellite_full_assert(first_receipt=replay AND outcome->'receipt'=first_receipt
  AND outcome->>'satellite_committed'='true','RPC replay and ambiguity resolver return the same complete immutable receipt');
 PERFORM pg_temp.satellite_full_assert(before_state=pg_temp.satellite_full_financial_state(),
  'replay moves no chips and creates no new receipt or seat capability');
 PERFORM pg_temp.satellite_full_assert(first_receipt->>'ok'='true' AND first_receipt->>'fully_settled'='true'
  AND (first_receipt->>'pool')::numeric=100 AND (first_receipt->>'seat_count')::integer=1,
  'complete source receipt certifies the full hundred-chip pool');
END $exact_replay$;
SELECT pg_temp.assert_manager_extra_native();
DO $deferred_table_proof$
DECLARE before_state jsonb:=pg_temp.satellite_full_financial_state(); refused boolean:=false;
BEGIN
 IF to_regprocedure('public.fn_ca_verify_current_satellite_terminal(uuid,uuid,boolean)') IS NOT NULL THEN
  BEGIN
   -- Controlled native storage-fault injection after the actual successful RPC.
   -- Suppress only this injected table corruption's ordinary guards, then force
   -- the already-queued deferred source-completion proof with guards restored.
   PERFORM set_config('session_replication_role','replica',true);
   UPDATE public.tables SET status='running',lifecycle='live',current_players=1,terminal_closed_at=NULL
    WHERE id='d5000000-0000-4000-8000-000000000001';
   PERFORM set_config('session_replication_role','origin',true);
   SET CONSTRAINTS current_satellite_terminal_commit_proof IMMEDIATE;
  EXCEPTION WHEN SQLSTATE 'P0404' THEN
   IF position('source table or seat closeout' IN SQLERRM)=0 THEN RAISE; END IF;
   refused:=true;
  END;
  PERFORM pg_temp.satellite_full_assert(refused,
   'deferred original receipt rejects omitted source table closure even after earlier financial proof');
  PERFORM pg_temp.satellite_full_assert(before_state=pg_temp.satellite_full_financial_state()
    AND current_setting('session_replication_role')='origin',
    'rejected closure corruption restores exact completed state and normal triggers');
  PERFORM pg_temp.satellite_full_assert(NOT EXISTS(SELECT 1 FROM public.tournament_satellite_terminal_authorizations)
   AND NOT has_table_privilege('service_role','public.tournament_satellite_terminal_authorizations','SELECT,INSERT,UPDATE,DELETE')
   AND NOT has_function_privilege('service_role','public.fn_ca_open_satellite_terminal_scope(uuid)','EXECUTE'),
   'execution capability is consumed and inaccessible through the service role');
 END IF;
END $deferred_table_proof$;
SELECT pg_temp.satellite_manager_outside_scope('after source completion and replay the source manager still cannot write the target without a capability');
SELECT pg_temp.satellite_full_assert((SELECT count(*) FROM satellite_target_scope_denials)=16,'all 16 active scope negatives executed');
SET CONSTRAINTS ALL IMMEDIATE;
SELECT 'SATELLITE_FULL_NATIVE_EVIDENCE='||jsonb_build_object(
 'rpc','fn_settle_satellite_tournament','first_receipt',(SELECT value FROM satellite_full_probe_results WHERE name='first_settlement'),
 'source_escrow',(SELECT to_jsonb(e) FROM public.tournament_escrow e WHERE tournament_id='d3000000-0000-4000-8000-000000000001'),
 'target_escrow',(SELECT to_jsonb(e) FROM public.tournament_escrow e WHERE tournament_id='d3000000-0000-4000-8000-000000000002'),
 'authority_events',(SELECT jsonb_agg(to_jsonb(e)) FROM satellite_full_authority_events e))::text;
ROLLBACK;
