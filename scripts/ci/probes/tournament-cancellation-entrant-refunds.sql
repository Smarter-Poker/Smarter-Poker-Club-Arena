-- Current-policy, rollback-only cancellation acceptance probe.
-- The 2026-09-10 local mixed-schema attempt did not pass native acceptance.
-- See docs/audits/2026-09-10-entry-refund-cancellation-acceptance-gate.json.
-- This SQL must pass against a complete current dependency graph before release acceptance.
-- One player has two club wallets and buys in at the tournament host club.
-- One player holds a satellite-funded seat and one player redeems a
-- tournament-entry-only ticket; both are returned as entry-only tickets. Fixture-only rows
-- are inserted with triggers disabled, then every operation under test calls
-- the installed production authorities with all production triggers enabled.
\set ON_ERROR_STOP on

BEGIN;

SET LOCAL statement_timeout='60s';
SET LOCAL lock_timeout='8s';

DO $prerequisites$
BEGIN
  IF current_user<>'postgres' OR inet_server_addr() IS NOT NULL
     OR to_regprocedure('public.fn_register_for_tournament_request(uuid,uuid)') IS NULL
     OR to_regprocedure('public.atomic_cancel_tournament(uuid,uuid)') IS NULL
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
  ('d1000000-0000-4000-8000-000000000003'),
  ('2d1cd6c3-5700-4af9-a271-d4863fdab20d')
ON CONFLICT(id) DO NOTHING;

INSERT INTO public.users(id,username)
VALUES
  ('d1000000-0000-4000-8000-000000000001',
   'cancel_cash_entrant_probe'),
  ('d1000000-0000-4000-8000-000000000002',
   'cancel_satellite_entrant_probe'),
  ('d1000000-0000-4000-8000-000000000003',
   'cancel_ticket_entrant_probe'),
  ('2d1cd6c3-5700-4af9-a271-d4863fdab20d','smarterpoker')
ON CONFLICT(id) DO NOTHING;

INSERT INTO public.profiles(id,username,display_name)
VALUES
  ('d1000000-0000-4000-8000-000000000001',
   'cancel_cash_entrant_probe','Cancellation Cash Entrant'),
  ('d1000000-0000-4000-8000-000000000002',
   'cancel_satellite_entrant_probe','Cancellation Satellite Entrant'),
  ('d1000000-0000-4000-8000-000000000003',
   'cancel_ticket_entrant_probe','Cancellation Ticket Entrant')
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
   'player','active',300,clock_timestamp()-interval '1 day'),
  ('d2000000-0000-4000-8000-000000000002',
   'd1000000-0000-4000-8000-000000000003',
   'player','active',400,clock_timestamp()-interval '1 day');

INSERT INTO public.tournaments(
  id,name,buy_in_amount,buy_in_fee,starting_chips,start_time,status,
  current_players,max_players,current_level,club_id,prize_pool,total_rake,
  bounty_pool,entry_contract_locked,is_rebuy,is_reentry,rebuy_levels,
  late_reg_levels,late_reg_mins)
VALUES
  ('d3000000-0000-4000-8000-000000000001',
   'Cancellation Source Satellite',20,0,1000,
   clock_timestamp()-interval '1 hour','RUNNING',0,9,1,
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
  'd1000000-0000-4000-8000-000000000001',now(),now());

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
CREATE TEMP TABLE cancellation_probe_results(
  name text PRIMARY KEY,
  value jsonb NOT NULL
) ON COMMIT DROP;
INSERT INTO cancellation_probe_results(name,value)
VALUES(
  'registration',
  public.fn_register_for_tournament_request(
    'd3000000-0000-4000-8000-000000000002',
    'd4000000-0000-4000-8000-000000000002'));
RESET ROLE;

DO $cash_entry_is_exact$
DECLARE
  v_registration jsonb:=(
    SELECT value FROM cancellation_probe_results WHERE name='registration');
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

-- The non-cash fixtures are the immutable output shapes consumed by the
-- cancellation function: funded prize-liability transfers, roster
-- provenance, target fee records and matching entitlements. The original
-- tournament ticket retains its complete direct-satellite award lineage. This setup is
-- trigger-free so the semantic test isolates cancellation rather than copying
-- or reimplementing its production body.
SET LOCAL session_replication_role=replica;

