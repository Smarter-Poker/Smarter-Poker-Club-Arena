-- Local rollback-only normal settlement acceptance. Opening entrants, standings,
-- custody, and the published host promise are synthetic fixtures. Contract capture,
-- bank debit, overlay journal, escrow credit, payments, terminal receipts and seat
-- capability consumption execute their actual database authorities with triggers on.
-- Variants: overlay (4.00 funded entries + 6.01 house funds = 10.01), zero (0.00).
-- @FINAL_DEAL_RUNTIME@
CREATE TEMP TABLE native_normal_config ON COMMIT DROP AS
SELECT variant,CASE WHEN variant='overlay' THEN 4.00 ELSE 0.00 END::numeric AS entries,
 CASE WHEN variant='overlay' THEN 10.01 ELSE 0.00 END::numeric AS pool,
 CASE WHEN variant='overlay' THEN 6.01 ELSE 0.00 END::numeric AS overlay
FROM (VALUES ('@NORMAL_VARIANT@'::text)) v(variant);
CREATE TEMP TABLE native_normal_checks(id integer GENERATED ALWAYS AS IDENTITY,label text NOT NULL) ON COMMIT DROP;
CREATE FUNCTION pg_temp.normal_assert(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $assert$
BEGIN
 IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL %',label; END IF;
 INSERT INTO native_normal_checks(label) VALUES(label);
 RAISE NOTICE 'PASS %',label;
END $assert$;
DO $guard$
BEGIN
 PERFORM pg_temp.normal_assert(current_database()='full_stage1' AND current_user='postgres'
  AND inet_server_addr() IS NULL AND (SELECT variant IN ('overlay','zero') FROM native_normal_config)
  AND NOT EXISTS(SELECT 1 FROM public.tournaments WHERE id='98510000-0000-0000-0000-000000000001'),
  'exclusive local baseline and unused supported synthetic normal event');
 PERFORM pg_temp.normal_assert(NOT EXISTS(SELECT 1 FROM unnest(ARRAY[
  'aa_guard_tournament_completing_claim','aaa_guard_atomic_satellite_completion',
  'zzzz_freeze_finalized_tournament_prize_pool','zzzz_tournament_pool_finalization_window_guard',
  'zzzz_tournaments_atomic_place_completion_guard','zzzzz_tournaments_atomic_final_table_deal_completion_guard',
  'zzzzzz_tournaments_financial_certificate']) names(name)
  WHERE NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.tournaments'::regclass
   AND tgname=names.name AND tgenabled='O')),'all seven financial guards active');
END $guard$;
SET LOCAL session_replication_role=replica;
INSERT INTO auth.users(id,email,is_sso_user,is_anonymous,created_at,updated_at)
SELECT md5('normal-overlay-user:'||g.i)::uuid,'normal-overlay-'||g.i||'@example.invalid',false,false,now(),now()
FROM generate_series(1,4) g(i);
INSERT INTO public.users
SELECT (jsonb_populate_record(NULL::public.users,to_jsonb(u)||jsonb_build_object(
 'id',md5('normal-overlay-user:'||g.i)::uuid,'username','normal_overlay_'||g.i))).*
FROM public.users u CROSS JOIN generate_series(1,4) g(i)
WHERE u.id='10000000-0000-0000-0000-000000000001';
INSERT INTO public.profiles
SELECT (jsonb_populate_record(NULL::public.profiles,to_jsonb(p)||jsonb_build_object(
 'id',md5('normal-overlay-user:'||g.i)::uuid,'username','normal_overlay_'||g.i))).*
FROM public.profiles p CROSS JOIN generate_series(1,4) g(i)
WHERE p.id='10000000-0000-0000-0000-000000000001';
INSERT INTO public.club_members
SELECT (jsonb_populate_record(NULL::public.club_members,to_jsonb(m)||jsonb_build_object(
 'user_id',md5('normal-overlay-user:'||g.i)::uuid,'chip_balance',0,'updated_at',now()))).*
FROM public.club_members m CROSS JOIN generate_series(1,4) g(i)
WHERE m.user_id='10000000-0000-0000-0000-000000000001'
 AND m.club_id='20000000-0000-0000-0000-000000000001';
