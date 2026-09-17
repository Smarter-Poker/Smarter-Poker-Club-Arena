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
INSERT INTO public.club_wallets(club_id) VALUES('d2000000-0000-4000-8000-000000000002');
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
UPDATE public.tables SET seat_game_scope='table:'||id::text,seat_admission_key='tournament:'||tournament_id::text WHERE id='d5000000-0000-4000-8000-000000000001';
INSERT INTO public.table_seats(active_game_scope,active_parent_key,id,table_id,seat_number,user_id,stack,status,left_at,
 leave_pending,is_sitting_out,is_away,club_id)
 VALUES('table:d5000000-0000-4000-8000-000000000001','tournament:d3000000-0000-4000-8000-000000000001','d6000000-0000-4000-8000-000000000001',
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
SELECT pg_temp.satellite_full_assert(NOT EXISTS(SELECT 1 FROM (VALUES ('aa_guard_tournament_completing_claim','D'),('aaa_guard_atomic_satellite_completion','D'),('cancelled_tournament_parent_is_immutable','O'),('non_satellite_completed_requires_terminal_receipt','O'),('poker_arena_tournament_guard','O'),('receipted_tournament_is_immutable','O'),('satellite_feeds_only_a_deliverable_target','O'),('satellite_target_contract_is_immutable','O'),('spin_tournament_contract_is_draw','O'),('stamp_tournament_terminal_evidence_markers','O'),('tournament_completed_stats','O'),('tournament_prize_math_contract','O'),('tournament_start_time_locked_during_launch','O'),('tournaments_cancel_must_refund','O'),('tournaments_creation_guard','O'),('tournaments_guarantee_affordable_ins','O'),('tournaments_guarantee_affordable_upd','O'),('tournaments_mystery_creation_contract','O'),('tournaments_new_mtt_blind_contract','O'),('tournaments_rank_before_complete','O'),('tournaments_short_formats_never_break','O'),('tournaments_spin_completed_guard','O'),('trg_clear_seats_on_game_end','O'),('trg_guard_retired_club_mutation','O'),('trg_receipt_mystery_activation','O'),('trg_refuse_completed_with_pending_bounties','O'),('trg_refuse_mystery_activation_with_pending_heads','O'),('trg_release_seats_on_tournament_finish','O'),('trg_retire_manager_wakes_after_terminal_status','O'),('trg_tournaments_capture_management_contract','O'),('trg_tournaments_emit_game_management_event','O'),('trg_tournaments_managed_delete_guard','O'),('trg_tournaments_managed_lifecycle_guard','O'),('trg_tournaments_publish_readiness','O'),('trg_tournaments_refuse_unbuilt_multi_day','O'),('trg_tournaments_registered_contract_lock','O'),('trg_tournaments_start_readiness','O'),('trg_tournaments_union_ownership','O'),('trg_tournaments_union_ownership_upd','O'),('trg_whole_dollar_buyin','O'),('zz_ca_fund_overlay_on_lock','O'),('zz_freerolls_are_free_buy','O'),('zz_freeze_launch_guard','O'),('zzz_spin_ladder_is_the_drawn_one','O'),('zzzy_lock_atomic_place_tournament_status','O'),('zzzz_capture_satellite_economics_on_start','O'),('zzzz_freeze_finalized_tournament_prize_pool','D'),('zzzz_freeze_registered_tournament_settlement_contract','O'),('zzzz_refuse_normal_tournament_completed_insert','O'),('zzzz_tournament_pool_finalization_window_guard','D'),('zzzz_tournaments_atomic_place_completion_guard','D'),('zzzzy_lock_atomic_final_table_deal_status','O'),('zzzzz_tournaments_atomic_final_table_deal_completion_guard','D'),('zzzzzz_tournaments_financial_certificate','D')) expected(name,state) WHERE NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid='public.tournaments'::regclass AND t.tgname=expected.name AND t.tgenabled::text=expected.state)),'all current tournament trigger states match read-only catalog');

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
 FOR t IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' ORDER BY c.relname LOOP
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
  PERFORM public.fn_settle_satellite_tournament('d3000000-0000-4000-8000-000000000001',
   'd1000000-0000-4000-8000-000000000002');
 EXCEPTION WHEN SQLSTATE 'PZ012' THEN refused:=true; END;
 PERFORM pg_temp.satellite_full_assert(refused,'injected final close fault is reached after actual money and lifecycle work');
 PERFORM pg_temp.satellite_full_assert(before_state=pg_temp.satellite_full_financial_state(),
  'late close fault restores every public relation plus observed capabilities');
