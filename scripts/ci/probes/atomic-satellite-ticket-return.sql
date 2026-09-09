-- Local PostgreSQL rehearsal for the satellite-entry refund contract.
-- It seeds one exact target seat while trigger execution is disabled, then
-- runs only the installed production authorities with every trigger enabled.
-- All fixture rows and the temporary auth helpers are rolled back.

BEGIN;

CREATE OR REPLACE FUNCTION auth.uid()
RETURNS uuid
LANGUAGE sql
STABLE
AS $probe_auth$
  SELECT nullif(current_setting('test.actor',true),'')::uuid
$probe_auth$;

CREATE OR REPLACE FUNCTION auth.role()
RETURNS text
LANGUAGE sql
STABLE
AS $probe_auth$
  SELECT 'service_role'::text
$probe_auth$;

SET LOCAL session_replication_role=replica;

INSERT INTO auth.users(id) VALUES
  ('11111111-1111-4111-8111-111111111111'),
  ('2d1cd6c3-5700-4af9-a271-d4863fdab20d')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.users(id,username) VALUES
  ('11111111-1111-4111-8111-111111111111','ticket_player_probe'),
  ('2d1cd6c3-5700-4af9-a271-d4863fdab20d','smarterpoker')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.profiles(id,username) VALUES
  ('11111111-1111-4111-8111-111111111111','Ticket Player'),
  ('2d1cd6c3-5700-4af9-a271-d4863fdab20d','smarterpoker');

INSERT INTO public.clubs(id,club_id,name) VALUES
  ('22222222-2222-4222-8222-222222222222',98765,'Ticket Club');

INSERT INTO public.club_members(
  club_id,user_id,role,status,chip_balance
) VALUES(
  '22222222-2222-4222-8222-222222222222',
  '11111111-1111-4111-8111-111111111111',
  'player','active',0
);

INSERT INTO public.tournaments(
  id,name,buy_in_amount,buy_in_fee,start_time,status,current_players,
  max_players,club_id,prize_pool,total_rake,bounty_pool,
  entry_contract_locked
) VALUES
  (
    '33333333-3333-4333-8333-333333333333','Source Satellite',
    20,0,now()+interval '1 day','COMPLETED',0,9,
    '22222222-2222-4222-8222-222222222222',0,0,0,false
  ),
  (
    '44444444-4444-4444-8444-444444444444','Target Tournament',
    180,20,now()+interval '1 day','REGISTERING',1,100,
    '22222222-2222-4222-8222-222222222222',180,20,0,true
  ),
  (
    '88888888-8888-4888-8888-888888888888','Free Tournament',
    0,0,now()+interval '1 day','REGISTERING',0,100,
    '22222222-2222-4222-8222-222222222222',0,0,0,false
  );

-- The immutable-provenance guard recognizes terminal state only through a
-- committed receipt. Seed the exact source receipt so the negative DELETE
-- probes below exercise the production guard rather than an impossible
-- status-only historical row.
INSERT INTO public.tournament_satellite_settlements(
  tournament_id,target_id,target_was_missing,target_contract_version,
  winner_id,field_size,advertised_seats,pool,target_buy_in,target_fee,
  ticket_cost,ticket_award_count,seat_count,cash_ticket_count,
  entry_ticket_count,remainder,bubble_user_id,bubble_position,
  source_table_count,source_table_ids,source_seat_count,source_seat_ids,
  released_seat_count,released_seat_ids,source_closed_at,
  source_escrow_closed_at,source_escrow_close_note,settled_at
) VALUES(
  '33333333-3333-4333-8333-333333333333',
  '44444444-4444-4444-8444-444444444444',false,NULL,
  '11111111-1111-4111-8111-111111111111',1,1,200,180,20,
  200,1,1,0,0,0,NULL,NULL,1,
  ARRAY['32333333-3333-4333-8333-333333333333'::uuid],
  0,ARRAY[]::uuid[],0,ARRAY[]::uuid[],transaction_timestamp(),
  transaction_timestamp(),'ticket-return source receipt exact zero',
  transaction_timestamp()
);

INSERT INTO public.tournament_escrow(
  tournament_id,gross_in,satellite_fee_in,prize_balance,fee_balance,
  opened_from
) VALUES(
  '44444444-4444-4444-8444-444444444444',180,20,180,20,
  'satellite ticket-return probe'
);

INSERT INTO public.tournament_players(
  id,tournament_id,user_id,username,chips,status,club_id,
  is_satellite_qualifier,source_satellite_id
) VALUES(
  '55555555-5555-4555-8555-555555555555',
  '44444444-4444-4444-8444-444444444444',
  '11111111-1111-4111-8111-111111111111',
  'Ticket Player',10000,'registered',
  '22222222-2222-4222-8222-222222222222',true,
  '33333333-3333-4333-8333-333333333333'
);