-- Publish the synthetic event through its actual INSERT triggers. The capture
-- correctly skips updated_at-only updates, so the initial publication must run.
SET LOCAL session_replication_role=origin;
SET LOCAL request.jwt.claim.role='service_role';
SET LOCAL request.jwt.claims='{"role":"service_role"}';
SET LOCAL request.jwt.claim.sub='';
INSERT INTO public.tournaments
SELECT (jsonb_populate_record(NULL::public.tournaments,to_jsonb(t)||jsonb_build_object(
 'id','98510000-0000-0000-0000-000000000001','name','Normal sparse rounded overlay terminal proof',
 'club_id','20000000-0000-0000-0000-000000000001','union_id',NULL,'is_private',false,
 'buy_in_amount',CASE WHEN c.variant='overlay' THEN 1 ELSE 0 END,'buy_in_fee',0,
 'starting_chips',1000,'prize_pool',c.entries,'guaranteed_prize',c.pool,
 'prize_pool_finalized',false,'bubble_protection',false,
 'status','RUNNING','current_players',1,'ended_at',NULL,
 'synchronized_breaks',false,'on_break',false,
 'bounty_pool',0,'bounty_pool_paid',0,'total_rake',0,
 'is_bounty',false,'is_pko',false,'is_mystery_bounty',false,
 'payout_structure','[{"place":1,"percentage":33.33},{"place":3,"percentage":33.33},{"place":4,"percentage":33.34}]'::jsonb))).*
FROM public.tournaments t CROSS JOIN native_normal_config c
WHERE t.id='30000000-0000-0000-0000-000000000001';
SET LOCAL session_replication_role=replica;
INSERT INTO public.tournament_players
SELECT (jsonb_populate_record(NULL::public.tournament_players,to_jsonb(tp)||jsonb_build_object(
 'id',md5('normal-overlay-player:'||g.i)::uuid,'tournament_id','98510000-0000-0000-0000-000000000001',
 'user_id',md5('normal-overlay-user:'||g.i)::uuid,'username','normal_overlay_'||g.i,
 'club_id','20000000-0000-0000-0000-000000000001',
 'table_id',CASE WHEN g.i=1 THEN '98530000-0000-0000-0000-000000000001' ELSE NULL END,
 'seat_number',CASE WHEN g.i=1 THEN 1 ELSE NULL END,
 'chips',CASE WHEN g.i=1 THEN 4000 ELSE 0 END,
 'status',CASE WHEN g.i=1 THEN 'playing' ELSE 'eliminated' END,
 'position',CASE WHEN g.i=1 THEN NULL ELSE g.i END,'prize',0,
 'eliminated_at',CASE WHEN g.i=1 THEN NULL ELSE now()-g.i*interval '1 minute' END,
 'elimination_sequence',CASE WHEN g.i=1 THEN NULL ELSE 5-g.i END,
 'current_bounty',0,'bounty_winnings',0,'mystery_bounty_value',0))).*
FROM public.tournament_players tp CROSS JOIN generate_series(1,4) g(i)
WHERE tp.id='31000000-0000-0000-0000-000000000001';
INSERT INTO public.tournament_escrow
SELECT (jsonb_populate_record(NULL::public.tournament_escrow,to_jsonb(e)||jsonb_build_object(
 'tournament_id','98510000-0000-0000-0000-000000000001',
 'gross_in',c.entries,'fee_entries_in',0,'satellite_fee_in',0,'bounty_in',0,
 'overlay_in',0,'satellite_in',0,'prize_out',0,'bounty_out',0,'fee_out',0,
 'refund_prize',0,'refund_bounty',0,'refund_fee',0,'reserve_out',0,'reserve_in',0,
 'prize_balance',c.entries,'bounty_balance',0,'fee_balance',0,
 'closed_at',NULL,'close_note',NULL,'opened_from','normal-overlay-terminal-proof'))).*
FROM public.tournament_escrow e CROSS JOIN native_normal_config c
WHERE e.tournament_id='30000000-0000-0000-0000-000000000001';
INSERT INTO public.tables(id,name,tournament_id,status,lifecycle,current_players,game_type,club_id)
VALUES ('98530000-0000-0000-0000-000000000001','Normal overlay terminal table',
 '98510000-0000-0000-0000-000000000001','running','live',1,'tournament',
 '20000000-0000-0000-0000-000000000001');
