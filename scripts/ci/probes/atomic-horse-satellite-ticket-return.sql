-- Local PostgreSQL rehearsal for the horse-beneficiary ticket rail.
-- A horse wins a satellite seat, exits the target before start, re-enters
-- through the service-only ticket-first door, retries that exact admission,
-- exits to another ticket, and can never fall through to its wallet when the
-- server's issued-ticket hint becomes stale or the issue proof is corrupt.

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
  ('91111111-1111-4111-8111-111111111111'),
  ('2d1cd6c3-5700-4af9-a271-d4863fdab20d');
INSERT INTO public.users(id,username) VALUES
  ('91111111-1111-4111-8111-111111111111','ticket_horse_probe'),
  ('2d1cd6c3-5700-4af9-a271-d4863fdab20d','smarterpoker');
INSERT INTO public.profiles(id,username,is_horse,horse_status) VALUES
  ('91111111-1111-4111-8111-111111111111',
   'Ticket Horse',true,'available'),
  ('2d1cd6c3-5700-4af9-a271-d4863fdab20d',
   'smarterpoker',false,'available');
INSERT INTO public.clubs(id,club_id,name) VALUES
  ('a41434bb-8d0c-400a-8f0d-e8b3d65afed4',98766,'Horse Ticket Club');
INSERT INTO public.club_members(
  club_id,user_id,role,status,chip_balance
) VALUES(
  'a41434bb-8d0c-400a-8f0d-e8b3d65afed4',
  '91111111-1111-4111-8111-111111111111',
  'player','active',1000
);

INSERT INTO public.tournaments(
  id,name,buy_in_amount,buy_in_fee,start_time,status,current_players,
  max_players,club_id,prize_pool,total_rake,bounty_pool,
  entry_contract_locked
) VALUES
  (
    '93333333-3333-4333-8333-333333333333','Horse Source Satellite',
    20,0,now()+interval '1 day','COMPLETED',0,9,
    'a41434bb-8d0c-400a-8f0d-e8b3d65afed4',0,0,0,false
  ),
  (
    '94444444-4444-4444-8444-444444444444','Horse Target Tournament',
    180,20,now()+interval '1 day','REGISTERING',1,100,
    'a41434bb-8d0c-400a-8f0d-e8b3d65afed4',180,20,0,true
  );
INSERT INTO public.tournament_escrow(
  tournament_id,gross_in,satellite_fee_in,prize_balance,fee_balance,
  opened_from
) VALUES(
  '94444444-4444-4444-8444-444444444444',180,20,180,20,
  'horse satellite ticket-return probe'
);
INSERT INTO public.tournament_players(
  id,tournament_id,user_id,username,chips,status,club_id,
  is_satellite_qualifier,source_satellite_id
) VALUES(
  '95555555-5555-4555-8555-555555555555',
  '94444444-4444-4444-8444-444444444444',
  '91111111-1111-4111-8111-111111111111',
  'Ticket Horse',10000,'registered',
  'a41434bb-8d0c-400a-8f0d-e8b3d65afed4',true,
  '93333333-3333-4333-8333-333333333333'
);
INSERT INTO public.chip_ledger(
  id,performed_by,from_type,from_entity_id,to_type,to_entity_id,
  amount,category,club_id,tournament_id,idempotency_key,metadata
) VALUES(
  '96666666-6666-4666-8666-666666666666',
  '2d1cd6c3-5700-4af9-a271-d4863fdab20d',
  'prize_liability','93333333-3333-4333-8333-333333333333',
  'prize_liability','94444444-4444-4444-8444-444444444444',
  200,'tournament_prize','a41434bb-8d0c-400a-8f0d-e8b3d65afed4',
  '93333333-3333-4333-8333-333333333333','probe:horse-satellite-seat',
  jsonb_build_object(
    'user_id','91111111-1111-4111-8111-111111111111',
    'registration_id','95555555-5555-4555-8555-555555555555')
);
INSERT INTO public.tournament_refund_entitlements(
  id,tournament_id,user_id,entitlement_kind,charge_category,
  refund_wallet_club_id,gross,refund_prize,refund_bounty,refund_fee,
  source_ledger_id,registration_id,source_satellite_id,source_award_place,
  escrow_bucket,evidence_kind
) VALUES(
  '97777777-7777-4777-8777-777777777777',
  '94444444-4444-4444-8444-444444444444',
  '91111111-1111-4111-8111-111111111111',
  'satellite_seat','satellite_seat',
  'a41434bb-8d0c-400a-8f0d-e8b3d65afed4',
  200,180,0,20,'96666666-6666-4666-8666-666666666666',
  '95555555-5555-4555-8555-555555555555',
  '93333333-3333-4333-8333-333333333333',1,
  'satellite_gross','atomic_satellite_seat'
);
INSERT INTO public.rake_records(
  club_id,rake_amount,pot_size,num_players,is_tournament,tournament_id,
  source,metadata
) VALUES(
  'a41434bb-8d0c-400a-8f0d-e8b3d65afed4',20,200,1,true,
  '94444444-4444-4444-8444-444444444444','fn_award_satellite_seat',
  jsonb_build_object(
    'kind','satellite_seat_entry_fee',
    'user_id','91111111-1111-4111-8111-111111111111',
    'registration_id','95555555-5555-4555-8555-555555555555')
);
INSERT INTO public.ca_settle_sources(source,note) VALUES(
  'fn_unregister_from_tournament','horse satellite ticket-return probe'
);