END $atomic_failure$;
DROP TRIGGER native_refuse_satellite_full_last_close ON public.tables;

INSERT INTO satellite_full_probe_results VALUES('first_settlement',
 public.fn_settle_satellite_tournament('d3000000-0000-4000-8000-000000000001',
 'd1000000-0000-4000-8000-000000000002'));
SELECT pg_temp.assert_satellite_full_money_closed();
SELECT pg_temp.satellite_full_assert((SELECT count(*)=0 FROM satellite_full_authority_events WHERE action='INSERT')
 AND (SELECT count(*)=0 FROM satellite_full_authority_events WHERE action='DELETE')
 AND NOT EXISTS(SELECT capability FROM satellite_full_authority_events WHERE action='INSERT'
  EXCEPT ALL SELECT capability FROM satellite_full_authority_events WHERE action='DELETE')
 AND NOT EXISTS(SELECT 1 FROM satellite_full_authority_events WHERE capability->>'operation'<>'satellite_finish'
  OR capability->>'seat_id'<>'d6000000-0000-4000-8000-000000000001')
 AND NOT EXISTS(SELECT 1 FROM public.tournament_seat_exit_authorizations
  WHERE tournament_id='d3000000-0000-4000-8000-000000000001'),
 'current satellite authority closes with no stray seat capability rows');
SELECT pg_temp.satellite_full_assert(EXISTS(SELECT 1 FROM public.tables
 WHERE id='d5000000-0000-4000-8000-000000000001' AND status='closed'
  AND lifecycle='closed' AND current_players=0 AND terminal_closed_at IS NOT NULL)
 AND EXISTS(SELECT 1 FROM public.table_seats WHERE id='d6000000-0000-4000-8000-000000000001'
  AND left_at IS NOT NULL AND status='left'),'every source seat and table durably closes');
DO $exact_replay$
DECLARE first_receipt jsonb:=(SELECT value FROM satellite_full_probe_results WHERE name='first_settlement');
 before_state jsonb:=pg_temp.satellite_full_financial_state(); replay jsonb; outcome jsonb;
BEGIN
 replay:=public.fn_settle_satellite_tournament('d3000000-0000-4000-8000-000000000001',
 'd1000000-0000-4000-8000-000000000002');
 outcome:=public.fn_resolve_satellite_settlement_outcome('d3000000-0000-4000-8000-000000000001',
 'd1000000-0000-4000-8000-000000000002');
 PERFORM pg_temp.satellite_full_assert(first_receipt=replay AND outcome->'receipt'=first_receipt
  AND outcome->>'satellite_committed'='true','RPC replay and ambiguity resolver return the same complete immutable receipt');
 PERFORM pg_temp.satellite_full_assert(before_state=pg_temp.satellite_full_financial_state(),
  'replay moves no chips and creates no new receipt or seat capability');
 PERFORM pg_temp.satellite_full_assert(first_receipt->>'ok'='true' AND first_receipt->>'fully_settled'='true'
  AND (first_receipt->>'pool')::numeric=100 AND (first_receipt->>'seat_count')::integer=1,
  'complete source receipt certifies the full hundred-chip pool');
