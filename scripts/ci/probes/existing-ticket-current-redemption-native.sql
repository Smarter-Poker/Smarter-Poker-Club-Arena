-- Existing committed ticket liability, actual current authenticated redemption.
-- Local PostgreSQL only, one outer rollback. This does not call a new issuer.
-- Historical input shape is reused from atomic-satellite-ticket-return.sql:
-- a 200-chip issued noncash liability with matching source award, issue journal
-- and transaction. It does not certify the historical source award execution.
-- Prestart target admission is exercised; late table creation and source terminal
-- completion are separate acceptance cases.
-- No production function is replaced; compose current dependencies beforehand.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout='8s';
SET LOCAL statement_timeout='60s';
DO $local_only$
BEGIN
  IF current_user<>'postgres' OR inet_server_addr() IS NOT NULL THEN
    RAISE EXCEPTION 'existing-ticket probe requires owned local PostgreSQL';
  END IF;
  IF to_regprocedure('public.fn_register_for_tournament_with_ticket(uuid,uuid)') IS NULL
     OR to_regprocedure('public.fn_ca_register_for_tournament_with_ticket_for(uuid,uuid,uuid)') IS NULL
     OR to_regprocedure('public.fn_caller_session_is_live()') IS NULL THEN
    RAISE EXCEPTION 'current authenticated ticket authority is incomplete';
  END IF;
END;
$local_only$;
SET LOCAL session_replication_role=replica;
INSERT INTO auth.users(id) VALUES('2d1cd6c3-5700-4af9-a271-d4863fdab20d') ON CONFLICT(id) DO NOTHING;
INSERT INTO public.users(id,username) VALUES('2d1cd6c3-5700-4af9-a271-d4863fdab20d','smarterpoker') ON CONFLICT(id) DO NOTHING;
INSERT INTO public.clubs(id,club_id,name)
VALUES('e4100000-0000-4000-8000-000000000002',991021,'Existing Ticket Funding Club');
INSERT INTO auth.users(id) VALUES
  ('e4100000-0000-4000-8000-000000000001');
INSERT INTO public.users(id,username) VALUES
  ('e4100000-0000-4000-8000-000000000001','direct_ticket_player_probe');
INSERT INTO public.profiles(id,username) VALUES
  ('e4100000-0000-4000-8000-000000000001','Direct Ticket Player');
INSERT INTO public.club_members(
  club_id,user_id,role,status,chip_balance
) VALUES(
  'e4100000-0000-4000-8000-000000000002',
  'e4100000-0000-4000-8000-000000000001',
  'player','active',0
);
INSERT INTO public.tournaments(
  id,name,buy_in_amount,buy_in_fee,start_time,status,current_players,
  max_players,club_id,prize_pool,total_rake,bounty_pool,
  entry_contract_locked,prize_pool_finalized
) VALUES
  (
    'e4100000-0000-4000-8000-000000000003','Direct Ticket Satellite',
    20,0,now()+interval '1 day','COMPLETED',0,9,
    'e4100000-0000-4000-8000-000000000002',0,0,0,false,true
  ),
  (
    'e4100000-0000-4000-8000-000000000004','Direct Ticket Target',
    180,20,now()+interval '1 day','REGISTERING',0,100,
    'e4100000-0000-4000-8000-000000000002',0,0,0,false,false
  ),
  (
    'e4100000-0000-4000-8000-000000000005','Wrong Ticket Target',
    180,20,now()+interval '1 day','REGISTERING',0,100,
    'e4100000-0000-4000-8000-000000000002',0,0,0,false,false
  );
INSERT INTO public.tournament_escrow(
  tournament_id,gross_in,satellite_fee_in,prize_balance,fee_balance,
  opened_from
) VALUES
  ('e4100000-0000-4000-8000-000000000004',0,0,0,0,
   'direct satellite ticket probe'),
  ('e4100000-0000-4000-8000-000000000005',0,0,0,0,
   'wrong direct satellite ticket target probe');