SET LOCAL session_replication_role=origin;
SELECT set_config(
  'test.actor','91111111-1111-4111-8111-111111111111',true);

CREATE TEMP TABLE horse_probe_results(
  name text PRIMARY KEY,
  value jsonb NOT NULL
) ON COMMIT DROP;

INSERT INTO horse_probe_results VALUES(
  'first_return',
  public.fn_unregister_from_tournament(
    '94444444-4444-4444-8444-444444444444',
    '9aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
);
INSERT INTO horse_probe_results VALUES(
  'ticket_hint',
  public.fn_horse_tournament_entry_ticket_hints(
    '94444444-4444-4444-8444-444444444444')
);
INSERT INTO horse_probe_results VALUES(
  'ticket_entry',
  public.fn_register_horse_for_tournament(
    '94444444-4444-4444-8444-444444444444',
    '91111111-1111-4111-8111-111111111111',false)
);
INSERT INTO horse_probe_results VALUES(
  'ticket_entry_replay',
  public.fn_register_horse_for_tournament(
    '94444444-4444-4444-8444-444444444444',
    '91111111-1111-4111-8111-111111111111',false)
);
INSERT INTO horse_probe_results VALUES(
  'second_return',
  public.fn_unregister_from_tournament(
    '94444444-4444-4444-8444-444444444444',
    '9bbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
);
INSERT INTO horse_probe_results VALUES(
  'second_ticket_hint',
  public.fn_horse_tournament_entry_ticket_hints(
    '94444444-4444-4444-8444-444444444444')
);

-- The server saw a valid issued-ticket hint, but the candidate disappears
-- before its admission RPC. Explicit no-wallet authority must prevent a chip
-- charge even though the exact selector now reports no ticket.
SET LOCAL session_replication_role=replica;
UPDATE public.tournament_tickets
   SET status='cancelled',cancelled_at=transaction_timestamp()
 WHERE holder_id='91111111-1111-4111-8111-111111111111'
   AND status='issued';
SET LOCAL session_replication_role=origin;
INSERT INTO horse_probe_results VALUES(
  'stale_hint_refusal',
  public.fn_register_horse_for_tournament(
    '94444444-4444-4444-8444-444444444444',
    '91111111-1111-4111-8111-111111111111',false)
);

-- Restore the disposable row, corrupt its private issue proof, and prove the
-- candidate-presence hint still suppresses wallet fallback while the exact
-- selector names the corruption.
SET LOCAL session_replication_role=replica;
UPDATE public.tournament_tickets
   SET status='issued',cancelled_at=NULL
 WHERE holder_id='91111111-1111-4111-8111-111111111111'
   AND status='cancelled';
DELETE FROM public.chip_transactions issue_tx
 WHERE issue_tx.transaction_type='tournament_ticket_issue'
   AND issue_tx.metadata->>'ticket_id'=(
     SELECT tk.id::text FROM public.tournament_tickets tk
      WHERE tk.holder_id='91111111-1111-4111-8111-111111111111'
        AND tk.status='issued');
DELETE FROM public.chip_ledger issue_l
 WHERE issue_l.category='ticket_issue'
   AND issue_l.to_entity_id=(
     SELECT tk.id FROM public.tournament_tickets tk
      WHERE tk.holder_id='91111111-1111-4111-8111-111111111111'
        AND tk.status='issued');
SET LOCAL session_replication_role=origin;
INSERT INTO horse_probe_results VALUES(
  'corrupt_ticket_refusal',
  public.fn_register_horse_for_tournament(
    '94444444-4444-4444-8444-444444444444',
    '91111111-1111-4111-8111-111111111111',false)
);

DO $assert_horse_ticket_cycle$
DECLARE
  v_first jsonb:=(
    SELECT value FROM horse_probe_results WHERE name='first_return');
  v_hint jsonb:=(
    SELECT value FROM horse_probe_results WHERE name='ticket_hint');
  v_entry jsonb:=(
    SELECT value FROM horse_probe_results WHERE name='ticket_entry');
  v_replay jsonb:=(
    SELECT value FROM horse_probe_results WHERE name='ticket_entry_replay');
  v_second jsonb:=(
    SELECT value FROM horse_probe_results WHERE name='second_return');
  v_second_hint jsonb:=(
    SELECT value FROM horse_probe_results WHERE name='second_ticket_hint');
  v_stale jsonb:=(
    SELECT value FROM horse_probe_results WHERE name='stale_hint_refusal');
  v_corrupt jsonb:=(
    SELECT value FROM horse_probe_results WHERE name='corrupt_ticket_refusal');
  v_user constant uuid:='91111111-1111-4111-8111-111111111111';
  v_target constant uuid:='94444444-4444-4444-8444-444444444444';
BEGIN
  IF (v_first->>'refunded_chips')::numeric<>0
     OR (v_first->>'returned_ticket_value')::numeric<>200
     OR COALESCE((v_hint->>'ok')::boolean,false) IS NOT TRUE
     OR NOT ((v_hint->'holder_ids') ? v_user::text)
     OR COALESCE((v_entry->>'ok')::boolean,false) IS NOT TRUE
     OR COALESCE((v_entry->>'replayed')::boolean,true) IS NOT FALSE
     OR (v_entry->>'wallet_chips_credited')::numeric<>0
     OR COALESCE((v_replay->>'ok')::boolean,false) IS NOT TRUE
     OR COALESCE((v_replay->>'replayed')::boolean,false) IS NOT TRUE
     OR v_replay->>'ticket_id' IS DISTINCT FROM v_entry->>'ticket_id'
     OR v_replay->>'registration_id' IS DISTINCT FROM
          v_entry->>'registration_id'
     OR (v_second->>'refunded_chips')::numeric<>0
     OR (v_second->>'returned_ticket_value')::numeric<>200
     OR COALESCE((v_second_hint->>'ok')::boolean,false) IS NOT TRUE
     OR NOT ((v_second_hint->'holder_ids') ? v_user::text)
     OR COALESCE((v_stale->>'ok')::boolean,true) IS NOT FALSE
     OR v_stale->>'reason'<>'hinted_tournament_ticket_no_longer_available'
     OR COALESCE((v_corrupt->>'ok')::boolean,true) IS NOT FALSE
     OR v_corrupt->>'reason'<>'matching_tournament_ticket_unavailable'
     OR (SELECT m.chip_balance FROM public.club_members m
          WHERE m.club_id='a41434bb-8d0c-400a-8f0d-e8b3d65afed4'
            AND m.user_id=v_user) IS DISTINCT FROM 1000::numeric
     OR (SELECT count(*) FROM public.wallet_transactions w
          WHERE w.user_id=v_user AND w.related_entity_id=v_target)<>0
     OR (SELECT count(*) FROM public.tournament_tickets tk
          WHERE tk.holder_id=v_user
            AND tk.redemption_mode='tournament_entry_only')<>2
     OR (SELECT count(*) FROM public.tournament_tickets tk
          WHERE tk.holder_id=v_user AND tk.status='redeemed')<>1
     OR (SELECT count(*) FROM public.tournament_tickets tk
          WHERE tk.holder_id=v_user AND tk.status='issued')<>1
     OR (SELECT count(*) FROM public.tournament_players tp
          WHERE tp.tournament_id=v_target AND tp.user_id=v_user)<>0
     OR EXISTS(
       SELECT 1 FROM public.tournament_refund_tranches tr
       JOIN public.tournament_refund_entitlements e
         ON e.id=tr.entitlement_id
       WHERE e.user_id=v_user
         AND e.entitlement_kind IN ('satellite_seat','tournament_ticket')) THEN
    RAISE EXCEPTION
      'FAIL horse ticket cycle: %, %, %, %, %, %, %, %',
      v_first,v_hint,v_entry,v_replay,v_second,v_second_hint,v_stale,v_corrupt;
  END IF;
END;
$assert_horse_ticket_cycle$;

SET CONSTRAINTS ALL IMMEDIATE;

SELECT
  'PASS horse satellite seat -> ticket -> service admission -> exact replay '
  || '-> ticket-only return; stale/corrupt hints refuse without wallet chips'
  AS result;

ROLLBACK;