INSERT INTO public.table_seats(id,table_id,seat_number,user_id,stack,status,left_at,
 leave_pending,is_sitting_out,club_id)
VALUES ('98540000-0000-0000-0000-000000000001','98530000-0000-0000-0000-000000000001',1,
 md5('normal-overlay-user:1')::uuid,4000,'active',NULL,false,false,
 '20000000-0000-0000-0000-000000000001');
SET LOCAL session_replication_role=origin;
SET LOCAL request.jwt.claim.role='service_role';
SET LOCAL request.jwt.claims='{"role":"service_role"}';
SET LOCAL request.jwt.claim.sub='';
-- Read the promise written by the real publication trigger above.
-- No version ledger row is inserted by this fixture.
CREATE TEMP TABLE native_normal_promise ON COMMIT DROP AS
SELECT contract,contract_hash,version FROM public.managed_game_contract_versions
WHERE game_kind='tournament' AND game_id='98510000-0000-0000-0000-000000000001';
CREATE TEMP TABLE native_normal_bank_before ON COMMIT DROP AS
SELECT chip_treasury FROM public.clubs WHERE id='20000000-0000-0000-0000-000000000001';
CREATE TEMP TABLE native_normal_expected ON COMMIT DROP AS
SELECT x.place,md5('normal-overlay-user:'||x.place)::uuid AS user_id,
 CASE WHEN c.variant='zero' THEN 0 ELSE x.amount END::numeric AS amount
FROM (VALUES (1,3.34::numeric),(3,3.34::numeric),(4,3.33::numeric)) x(place,amount)
CROSS JOIN native_normal_config c;
-- Observe real capability rows without authorizing any seat ourselves.
CREATE TEMP TABLE native_normal_terminal_expected_seats ON COMMIT DROP AS
SELECT s.id AS seat_id,s.user_id,t.tournament_id
FROM public.table_seats s JOIN public.tables t ON t.id=s.table_id
WHERE t.tournament_id='98510000-0000-0000-0000-000000000001' AND s.left_at IS NULL;
CREATE TEMP TABLE native_normal_terminal_authority_events (
 action text NOT NULL, capability jsonb NOT NULL
) ON COMMIT DROP;
CREATE FUNCTION pg_temp.normal_terminal_authority_observer() RETURNS trigger
LANGUAGE plpgsql AS $observer$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.tournament_id='98510000-0000-0000-0000-000000000001' THEN
   INSERT INTO native_normal_terminal_authority_events VALUES ('INSERT',to_jsonb(NEW));
  END IF;
  RETURN NEW;
 END IF;
 IF OLD.tournament_id='98510000-0000-0000-0000-000000000001' THEN
  INSERT INTO native_normal_terminal_authority_events VALUES ('DELETE',to_jsonb(OLD));
 END IF;
 RETURN OLD;
END $observer$;
CREATE TRIGGER native_normal_terminal_authority_observer
AFTER INSERT OR DELETE ON public.tournament_seat_exit_authorizations
FOR EACH ROW EXECUTE FUNCTION pg_temp.normal_terminal_authority_observer();

CREATE FUNCTION pg_temp.assert_normal_terminal_authority() RETURNS void
LANGUAGE plpgsql AS $assert_authority$
BEGIN
 IF (SELECT count(*) FROM native_normal_terminal_authority_events WHERE action='INSERT')<>(SELECT count(*) FROM native_normal_terminal_expected_seats)
  OR (SELECT count(*) FROM native_normal_terminal_authority_events WHERE action='DELETE')<>(SELECT count(*) FROM native_normal_terminal_expected_seats)
  OR (SELECT count(DISTINCT capability->>'token') FROM native_normal_terminal_authority_events)<>LEAST((SELECT count(*) FROM native_normal_terminal_expected_seats),1)
  OR EXISTS(SELECT 1 FROM native_normal_terminal_authority_events e
   WHERE e.capability->>'operation'<>'terminal_finish'
    OR e.capability->>'tournament_id'<>'98510000-0000-0000-0000-000000000001'
    OR NOT EXISTS(SELECT 1 FROM native_normal_terminal_expected_seats s
      WHERE s.seat_id=(e.capability->>'seat_id')::uuid
       AND s.user_id=(e.capability->>'user_id')::uuid
       AND s.tournament_id=(e.capability->>'tournament_id')::uuid))
  OR EXISTS(SELECT capability FROM native_normal_terminal_authority_events WHERE action='INSERT'
            EXCEPT ALL SELECT capability FROM native_normal_terminal_authority_events WHERE action='DELETE')
  OR EXISTS(SELECT 1 FROM public.tournament_seat_exit_authorizations
            WHERE tournament_id='98510000-0000-0000-0000-000000000001')
 THEN RAISE EXCEPTION 'FAIL exact per-seat authority rows were not minted and consumed'; END IF;