INSERT INTO public.tournament_satellite_settlements(
  tournament_id,target_id,target_was_missing,target_contract_version,
  winner_id,field_size,advertised_seats,pool,target_buy_in,target_fee,
  ticket_cost,ticket_award_count,seat_count,cash_ticket_count,
  entry_ticket_count,remainder,bubble_user_id,bubble_position,
  source_table_count,source_table_ids,source_seat_count,source_seat_ids,
  released_seat_count,released_seat_ids,source_closed_at,
  source_escrow_closed_at,source_escrow_close_note,settled_at
) VALUES(
  'e4100000-0000-4000-8000-000000000003',
  'e4100000-0000-4000-8000-000000000004',false,NULL,
  'e4100000-0000-4000-8000-000000000001',1,1,200,180,20,
  200,1,0,0,1,0,NULL,NULL,1,
  ARRAY['e4100000-0000-4000-8000-000000000006'::uuid],
  0,ARRAY[]::uuid[],0,ARRAY[]::uuid[],transaction_timestamp(),
  transaction_timestamp(),'direct ticket probe exact zero',
  transaction_timestamp()
);
INSERT INTO public.tournament_payouts(
  id,tournament_id,user_id,"position",amount,source,idempotency_key,paid_at,
  tournament_type,field_size,prize_pool,payout_structure,recorded_by,metadata
) VALUES(
  'e4100000-0000-4000-8000-000000000007',
  'e4100000-0000-4000-8000-000000000003',
  'e4100000-0000-4000-8000-000000000001',1,200,'satellite_ticket',
  'probe:existing-ticket-current',transaction_timestamp(),'SATELLITE',1,200,
  NULL,'probe',jsonb_build_object(
    'delivery_kind','ticket',
    'ticket_id','e4100000-0000-4000-8000-000000000008',
    'satellite_target_id','e4100000-0000-4000-8000-000000000004',
    'wallet_chips_credited',0)
);
INSERT INTO public.tournament_tickets(
  id,club_id,issued_by,holder_id,value,status,note,redemption_mode,
  source_tournament_id,source_satellite_id,source_refund_entitlement_id,
  source_satellite_award_place,entry_prize,entry_bounty,entry_fee,created_at
) VALUES(
  'e4100000-0000-4000-8000-000000000008',
  'e4100000-0000-4000-8000-000000000002',
  '2d1cd6c3-5700-4af9-a271-d4863fdab20d',
  'e4100000-0000-4000-8000-000000000001',200,'issued',
  'Four-Table Cap Satellite Award: Tournament Entry Only',
  'tournament_entry_only','e4100000-0000-4000-8000-000000000004',
  'e4100000-0000-4000-8000-000000000003',NULL,1,180,0,20,
  transaction_timestamp()
);
INSERT INTO public.chip_ledger(
  id,performed_by,from_type,from_entity_id,from_label,to_type,to_entity_id,
  to_label,amount,category,club_id,tournament_id,idempotency_key,
  settlement_id,actor_service,description,metadata,pre_from_balance,
  post_from_balance,pre_to_balance,post_to_balance
) VALUES(
  'e4100000-0000-4000-8000-000000000010',
  '2d1cd6c3-5700-4af9-a271-d4863fdab20d','prize_liability',
  'e4100000-0000-4000-8000-000000000003','tournaments.prize_pool',
  'escrow','e4100000-0000-4000-8000-000000000008',
  'satellite tournament entry ticket',200,'ticket_issue',
  'e4100000-0000-4000-8000-000000000002',
  'e4100000-0000-4000-8000-000000000003',
  'probe:existing-ticket-current:ticket_escrow',
  'satellite-ticket:e4100000-0000-4000-8000-000000000008',
  'fn_settle_satellite_tournament','Direct satellite entry ticket probe',
  jsonb_build_object(
    'kind','direct_satellite_entry_ticket','delivery_kind','ticket',
    'ticket_id','e4100000-0000-4000-8000-000000000008',
    'payout_id','e4100000-0000-4000-8000-000000000007',
    'satellite_id','e4100000-0000-4000-8000-000000000003',
    'satellite_target_id','e4100000-0000-4000-8000-000000000004',
    'user_id','e4100000-0000-4000-8000-000000000001','position',1,
    'entry_prize',180,'entry_bounty',0,'entry_fee',20,
    'wallet_chips_credited',0,'unbacked',0),
  200,0,0,200
);
INSERT INTO public.tournament_satellite_awards(
  tournament_id,place,user_id,delivery_kind,amount,payout_id,payout_source,
  idempotency_key,ticket_id
) VALUES(
  'e4100000-0000-4000-8000-000000000003',1,
  'e4100000-0000-4000-8000-000000000001','ticket',200,
  'e4100000-0000-4000-8000-000000000007','satellite_ticket',
  'probe:existing-ticket-current','e4100000-0000-4000-8000-000000000008'
);
INSERT INTO public.chip_transactions(
  club_id,from_user_id,to_user_id,amount,transaction_type,notes,
  balance_after,metadata
) VALUES(
  'e4100000-0000-4000-8000-000000000002',NULL,
  'e4100000-0000-4000-8000-000000000001',200,
  'tournament_ticket_issue','Direct Satellite Entry Ticket Probe',NULL,
  jsonb_build_object(
    'ticket_id','e4100000-0000-4000-8000-000000000008',
    'escrow_entity_id','e4100000-0000-4000-8000-000000000008',
    'holder_id','e4100000-0000-4000-8000-000000000001','value',200,
    'redemption_mode','tournament_entry_only',
    'source_tournament_id','e4100000-0000-4000-8000-000000000004',
    'source_satellite_id','e4100000-0000-4000-8000-000000000003',
    'source_award_place',1,
    'payout_id','e4100000-0000-4000-8000-000000000007',
    'ledger_id','e4100000-0000-4000-8000-000000000010',
    'idempotency_key','probe:existing-ticket-current',
    'wallet_chips_credited',0)
);