INSERT INTO public.tournament_satellite_settlements(
  tournament_id,target_id,target_was_missing,target_contract_version,
  winner_id,field_size,advertised_seats,pool,target_buy_in,target_fee,
  ticket_cost,ticket_award_count,seat_count,cash_ticket_count,
  entry_ticket_count,remainder,bubble_user_id,bubble_position,
  source_table_count,source_table_ids,source_seat_count,source_seat_ids,
  released_seat_count,released_seat_ids,source_closed_at,
  source_escrow_closed_at,source_escrow_close_note,settled_at)
VALUES(
  'd3000000-0000-4000-8000-000000000001',
  'd3000000-0000-4000-8000-000000000002',false,NULL,
  'd1000000-0000-4000-8000-000000000003',1,1,100,90,10,
  100,1,0,0,1,0,NULL,NULL,1,
  ARRAY['d9000000-0000-4000-8000-000000000003'::uuid],0,ARRAY[]::uuid[],
  0,ARRAY[]::uuid[],transaction_timestamp(),transaction_timestamp(),
  'cancellation tournament-ticket fixture exact zero',transaction_timestamp());

INSERT INTO public.tournament_payouts(
  id,tournament_id,user_id,"position",amount,source,idempotency_key,paid_at,
  tournament_type,field_size,prize_pool,payout_structure,recorded_by,metadata)
VALUES(
  'd9000000-0000-4000-8000-000000000001',
  'd3000000-0000-4000-8000-000000000001',
  'd1000000-0000-4000-8000-000000000003',1,100,'satellite_ticket',
  'probe:cancellation:tournament-ticket-source',transaction_timestamp(),
  'SATELLITE',1,100,NULL,'probe',jsonb_build_object(
    'delivery_kind','ticket',
    'ticket_id','d9000000-0000-4000-8000-000000000002',
    'satellite_target_id','d3000000-0000-4000-8000-000000000002',
    'wallet_chips_credited',0));

INSERT INTO public.tournament_tickets(
  id,club_id,issued_by,holder_id,value,status,note,redemption_mode,
  source_tournament_id,source_satellite_id,source_refund_entitlement_id,
  source_satellite_award_place,entry_prize,entry_bounty,entry_fee,
  created_at,redeemed_at)
VALUES(
  'd9000000-0000-4000-8000-000000000002',
  'd2000000-0000-4000-8000-000000000002',
  '2d1cd6c3-5700-4af9-a271-d4863fdab20d',
  'd1000000-0000-4000-8000-000000000003',100,'redeemed',
  'Cancellation Tournament Ticket Entrant Source',
  'tournament_entry_only','d3000000-0000-4000-8000-000000000002',
  'd3000000-0000-4000-8000-000000000001',NULL,1,90,0,10,
  transaction_timestamp()-interval '2 days',
  transaction_timestamp()-interval '1 day');

INSERT INTO public.tournament_satellite_awards(
  tournament_id,place,user_id,delivery_kind,amount,payout_id,payout_source,
  idempotency_key,ticket_id)
VALUES(
  'd3000000-0000-4000-8000-000000000001',1,
  'd1000000-0000-4000-8000-000000000003','ticket',100,
  'd9000000-0000-4000-8000-000000000001','satellite_ticket',
  'probe:cancellation:tournament-ticket-source',
  'd9000000-0000-4000-8000-000000000002');

INSERT INTO public.tournament_players(
  id,tournament_id,user_id,username,chips,status,club_id,
  is_satellite_qualifier,source_satellite_id)
VALUES(
  'd5000000-0000-4000-8000-000000000001',
  'd3000000-0000-4000-8000-000000000002',
  'd1000000-0000-4000-8000-000000000002',
  'Cancellation Satellite Entrant',1000,'registered',
  'd2000000-0000-4000-8000-000000000002',true,
  'd3000000-0000-4000-8000-000000000001'),
 (
  'd5000000-0000-4000-8000-000000000002',
  'd3000000-0000-4000-8000-000000000002',
  'd1000000-0000-4000-8000-000000000003',
  'Cancellation Ticket Entrant',1000,'registered',
  'd2000000-0000-4000-8000-000000000002',true,
  'd3000000-0000-4000-8000-000000000001');