END $assert_authority$;



CREATE FUNCTION pg_temp.normal_terminal_state() RETURNS jsonb LANGUAGE plpgsql AS $state$
DECLARE result jsonb:='{}'::jsonb; item jsonb; table_name text;
BEGIN
 FOREACH table_name IN ARRAY ARRAY['tournaments','tournament_players','tables','table_seats',
 'clubs','club_wallets','union_wallets','union_wallet_transactions','club_members','wallets','wallet_transactions','wallet_credit_idempotency','chip_ledger',
 'tournament_escrow','tournament_obligations','tournament_payouts',
 'tournament_guarantee_overlays','managed_game_contract_versions','tournament_place_settlement_batches','tournament_final_table_deal_batches','tournament_final_table_deal_receipts',
 'tournament_finish_receipts','tournament_terminal_settlements',
 'tournament_rake_settlements','rake_records','rake_attributions','agent_commissions',
 'player_stats','vip_points_carry','tournament_seat_exit_authorizations',
 'tournament_deal_reviews','tournament_deal_proposals','tournament_deal_proposal_consents',
 'tournament_deal_proposal_executions']
 LOOP
  EXECUTE format('SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),''[]''::jsonb) FROM public.%I t',table_name) INTO item;
  result:=result||jsonb_build_object(table_name,item);
 END LOOP;
 RETURN result||jsonb_build_object('observed_seat_authority',
  (SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb)
   FROM native_normal_terminal_authority_events t));
END $state$;

DO $promise$
DECLARE before_state jsonb; command text; refused boolean; result jsonb;
BEGIN
 PERFORM pg_temp.normal_assert(current_setting('session_replication_role')='origin'
  AND (SELECT count(*) FROM native_normal_promise)=1
  AND (SELECT (contract->>'guaranteed_prize')::numeric FROM native_normal_promise)=(SELECT pool FROM native_normal_config)
  AND (SELECT contract_hash=public.fn_managed_game_contract_hash(contract) FROM native_normal_promise),
  'actual capture persists one exact hash of the host guarantee and sparse ladder');
 PERFORM set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000001',true);
 FOREACH command IN ARRAY ARRAY[
  $q$UPDATE public.tournaments SET guaranteed_prize=guaranteed_prize+1 WHERE id='98510000-0000-0000-0000-000000000001'$q$,
  $q$UPDATE public.tournaments SET payout_structure='[{"place":1,"percentage":100}]' WHERE id='98510000-0000-0000-0000-000000000001'$q$,
  $q$UPDATE public.managed_game_contract_versions SET contract='{}'::jsonb WHERE game_kind='tournament' AND game_id='98510000-0000-0000-0000-000000000001'$q$
 ] LOOP
  before_state:=pg_temp.normal_terminal_state(); refused:=false;
  BEGIN EXECUTE command;
  EXCEPTION WHEN check_violation OR SQLSTATE '55000' THEN
   IF lower(SQLERRM) !~ '(contract|guarantee|payout|frozen|immutable|registered)' THEN RAISE; END IF;
   refused:=true;
  END;
  PERFORM pg_temp.normal_assert(refused AND pg_temp.normal_terminal_state() IS NOT DISTINCT FROM before_state,
   'operator-context promise mutation is refused with exact rollback: '||split_part(command,' SET ',2));
 END LOOP;
 PERFORM set_config('request.jwt.claim.sub','',true);
 result:=public.fn_claim_tournament_finish('98510000-0000-0000-0000-000000000001',
  md5('normal-overlay-user:1')::uuid,'native-normal-overlay-proof');
 PERFORM pg_temp.normal_assert(result->>'ok'='true' AND result->>'status'='COMPLETING',
  'genuine finish claim records the sole observed winner');