END $exact_replay$;
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
SET CONSTRAINTS ALL IMMEDIATE;
-- Advance the already-funded target to a synthetic final hand. Actual entry
-- purchases above are its sole 180-chip prize / 20-chip fee custody source.
SET CONSTRAINTS ALL DEFERRED;
SET LOCAL session_replication_role=replica;
UPDATE public.tournaments SET status='RUNNING',started_at=now()-interval '2 hours',current_level=5,
 current_players=1,prize_pool_finalized=true,payout_structure='[{"place":1,"percentage":100}]',
 late_reg_levels=0,rebuy_levels=0,late_reg_mins=0
 WHERE id='d3000000-0000-4000-8000-000000000002';
UPDATE public.tournament_players SET status=CASE WHEN user_id='d1000000-0000-4000-8000-000000000002' THEN 'playing' ELSE 'eliminated' END,
 chips=CASE WHEN user_id='d1000000-0000-4000-8000-000000000002' THEN 2000 ELSE 0 END,
 position=CASE WHEN user_id='d1000000-0000-4000-8000-000000000002' THEN NULL ELSE 2 END,
 eliminated_at=CASE WHEN user_id='d1000000-0000-4000-8000-000000000002' THEN NULL ELSE now() END,
 elimination_sequence=CASE WHEN user_id='d1000000-0000-4000-8000-000000000002' THEN NULL ELSE 1 END,
 table_id=CASE WHEN user_id='d1000000-0000-4000-8000-000000000002' THEN 'd5000000-0000-4000-8000-000000000002'::uuid ELSE NULL END,
 seat_number=CASE WHEN user_id='d1000000-0000-4000-8000-000000000002' THEN 1 ELSE NULL END
 WHERE tournament_id='d3000000-0000-4000-8000-000000000002';
INSERT INTO public.tables(id,name,tournament_id,status,lifecycle,current_players,game_type,club_id,seat_game_scope,seat_admission_key)
 VALUES('d5000000-0000-4000-8000-000000000002','Target final hand',
 'd3000000-0000-4000-8000-000000000002','running','live',1,'tournament','d2000000-0000-4000-8000-000000000002',
 'table:d5000000-0000-4000-8000-000000000002','tournament:d3000000-0000-4000-8000-000000000002');
INSERT INTO public.table_seats(id,table_id,seat_number,user_id,stack,status,club_id,active_game_scope,active_parent_key)
 VALUES('d6000000-0000-4000-8000-000000000002','d5000000-0000-4000-8000-000000000002',1,
 'd1000000-0000-4000-8000-000000000002',2000,'active','d2000000-0000-4000-8000-000000000002',
 'table:d5000000-0000-4000-8000-000000000002','tournament:d3000000-0000-4000-8000-000000000002');
SET LOCAL session_replication_role=origin;
SELECT pg_temp.satellite_full_assert(public.fn_claim_tournament_finish('d3000000-0000-4000-8000-000000000002',
 'd1000000-0000-4000-8000-000000000002','native-full-target')->>'ok'='true','funded target obtains real terminal winner claim');
-- This target has genuine funded entries but no observed historical agent
-- agreements. Completion must roll back its preceding prize/lifecycle work;
-- banked-but-unattributed is no longer an accepted positive-fee terminal state.
CREATE TEMP TABLE target_retirement_before AS SELECT public.fn_ca_mint_supply('chips') AS supply,
 (SELECT chip_treasury FROM public.clubs WHERE id='d2000000-0000-4000-8000-000000000002') AS treasury;