INSERT INTO public.chip_ledger(
  id,performed_by,from_type,from_entity_id,to_type,to_entity_id,
  amount,category,club_id,tournament_id,idempotency_key,metadata)
VALUES(
  'd6000000-0000-4000-8000-000000000001',
  '2d1cd6c3-5700-4af9-a271-d4863fdab20d',
  'prize_liability','d3000000-0000-4000-8000-000000000001',
  'prize_liability','d3000000-0000-4000-8000-000000000002',
  100,'tournament_buyin','d2000000-0000-4000-8000-000000000002',
  'd3000000-0000-4000-8000-000000000001',
  'tourney:d3000000-0000-4000-8000-000000000001:seat:'
    ||'d1000000-0000-4000-8000-000000000002:pool_transfer',
  jsonb_build_object(
    'kind','satellite_seat_pool_transfer','entry_split_version',2,
    'entry_prize',90,'entry_bounty',0,'entry_fee',10,
    'satellite_id','d3000000-0000-4000-8000-000000000001',
    'satellite_target_id','d3000000-0000-4000-8000-000000000002',
    'user_id','d1000000-0000-4000-8000-000000000002',
    'registration_id','d5000000-0000-4000-8000-000000000001',
    'seat_value',100,'moved',100,'unbacked',0)),
 (
  'd6000000-0000-4000-8000-000000000002',
  '2d1cd6c3-5700-4af9-a271-d4863fdab20d',
  'escrow','d9000000-0000-4000-8000-000000000002',
  'prize_liability','d3000000-0000-4000-8000-000000000002',
  100,'ticket_redeem','d2000000-0000-4000-8000-000000000002',
  'd3000000-0000-4000-8000-000000000002',
  'probe:cancellation:tournament-ticket-redemption',
  jsonb_build_object(
    'kind','tournament_ticket_entry','entry_split_version',2,
    'entry_prize',90,'entry_bounty',0,'entry_fee',10,
    'ticket_id','d9000000-0000-4000-8000-000000000002',
    'user_id','d1000000-0000-4000-8000-000000000003',
    'registration_id','d5000000-0000-4000-8000-000000000002'));

INSERT INTO public.tournament_refund_entitlements(
  id,tournament_id,user_id,entitlement_kind,charge_category,
  refund_wallet_club_id,gross,refund_prize,refund_bounty,refund_fee,
  source_ledger_id,registration_id,source_satellite_id,source_award_place,
  source_ticket_id,escrow_bucket,evidence_kind)
VALUES(
  'd7000000-0000-4000-8000-000000000001',
  'd3000000-0000-4000-8000-000000000002',
  'd1000000-0000-4000-8000-000000000002',
  'satellite_seat','satellite_seat',
  'd2000000-0000-4000-8000-000000000002',
  100,90,0,10,'d6000000-0000-4000-8000-000000000001',
  'd5000000-0000-4000-8000-000000000001',
  'd3000000-0000-4000-8000-000000000001',1,
  NULL,'satellite_gross','atomic_satellite_seat'),
 (
  'd7000000-0000-4000-8000-000000000002',
  'd3000000-0000-4000-8000-000000000002',
  'd1000000-0000-4000-8000-000000000003',
  'tournament_ticket','tournament_ticket',
  'd2000000-0000-4000-8000-000000000002',
  100,90,0,10,'d6000000-0000-4000-8000-000000000002',
  'd5000000-0000-4000-8000-000000000002',
  'd3000000-0000-4000-8000-000000000001',NULL,
  'd9000000-0000-4000-8000-000000000002',
  'ticket_gross','atomic_tournament_ticket');

INSERT INTO public.rake_records(
  id,club_id,rake_amount,pot_size,num_players,is_tournament,tournament_id,
  source,metadata)
