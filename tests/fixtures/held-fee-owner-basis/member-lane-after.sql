-- Two existing original events, synthetic completion-time agreements only.
BEGIN;
SET LOCAL request.jwt.claims='{"role":"service_role"}';
CREATE TEMP TABLE lane_before AS SELECT held_fee_fixture.snapshot() state;
CREATE TEMP TABLE lane_context(key text PRIMARY KEY,value text);
INSERT INTO lane_context VALUES
 ('app.ledger_settlement','outer-owner'),
 ('app.ledger_correlation','e1d0f00d-0000-4000-8000-000000000aaa'),
 ('app.ledger_tournament_id','e1d0f00d-0000-4000-8000-000000000bbb'),
 ('app.ledger_hand_id','e1d0f00d-0000-4000-8000-000000000ccc'),
 ('app.ledger_idempotency_key','outer-key'),('app.ledger_category','outer-category'),
 ('app.ledger_counterparty','outer-counterparty'),('app.ledger_counterparty_entity','outer-entity'),
 ('app.ledger_autoledger_club_id','outer-club');
SELECT set_config(key,value,true) FROM lane_context;
DO $$ DECLARE r jsonb;s jsonb;message text;BEGIN
 r:=public.fn_ca_recognize_held_tournament_fees_by_owner_basis(held_fee_fixture.operation(),held_fee_fixture.lane_events());
 PERFORM held_fee_fixture.assert(r->>'ok'='true' AND (r->>'event_count')::int=2 AND (r->>'amount')::numeric=2.94
  AND (r->>'journal_rows')::int=2 AND (r->>'escrow_out')::numeric=2.94 AND (r->>'bank_in')::numeric=2.94
  AND (r->>'recognized_credit')::numeric=2.94 AND (r->>'settlement_suspense_net')::numeric=0,
  'Member lane settles two original events with distinct union and standalone bank legs while cash holds G shared');
 PERFORM held_fee_fixture.assert((SELECT count(*)=2 AND count(DISTINCT tournament_id)=2 AND sum(amount)=2.94
  AND count(*) FILTER(WHERE to_type='union_wallet' AND category='rake' AND amount=2.70)=1
  AND count(*) FILTER(WHERE to_type='chip_retirement' AND category='burn' AND amount=0.24)=1
  AND bool_and(correlation_id=held_fee_fixture.operation() AND hand_id IS NULL AND idempotency_key IS NULL)
  FROM public.chip_ledger WHERE settlement_id='owner-basis:'||held_fee_fixture.operation()),
  'Exactly the two expected bank legs carry their own tournament and operation provenance');
 PERFORM held_fee_fixture.assert(NOT EXISTS(SELECT 1 FROM lane_context WHERE current_setting(key,true) IS DISTINCT FROM value),
  'All inherited ledger contexts are restored after the multi-event operation');
 s:=held_fee_fixture.snapshot();
 r:=public.fn_ca_recognize_held_tournament_fees_by_owner_basis(held_fee_fixture.operation(),held_fee_fixture.lane_events());
 PERFORM held_fee_fixture.assert(r->>'replayed'='true' AND s=held_fee_fixture.snapshot()
  AND NOT EXISTS(SELECT 1 FROM lane_context WHERE current_setting(key,true) IS DISTINCT FROM value),
  'Multi-event replay preserves all money and inherited ledger contexts');
 BEGIN PERFORM public.fn_ca_recognize_held_tournament_fees_by_owner_basis(held_fee_fixture.operation(),held_fee_fixture.lane_events()||jsonb_build_array(jsonb_build_object('tournament_id',gen_random_uuid(),'amount',1)));
 EXCEPTION WHEN SQLSTATE '40001' THEN message:=SQLERRM; END;
 PERFORM held_fee_fixture.assert(message='owner_fee_operation_replayed_with_different_events' AND s=held_fee_fixture.snapshot(),
  'Changed multi-event replay refuses without another transfer');
END $$;
SET CONSTRAINTS ALL IMMEDIATE;
ROLLBACK;
