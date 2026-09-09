-- Production-shaped, rollback-only proof that a player's funding wallet and
-- the tournament's fee recipient remain separate through unregistration.
-- The public registration door and private atomic rebuy money core create the
-- real journals; the public unregister door must credit each exact funding
-- club and reverse each fee against the original rake recipient.

BEGIN;

SET LOCAL session_replication_role=replica;

INSERT INTO auth.users(id) VALUES
  ('c1000000-0000-4000-8000-000000000001');

INSERT INTO public.users(id,username) VALUES
  ('c1000000-0000-4000-8000-000000000001',
   'cross_club_unregister_probe');

INSERT INTO public.profiles(id,username,display_name) VALUES
  ('c1000000-0000-4000-8000-000000000001',
   'cross_club_unregister_probe','Cross Club Unregister Probe');

INSERT INTO public.unions(id,name,owner_id,slug,union_code) VALUES(
  'c6000000-0000-4000-8000-000000000001','Cross Club Probe Union',
  'c1000000-0000-4000-8000-000000000001','cross-club-probe-union',990003
);

INSERT INTO public.clubs(id,club_id,name,union_id) VALUES
  ('c2000000-0000-4000-8000-000000000001',990001,
   'Funding Club Probe','c6000000-0000-4000-8000-000000000001'),
  ('c2000000-0000-4000-8000-000000000002',990002,
   'Fee Recipient Club Probe','c6000000-0000-4000-8000-000000000001');

INSERT INTO public.club_members(
  club_id,user_id,role,status,chip_balance,joined_at
) VALUES
  (
    'c2000000-0000-4000-8000-000000000001',
    'c1000000-0000-4000-8000-000000000001',
    'player','active',1000,now()-interval '1 day'
  ),
  (
    'c2000000-0000-4000-8000-000000000002',
    'c1000000-0000-4000-8000-000000000001',
    'player','active',200,now()
  );

INSERT INTO public.tournaments(
  id,name,buy_in_amount,buy_in_fee,starting_chips,start_time,status,
  current_players,max_players,current_level,club_id,prize_pool,total_rake,
  bounty_pool,entry_contract_locked,is_rebuy,is_reentry,rebuy_cost,
  rebuy_chips,rebuy_levels,late_reg_levels,late_reg_mins,max_rebuys
) VALUES(
  'c3000000-0000-4000-8000-000000000001',
  'Cross Club Unregister Probe',90,10,1000,
  clock_timestamp()+interval '1 day','REGISTERING',0,100,1,
  'c2000000-0000-4000-8000-000000000002',0,0,0,false,
  true,false,50,500,5,5,60,5
);

INSERT INTO auth.sessions(id,user_id,created_at,updated_at) VALUES(
  'c4000000-0000-4000-8000-000000000001',
  'c1000000-0000-4000-8000-000000000001',now(),now()
);

INSERT INTO public.ca_settle_sources(source,note) VALUES(
  'fn_unregister_from_tournament','cross-club unregister probe'
);

SET LOCAL session_replication_role=origin;

SELECT set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub','c1000000-0000-4000-8000-000000000001',
    'role','authenticated',
    'session_id','c4000000-0000-4000-8000-000000000001')::text,
  true
);

SET LOCAL ROLE authenticated;
DO $register$
DECLARE
  v_result jsonb;
BEGIN
  v_result:=public.fn_register_for_tournament(
    'c3000000-0000-4000-8000-000000000001');
  IF COALESCE((v_result->>'ok')::boolean,false) IS NOT TRUE
     OR (v_result->>'cost')::numeric IS DISTINCT FROM 100
     OR (v_result->>'rake')::numeric IS DISTINCT FROM 10 THEN
    RAISE EXCEPTION 'FAIL cross-club registration did not commit: %',v_result;
  END IF;
END;
$register$;
RESET ROLE;

DO $rebuy$
DECLARE
  v_result jsonb;