END $promise$;

CREATE FUNCTION pg_temp.assert_normal_completed() RETURNS void LANGUAGE plpgsql AS $complete$
DECLARE tid uuid:='98510000-0000-0000-0000-000000000001'; config record;
BEGIN
 SELECT * INTO STRICT config FROM native_normal_config;
 PERFORM pg_temp.normal_assert((SELECT status='COMPLETED' AND ended_at IS NOT NULL
  AND prize_pool=config.pool AND guaranteed_prize=config.pool AND prize_pool_finalized
  FROM public.tournaments WHERE id=tid),'actual terminal lifecycle pays the unchanged published prize pool');
 PERFORM pg_temp.normal_assert((SELECT count(*) FROM public.tournament_terminal_settlements WHERE tournament_id=tid)=1
  AND (SELECT count(*) FROM public.tournament_finish_receipts WHERE tournament_id=tid)=1,
  'one real finish claim and one stored terminal settlement exist');
 PERFORM pg_temp.normal_assert((SELECT chip_treasury FROM public.clubs WHERE id='20000000-0000-0000-0000-000000000001')
   =(SELECT chip_treasury FROM native_normal_bank_before)-config.overlay,
  'the house treasury funds exactly the shortfall and no player-funded principal');
 PERFORM pg_temp.normal_assert((SELECT overlay_in=config.overlay AND prize_out=config.pool
  AND prize_balance=0 AND bounty_balance=0 AND fee_balance=0 AND closed_at IS NOT NULL
  AND close_note='terminal receipt: exact zero' FROM public.tournament_escrow WHERE tournament_id=tid),
  'actual overlay enters prize custody once and all three escrow balances close at zero');
 IF config.overlay>0 THEN
  PERFORM pg_temp.normal_assert(EXISTS(SELECT 1 FROM public.tournament_guarantee_overlays
   WHERE tournament_id=tid AND amount=config.overlay AND pool_before=config.entries AND pool_after=config.pool
    AND bank_type='club' AND bank_entity_id='20000000-0000-0000-0000-000000000001'
    AND treasury_after=(SELECT chip_treasury FROM native_normal_bank_before)-config.overlay
    AND terminal_closed_at=(SELECT ended_at FROM public.tournaments WHERE id=tid))
   AND (SELECT count(*) FROM public.chip_ledger WHERE tournament_id=tid
    AND idempotency_key='tourney:'||tid::text||':guarantee_overlay'
    AND from_type='club_treasury' AND from_entity_id='20000000-0000-0000-0000-000000000001'
    AND to_type='prize_liability' AND to_entity_id=tid AND category='overlay' AND amount=config.overlay)=1,
   'one exact independent bank-to-prize-liability journal and immutable overlay receipt exist');
 ELSE
  PERFORM pg_temp.normal_assert(NOT EXISTS(SELECT 1 FROM public.tournament_guarantee_overlays WHERE tournament_id=tid)
   AND NOT EXISTS(SELECT 1 FROM public.chip_ledger WHERE tournament_id=tid AND category='overlay')
   AND NOT EXISTS(SELECT 1 FROM public.tournament_payouts WHERE tournament_id=tid)
   AND NOT EXISTS(SELECT 1 FROM public.tournament_obligations WHERE tournament_id=tid),
   'zero prize completes without an overlay, synthetic debt or zero-value payout rows');
 END IF;
 PERFORM pg_temp.normal_assert(NOT EXISTS(
  SELECT place,amount FROM native_normal_expected
  EXCEPT ALL SELECT place,amount FROM public.fn_ca_tournament_place_amounts(tid))
  AND NOT EXISTS(SELECT place,amount FROM public.fn_ca_tournament_place_amounts(tid)
   EXCEPT ALL SELECT place,amount FROM native_normal_expected),
  'sparse places and independently computed final-cent remainder match the real calculator');
 PERFORM pg_temp.normal_assert(NOT EXISTS(
  SELECT place,user_id,amount FROM native_normal_expected WHERE amount>0
  EXCEPT ALL SELECT position,user_id,amount FROM public.tournament_payouts WHERE tournament_id=tid)
  AND NOT EXISTS(SELECT position,user_id,amount FROM public.tournament_payouts WHERE tournament_id=tid
   EXCEPT ALL SELECT place,user_id,amount FROM native_normal_expected WHERE amount>0)
  AND (SELECT COALESCE(sum(amount),0) FROM public.wallet_transactions WHERE related_entity_id=tid AND type='credit')=config.pool,
  'each real recipient receives exactly its independent expected cents and the full pool is conserved');
 PERFORM pg_temp.normal_assert(NOT EXISTS(SELECT 1 FROM public.tournament_players tp
  LEFT JOIN native_normal_expected e ON e.user_id=tp.user_id
  WHERE tp.tournament_id=tid AND tp.prize IS DISTINCT FROM COALESCE(e.amount,0))
  AND (SELECT prize=0 FROM public.tournament_players WHERE tournament_id=tid AND position=2),
  'the omitted second place gets zero and every final result matches actual entitlement');
 PERFORM pg_temp.normal_assert((public.fn_ca_verify_terminal_place_batch(tid,true)->>'ok')='true'
  AND (SELECT contract_version=2 AND amount_owed=config.pool
   AND place_count=(SELECT count(*) FROM native_normal_expected WHERE amount>0)
   FROM public.tournament_place_settlement_batches WHERE tournament_id=tid),
  'canonical immutable version-two batch proves the complete normal cash plan');
 PERFORM pg_temp.normal_assert((SELECT count(*) FROM public.tables WHERE tournament_id=tid
  AND status='closed' AND lifecycle='closed' AND current_players=0 AND terminal_closed_at IS NOT NULL)=1
  AND NOT EXISTS(SELECT 1 FROM public.table_seats WHERE table_id='98530000-0000-0000-0000-000000000001'
   AND (left_at IS NULL OR status<>'left')),'the actual winner seat and final table close');
 PERFORM pg_temp.assert_normal_terminal_authority();
 PERFORM pg_temp.normal_assert((SELECT count(*) FROM native_normal_terminal_expected_seats)=1,
  'one exact real seat capability is minted and consumed');
 PERFORM pg_temp.normal_assert((SELECT count(*) FROM public.managed_game_contract_versions
  WHERE game_kind='tournament' AND game_id=tid)=1
  AND NOT EXISTS(SELECT contract,contract_hash,version FROM native_normal_promise
   EXCEPT ALL SELECT contract,contract_hash,version FROM public.managed_game_contract_versions
    WHERE game_kind='tournament' AND game_id=tid),
  'settlement preserves the exact published guarantee and ladder version');
