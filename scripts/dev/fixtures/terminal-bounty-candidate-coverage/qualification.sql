BEGIN;
DO $$
DECLARE x jsonb;t uuid;r jsonb;before_state jsonb;mode text;label text;o uuid;first_result jsonb;
BEGIN
 FOREACH mode IN ARRAY ARRAY['regular','pko','mystery_pre','mystery_active'] LOOP
  FOREACH label IN ARRAY ARRAY['pending','eliminated','rebought','winner'] LOOP
   x:=fixture_terminal_case(mode);t:=(x->>'t')::uuid;
   UPDATE tournament_knockout_candidates SET state=label WHERE tournament_id=t;
   IF mode='mystery_active' THEN
    INSERT INTO tournament_bounty_chests(tournament_id,seq,tier,amount_cents) VALUES(t,1,'base',1000);
    UPDATE tournaments SET mystery_bounty_stage='active',mystery_bounty_activation_generation=1,
     mystery_bounty_pool_cents=1000,mystery_bounty_activated_at=clock_timestamp() WHERE id=t;
   END IF;
   before_state:=fixture_terminal_snapshot(t);
   r:=fn_finalize_bounty_pool(t,(x->>'b')::uuid);
   PERFORM fixture_assert(r->>'ok'='false' AND r->>'reason'='unclaimed_bounty_candidate'
    AND r->>'candidate_id' IS NOT NULL,'ordinary refuses exact missing '||mode||' '||label);
   PERFORM fixture_assert(fixture_terminal_snapshot(t)=before_state,'ordinary refusal preserves all financial and receipt state');
   IF mode LIKE 'mystery%' THEN
    r:=fn_mystery_bounty_settle(t,(x->>'b')::uuid);
    PERFORM fixture_assert(r->>'ok'='false' AND r->>'reason'='unclaimed_bounty_candidate',
     'mystery refuses exact missing head before residual or void');
    PERFORM fixture_assert(fixture_terminal_snapshot(t)=before_state,'mystery refusal preserves all financial and receipt state');
   END IF;
  END LOOP;
 END LOOP;

 x:=fixture_terminal_case();t:=(x->>'t')::uuid;
 UPDATE hand_history SET winners='[]' WHERE id=(x->>'hand')::uuid;
 before_state:=fixture_terminal_snapshot(t);
 r:=fn_finalize_bounty_pool(t,(x->>'b')::uuid);
 PERFORM fixture_assert(r->>'reason'='bounty_candidate_evidence_unknown','unknown attribution cannot establish champion entitlement');
 PERFORM fixture_assert(fixture_terminal_snapshot(t)=before_state,'unknown attribution cannot pay or close');

 x:=fixture_terminal_case();t:=(x->>'t')::uuid;
 UPDATE hand_atomic_commits SET stack_result=jsonb_set(stack_result,'{written}','{}') WHERE hand_id=(x->>'hand')::uuid;
 r:=fn_finalize_bounty_pool(t,(x->>'b')::uuid);
 PERFORM fixture_assert(r->>'reason'='bounty_candidate_evidence_unknown','invalid accepted evidence refuses terminal allocation');

 -- Actual local claim and collector produce the original complete marker.
 x:=fixture_terminal_case();t:=(x->>'t')::uuid;
 r:=fixture_claim(t,(x->>'a')::uuid,(x->>'b')::uuid,2);o:=(r->>'obligation_id')::uuid;
 PERFORM fixture_assert(o IS NOT NULL,'native accepted claim creates exact terminal obligation');
 before_state:=fixture_terminal_snapshot(t);
 r:=fn_finalize_bounty_pool(t,(x->>'b')::uuid);
 PERFORM fixture_assert(r->>'reason'='pending_bounty_obligations','existing pending obligation retains its original refusal');
 PERFORM fixture_assert(fixture_terminal_snapshot(t)=before_state,'existing pending refusal has no partial state');
 r:=fn_collect_bounty_obligation(o);
 PERFORM fixture_assert(r->>'ok'='true' AND fn_bounty_obligation_has_complete_marker(o),'actual local collector creates complete exact marker');
 r:=fn_finalize_bounty_pool(t,(x->>'b')::uuid);first_result:=r;
 PERFORM fixture_assert(r->>'ok'='true' AND (r->>'residual')::numeric=7.50,'champion receives correct own and accumulated head after prior bounty');
 PERFORM fixture_assert((SELECT sum(amount)=10 FROM wallet_transactions WHERE related_entity_id=t),'terminal exact bounty cash conserves funded pool');
 UPDATE tournament_players SET current_bounty=999,status='eliminated',position=NULL WHERE tournament_id=t;
 UPDATE tournament_knockout_candidates SET seat_joined_at=seat_joined_at+interval '1 microsecond' WHERE tournament_id=t;
 before_state:=fixture_terminal_snapshot(t);
 r:=fn_finalize_bounty_pool(t,(x->>'b')::uuid);
 PERFORM fixture_assert(r=first_result,'ordinary immutable receipt wins after standing and candidate changes');
 PERFORM fixture_assert(fixture_terminal_snapshot(t)=before_state,'ordinary replay neither pays nor reconstructs state');

 -- Another seat generation's complete marker cannot cover this candidate.
 x:=fixture_terminal_case();t:=(x->>'t')::uuid;
 r:=fixture_claim(t,(x->>'a')::uuid,(x->>'b')::uuid,2);o:=(r->>'obligation_id')::uuid;
 r:=fn_collect_bounty_obligation(o);
 UPDATE tournament_knockout_candidates SET seat_joined_at=seat_joined_at+interval '1 microsecond' WHERE tournament_id=t;
 r:=fn_finalize_bounty_pool(t,(x->>'b')::uuid);
 PERFORM fixture_assert(r->>'reason'='unclaimed_bounty_candidate','microsecond-distinct generation is not covered by a different complete marker');

 x:=fixture_terminal_case('mystery_pre');t:=(x->>'t')::uuid;
 r:=fixture_claim(t,(x->>'a')::uuid,(x->>'b')::uuid,2);o:=(r->>'obligation_id')::uuid;
 r:=fn_collect_bounty_obligation(o);
 PERFORM fixture_assert(r->>'ok'='true','pre-activation head pays through actual collector');
 r:=fn_mystery_bounty_settle(t,(x->>'b')::uuid);first_result:=r;
 PERFORM fixture_assert(r->>'ok'='true' AND r->>'reason'='never_activated','never activated mystery closes after pre-phase liability is covered');
 UPDATE tournament_knockout_candidates SET seat_joined_at=seat_joined_at+interval '1 microsecond' WHERE tournament_id=t;
 UPDATE tournament_players SET status='eliminated',position=NULL WHERE tournament_id=t;
 before_state:=fixture_terminal_snapshot(t);
 r:=fn_mystery_bounty_settle(t,(x->>'b')::uuid);
 PERFORM fixture_assert(r=first_result,'mystery immutable receipt wins after underlying generation changes');
 PERFORM fixture_assert(fixture_terminal_snapshot(t)=before_state,'mystery replay leaves money inventory and receipts untouched');

 x:=fixture_terminal_case('regular');t:=(x->>'t')::uuid;
 UPDATE tournaments SET is_bounty=false,is_pko=false,is_mystery_bounty=false WHERE id=t;
 r:=fn_finalize_bounty_pool(t,(x->>'b')::uuid);
 PERFORM fixture_assert(r->>'ok'='true' AND r->>'reason'='not_a_bounty_tournament','ordinary non-bounty completion is outside bounty candidate guard');
END $$;
ROLLBACK;