DO $target_attribution_refusal$
DECLARE before_state jsonb:=pg_temp.satellite_full_financial_state();message text;attempt int;
BEGIN
 FOR attempt IN 1..2 LOOP
  message:=NULL;
  BEGIN
   PERFORM public.fn_complete_tournament_terminal('d3000000-0000-4000-8000-000000000002',
    'd1000000-0000-4000-8000-000000000002','places');
  EXCEPTION WHEN SQLSTATE 'P0404' THEN message:=SQLERRM; END;
  PERFORM pg_temp.satellite_full_assert(message=
   'tournament d3000000-0000-4000-8000-000000000002 rake attribution incomplete: tournament_fee_sources_require_reconciliation',
   'positive-fee source gap reaches the actual terminal authority refusal');
  PERFORM pg_temp.satellite_full_assert(before_state=pg_temp.satellite_full_financial_state(),
   'initial and explicit retry refusals preserve every public relation and observed capability');
 END LOOP;
 PERFORM pg_temp.satellite_full_assert(EXISTS(SELECT 1 FROM public.tournament_escrow
  WHERE tournament_id='d3000000-0000-4000-8000-000000000002'
   AND prize_balance=180 AND fee_balance=20 AND bounty_balance=0 AND closed_at IS NULL)
  AND NOT EXISTS(SELECT 1 FROM public.tournament_payouts WHERE tournament_id='d3000000-0000-4000-8000-000000000002')
  AND NOT EXISTS(SELECT 1 FROM public.tournament_rake_settlements WHERE tournament_id='d3000000-0000-4000-8000-000000000002')
  AND NOT EXISTS(SELECT 1 FROM public.tournament_terminal_settlements WHERE tournament_id='d3000000-0000-4000-8000-000000000002')
  AND NOT EXISTS(SELECT 1 FROM public.accounting_tournament_fee_recognitions WHERE tournament_id='d3000000-0000-4000-8000-000000000002'),
  'refused completion keeps all180 prize and20 fee chips in custody with no paid or completion receipt');
 PERFORM pg_temp.satellite_full_assert((SELECT count(*)=2 AND sum(rake_amount)=20
   AND bool_and(source_manifest->>'capture_reason'='accounting_terms_not_observed')
   FROM public.accounting_tournament_fee_batches WHERE tournament_id='d3000000-0000-4000-8000-000000000002'
    AND status='legacy_unverified')
  AND NOT EXISTS(SELECT 1 FROM public.accounting_tournament_recognized_sources WHERE tournament_id='d3000000-0000-4000-8000-000000000002'),
  'original missing-history manifests survive without fabricated recognition');
 INSERT INTO satellite_full_probe_results(name,value) VALUES('target_terminal',
  jsonb_build_object('completed',false,'refusal_sqlstate','P0404','refusal',message,'attempts',2));
END $target_attribution_refusal$;
SET CONSTRAINTS ALL IMMEDIATE;
SELECT pg_temp.satellite_full_assert(public.fn_ca_mint_supply('chips')=(SELECT supply FROM target_retirement_before)
 AND (SELECT chip_treasury FROM public.clubs WHERE id='d2000000-0000-4000-8000-000000000002')
  IS NOT DISTINCT FROM (SELECT treasury FROM target_retirement_before)
 AND NOT EXISTS(SELECT 1 FROM public.ca_mint_ledger m JOIN public.chip_ledger l ON l.id=m.chip_ledger_id
  WHERE l.from_type='prize_liability' AND l.from_entity_id='d3000000-0000-4000-8000-000000000002'
   AND l.to_type='chip_retirement' AND m.action='burn' AND m.asset='chips'),
 'refused attribution changes neither issued supply nor treasury and records no fee retirement');

SELECT 'SATELLITE_FULL_NATIVE_EVIDENCE='||jsonb_build_object(
 'target_terminal',(SELECT value FROM satellite_full_probe_results WHERE name='target_terminal'),'rpc','fn_settle_satellite_tournament','first_receipt',(SELECT value FROM satellite_full_probe_results WHERE name='first_settlement'),
 'source_escrow',(SELECT to_jsonb(e) FROM public.tournament_escrow e WHERE tournament_id='d3000000-0000-4000-8000-000000000001'),
 'target_escrow',(SELECT to_jsonb(e) FROM public.tournament_escrow e WHERE tournament_id='d3000000-0000-4000-8000-000000000002'),
 'authority_events',(SELECT jsonb_agg(to_jsonb(e)) FROM satellite_full_authority_events e))::text;
ROLLBACK;