END $complete$;

CREATE FUNCTION pg_temp.normal_terminal_receipt_fault() RETURNS trigger LANGUAGE plpgsql AS $fault$
BEGIN
 IF NEW.tournament_id='98510000-0000-0000-0000-000000000001' THEN
  PERFORM pg_temp.assert_normal_completed();
  RAISE EXCEPTION 'expected normal overlay terminal receipt fault' USING ERRCODE='ZX007';
 END IF;
 RETURN NEW;
END $fault$;
CREATE TRIGGER native_normal_terminal_receipt_fault AFTER INSERT ON public.tournament_terminal_settlements
FOR EACH ROW EXECUTE FUNCTION pg_temp.normal_terminal_receipt_fault();
DO $rollback$
DECLARE before_state jsonb:=pg_temp.normal_terminal_state(); refused boolean:=false;
BEGIN
 BEGIN PERFORM public.fn_complete_tournament_terminal('98510000-0000-0000-0000-000000000001',
  md5('normal-overlay-user:1')::uuid,'places');
 EXCEPTION WHEN SQLSTATE 'ZX007' THEN refused:=true; END;
 PERFORM pg_temp.normal_assert(refused,'late fault reaches the real receipt after funding, payment and closure');
 PERFORM pg_temp.normal_assert(pg_temp.normal_terminal_state() IS NOT DISTINCT FROM before_state,
  'late fault rolls back the independent bank debit, overlay, every payment and all lifecycle evidence');