VALUES(
  'd8000000-0000-4000-8000-000000000001',
  'd2000000-0000-4000-8000-000000000002',10,100,1,true,
  'd3000000-0000-4000-8000-000000000002','fn_award_satellite_seat',
  jsonb_build_object(
    'kind','satellite_seat_entry_fee','entry_split_version',2,
    'user_id','d1000000-0000-4000-8000-000000000002',
    'satellite_id','d3000000-0000-4000-8000-000000000001',
    'registration_id','d5000000-0000-4000-8000-000000000001')),
 (
  'd8000000-0000-4000-8000-000000000002',
  'd2000000-0000-4000-8000-000000000002',10,100,1,true,
  'd3000000-0000-4000-8000-000000000002','fn_redeem_tournament_ticket',
  jsonb_build_object(
    'kind','tournament_ticket_entry_fee','entry_split_version',2,
    'user_id','d1000000-0000-4000-8000-000000000003',
    'ticket_id','d9000000-0000-4000-8000-000000000002',
    'registration_id','d5000000-0000-4000-8000-000000000002'));

UPDATE public.tournaments
   SET current_players=3,prize_pool=270,total_rake=30
 WHERE id='d3000000-0000-4000-8000-000000000002';

UPDATE public.tournament_escrow
   SET gross_in=290,fee_entries_in=20,satellite_fee_in=10,
       bounty_in=0,satellite_in=0,
       prize_balance=270,bounty_balance=0,fee_balance=30,
       updated_at=clock_timestamp()
 WHERE tournament_id='d3000000-0000-4000-8000-000000000002';

SET LOCAL session_replication_role=origin;

-- Cancellation is an engine command. Remove the player's earlier request
-- identity and run the installed service authority twice with the same
-- tournament command identity. The second call must be a byte-identical
-- durable receipt read, not a compensating write or reconciliation pass.
SELECT set_config('request.jwt.claims','{"role":"service_role"}',true);
SELECT set_config('request.jwt.claim.sub','',true);
SELECT set_config('request.jwt.claim.role','service_role',true);

INSERT INTO cancellation_probe_results(name,value)
VALUES(
  'first_cancellation',
  public.atomic_cancel_tournament(
    'd3000000-0000-4000-8000-000000000002',NULL));

INSERT INTO cancellation_probe_results(name,value)
VALUES(
  'same_command_replay',
  public.atomic_cancel_tournament(
    'd3000000-0000-4000-8000-000000000002',NULL));

INSERT INTO cancellation_probe_results(name,value)
VALUES(
  'durable_verifier',
  public.fn_ca_tournament_cancellation_receipt(
    'd3000000-0000-4000-8000-000000000002',NULL));

-- Force the deferred parent invariant now. ROLLBACK alone would otherwise
-- discard it before commit-time execution.
SET CONSTRAINTS tournaments_cancel_must_refund IMMEDIATE;

DO $assert_exact_cancellation$
DECLARE
  v_target constant uuid:='d3000000-0000-4000-8000-000000000002';
  v_cash_user constant uuid:='d1000000-0000-4000-8000-000000000001';
  v_sat_user constant uuid:='d1000000-0000-4000-8000-000000000002';
  v_ticket_user constant uuid:='d1000000-0000-4000-8000-000000000003';
  v_funding_club constant uuid:='d2000000-0000-4000-8000-000000000001';
  v_fee_club constant uuid:='d2000000-0000-4000-8000-000000000002';
  v_first jsonb:=(
    SELECT value FROM cancellation_probe_results
     WHERE name='first_cancellation');
  v_replay jsonb:=(
    SELECT value FROM cancellation_probe_results
     WHERE name='same_command_replay');
  v_verified jsonb:=(
    SELECT value FROM cancellation_probe_results
     WHERE name='durable_verifier');
  v_receipt public.tournament_cancellation_receipts%ROWTYPE;