BEGIN
  v_result:=public.fn_ca_process_tournament_chip_purchase_money_v1(
    'c3000000-0000-4000-8000-000000000001',
    'c1000000-0000-4000-8000-000000000001',
    'rebuy',50,500,1,
    'tourney:c3000000-0000-4000-8000-000000000001:rebuy:'
      ||'c1000000-0000-4000-8000-000000000001:tok:cross-club-v1');
  IF COALESCE((v_result->>'success')::boolean,false) IS NOT TRUE
     OR COALESCE((v_result->>'idempotent')::boolean,false)
     OR (v_result->>'new_stack')::numeric IS DISTINCT FROM 500 THEN
    RAISE EXCEPTION 'FAIL cross-club rebuy did not commit: %',v_result;
  END IF;
END;
$rebuy$;

SET CONSTRAINTS ALL IMMEDIATE;

DO $before_unregister$
BEGIN
  IF NOT EXISTS (
       SELECT 1 FROM public.tournament_players tp
        WHERE tp.tournament_id=
                'c3000000-0000-4000-8000-000000000001'
          AND tp.user_id='c1000000-0000-4000-8000-000000000001'
          AND tp.club_id='c2000000-0000-4000-8000-000000000002'
          AND tp.status='playing' AND tp.chips=500 AND tp.rebuys=1)
     OR (SELECT chip_balance FROM public.club_members
          WHERE club_id='c2000000-0000-4000-8000-000000000001'
            AND user_id='c1000000-0000-4000-8000-000000000001')
          IS DISTINCT FROM 900
     OR (SELECT chip_balance FROM public.club_members
          WHERE club_id='c2000000-0000-4000-8000-000000000002'
            AND user_id='c1000000-0000-4000-8000-000000000001')
          IS DISTINCT FROM 150
     OR (SELECT count(*) FROM public.tournament_refund_entitlements e
          WHERE e.tournament_id='c3000000-0000-4000-8000-000000000001'
            AND e.user_id='c1000000-0000-4000-8000-000000000001'
            AND e.entitlement_kind='wallet_charge')<>2
     OR (SELECT round(sum(e.gross),2)
           FROM public.tournament_refund_entitlements e
          WHERE e.tournament_id='c3000000-0000-4000-8000-000000000001'
            AND e.user_id='c1000000-0000-4000-8000-000000000001')
          IS DISTINCT FROM 150
     OR (SELECT round(sum(e.refund_fee),2)
           FROM public.tournament_refund_entitlements e
          WHERE e.tournament_id='c3000000-0000-4000-8000-000000000001'
            AND e.user_id='c1000000-0000-4000-8000-000000000001')
          IS DISTINCT FROM 15
     OR (SELECT count(*) FROM public.rake_records r
          WHERE r.tournament_id='c3000000-0000-4000-8000-000000000001'
            AND r.rake_amount>0
            AND r.club_id='c2000000-0000-4000-8000-000000000002'
            AND r.metadata->>'user_id'=
                  'c1000000-0000-4000-8000-000000000001')<>2
     OR EXISTS (
       SELECT 1 FROM public.rake_records r
        WHERE r.tournament_id='c3000000-0000-4000-8000-000000000001'
          AND r.rake_amount>0
          AND r.club_id='c2000000-0000-4000-8000-000000000001') THEN
    RAISE EXCEPTION
      'FAIL buy-in/rebuy did not separate funding wallet from fee recipient';
  END IF;
END;
$before_unregister$;

SET LOCAL ROLE authenticated;
CREATE TEMP TABLE cross_club_unregister_result(value jsonb NOT NULL)
  ON COMMIT DROP;
INSERT INTO cross_club_unregister_result(value)
SELECT public.fn_unregister_from_tournament(
  'c3000000-0000-4000-8000-000000000001',
  'c5000000-0000-4000-8000-000000000001');
RESET ROLE;

SET CONSTRAINTS ALL IMMEDIATE;

DO $assert$
DECLARE
  v_result jsonb:=(SELECT value FROM cross_club_unregister_result);
  v_receipt public.tournament_unregistration_receipts%ROWTYPE;
