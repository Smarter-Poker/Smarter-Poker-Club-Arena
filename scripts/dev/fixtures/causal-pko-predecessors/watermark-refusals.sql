BEGIN;
DO $$
DECLARE label text;t uuid;r jsonb;higher uuid;k record;before_state jsonb;expected text;h uuid;
 a uuid:='a0000000-0000-4000-8000-000000000001';b uuid:='b0000000-0000-4000-8000-000000000001';
 c uuid:='c0000000-0000-4000-8000-000000000001';d uuid:='d0000000-0000-4000-8000-000000000001';
 e uuid:='e0000000-0000-4000-8000-000000000001';f uuid:='f0000000-0000-4000-8000-000000000001';
BEGIN
 FOREACH label IN ARRAY ARRAY['marker','accepted','claimants','generation','identity','pending','consume_collector','credit_eliminated','repeat_eliminated'] LOOP
  t:=fixture_event('Watermark exact head refusal',ARRAY[a,b,c,d,e,f]::text[],5);
  UPDATE tournaments SET is_mystery_bounty=false,is_pko=true WHERE id=t;
  -- Construct the retained later settlement before the missing original
  -- candidate, matching the historical partial-order failure being defended.
  h:=fixture_bust(t,CASE label WHEN 'consume_collector' THEN b WHEN 'repeat_eliminated' THEN a ELSE c END,
    CASE WHEN label='credit_eliminated' THEN a ELSE d END,6500002,clock_timestamp()-interval '5 seconds');
  r:=fixture_claim(t,CASE label WHEN 'consume_collector' THEN b WHEN 'repeat_eliminated' THEN a ELSE c END,
    CASE WHEN label='credit_eliminated' THEN a ELSE d END,6);higher:=(r->>'obligation_id')::uuid;
  PERFORM fixture_assert(r->>'ok'='true' AND higher IS NOT NULL,'negative scene later claim: '||label);
  r:=fn_collect_bounty_obligation(higher);
  PERFORM fixture_assert(r->>'ok'='true','negative scene real later payout: '||label);
  -- A current-playing label alone must not erase historical consumed heads.
  UPDATE tournament_players SET status='playing',position=NULL WHERE tournament_id=t AND user_id IN(a,b);
  -- A corrupt reused eliminated identity gets the original seat locally so
  -- this control reaches the causal guard instead of failing seed creation.
  IF label='repeat_eliminated' THEN UPDATE table_seats SET left_at=NULL,joined_at=joined_at+interval '1 second' WHERE user_id=a AND table_id IN(SELECT id FROM tables WHERE tournament_id=t); END IF;
  PERFORM fixture_bust(t,a,b,6500001,clock_timestamp()-interval '10 seconds');
  SELECT * INTO k FROM tournament_knockout_candidates WHERE tournament_id=t AND hand_number=6500001;
  expected:=CASE label
   WHEN 'marker' THEN 'watermark_marker_incomplete'
   WHEN 'accepted' THEN 'watermark_prior_evidence_unproven'
   WHEN 'claimants' THEN 'watermark_prior_claimants_conflict'
   WHEN 'generation' THEN 'watermark_target_generation_unproven'
   WHEN 'identity' THEN 'watermark_prior_candidate_conflict'
   WHEN 'pending' THEN 'watermark_shared_head_pending'
   ELSE 'watermark_shared_head_not_causally_prior' END;
  CASE label
   WHEN 'marker' THEN DELETE FROM tournament_bounties WHERE bounty_obligation_id=higher;
   WHEN 'accepted' THEN DELETE FROM hand_atomic_commits WHERE hand_id=h;
   WHEN 'claimants' THEN
    UPDATE tournament_bounty_obligations SET claimants=jsonb_build_array(jsonb_build_object('user_id',e,'weight',1)) WHERE id=higher;
    UPDATE tournament_bounties SET collector_player_id=e WHERE bounty_obligation_id=higher;
   WHEN 'generation' THEN UPDATE tournament_players SET status='eliminated' WHERE tournament_id=t AND user_id=b;
   WHEN 'identity' THEN UPDATE tournament_bounty_obligations SET seat_joined_at=seat_joined_at-interval '1 second' WHERE id=higher;
   WHEN 'pending' THEN
    PERFORM fixture_bust(t,e,f,6500003,clock_timestamp());
    r:=fixture_claim(t,e,f,5);r:=fn_collect_bounty_obligation((r->>'obligation_id')::uuid);
    UPDATE tournament_bounty_obligations SET state='pending',settled_at=NULL WHERE id=higher;
   ELSE NULL;
  END CASE;
  before_state:=fixture_causal_snapshot(t);
  r:=fn_pko_watermark_admission_status_v1(t,a,k.table_id,k.hand_id,k.hand_number,k.seat_joined_at,jsonb_build_array(jsonb_build_object('user_id',b,'weight',1)));
  PERFORM fixture_assert(r->>'ok'='false' AND r->>'reason'=expected,'exact watermark refusal '||label||': '||r::text);
  PERFORM fixture_assert(before_state=fixture_causal_snapshot(t),'watermark refusal preserves complete state: '||label);
 END LOOP;
END $$;
ROLLBACK;