END $rollback$;
DROP TRIGGER native_normal_terminal_receipt_fault ON public.tournament_terminal_settlements;
CREATE TEMP TABLE native_normal_terminal_result(receipt jsonb) ON COMMIT DROP;
DO $settle$
DECLARE result jsonb; replay jsonb; outcome jsonb; before_state jsonb; refused boolean;
BEGIN
 result:=public.fn_complete_tournament_terminal('98510000-0000-0000-0000-000000000001',
  md5('normal-overlay-user:1')::uuid,'places');
 PERFORM pg_temp.normal_assert(result->>'ok'='true' AND result->>'fully_settled'='true'
  AND result->>'status'='COMPLETED','actual normal authority returns its completed stored receipt');
 PERFORM pg_temp.assert_normal_completed();
 before_state:=pg_temp.normal_terminal_state();
 replay:=public.fn_complete_tournament_terminal('98510000-0000-0000-0000-000000000001',
  md5('normal-overlay-user:1')::uuid,'places');
 outcome:=public.fn_resolve_tournament_terminal_outcome('98510000-0000-0000-0000-000000000001',
  md5('normal-overlay-user:1')::uuid,'places');
 PERFORM pg_temp.normal_assert(replay IS NOT DISTINCT FROM result
  AND outcome->>'terminal_committed'='true' AND outcome->>'definitively_not_committed'='false'
  AND outcome->'receipt' IS NOT DISTINCT FROM result
  AND pg_temp.normal_terminal_state() IS NOT DISTINCT FROM before_state,
  'lost-response replay and resolver retain the exact receipt without funding or paying twice');
 IF (SELECT overlay>0 FROM native_normal_config) THEN
  refused:=false;
  BEGIN UPDATE public.tournament_guarantee_overlays SET amount=amount+1
   WHERE tournament_id='98510000-0000-0000-0000-000000000001';
  EXCEPTION WHEN SQLSTATE '55000' THEN
   IF lower(SQLERRM) NOT LIKE '%immutable%' THEN RAISE; END IF;
   refused:=true;
  END;
  PERFORM pg_temp.normal_assert(refused AND pg_temp.normal_terminal_state() IS NOT DISTINCT FROM before_state,
   'settled independent overlay evidence is immutable');
 END IF;
 PERFORM pg_temp.normal_assert(COALESCE(current_setting('app.tournament_seat_exit_token',true),'')=''
  AND COALESCE(current_setting('app.tournament_seat_exit_operation',true),'')='',
  'terminal wrapper restores all prior seat capability settings');
 INSERT INTO native_normal_terminal_result VALUES(result);
END $settle$;
SET CONSTRAINTS ALL IMMEDIATE;
SELECT pg_temp.normal_assert(true,'all deferred constraints forced before rollback');
SELECT 'NORMAL_OVERLAY_NATIVE_EVIDENCE='||jsonb_build_object(
 'variant',(SELECT variant FROM native_normal_config),
 'opening_entry_custody',(SELECT entries FROM native_normal_config),
 'independent_overlay',(SELECT overlay FROM native_normal_config),
 'published_pool',(SELECT pool FROM native_normal_config),
 'expected_payouts',(SELECT jsonb_agg(to_jsonb(e) ORDER BY place) FROM native_normal_expected e),
 'published_promise',(SELECT to_jsonb(p) FROM native_normal_promise p),
 'receipt',(SELECT receipt FROM native_normal_terminal_result),
 'overlay',(SELECT to_jsonb(o) FROM public.tournament_guarantee_overlays o WHERE tournament_id='98510000-0000-0000-0000-000000000001'),
 'batch',(SELECT to_jsonb(b) FROM public.tournament_place_settlement_batches b WHERE tournament_id='98510000-0000-0000-0000-000000000001'),
 'expected_seats',(SELECT count(*) FROM native_normal_terminal_expected_seats),
 'authority_inserts',(SELECT count(*) FROM native_normal_terminal_authority_events WHERE action='INSERT'),
 'authority_deletes',(SELECT count(*) FROM native_normal_terminal_authority_events WHERE action='DELETE'),
 'assertion_count',(SELECT count(*) FROM native_normal_checks),
 'assertions',(SELECT jsonb_agg(label ORDER BY id) FROM native_normal_checks),
 'deferred_constraints_checked',true)::text;
ROLLBACK;