-- Three independent occupants make the capacity refusal a real roster count.
INSERT INTO auth.users(id) SELECT ('e4200000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid FROM generate_series(1,3) n;
INSERT INTO public.users(id,username) SELECT ('e4200000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'existing_ticket_other_'||n FROM generate_series(1,3) n;
INSERT INTO public.profiles(id,username) SELECT ('e4200000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'Existing Ticket Other '||n FROM generate_series(1,3) n;
INSERT INTO public.club_members(club_id,user_id,role,status,chip_balance)
SELECT 'e4100000-0000-4000-8000-000000000002',('e4200000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'player','active',0 FROM generate_series(1,3) n;
INSERT INTO auth.sessions(id,user_id,created_at,updated_at) VALUES
 ('e4300000-0000-4000-8000-000000000001','e4100000-0000-4000-8000-000000000001',now(),now()),
 ('e4300000-0000-4000-8000-000000000002','e4200000-0000-4000-8000-000000000001',now(),now());
SET LOCAL session_replication_role=origin;
CREATE TEMP TABLE existing_ticket_results(name text PRIMARY KEY,value jsonb NOT NULL) ON COMMIT DROP;
GRANT INSERT,SELECT ON existing_ticket_results TO authenticated;

CREATE FUNCTION pg_temp.existing_ticket_state() RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $state$
DECLARE n text; a jsonb; j jsonb:='{}'::jsonb;
BEGIN
  FOREACH n IN ARRAY ARRAY[
    'tournaments','tournament_players','tournament_escrow','club_members',
    'chip_ledger','chip_ledger_idem','wallet_transactions','wallet_credit_idempotency',
    'rake_records','tournament_tickets','tournament_refund_entitlements',
    'tournament_refund_tranches','tournament_ticket_admission_authorizations',
    'chip_transactions','tournament_satellite_settlements','tournament_satellite_awards',
    'tournament_payouts','table_seats','tables'] LOOP
    EXECUTE format('SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY to_jsonb(x)::text),''[]''::jsonb) FROM public.%I x',n) INTO a;
    j:=j||jsonb_build_object(n,a);
  END LOOP;
  RETURN md5(j::text);
END;
$state$;
DO $opening_liability$
DECLARE balance numeric;
BEGIN
  SELECT COALESCE(sum(CASE WHEN l.to_type='escrow' AND l.to_entity_id='e4100000-0000-4000-8000-000000000008' THEN l.amount ELSE 0 END
                   - CASE WHEN l.from_type='escrow' AND l.from_entity_id='e4100000-0000-4000-8000-000000000008' THEN l.amount ELSE 0 END),0)
    INTO balance FROM public.chip_ledger l;
  IF balance IS DISTINCT FROM 200::numeric
     OR NOT EXISTS(SELECT 1 FROM public.tournament_tickets WHERE id='e4100000-0000-4000-8000-000000000008' AND status='issued' AND value=200)
     OR EXISTS(SELECT 1 FROM public.wallet_transactions WHERE user_id='e4100000-0000-4000-8000-000000000001') THEN
    RAISE EXCEPTION 'FAIL historical opening ticket does not hold exactly 200 noncash chips';
  END IF;
END;
$opening_liability$;
CREATE TEMP TABLE existing_ticket_before AS SELECT pg_temp.existing_ticket_state() AS fingerprint;

SELECT set_config('request.jwt.claims',jsonb_build_object(
 'sub','e4200000-0000-4000-8000-000000000001','role','authenticated',
 'session_id','e4300000-0000-4000-8000-000000000002')::text,true);
SET LOCAL ROLE authenticated;
INSERT INTO existing_ticket_results VALUES('wrong_owner',public.fn_register_for_tournament_with_ticket(
 'e4100000-0000-4000-8000-000000000004','e4100000-0000-4000-8000-000000000008'));
RESET ROLE;
DO $wrong_owner$
BEGIN
  IF (SELECT value->>'reason' FROM existing_ticket_results WHERE name='wrong_owner') IS DISTINCT FROM 'ticket_not_owned'
     OR pg_temp.existing_ticket_state() IS DISTINCT FROM (SELECT fingerprint FROM existing_ticket_before) THEN
    RAISE EXCEPTION 'FAIL wrong owner changed an existing ticket or financial state';
  END IF;
  RAISE NOTICE 'AUDIT_TEST_PASS: wrong authenticated owner cannot consume the existing ticket';
END;
$wrong_owner$;

SELECT set_config('request.jwt.claims',jsonb_build_object(
 'sub','e4100000-0000-4000-8000-000000000001','role','authenticated',
 'session_id','e4300000-0000-4000-8000-000000000001')::text,true);
SET LOCAL ROLE authenticated;
DO $wrong_target$
DECLARE refused boolean:=false;
BEGIN
  BEGIN
    PERFORM public.fn_register_for_tournament_with_ticket(
      'e4100000-0000-4000-8000-000000000005','e4100000-0000-4000-8000-000000000008');
  EXCEPTION WHEN SQLSTATE 'P0404' THEN refused:=true;
  END;
  IF NOT refused THEN RAISE EXCEPTION 'FAIL existing direct award ticket entered the wrong target'; END IF;
END;
$wrong_target$;
RESET ROLE;
DO $wrong_target_unchanged$
BEGIN
  IF pg_temp.existing_ticket_state() IS DISTINCT FROM (SELECT fingerprint FROM existing_ticket_before) THEN
    RAISE EXCEPTION 'FAIL wrong target refusal changed financial state';
  END IF;
  RAISE NOTICE 'AUDIT_TEST_PASS: direct historical ticket retains its target identity';
END;
$wrong_target_unchanged$;

SET LOCAL session_replication_role=replica;
INSERT INTO public.tournament_players(tournament_id,user_id,username,chips,status,club_id)
SELECT 'e4100000-0000-4000-8000-000000000004',('e4200000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
 'Capacity Fixture '||n,0,'registered','e4100000-0000-4000-8000-000000000002' FROM generate_series(1,3) n;
UPDATE public.tournaments SET max_players=3,current_players=3 WHERE id='e4100000-0000-4000-8000-000000000004';
SET LOCAL session_replication_role=origin;
UPDATE existing_ticket_before SET fingerprint=pg_temp.existing_ticket_state();
SET LOCAL ROLE authenticated;
INSERT INTO existing_ticket_results VALUES('full_target',public.fn_register_for_tournament_with_ticket(
 'e4100000-0000-4000-8000-000000000004','e4100000-0000-4000-8000-000000000008'));
RESET ROLE;
DO $capacity$
BEGIN
  IF (SELECT value->>'reason' FROM existing_ticket_results WHERE name='full_target') IS DISTINCT FROM 'tournament_full'
     OR pg_temp.existing_ticket_state() IS DISTINCT FROM (SELECT fingerprint FROM existing_ticket_before) THEN
    RAISE EXCEPTION 'FAIL capacity refusal consumed the ticket or moved its funding';
  END IF;
  RAISE NOTICE 'AUDIT_TEST_PASS: a genuinely full roster leaves the issued 200-chip liability intact';
END;
$capacity$;
SET LOCAL session_replication_role=replica;
DELETE FROM public.tournament_players WHERE tournament_id='e4100000-0000-4000-8000-000000000004';
UPDATE public.tournaments SET max_players=100,current_players=0 WHERE id='e4100000-0000-4000-8000-000000000004';
SET LOCAL session_replication_role=origin;
UPDATE existing_ticket_before SET fingerprint=pg_temp.existing_ticket_state();

-- Fail the final receipt only after the actual core consumed the ticket,
-- inserted its entitlement and transferred its complete split into escrow.
CREATE FUNCTION pg_temp.refuse_existing_ticket_final_receipt() RETURNS trigger
LANGUAGE plpgsql AS $final_receipt$
BEGIN
  IF NEW.transaction_type='tournament_ticket_entry'
     AND NEW.metadata->>'ticket_id'='e4100000-0000-4000-8000-000000000008' THEN
    IF NOT EXISTS(SELECT 1 FROM public.tournament_tickets WHERE id='e4100000-0000-4000-8000-000000000008' AND status='redeemed')
       OR NOT EXISTS(SELECT 1 FROM public.tournament_escrow WHERE tournament_id='e4100000-0000-4000-8000-000000000004' AND prize_balance=180 AND bounty_balance=0 AND fee_balance=20)
       OR (SELECT count(*) FROM public.tournament_refund_entitlements WHERE source_ticket_id='e4100000-0000-4000-8000-000000000008' AND gross=200 AND refund_prize=180 AND refund_bounty=0 AND refund_fee=20)<>1
       OR (SELECT count(*) FROM public.chip_ledger WHERE from_type='escrow' AND from_entity_id='e4100000-0000-4000-8000-000000000008' AND category='ticket_redeem' AND amount=200)<>1 THEN
      RAISE EXCEPTION 'FAIL final ticket receipt did not observe the completed funded admission';
    END IF;
    RAISE EXCEPTION 'injected final existing-ticket receipt failure' USING ERRCODE='PZ021';
  END IF;
  RETURN NEW;
END;
$final_receipt$;
CREATE TRIGGER native_existing_ticket_final_receipt BEFORE INSERT ON public.chip_transactions
FOR EACH ROW EXECUTE FUNCTION pg_temp.refuse_existing_ticket_final_receipt();
SET LOCAL ROLE authenticated;
DO $late_failure$
DECLARE refused boolean:=false;
BEGIN
  BEGIN
    PERFORM public.fn_register_for_tournament_with_ticket(
      'e4100000-0000-4000-8000-000000000004','e4100000-0000-4000-8000-000000000008');
  EXCEPTION WHEN SQLSTATE 'PZ021' THEN refused:=true;
  END;
  IF NOT refused THEN RAISE EXCEPTION 'FAIL final ticket receipt was not reached'; END IF;
END;
$late_failure$;
RESET ROLE;
DO $late_failure_unchanged$
BEGIN
  IF pg_temp.existing_ticket_state() IS DISTINCT FROM (SELECT fingerprint FROM existing_ticket_before) THEN
    RAISE EXCEPTION 'FAIL failed redemption did not restore all 19 financial/seat relations';
  END IF;
  RAISE NOTICE 'AUDIT_TEST_PASS: final receipt failure restores the issued liability, wallet, roster, entitlement and escrow';
END;
$late_failure_unchanged$;
DROP TRIGGER native_existing_ticket_final_receipt ON public.chip_transactions;

CREATE TEMP TABLE existing_ticket_issue_before AS
SELECT md5(jsonb_build_object(
 'ticket',(SELECT to_jsonb(t)-'status'-'redeemed_at' FROM public.tournament_tickets t WHERE id='e4100000-0000-4000-8000-000000000008'),
 'issue_ledger',(SELECT to_jsonb(l) FROM public.chip_ledger l WHERE id='e4100000-0000-4000-8000-000000000010'),
 'issue_receipt',(SELECT to_jsonb(t) FROM public.chip_transactions t WHERE transaction_type='tournament_ticket_issue' AND metadata->>'ticket_id'='e4100000-0000-4000-8000-000000000008'))::text) AS fingerprint;
SET LOCAL ROLE authenticated;
INSERT INTO existing_ticket_results VALUES('entry',public.fn_register_for_tournament_with_ticket(
 'e4100000-0000-4000-8000-000000000004','e4100000-0000-4000-8000-000000000008'));
RESET ROLE;
SET CONSTRAINTS ALL IMMEDIATE;
DO $exact_admission$
DECLARE r jsonb:=(SELECT value FROM existing_ticket_results WHERE name='entry'); ticket_balance numeric;
BEGIN
  SELECT COALESCE(sum(CASE WHEN l.to_type='escrow' AND l.to_entity_id='e4100000-0000-4000-8000-000000000008' THEN l.amount ELSE 0 END
                   - CASE WHEN l.from_type='escrow' AND l.from_entity_id='e4100000-0000-4000-8000-000000000008' THEN l.amount ELSE 0 END),0)
    INTO ticket_balance FROM public.chip_ledger l;
  IF ticket_balance IS DISTINCT FROM 0::numeric
     OR (r->>'ok')::boolean IS DISTINCT FROM true OR (r->>'replayed')::boolean IS DISTINCT FROM false
     OR (r->>'ticket_value')::numeric IS DISTINCT FROM 200::numeric
     OR (r->>'wallet_chips_credited')::numeric IS DISTINCT FROM 0::numeric
     OR (r->>'prize_contribution')::numeric IS DISTINCT FROM 180::numeric
     OR (r->>'bounty_contribution')::numeric IS DISTINCT FROM 0::numeric
     OR (r->>'fee_contribution')::numeric IS DISTINCT FROM 20::numeric
     OR NOT EXISTS(SELECT 1 FROM public.tournament_tickets WHERE id='e4100000-0000-4000-8000-000000000008' AND status='redeemed' AND redeemed_at IS NOT NULL)
     OR NOT EXISTS(SELECT 1 FROM public.tournament_refund_entitlements e JOIN public.tournament_players tp ON tp.id=e.registration_id JOIN public.chip_ledger l ON l.id=e.source_ledger_id
          WHERE e.id=(r->>'entitlement_id')::uuid AND tp.id=(r->>'registration_id')::uuid
            AND e.source_ticket_id=(r->>'ticket_id')::uuid AND e.entitlement_kind='tournament_ticket'
            AND e.tournament_id='e4100000-0000-4000-8000-000000000004' AND tp.tournament_id=e.tournament_id
            AND e.user_id='e4100000-0000-4000-8000-000000000001' AND tp.user_id=e.user_id
            AND e.refund_wallet_club_id='e4100000-0000-4000-8000-000000000002' AND tp.club_id=e.refund_wallet_club_id
            AND e.gross=200 AND e.refund_prize=180 AND e.refund_bounty=0 AND e.refund_fee=20
            AND l.from_type='escrow' AND l.from_entity_id=e.source_ticket_id AND l.to_type='prize_liability' AND l.to_entity_id=e.tournament_id AND l.amount=200 AND l.category='ticket_redeem')
     OR (SELECT count(*) FROM public.tournament_players WHERE tournament_id='e4100000-0000-4000-8000-000000000004')<>1
     OR NOT EXISTS(SELECT 1 FROM public.tournaments WHERE id='e4100000-0000-4000-8000-000000000004' AND current_players=1 AND prize_pool=180 AND bounty_pool=0 AND total_rake=20)
     OR NOT EXISTS(SELECT 1 FROM public.tournament_escrow WHERE tournament_id='e4100000-0000-4000-8000-000000000004' AND prize_balance=180 AND bounty_balance=0 AND fee_balance=20)
     OR (SELECT count(*) FROM public.rake_records WHERE tournament_id='e4100000-0000-4000-8000-000000000004' AND rake_amount=20 AND metadata->>'ticket_id'='e4100000-0000-4000-8000-000000000008')<>1
     OR EXISTS(SELECT 1 FROM public.tournament_ticket_admission_authorizations WHERE ticket_id='e4100000-0000-4000-8000-000000000008')
     OR EXISTS(SELECT 1 FROM public.wallet_transactions WHERE user_id='e4100000-0000-4000-8000-000000000001')
     OR (SELECT chip_balance FROM public.club_members WHERE club_id='e4100000-0000-4000-8000-000000000002' AND user_id='e4100000-0000-4000-8000-000000000001') IS DISTINCT FROM 0::numeric
     OR (SELECT count(*) FROM public.chip_transactions WHERE transaction_type='tournament_ticket_entry' AND metadata->>'ticket_id'='e4100000-0000-4000-8000-000000000008')<>1 THEN
    RAISE EXCEPTION 'FAIL existing-ticket admission lost its exact one-time funding or identity: %',r;
  END IF;
  RAISE NOTICE 'AUDIT_TEST_PASS: exactly one historical 200-chip ticket becomes one bound registration with 180 prize and 20 fee, without wallet movement';
END;
$exact_admission$;
UPDATE existing_ticket_before SET fingerprint=pg_temp.existing_ticket_state();
SET LOCAL ROLE authenticated;
INSERT INTO existing_ticket_results VALUES('replay',public.fn_register_for_tournament_with_ticket(
 'e4100000-0000-4000-8000-000000000004','e4100000-0000-4000-8000-000000000008'));
RESET ROLE;
DO $replay$
DECLARE a jsonb:=(SELECT value FROM existing_ticket_results WHERE name='entry'); b jsonb:=(SELECT value FROM existing_ticket_results WHERE name='replay'); issue_now text;
BEGIN
  IF (b->>'ok')::boolean IS DISTINCT FROM true OR (b->>'replayed')::boolean IS DISTINCT FROM true
     OR b->>'ticket_id' IS DISTINCT FROM a->>'ticket_id'
     OR b->>'registration_id' IS DISTINCT FROM a->>'registration_id'
     OR b->>'entitlement_id' IS DISTINCT FROM a->>'entitlement_id'
     OR (b->>'wallet_chips_credited')::numeric IS DISTINCT FROM 0::numeric
     OR pg_temp.existing_ticket_state() IS DISTINCT FROM (SELECT fingerprint FROM existing_ticket_before) THEN
    RAISE EXCEPTION 'FAIL ticket retry consumed funding or changed its registration: %',b;
  END IF;
  SELECT md5(jsonb_build_object(
   'ticket',(SELECT to_jsonb(t)-'status'-'redeemed_at' FROM public.tournament_tickets t WHERE id='e4100000-0000-4000-8000-000000000008'),
   'issue_ledger',(SELECT to_jsonb(l) FROM public.chip_ledger l WHERE id='e4100000-0000-4000-8000-000000000010'),
   'issue_receipt',(SELECT to_jsonb(t) FROM public.chip_transactions t WHERE transaction_type='tournament_ticket_issue' AND metadata->>'ticket_id'='e4100000-0000-4000-8000-000000000008'))::text) INTO issue_now;
  IF issue_now IS DISTINCT FROM (SELECT fingerprint FROM existing_ticket_issue_before) THEN
    RAISE EXCEPTION 'FAIL redemption rewrote historical issue evidence or ticket terms';
  END IF;
  RAISE NOTICE 'AUDIT_TEST_PASS: retry returns the identical ticket, registration and entitlement without another consume; historical issue evidence is unchanged';
END;
$replay$;
ROLLBACK;
SELECT 'EXISTING_TICKET_CURRENT_REDEMPTION_NATIVE_PASS' AS result;
