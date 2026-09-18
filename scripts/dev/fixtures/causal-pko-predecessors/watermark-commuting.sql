-- Same actual caller and financial oracle before/after the successor helper.
SELECT set_config('fixture.watermark_repaired', :'watermark_repaired',false);
BEGIN;
DO $$
DECLARE t uuid;r jsonb;o1 uuid;o2 uuid;shared boolean; expected boolean:=current_setting('fixture.watermark_repaired')::boolean;
 a uuid:='a0000000-0000-4000-8000-000000000001';b uuid:='b0000000-0000-4000-8000-000000000001';
 c uuid:='c0000000-0000-4000-8000-000000000001';d uuid:='d0000000-0000-4000-8000-000000000001';
 before_state jsonb;
BEGIN
 FOREACH shared IN ARRAY ARRAY[false,true] LOOP
  t:=fixture_event('Independent same-table accepted heads',ARRAY[a,b,c,d]::text[],5);
  UPDATE tournaments SET is_mystery_bounty=false,is_pko=true WHERE id=t;
  PERFORM fixture_bust(t,a,b,6400001,clock_timestamp()-interval '5 seconds');
  PERFORM fixture_bust(t,c,CASE WHEN shared THEN b ELSE d END,6400002,clock_timestamp());
  r:=fixture_claim(t,c,CASE WHEN shared THEN b ELSE d END,4);o2:=(r->>'obligation_id')::uuid;
  PERFORM fixture_assert(r->>'ok'='true' AND o2 IS NOT NULL,'later independent head claim');
  r:=fn_collect_bounty_obligation(o2);
  PERFORM fixture_assert(r->>'ok'='true' AND r->>'marker_verified'='true','later independent head pays exactly');
  before_state:=fixture_causal_snapshot(t);
  r:=fixture_claim(t,a,b,3);
  IF NOT expected THEN
   PERFORM fixture_assert(r->>'ok'='false' AND r->>'reason'='pko_order_unproven'
    AND r->'watermark_proof'->>'reason'='watermark_shared_head_not_causally_prior',
    'original same-table/common-collector refusal reproduced');
   PERFORM fixture_assert(before_state=fixture_causal_snapshot(t),'original refusal leaves exact state unchanged');
   CONTINUE;
  END IF;
  o1:=(r->>'obligation_id')::uuid;
  PERFORM fixture_assert(r->>'ok'='true' AND o1 IS NOT NULL,'independent earlier head admitted below watermark');
  r:=fn_collect_bounty_obligation(o1);
  PERFORM fixture_assert(r->>'ok'='true' AND (r->>'paid_cash')::numeric=2.5 AND (r->>'added_to_head')::numeric=2.5,'independent earlier head exact cash/carry');
  PERFORM fixture_assert((SELECT sum(amount)=5 AND count(*)=2 FROM wallet_transactions WHERE related_entity_id=t),'two heads conserve exact cash');
  PERFORM fixture_assert((SELECT current_bounty=CASE WHEN shared THEN 10 ELSE 7.5 END FROM tournament_players WHERE tournament_id=t AND user_id=b),'collector additions commute exactly');
  PERFORM fixture_assert((SELECT last_settled_hand_number=6400002 AND last_obligation_id=o2 FROM tournament_pko_settlement_watermarks WHERE tournament_id=t),'higher watermark remains immutable');
  before_state:=fixture_causal_snapshot(t);
  r:=fn_collect_bounty_obligation(o1);
  PERFORM fixture_assert(r->>'already'='true' AND r->>'marker_verified'='true' AND before_state=fixture_causal_snapshot(t),'earlier duplicate returns receipt without payment');
 END LOOP;
END $$;
ROLLBACK;