BEGIN
  SELECT * INTO STRICT v_receipt
    FROM public.tournament_cancellation_receipts r
   WHERE r.tournament_id=v_target;

  IF v_replay IS DISTINCT FROM v_first
     OR v_verified IS DISTINCT FROM v_first
     OR COALESCE((v_first->>'ok')::boolean,false) IS NOT TRUE
     OR COALESCE((v_first->>'success')::boolean,false) IS NOT TRUE
     OR COALESCE((v_first->>'fully_settled')::boolean,false) IS NOT TRUE
     OR v_first->>'status' IS DISTINCT FROM 'CANCELLED'
     OR (v_first->>'source_player_count')::integer IS DISTINCT FROM 3
     OR (v_first->>'refunded_count')::integer IS DISTINCT FROM 3
     OR (v_first->>'refund_line_count')::integer IS DISTINCT FROM 1
     OR (v_first->>'ticket_return_count')::integer IS DISTINCT FROM 2
     OR (v_first->>'total_refunded')::numeric IS DISTINCT FROM 100::numeric
     OR (v_first->>'total_ticket_returned')::numeric
          IS DISTINCT FROM 200::numeric
     OR (v_first->>'fees_reversed')::numeric IS DISTINCT FROM 30::numeric
     OR v_receipt.receipt IS DISTINCT FROM v_first
     OR v_receipt.source_player_count IS DISTINCT FROM 3
     OR v_receipt.refund_line_count IS DISTINCT FROM 1
     OR v_receipt.ticket_return_count IS DISTINCT FROM 2
     OR v_receipt.total_refunded IS DISTINCT FROM 100::numeric
     OR v_receipt.total_ticket_returned IS DISTINCT FROM 200::numeric
     OR v_receipt.fees_reversed IS DISTINCT FROM 30::numeric
     OR v_receipt.total_rake_before IS DISTINCT FROM 30::numeric
     OR v_receipt.total_rake_after IS DISTINCT FROM 0::numeric
     OR cardinality(v_receipt.fee_reversal_ids)<>3
     OR (SELECT count(*) FROM public.tournament_cancellation_receipts r
          WHERE r.tournament_id=v_target)<>1
     OR (SELECT count(*) FROM public.tournament_refund_tranches tr
          WHERE tr.tournament_id=v_target)<>1
     OR (SELECT count(*) FROM public.wallet_transactions w
          WHERE w.related_entity_id=v_target AND w.type='credit'
            AND lower(w.category) IN ('refund','tournament_refund'))<>1
     OR (SELECT count(*) FROM public.wallet_transactions w
          WHERE w.related_entity_id=v_target AND w.type='credit'
            AND w.user_id=v_cash_user AND w.amount=100)<>1
     OR EXISTS(SELECT 1 FROM public.wallet_transactions w
        WHERE w.related_entity_id=v_target AND w.type='credit'
          AND w.user_id IN (v_sat_user,v_ticket_user))
     OR EXISTS(SELECT 1 FROM public.tournament_refund_tranches tr
        WHERE tr.tournament_id=v_target
          AND tr.user_id IN (v_sat_user,v_ticket_user))
     OR (SELECT chip_balance FROM public.club_members
          WHERE club_id=v_funding_club AND user_id=v_cash_user)
          IS DISTINCT FROM 1000::numeric
     OR (SELECT chip_balance FROM public.club_members
          WHERE club_id=v_fee_club AND user_id=v_cash_user)
          IS DISTINCT FROM 200::numeric
     OR (SELECT chip_balance FROM public.club_members
          WHERE club_id=v_fee_club AND user_id=v_sat_user)
          IS DISTINCT FROM 300::numeric
     OR (SELECT chip_balance FROM public.club_members
          WHERE club_id=v_fee_club AND user_id=v_ticket_user)
          IS DISTINCT FROM 400::numeric
     OR (SELECT count(*) FROM public.tournament_tickets tk
          WHERE tk.source_tournament_id=v_target
            AND tk.source_satellite_id=
                  'd3000000-0000-4000-8000-000000000001'
            AND tk.source_refund_entitlement_id=
                  'd7000000-0000-4000-8000-000000000001'
            AND tk.holder_id=v_sat_user
            AND tk.status='issued'
            AND tk.redemption_mode='tournament_entry_only'
            AND tk.value=100 AND tk.entry_prize=90
            AND tk.entry_bounty=0 AND tk.entry_fee=10)<>1
     OR (SELECT count(*) FROM public.tournament_tickets tk
          WHERE tk.source_tournament_id=v_target
            AND tk.source_satellite_id=
                  'd3000000-0000-4000-8000-000000000001'
            AND tk.source_refund_entitlement_id=
                  'd7000000-0000-4000-8000-000000000002'
            AND tk.holder_id=v_ticket_user
            AND tk.status='issued'
            AND tk.redemption_mode='tournament_entry_only'
            AND tk.value=100 AND tk.entry_prize=90
            AND tk.entry_bounty=0 AND tk.entry_fee=10)<>1
     OR NOT EXISTS(
       SELECT 1 FROM public.tournament_tickets tk
        WHERE tk.id='d9000000-0000-4000-8000-000000000002'
          AND tk.holder_id=v_ticket_user AND tk.status='redeemed'
          AND tk.source_tournament_id=v_target
          AND tk.source_satellite_id=
                'd3000000-0000-4000-8000-000000000001'
          AND tk.source_refund_entitlement_id IS NULL
          AND tk.source_satellite_award_place=1
          AND tk.redemption_mode='tournament_entry_only'
          AND tk.value=100 AND tk.entry_prize=90
          AND tk.entry_bounty=0 AND tk.entry_fee=10)
     OR (SELECT count(*) FROM public.chip_ledger l
          WHERE l.tournament_id=v_target AND l.amount=100
            AND l.category='ticket_issue'
            AND l.from_type='prize_liability'
            AND l.from_entity_id=v_target
            AND l.to_type='escrow'
            AND l.idempotency_key='tourney:'||v_target::text
                  ||':satellite-ticket-return:'
                  ||'d7000000-0000-4000-8000-000000000001')<>1
     OR (SELECT count(*) FROM public.chip_ledger l
          WHERE l.tournament_id=v_target AND l.amount=100
            AND l.category='ticket_issue'
            AND l.from_type='prize_liability'
            AND l.from_entity_id=v_target
            AND l.to_type='escrow'
            AND l.idempotency_key='tourney:'||v_target::text
                  ||':satellite-ticket-return:'
                  ||'d7000000-0000-4000-8000-000000000002')<>1
     OR (SELECT count(*) FROM public.chip_transactions ct
          WHERE ct.transaction_type='tournament_ticket_issue'
            AND ct.to_user_id=v_sat_user AND ct.amount=100
            AND ct.metadata->>'entitlement_id'=
                  'd7000000-0000-4000-8000-000000000001')<>1
     OR (SELECT count(*) FROM public.chip_transactions ct
          WHERE ct.transaction_type='tournament_ticket_issue'
            AND ct.to_user_id=v_ticket_user AND ct.amount=100
            AND ct.metadata->>'entitlement_id'=
                  'd7000000-0000-4000-8000-000000000002')<>1
     OR (SELECT count(*) FROM public.rake_records r
          WHERE r.tournament_id=v_target
            AND r.source='atomic_cancel_tournament'
            AND r.rake_amount=-10
            AND r.club_id=v_fee_club
            AND r.metadata->>'kind'='tournament_fee_refund')<>3
     OR EXISTS(
       SELECT 1 FROM public.rake_records r
        WHERE r.tournament_id=v_target AND r.rake_amount<0
          AND r.club_id<>v_fee_club)
     OR NOT EXISTS(
       SELECT 1 FROM public.wallet_transactions w
        JOIN public.tournament_refund_tranches tr
          ON tr.wallet_transaction_id=w.id
        JOIN public.chip_ledger l ON l.id=tr.credit_ledger_id
       WHERE w.related_entity_id=v_target AND w.user_id=v_cash_user
         AND w.type='credit' AND w.amount=100
         AND tr.source_wallet_club_id=v_fee_club
         AND tr.refund_prize=90 AND tr.refund_bounty=0 AND tr.refund_fee=10
         AND l.club_id=v_fee_club
         AND l.from_type='prize_liability' AND l.from_entity_id=v_target
         AND l.to_type='player_wallet' AND l.to_entity_id=v_cash_user
         AND l.amount=100)
     OR NOT EXISTS(
       SELECT 1 FROM public.tournaments t
        WHERE t.id=v_target AND t.status='CANCELLED'
          AND t.current_players=0 AND t.prize_pool=0
          AND t.bounty_pool=0 AND t.total_rake=0)
     OR NOT EXISTS(
       SELECT 1 FROM public.tournament_escrow e
        WHERE e.tournament_id=v_target AND e.closed_at IS NOT NULL
          AND e.prize_balance=0 AND e.bounty_balance=0 AND e.fee_balance=0)
     OR EXISTS(
       SELECT 1 FROM public.tournament_players tp
        WHERE tp.tournament_id=v_target
          AND (tp.status<>'eliminated' OR tp.chips<>0)) THEN
    RAISE EXCEPTION
      'FAIL entrant cancellation did not return cash, satellite and tournament-ticket funding on their exact rails: %',
      v_first;
  END IF;

  RAISE NOTICE
    'AUDIT_TEST_PASS: cancellation returned the cash entrant exactly 100 chips to its recorded source wallet, returned both the satellite-seat-funded and tournament-ticket-funded entrants exactly one 100-chip entry-only ticket and no wallet chips, reversed all three 10 fees only at the actual fee recipient, stored one exact receipt, and same-command replay returned identical bytes without duplicate money';