INSERT INTO public.chip_ledger(
  id,performed_by,from_type,from_entity_id,to_type,to_entity_id,
  amount,category,club_id,tournament_id,idempotency_key,metadata
) VALUES(
  '66666666-6666-4666-8666-666666666666',
  '2d1cd6c3-5700-4af9-a271-d4863fdab20d',
  'prize_liability','33333333-3333-4333-8333-333333333333',
  'prize_liability','44444444-4444-4444-8444-444444444444',
  200,'tournament_prize','22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333','probe:satellite-seat',
  jsonb_build_object(
    'user_id','11111111-1111-4111-8111-111111111111',
    'registration_id','55555555-5555-4555-8555-555555555555')
);

INSERT INTO public.tournament_refund_entitlements(
  id,tournament_id,user_id,entitlement_kind,charge_category,
  refund_wallet_club_id,gross,refund_prize,refund_bounty,refund_fee,
  source_ledger_id,registration_id,source_satellite_id,source_award_place,
  escrow_bucket,evidence_kind
) VALUES(
  '77777777-7777-4777-8777-777777777777',
  '44444444-4444-4444-8444-444444444444',
  '11111111-1111-4111-8111-111111111111',
  'satellite_seat','satellite_seat',
  '22222222-2222-4222-8222-222222222222',
  200,180,0,20,'66666666-6666-4666-8666-666666666666',
  '55555555-5555-4555-8555-555555555555',
  '33333333-3333-4333-8333-333333333333',1,
  'satellite_gross','atomic_satellite_seat'
);

INSERT INTO public.rake_records(
  club_id,rake_amount,pot_size,num_players,is_tournament,tournament_id,
  source,metadata
) VALUES(
  '22222222-2222-4222-8222-222222222222',20,200,1,true,
  '44444444-4444-4444-8444-444444444444','fn_award_satellite_seat',
  jsonb_build_object(
    'kind','satellite_seat_entry_fee',
    'user_id','11111111-1111-4111-8111-111111111111',
    'registration_id','55555555-5555-4555-8555-555555555555')
);

INSERT INTO public.ca_settle_sources(source,note) VALUES(
  'fn_unregister_from_tournament','satellite ticket-return probe'
);

SET LOCAL session_replication_role=origin;
SELECT set_config(
  'test.actor','11111111-1111-4111-8111-111111111111',true);

-- A returned ticket may remove its provenance row only inside the exact
-- unregistration root. Neither half of that capability is sufficient on its
-- own, and the browser role cannot write the roster directly at all.
SELECT set_config('app.tournament_seat_exit_operation','unregister',true);
DO $forged_unregister_guc_refused$
DECLARE
  v_refused boolean:=false;
BEGIN
  BEGIN
    DELETE FROM public.tournament_players
     WHERE id='55555555-5555-4555-8555-555555555555';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    v_refused:=true;
  END;
  IF NOT v_refused THEN
    RAISE EXCEPTION
      'FAIL forged unregistration GUC deleted satellite provenance without the terminal root';
  END IF;
END;
$forged_unregister_guc_refused$;
SELECT set_config('app.tournament_seat_exit_operation','',true);

SET LOCAL ROLE authenticated;
DO $raw_authenticated_delete_refused$
DECLARE
  v_refused boolean:=false;
BEGIN
  BEGIN
    DELETE FROM public.tournament_players
     WHERE id='55555555-5555-4555-8555-555555555555';
  EXCEPTION WHEN insufficient_privilege THEN
    v_refused:=true;
  END;
  IF NOT v_refused THEN
    RAISE EXCEPTION
      'FAIL authenticated role could directly delete satellite provenance';
  END IF;
END;
$raw_authenticated_delete_refused$;
RESET ROLE;

SELECT pg_advisory_xact_lock(
  hashtextextended('ca:tournament-terminal-settlement:v1',0));
DO $terminal_lock_without_unregister_scope_refused$
DECLARE
  v_refused boolean:=false;
BEGIN
  BEGIN
    DELETE FROM public.tournament_players
     WHERE id='55555555-5555-4555-8555-555555555555';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    v_refused:=true;
  END;
  IF NOT v_refused THEN
    RAISE EXCEPTION
      'FAIL terminal root alone deleted satellite provenance without unregistration scope';
  END IF;
END;
$terminal_lock_without_unregister_scope_refused$;

CREATE TEMP TABLE probe_results(
  name text PRIMARY KEY,
  value jsonb NOT NULL
) ON COMMIT DROP;