BEGIN
  SELECT * INTO STRICT v_receipt
    FROM public.tournament_unregistration_receipts receipt
   WHERE receipt.request_id='c5000000-0000-4000-8000-000000000001';

  IF COALESCE((v_result->>'ok')::boolean,false) IS NOT TRUE
     OR COALESCE((v_result->>'replayed')::boolean,true)
     OR (v_result->>'refunded_chips')::numeric IS DISTINCT FROM 150
     OR (v_result->>'returned_ticket_value')::numeric IS DISTINCT FROM 0
     OR (v_result->>'fees_reversed')::numeric IS DISTINCT FROM 15
     OR v_receipt.refunded_chips IS DISTINCT FROM 150
     OR v_receipt.returned_ticket_value IS DISTINCT FROM 0
     OR v_receipt.fees_reversed IS DISTINCT FROM 15
     OR cardinality(v_receipt.entitlement_ids)<>2
     OR cardinality(v_receipt.source_wallet_club_ids)<>2
     OR cardinality(v_receipt.credit_ledger_ids)<>2
     OR cardinality(v_receipt.wallet_transaction_ids)<>2
     OR cardinality(v_receipt.fee_reversal_ids)<>1
     OR cardinality(v_receipt.fee_source_rake_record_ids)<>2
     OR (SELECT count(*)
           FROM unnest(v_receipt.source_wallet_club_ids) funding(club_id)
          WHERE funding.club_id=
                'c2000000-0000-4000-8000-000000000001')<>1
     OR (SELECT count(*)
           FROM unnest(v_receipt.source_wallet_club_ids) funding(club_id)
          WHERE funding.club_id=
                'c2000000-0000-4000-8000-000000000002')<>1
     OR EXISTS (
       SELECT 1 FROM public.rake_records source
        WHERE source.id=ANY(v_receipt.fee_source_rake_record_ids)
          AND (source.club_id IS DISTINCT FROM
                 'c2000000-0000-4000-8000-000000000002'
            OR source.rake_amount<=0))
     OR NOT EXISTS (
       SELECT 1 FROM public.rake_records reversal
        WHERE reversal.id=ANY(v_receipt.fee_reversal_ids)
          AND reversal.club_id=
                'c2000000-0000-4000-8000-000000000002'
          AND reversal.rake_amount=-15
          AND reversal.source='fn_unregister_from_tournament'
          AND reversal.metadata->>'kind'='tournament_fee_refund'
          AND reversal.metadata->>'fee_recipient_club_id'=
                'c2000000-0000-4000-8000-000000000002'
          AND ARRAY(
                SELECT raw.id::uuid
                  FROM jsonb_array_elements_text(
                    reversal.metadata->'original_rake_record_ids') raw(id)
                 ORDER BY raw.id::uuid)
              IS NOT DISTINCT FROM v_receipt.fee_source_rake_record_ids)
     OR EXISTS (
       SELECT 1 FROM public.rake_records reversal
        WHERE reversal.tournament_id=
                'c3000000-0000-4000-8000-000000000001'
          AND reversal.rake_amount<0
          AND reversal.club_id=
                'c2000000-0000-4000-8000-000000000001')
     OR (SELECT chip_balance FROM public.club_members
          WHERE club_id='c2000000-0000-4000-8000-000000000001'
            AND user_id='c1000000-0000-4000-8000-000000000001')
          IS DISTINCT FROM 1000
     OR (SELECT chip_balance FROM public.club_members
          WHERE club_id='c2000000-0000-4000-8000-000000000002'
            AND user_id='c1000000-0000-4000-8000-000000000001')
          IS DISTINCT FROM 200
     OR EXISTS (
       SELECT 1 FROM public.tournament_players tp
        WHERE tp.tournament_id='c3000000-0000-4000-8000-000000000001'
          AND tp.user_id='c1000000-0000-4000-8000-000000000001')
     OR NOT EXISTS (
       SELECT 1 FROM public.tournaments t
        WHERE t.id='c3000000-0000-4000-8000-000000000001'
          AND t.current_players=0 AND t.prize_pool=0
          AND t.bounty_pool=0 AND t.total_rake=0) THEN
    RAISE EXCEPTION
      'FAIL cross-club unregistration did not conserve exact wallet/fee books: %',
      v_result;
  END IF;

  RAISE NOTICE
    'AUDIT_TEST_PASS: buy-in debited home Club A, rebuy debited roster Club B, both fee rows credited tournament Club B, unregistration returned each charge to its own funding club, reversed both exact rake sources only in B, and persisted immutable source/reversal IDs; fixture rolls back';
END;
$assert$;

-- The exact same request id is an outcome read, not a second refund. Prove the
-- public wrapper returns the durable receipt and does not add a credit,
-- tranche, fee reversal, or receipt.
SET LOCAL ROLE authenticated;
CREATE TEMP TABLE cross_club_unregister_replay(value jsonb NOT NULL)
  ON COMMIT DROP;