END;
$assert_exact_cancellation$;

-- Every durable source read by replay is protected at write time. A direct
-- superuser mutation is useful here because it proves trigger-enforced
-- immutability instead of relying on application ACLs or a later watcher.
DO $immutable_evidence$
DECLARE
  v_receipt public.tournament_cancellation_receipts%ROWTYPE;
  v_receipt_blocked boolean:=false;
  v_source_rake_blocked boolean:=false;
  v_reversal_rake_blocked boolean:=false;
  v_wallet_blocked boolean:=false;
  v_parent_blocked boolean:=false;
  v_wallet_id uuid;
  v_cash_rake_id uuid;
BEGIN
  SELECT * INTO STRICT v_receipt
    FROM public.tournament_cancellation_receipts r
   WHERE r.tournament_id='d3000000-0000-4000-8000-000000000002';
  SELECT w.id INTO STRICT v_wallet_id
    FROM public.wallet_transactions w
   WHERE w.related_entity_id=v_receipt.tournament_id AND w.type='credit'
     AND w.user_id='d1000000-0000-4000-8000-000000000001';
  SELECT r.id INTO STRICT v_cash_rake_id
    FROM public.rake_records r
   WHERE r.tournament_id=v_receipt.tournament_id AND r.rake_amount>0
     AND r.metadata->>'user_id'='d1000000-0000-4000-8000-000000000001';

  BEGIN
    UPDATE public.tournament_cancellation_receipts
       SET receipt=receipt WHERE tournament_id=v_receipt.tournament_id;
  EXCEPTION WHEN SQLSTATE '55000' THEN
    v_receipt_blocked:=true;
  END;
  BEGIN
    UPDATE public.rake_records
       SET metadata=metadata||jsonb_build_object('_probe_mutation',true)
     WHERE id=v_cash_rake_id;
  EXCEPTION WHEN SQLSTATE '55000' THEN
    v_source_rake_blocked:=true;
  END;
  BEGIN
    DELETE FROM public.rake_records
     WHERE id=v_receipt.fee_reversal_ids[1];
  EXCEPTION WHEN SQLSTATE '55000' THEN
    v_reversal_rake_blocked:=true;
  END;
  BEGIN
    UPDATE public.wallet_transactions
       SET description=description WHERE id=v_wallet_id;
  EXCEPTION WHEN SQLSTATE '55000' THEN
    v_wallet_blocked:=true;
  END;
  BEGIN
    UPDATE public.tournaments
       SET prize_pool=prize_pool WHERE id=v_receipt.tournament_id;
  EXCEPTION WHEN SQLSTATE '55000' THEN
    v_parent_blocked:=true;
  END;

  IF NOT v_receipt_blocked OR NOT v_source_rake_blocked
     OR NOT v_reversal_rake_blocked OR NOT v_wallet_blocked
     OR NOT v_parent_blocked THEN
    RAISE EXCEPTION
      'FAIL cancellation evidence was mutable (receipt %, source rake %, reversal %, wallet %, parent %)',
      v_receipt_blocked,v_source_rake_blocked,v_reversal_rake_blocked,
      v_wallet_blocked,v_parent_blocked;
  END IF;

  RAISE NOTICE
    'AUDIT_TEST_PASS: cancellation receipt, positive fee source, negative fee reversal, exact wallet credit and terminal tournament row all reject direct mutation at the database root';
END;
$immutable_evidence$;

ROLLBACK;

SELECT 'TOURNAMENT_CANCELLATION_ENTRANT_REFUNDS_PASS' AS result;