INSERT INTO probe_results VALUES(
  'first_return',
  public.fn_unregister_from_tournament(
    '44444444-4444-4444-8444-444444444444',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
);

-- The exact same request identity is a pure receipt replay. It must not mint a
-- second ticket, touch a wallet, or manufacture a different outcome.
INSERT INTO probe_results VALUES(
  'first_return_replay',
  public.fn_unregister_from_tournament(
    '44444444-4444-4444-8444-444444444444',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
);

INSERT INTO probe_results VALUES(
  'selector',
  public.fn_find_tournament_entry_ticket(
    '44444444-4444-4444-8444-444444444444')
);

INSERT INTO probe_results VALUES(
  'free_selector',
  public.fn_find_tournament_entry_ticket(
    '88888888-8888-4888-8888-888888888888')
);

INSERT INTO probe_results
SELECT 'ticket_entry',public.fn_register_for_tournament_with_ticket(
  '44444444-4444-4444-8444-444444444444',
  (value->>'ticket_id')::uuid)
FROM probe_results
WHERE name='selector';

INSERT INTO probe_results
SELECT 'ticket_entry_replay',public.fn_register_for_tournament_with_ticket(
  '44444444-4444-4444-8444-444444444444',
  (value->>'ticket_id')::uuid)
FROM probe_results
WHERE name='selector';

DO $old_request_cannot_touch_new_registration$
DECLARE
  v_refused boolean:=false;
BEGIN
  BEGIN
    PERFORM public.fn_ca_unregister_tournament_player_exact(
      '44444444-4444-4444-8444-444444444444',
      '11111111-1111-4111-8111-111111111111',
      NULL,'Reused Request Must Not Touch Re-Entry',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  EXCEPTION WHEN SQLSTATE 'P0404' THEN
    v_refused:=true;
  END;
  IF NOT v_refused THEN
    RAISE EXCEPTION
      'FAIL old unregistration request id touched a later registration';
  END IF;
END;
$old_request_cannot_touch_new_registration$;

SET LOCAL session_replication_role=replica;
UPDATE public.tournaments
   SET start_time=clock_timestamp()-interval '1 second'
 WHERE id='44444444-4444-4444-8444-444444444444';
SET LOCAL session_replication_role=origin;

INSERT INTO probe_results VALUES(
  'post_start_refusal',
  public.fn_unregister_from_tournament(
    '44444444-4444-4444-8444-444444444444',
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc')
);

SET LOCAL session_replication_role=replica;
UPDATE public.tournaments
   SET start_time=clock_timestamp()+interval '1 day'
 WHERE id='44444444-4444-4444-8444-444444444444';
SET LOCAL session_replication_role=origin;

INSERT INTO probe_results VALUES(
  'second_return',
  public.fn_unregister_from_tournament(
    '44444444-4444-4444-8444-444444444444',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
);

INSERT INTO probe_results VALUES(
  'second_return_replay',
  public.fn_unregister_from_tournament(
    '44444444-4444-4444-8444-444444444444',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
);

-- Once the tournament begins, the exact request may still read its already
-- committed pre-start outcome. A fresh request identity is refused, proving
-- that the successful keyed call is replay and not a post-start unregister.
SET LOCAL session_replication_role=replica;
UPDATE public.tournaments
   SET start_time=clock_timestamp()-interval '1 second'
 WHERE id='44444444-4444-4444-8444-444444444444';
SET LOCAL session_replication_role=origin;

INSERT INTO probe_results VALUES(
  'second_return_post_start_replay',
  public.fn_unregister_from_tournament(
    '44444444-4444-4444-8444-444444444444',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
);

INSERT INTO probe_results VALUES(
  'fresh_request_post_start_refusal',
  public.fn_unregister_from_tournament(
    '44444444-4444-4444-8444-444444444444',
    'dddddddd-dddd-4ddd-8ddd-dddddddddddd')
);

SET LOCAL session_replication_role=replica;
UPDATE public.tournaments
   SET start_time=clock_timestamp()+interval '1 day'
 WHERE id='44444444-4444-4444-8444-444444444444';

-- Seed one cap-disposition ticket with the exact immutable evidence emitted by
-- the atomic satellite settler. This second player proves the direct ticket
-- is target-scoped, survives a temporarily full target without becoming cash,
-- enters only its named target, and unregisters back to another ticket.
INSERT INTO auth.users(id) VALUES
  ('12111111-1111-4111-8111-111111111111');
INSERT INTO public.users(id,username) VALUES
  ('12111111-1111-4111-8111-111111111111','direct_ticket_player_probe');
INSERT INTO public.profiles(id,username) VALUES
  ('12111111-1111-4111-8111-111111111111','Direct Ticket Player');
INSERT INTO public.club_members(
  club_id,user_id,role,status,chip_balance
) VALUES(
  '22222222-2222-4222-8222-222222222222',
  '12111111-1111-4111-8111-111111111111',
  'player','active',0
);
INSERT INTO public.tournaments(
  id,name,buy_in_amount,buy_in_fee,start_time,status,current_players,
  max_players,club_id,prize_pool,total_rake,bounty_pool,
  entry_contract_locked,prize_pool_finalized
) VALUES
  (
    '34333333-3333-4333-8333-333333333333','Direct Ticket Satellite',
    20,0,now()+interval '1 day','COMPLETED',0,9,
    '22222222-2222-4222-8222-222222222222',0,0,0,false,true
  ),
  (
    '45444444-4444-4444-8444-444444444444','Direct Ticket Target',
    180,20,now()+interval '1 day','REGISTERING',0,100,
    '22222222-2222-4222-8222-222222222222',0,0,0,false,false
  ),
  (
    '46444444-4444-4444-8444-444444444444','Wrong Ticket Target',
    180,20,now()+interval '1 day','REGISTERING',0,100,
    '22222222-2222-4222-8222-222222222222',0,0,0,false,false
  );
INSERT INTO public.tournament_escrow(
  tournament_id,gross_in,satellite_fee_in,prize_balance,fee_balance,
  opened_from
) VALUES
  ('45444444-4444-4444-8444-444444444444',0,0,0,0,
   'direct satellite ticket probe'),
  ('46444444-4444-4444-8444-444444444444',0,0,0,0,
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
  '34333333-3333-4333-8333-333333333333',
  '45444444-4444-4444-8444-444444444444',false,NULL,
  '12111111-1111-4111-8111-111111111111',1,1,200,180,20,
  200,1,0,0,1,0,NULL,NULL,1,
  ARRAY['47444444-4444-4444-8444-444444444444'::uuid],
  0,ARRAY[]::uuid[],0,ARRAY[]::uuid[],transaction_timestamp(),
  transaction_timestamp(),'direct ticket probe exact zero',
  transaction_timestamp()
);
INSERT INTO public.tournament_payouts(
  id,tournament_id,user_id,"position",amount,source,idempotency_key,paid_at,
  tournament_type,field_size,prize_pool,payout_structure,recorded_by,metadata
) VALUES(
  '57555555-5555-4555-8555-555555555555',
  '34333333-3333-4333-8333-333333333333',
  '12111111-1111-4111-8111-111111111111',1,200,'satellite_ticket',
  'probe:direct-satellite-ticket',transaction_timestamp(),'SATELLITE',1,200,
  NULL,'probe',jsonb_build_object(
    'delivery_kind','ticket',
    'ticket_id','56555555-5555-4555-8555-555555555555',
    'satellite_target_id','45444444-4444-4444-8444-444444444444',
    'wallet_chips_credited',0)
);
INSERT INTO public.tournament_tickets(
  id,club_id,issued_by,holder_id,value,status,note,redemption_mode,
  source_tournament_id,source_satellite_id,source_refund_entitlement_id,
  source_satellite_award_place,entry_prize,entry_bounty,entry_fee,created_at
) VALUES(
  '56555555-5555-4555-8555-555555555555',
  '22222222-2222-4222-8222-222222222222',
  '2d1cd6c3-5700-4af9-a271-d4863fdab20d',
  '12111111-1111-4111-8111-111111111111',200,'issued',
  'Four-Table Cap Satellite Award: Tournament Entry Only',
  'tournament_entry_only','45444444-4444-4444-8444-444444444444',
  '34333333-3333-4333-8333-333333333333',NULL,1,180,0,20,
  transaction_timestamp()
);
INSERT INTO public.chip_ledger(
  id,performed_by,from_type,from_entity_id,from_label,to_type,to_entity_id,
  to_label,amount,category,club_id,tournament_id,idempotency_key,
  settlement_id,actor_service,description,metadata,pre_from_balance,
  post_from_balance,pre_to_balance,post_to_balance
) VALUES(
  '67666666-6666-4666-8666-666666666666',
  '2d1cd6c3-5700-4af9-a271-d4863fdab20d','prize_liability',
  '34333333-3333-4333-8333-333333333333','tournaments.prize_pool',
  'escrow','56555555-5555-4555-8555-555555555555',
  'satellite tournament entry ticket',200,'ticket_issue',
  '22222222-2222-4222-8222-222222222222',
  '34333333-3333-4333-8333-333333333333',
  'probe:direct-satellite-ticket:ticket_escrow',
  'satellite-ticket:56555555-5555-4555-8555-555555555555',
  'fn_settle_satellite_tournament','Direct satellite entry ticket probe',
  jsonb_build_object(
    'kind','direct_satellite_entry_ticket','delivery_kind','ticket',
    'ticket_id','56555555-5555-4555-8555-555555555555',
    'payout_id','57555555-5555-4555-8555-555555555555',
    'satellite_id','34333333-3333-4333-8333-333333333333',
    'satellite_target_id','45444444-4444-4444-8444-444444444444',
    'user_id','12111111-1111-4111-8111-111111111111','position',1,
    'entry_prize',180,'entry_bounty',0,'entry_fee',20,
    'wallet_chips_credited',0,'unbacked',0),
  200,0,0,200
);
INSERT INTO public.tournament_satellite_awards(
  tournament_id,place,user_id,delivery_kind,amount,payout_id,payout_source,
  idempotency_key,ticket_id
) VALUES(
  '34333333-3333-4333-8333-333333333333',1,
  '12111111-1111-4111-8111-111111111111','ticket',200,
  '57555555-5555-4555-8555-555555555555','satellite_ticket',
  'probe:direct-satellite-ticket','56555555-5555-4555-8555-555555555555'
);
INSERT INTO public.chip_transactions(
  club_id,from_user_id,to_user_id,amount,transaction_type,notes,
  balance_after,metadata
) VALUES(
  '22222222-2222-4222-8222-222222222222',NULL,
  '12111111-1111-4111-8111-111111111111',200,
  'tournament_ticket_issue','Direct Satellite Entry Ticket Probe',NULL,
  jsonb_build_object(
    'ticket_id','56555555-5555-4555-8555-555555555555',
    'escrow_entity_id','56555555-5555-4555-8555-555555555555',
    'holder_id','12111111-1111-4111-8111-111111111111','value',200,
    'redemption_mode','tournament_entry_only',
    'source_tournament_id','45444444-4444-4444-8444-444444444444',
    'source_satellite_id','34333333-3333-4333-8333-333333333333',
    'source_award_place',1,
    'payout_id','57555555-5555-4555-8555-555555555555',
    'ledger_id','67666666-6666-4666-8666-666666666666',
    'idempotency_key','probe:direct-satellite-ticket',
    'wallet_chips_credited',0)
);
SET LOCAL session_replication_role=origin;

SELECT set_config(
  'test.actor','12111111-1111-4111-8111-111111111111',true);

INSERT INTO probe_results VALUES(
  'direct_wrong_selector',
  public.fn_find_tournament_entry_ticket(
    '46444444-4444-4444-8444-444444444444')
);

DO $direct_wrong_target_refused$
DECLARE
  v_refused boolean:=false;
BEGIN
  BEGIN
    PERFORM public.fn_register_for_tournament_with_ticket(
      '46444444-4444-4444-8444-444444444444',
      '56555555-5555-4555-8555-555555555555');
  EXCEPTION WHEN SQLSTATE 'P0404' THEN
    v_refused:=true;
  END;
  IF NOT v_refused THEN
    RAISE EXCEPTION 'FAIL direct satellite ticket entered the wrong target';
  END IF;
END;
$direct_wrong_target_refused$;

SET LOCAL session_replication_role=replica;
UPDATE public.tournaments SET max_players=3,current_players=3
 WHERE id='45444444-4444-4444-8444-444444444444';
SET LOCAL session_replication_role=origin;
INSERT INTO probe_results VALUES(
  'direct_full_refusal',
  public.fn_register_for_tournament_with_ticket(
    '45444444-4444-4444-8444-444444444444',
    '56555555-5555-4555-8555-555555555555')
);
SET LOCAL session_replication_role=replica;
UPDATE public.tournaments SET max_players=100,current_players=0
 WHERE id='45444444-4444-4444-8444-444444444444';
SET LOCAL session_replication_role=origin;

INSERT INTO probe_results VALUES(
  'direct_selector',
  public.fn_find_tournament_entry_ticket(
    '45444444-4444-4444-8444-444444444444')
);
INSERT INTO probe_results VALUES(
  'direct_ticket_entry',
  public.fn_register_for_tournament_with_ticket(
    '45444444-4444-4444-8444-444444444444',
    '56555555-5555-4555-8555-555555555555')
);
INSERT INTO probe_results VALUES(
  'direct_ticket_entry_replay',
  public.fn_register_for_tournament_with_ticket(
    '45444444-4444-4444-8444-444444444444',
    '56555555-5555-4555-8555-555555555555')
);
INSERT INTO probe_results VALUES(
  'direct_ticket_return',
  public.fn_unregister_from_tournament(
    '45444444-4444-4444-8444-444444444444',
    'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee')
);
INSERT INTO probe_results VALUES(
  'direct_ticket_return_replay',
  public.fn_unregister_from_tournament(
    '45444444-4444-4444-8444-444444444444',
    'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee')
);

SELECT set_config(
  'test.actor','11111111-1111-4111-8111-111111111111',true);

INSERT INTO probe_results
SELECT 'cash_redeem_refusal',
       public.fn_redeem_tournament_ticket(tk.id)
  FROM public.tournament_tickets tk
 WHERE tk.status='issued'
   AND tk.holder_id='11111111-1111-4111-8111-111111111111'
   AND tk.redemption_mode='tournament_entry_only';

INSERT INTO probe_results
SELECT 'cash_cancel_refusal',
       public.fn_cancel_tournament_ticket(tk.id)
  FROM public.tournament_tickets tk
 WHERE tk.status='issued'
   AND tk.holder_id='11111111-1111-4111-8111-111111111111'
   AND tk.redemption_mode='tournament_entry_only';

-- Corrupt only the disposable fixture's private issue evidence while all
-- production triggers are disabled, then prove the selector refuses the
-- candidate instead of erasing it through an inner join and charging chips.
SET LOCAL session_replication_role=replica;
DELETE FROM public.chip_transactions issue_tx
 WHERE issue_tx.transaction_type='tournament_ticket_issue'
   AND issue_tx.metadata->>'ticket_id'=(
     SELECT tk.id::text FROM public.tournament_tickets tk
      WHERE tk.status='issued'
        AND tk.holder_id='11111111-1111-4111-8111-111111111111'
        AND tk.redemption_mode='tournament_entry_only');
DELETE FROM public.chip_ledger issue_l
 WHERE issue_l.category='ticket_issue'
   AND issue_l.to_entity_id=(
     SELECT tk.id FROM public.tournament_tickets tk
      WHERE tk.status='issued'
        AND tk.holder_id='11111111-1111-4111-8111-111111111111'
        AND tk.redemption_mode='tournament_entry_only');
SET LOCAL session_replication_role=origin;

DO $corrupt_receipt_fails_closed$
DECLARE
  v_refused boolean:=false;
BEGIN
  BEGIN
    PERFORM public.fn_unregister_from_tournament(
      '44444444-4444-4444-8444-444444444444',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  EXCEPTION WHEN SQLSTATE 'P0404' THEN
    v_refused:=true;
  END;
  IF NOT v_refused THEN
    RAISE EXCEPTION
      'FAIL corrupted ticket evidence still produced an unregister receipt';
  END IF;
END;
$corrupt_receipt_fails_closed$;

INSERT INTO probe_results VALUES(
  'corrupt_ticket_selector',
  public.fn_find_tournament_entry_ticket(
    '44444444-4444-4444-8444-444444444444')
);

DO $assert$
DECLARE
  v_first jsonb:=(SELECT value FROM probe_results WHERE name='first_return');
  v_first_replay jsonb:=(
    SELECT value FROM probe_results WHERE name='first_return_replay');
  v_selector jsonb:=(SELECT value FROM probe_results WHERE name='selector');
  v_free_selector jsonb:=(
    SELECT value FROM probe_results WHERE name='free_selector');
  v_entry jsonb:=(SELECT value FROM probe_results WHERE name='ticket_entry');
  v_entry_replay jsonb:=(
    SELECT value FROM probe_results WHERE name='ticket_entry_replay');
  v_post_start jsonb:=(
    SELECT value FROM probe_results WHERE name='post_start_refusal');
  v_second jsonb:=(SELECT value FROM probe_results WHERE name='second_return');
  v_second_replay jsonb:=(
    SELECT value FROM probe_results WHERE name='second_return_replay');
  v_second_post_start_replay jsonb:=(
    SELECT value FROM probe_results
     WHERE name='second_return_post_start_replay');
  v_fresh_request_post_start jsonb:=(
    SELECT value FROM probe_results
     WHERE name='fresh_request_post_start_refusal');
  v_redeem jsonb:=(
    SELECT value FROM probe_results WHERE name='cash_redeem_refusal');
  v_cancel jsonb:=(
    SELECT value FROM probe_results WHERE name='cash_cancel_refusal');
  v_corrupt_selector jsonb:=(
    SELECT value FROM probe_results WHERE name='corrupt_ticket_selector');
  v_direct_wrong_selector jsonb:=(
    SELECT value FROM probe_results WHERE name='direct_wrong_selector');
  v_direct_full jsonb:=(
    SELECT value FROM probe_results WHERE name='direct_full_refusal');
  v_direct_selector jsonb:=(
    SELECT value FROM probe_results WHERE name='direct_selector');
  v_direct_entry jsonb:=(
    SELECT value FROM probe_results WHERE name='direct_ticket_entry');
  v_direct_entry_replay jsonb:=(
    SELECT value FROM probe_results WHERE name='direct_ticket_entry_replay');
  v_direct_return jsonb:=(
    SELECT value FROM probe_results WHERE name='direct_ticket_return');
  v_direct_return_replay jsonb:=(
    SELECT value FROM probe_results WHERE name='direct_ticket_return_replay');
  v_user constant uuid:='11111111-1111-4111-8111-111111111111';
  v_target constant uuid:='44444444-4444-4444-8444-444444444444';
  v_direct_user constant uuid:='12111111-1111-4111-8111-111111111111';
  v_direct_target constant uuid:='45444444-4444-4444-8444-444444444444';
  v_guard_refused boolean:=false;
  v_forged_guard_refused boolean:=false;
  v_receipt_update_refused boolean:=false;
  v_receipt_delete_refused boolean:=false;
  v_issued_ticket_id uuid;
BEGIN
  IF (v_first->>'refunded_chips')::numeric<>0
     OR (v_first->>'returned_ticket_value')::numeric<>200
     OR (v_first->>'wallet_chips_from_satellite_entitlements')::numeric<>0
     OR COALESCE((v_first->>'replayed')::boolean,true) IS NOT FALSE
     OR COALESCE((v_first_replay->>'ok')::boolean,false) IS NOT TRUE
     OR COALESCE((v_first_replay->>'replayed')::boolean,false) IS NOT TRUE
     OR (v_first_replay-'replayed') IS DISTINCT FROM (v_first-'replayed')
     OR (v_selector->>'ticket_id')::uuid IS DISTINCT FROM
          (v_entry->>'ticket_id')::uuid
     OR COALESCE((v_free_selector->>'ok')::boolean,false) IS NOT TRUE
     OR v_free_selector->>'ticket_id' IS NOT NULL
     OR COALESCE((v_entry->>'ok')::boolean,false) IS NOT TRUE
     OR (v_entry->>'wallet_chips_credited')::numeric<>0
     OR COALESCE((v_entry_replay->>'ok')::boolean,false) IS NOT TRUE
     OR COALESCE((v_entry_replay->>'replayed')::boolean,false) IS NOT TRUE
     OR (v_entry_replay->>'registration_id') IS DISTINCT FROM
          (v_entry->>'registration_id')
     OR COALESCE((v_post_start->>'ok')::boolean,true) IS NOT FALSE
     OR v_post_start->>'reason'<>'tournament_started'
     OR (v_second->>'refunded_chips')::numeric<>0
     OR (v_second->>'returned_ticket_value')::numeric<>200
     OR (v_second->>'wallet_chips_from_satellite_entitlements')::numeric<>0
     OR COALESCE((v_second->>'replayed')::boolean,true) IS NOT FALSE
     OR COALESCE((v_second_replay->>'ok')::boolean,false) IS NOT TRUE
     OR COALESCE((v_second_replay->>'replayed')::boolean,false) IS NOT TRUE
     OR (v_second_replay-'replayed') IS DISTINCT FROM (v_second-'replayed')
     OR COALESCE((v_second_post_start_replay->>'ok')::boolean,false)
          IS NOT TRUE
     OR COALESCE((v_second_post_start_replay->>'replayed')::boolean,false)
          IS NOT TRUE
     OR (v_second_post_start_replay-'replayed')
          IS DISTINCT FROM (v_second-'replayed')
     OR COALESCE((v_fresh_request_post_start->>'ok')::boolean,true) IS NOT FALSE
     OR v_fresh_request_post_start->>'reason'<>'tournament_started'
     OR COALESCE((v_redeem->>'success')::boolean,true) IS NOT FALSE
     OR COALESCE((v_cancel->>'success')::boolean,true) IS NOT FALSE
     OR COALESCE((v_corrupt_selector->>'ok')::boolean,true) IS NOT FALSE
     OR v_corrupt_selector->>'reason'<>
          'matching_tournament_ticket_unavailable'
     OR (SELECT count(*) FROM public.wallet_transactions w
          WHERE w.user_id=v_user AND w.related_entity_id=v_target)<>0
     OR (SELECT count(*) FROM public.tournament_tickets tk
          WHERE tk.holder_id=v_user
            AND tk.redemption_mode='tournament_entry_only')<>2
     OR (SELECT count(*) FROM public.tournament_tickets tk
          WHERE tk.holder_id=v_user AND tk.status='redeemed')<>1
     OR (SELECT count(*) FROM public.tournament_tickets tk
          WHERE tk.holder_id=v_user AND tk.status='issued')<>1
     OR (SELECT count(*) FROM public.tournament_unregistration_receipts r
          WHERE r.tournament_id=v_target AND r.user_id=v_user)<>2
     OR EXISTS(
       SELECT 1 FROM public.tournament_unregistration_receipts r
        WHERE r.tournament_id=v_target AND r.user_id=v_user
          AND (r.settled_at>=r.scheduled_start_at
            OR r.request_id NOT IN (
              'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid,
              'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid)))
     OR EXISTS(
       SELECT 1 FROM public.tournament_refund_tranches tr
       JOIN public.tournament_refund_entitlements e
         ON e.id=tr.entitlement_id
       WHERE e.user_id=v_user
         AND e.entitlement_kind IN ('satellite_seat','tournament_ticket')) THEN
    RAISE EXCEPTION
      'FAIL satellite ticket-only cycle: %, %, %, %, %, %',
      v_first,v_selector,v_entry,v_second,v_redeem,v_cancel;
  END IF;

  IF COALESCE((v_direct_wrong_selector->>'ok')::boolean,false) IS NOT TRUE
     OR v_direct_wrong_selector->>'ticket_id' IS NOT NULL
     OR COALESCE((v_direct_full->>'ok')::boolean,true) IS NOT FALSE
     OR v_direct_full->>'reason'<>'tournament_full'
     OR (v_direct_selector->>'ticket_id')::uuid IS DISTINCT FROM
          '56555555-5555-4555-8555-555555555555'::uuid
     OR COALESCE((v_direct_entry->>'ok')::boolean,false) IS NOT TRUE
     OR (v_direct_entry->>'wallet_chips_credited')::numeric<>0
     OR COALESCE((v_direct_entry_replay->>'ok')::boolean,false) IS NOT TRUE
     OR COALESCE((v_direct_entry_replay->>'replayed')::boolean,false)
          IS NOT TRUE
     OR v_direct_entry_replay->>'registration_id'
          IS DISTINCT FROM v_direct_entry->>'registration_id'
     OR (v_direct_return->>'refunded_chips')::numeric<>0
     OR (v_direct_return->>'returned_ticket_value')::numeric<>200
     OR (v_direct_return->>'wallet_chips_from_satellite_entitlements')::numeric
          <>0
     OR COALESCE((v_direct_return_replay->>'ok')::boolean,false) IS NOT TRUE
     OR COALESCE((v_direct_return_replay->>'replayed')::boolean,false)
          IS NOT TRUE
     OR (v_direct_return_replay-'replayed') IS DISTINCT FROM
          (v_direct_return-'replayed')
     OR EXISTS(
       SELECT 1 FROM public.wallet_transactions w
        WHERE w.user_id=v_direct_user AND w.related_entity_id=v_direct_target)
     OR (SELECT count(*) FROM public.tournament_tickets tk
          WHERE tk.holder_id=v_direct_user
            AND tk.redemption_mode='tournament_entry_only')<>2
     OR (SELECT count(*) FROM public.tournament_tickets tk
          WHERE tk.holder_id=v_direct_user AND tk.status='redeemed')<>1
     OR (SELECT count(*) FROM public.tournament_tickets tk
          WHERE tk.holder_id=v_direct_user AND tk.status='issued'
            AND tk.source_tournament_id=v_direct_target
            AND tk.source_refund_entitlement_id IS NOT NULL
            AND tk.source_satellite_award_place IS NULL)<>1
     OR NOT EXISTS(
       SELECT 1 FROM public.tournament_tickets tk
        WHERE tk.id='56555555-5555-4555-8555-555555555555'
          AND tk.source_tournament_id=v_direct_target
          AND tk.source_satellite_id=
                '34333333-3333-4333-8333-333333333333'
          AND tk.source_refund_entitlement_id IS NULL
          AND tk.source_satellite_award_place=1)
     OR (SELECT count(*) FROM public.tournament_unregistration_receipts r
          WHERE r.tournament_id=v_direct_target
            AND r.user_id=v_direct_user
            AND r.request_id='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee')<>1
     OR EXISTS(
       SELECT 1 FROM public.tournament_players tp
        WHERE tp.tournament_id=v_direct_target AND tp.user_id=v_direct_user)
     OR NOT EXISTS(
       SELECT 1 FROM public.tournaments t
        WHERE t.id=v_direct_target AND t.current_players=0
          AND t.prize_pool=0 AND t.total_rake=0 AND t.bounty_pool=0)
     OR EXISTS(
       SELECT 1 FROM public.tournament_refund_tranches tr
       JOIN public.tournament_refund_entitlements e
         ON e.id=tr.entitlement_id
       WHERE e.user_id=v_direct_user
         AND e.entitlement_kind='tournament_ticket') THEN
    RAISE EXCEPTION
      'FAIL direct cap ticket exact-target admission/return chain: %, %, %, %, %',
      v_direct_wrong_selector,v_direct_full,v_direct_selector,
      v_direct_entry,v_direct_return;
  END IF;

  BEGIN
    UPDATE public.tournament_tickets
       SET status='redeemed',redeemed_at=transaction_timestamp()
     WHERE holder_id=v_user AND status='issued';
  EXCEPTION WHEN SQLSTATE '42501' THEN
    v_guard_refused:=true;
  END;
  IF NOT v_guard_refused THEN
    RAISE EXCEPTION
      'FAIL tournament-entry ticket accepted a direct status update';
  END IF;

  SELECT tk.id INTO STRICT v_issued_ticket_id
    FROM public.tournament_tickets tk
   WHERE tk.holder_id=v_user AND tk.status='issued'
     AND tk.redemption_mode='tournament_entry_only';
  PERFORM set_config(
    'app.ca_satellite_ticket_use_token',v_issued_ticket_id::text,true);
  BEGIN
    UPDATE public.tournament_tickets
       SET status='redeemed',redeemed_at=transaction_timestamp()
     WHERE id=v_issued_ticket_id;
  EXCEPTION WHEN SQLSTATE '42501' THEN
    v_forged_guard_refused:=true;
  END;
  PERFORM set_config('app.ca_satellite_ticket_use_token','',true);
  IF NOT v_forged_guard_refused THEN
    RAISE EXCEPTION
      'FAIL a forged session setting redeemed a tournament-entry ticket';
  END IF;

  BEGIN
    UPDATE public.tournament_unregistration_receipts
       SET settled_at=settled_at
     WHERE request_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    v_receipt_update_refused:=true;
  END;
  BEGIN
    DELETE FROM public.tournament_unregistration_receipts
     WHERE request_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    v_receipt_delete_refused:=true;
  END;
  IF NOT v_receipt_update_refused OR NOT v_receipt_delete_refused THEN
    RAISE EXCEPTION
      'FAIL unregistration receipt accepted an update or delete';
  END IF;
END;
$assert$;

SET CONSTRAINTS ALL IMMEDIATE;

SELECT
  'PASS satellite seat -> ticket -> admission -> ticket-only return; '
  || 'direct cap ticket -> exact target -> ticket-only return; '
  || 'request-key replay exact before and after start; fresh post-start, '
  || 'cash and forged redemptions refused; GUC-only, lock-only and raw-role '
  || 'provenance deletes refused; zero wallet rows'
  AS result;

ROLLBACK;