INSERT INTO cross_club_unregister_replay(value)
SELECT public.fn_unregister_from_tournament(
  'c3000000-0000-4000-8000-000000000001',
  'c5000000-0000-4000-8000-000000000001');
RESET ROLE;

DO $replay$
DECLARE
  v_first jsonb:=(SELECT value FROM cross_club_unregister_result);
  v_replay jsonb:=(SELECT value FROM cross_club_unregister_replay);
BEGIN
  IF COALESCE((v_replay->>'ok')::boolean,false) IS NOT TRUE
     OR COALESCE((v_replay->>'replayed')::boolean,false) IS NOT TRUE
     OR (v_replay-'replayed') IS DISTINCT FROM (v_first-'replayed')
     OR (SELECT count(*)
           FROM public.tournament_unregistration_receipts receipt
          WHERE receipt.request_id=
                  'c5000000-0000-4000-8000-000000000001')<>1
     OR (SELECT count(*)
           FROM public.tournament_refund_tranches tranche
          WHERE tranche.tournament_id=
                  'c3000000-0000-4000-8000-000000000001'
            AND tranche.user_id=
                  'c1000000-0000-4000-8000-000000000001')<>2
     OR (SELECT count(*)
           FROM public.rake_records reversal
          WHERE reversal.tournament_id=
                  'c3000000-0000-4000-8000-000000000001'
            AND reversal.rake_amount<0
            AND reversal.source='fn_unregister_from_tournament')<>1
     OR (SELECT chip_balance FROM public.club_members
          WHERE club_id='c2000000-0000-4000-8000-000000000001'
            AND user_id='c1000000-0000-4000-8000-000000000001')
          IS DISTINCT FROM 1000
     OR (SELECT chip_balance FROM public.club_members
          WHERE club_id='c2000000-0000-4000-8000-000000000002'
            AND user_id='c1000000-0000-4000-8000-000000000001')
          IS DISTINCT FROM 200 THEN
    RAISE EXCEPTION
      'FAIL same-request replay changed cross-club unregistration state: %',
      v_replay;
  END IF;
END;
$replay$;

-- The receipt and every positive/negative rake row it names are the replay's
-- source of truth. Their database triggers must reject direct mutation even
-- by this superuser probe; no watcher or later reconciler is involved.
DO $immutability$
DECLARE
  v_receipt public.tournament_unregistration_receipts%ROWTYPE;
  v_source_blocked boolean:=false;
  v_reversal_blocked boolean:=false;
  v_receipt_blocked boolean:=false;
BEGIN
  SELECT * INTO STRICT v_receipt
    FROM public.tournament_unregistration_receipts receipt
   WHERE receipt.request_id='c5000000-0000-4000-8000-000000000001';

  BEGIN
    UPDATE public.rake_records
       SET metadata=metadata||jsonb_build_object('_probe_mutation',true)
     WHERE id=v_receipt.fee_source_rake_record_ids[1];
  EXCEPTION WHEN SQLSTATE '55000' THEN
    v_source_blocked:=true;
  END;

  BEGIN
    DELETE FROM public.rake_records
     WHERE id=v_receipt.fee_reversal_ids[1];
  EXCEPTION WHEN SQLSTATE '55000' THEN
    v_reversal_blocked:=true;
  END;

  BEGIN
    UPDATE public.tournament_unregistration_receipts
       SET fees_reversed=fees_reversed
     WHERE registration_id=v_receipt.registration_id;
  EXCEPTION WHEN SQLSTATE '55000' THEN
    v_receipt_blocked:=true;
  END;

  IF NOT v_source_blocked OR NOT v_reversal_blocked
     OR NOT v_receipt_blocked THEN
    RAISE EXCEPTION
      'FAIL unregistration evidence was mutable (source %, reversal %, receipt %)',
      v_source_blocked,v_reversal_blocked,v_receipt_blocked;
  END IF;

  RAISE NOTICE
    'AUDIT_TEST_PASS: identical request replays one immutable cross-club receipt with no second money movement; receipt, positive rake sources, and negative rake reversals all reject direct mutation';
END;
$immutability$;

ROLLBACK;
