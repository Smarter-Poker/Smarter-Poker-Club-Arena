SET request.jwt.claims='{"role":"service_role","sub":"00000000-0000-0000-0000-000000000900"}';
-- All accepted rows come through the exact current twelve-argument public
-- lease-fenced wrapper. No final payload or financial receipt is hand-seeded.
CREATE FUNCTION fixture.commit_through_outer(n bigint,original_manifest boolean) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE roster jsonb; stacks jsonb; manifest uuid; facts jsonb; hand jsonb; obligations jsonb; result jsonb;
BEGIN
 UPDATE engine_table_leases SET heartbeat_at=pg_catalog.clock_timestamp() WHERE table_id=fixture.u(305);
 SELECT jsonb_agg(jsonb_build_object('user_id',s.user_id,'seat_id',s.id,'occupancy_id',s.occupancy_id,'seat_joined_at',s.joined_at,'stack_before',s.stack,'is_horse',p.is_horse) ORDER BY s.user_id) INTO roster
 FROM table_seats s JOIN profiles p ON p.id=s.user_id WHERE s.table_id=fixture.u(305) AND s.left_at IS NULL;
 IF original_manifest THEN
  PERFORM fn_cash_capture_hand_manifest(fixture.u(305),n,roster,'weekly-raked-native',fixture.u(602));
  SELECT id INTO manifest FROM cash_hand_participant_manifests WHERE table_id=fixture.u(305) AND hand_number=n;
 END IF;
 SELECT jsonb_agg((x-'is_horse')||jsonb_build_object('stack',x->'stack_before')||CASE WHEN manifest IS NOT NULL THEN jsonb_build_object('funding_manifest_id',manifest) ELSE '{}'::jsonb END ORDER BY x->>'user_id') INTO stacks FROM jsonb_array_elements(roster) x;
 SELECT jsonb_build_object('contributions',jsonb_object_agg(x->>'user_id',0),'returned_uncalled','{}'::jsonb,'insurance','[]'::jsonb) INTO facts FROM jsonb_array_elements(roster) x;
 hand:=jsonb_build_object('table_id',fixture.u(305),'hand_number',n,'pot_size',0,'big_blind',4,'_accepted_post_commit_facts',facts);
 obligations:=jsonb_build_object('version',1,'time_banks',(SELECT jsonb_agg(jsonb_build_object('user_id',s.user_id,'seat_id',s.id,'seat_joined_at',s.joined_at,'uses_remaining',COALESCE(s.time_bank_uses_remaining,0),'seconds_remaining',COALESCE(s.time_bank_remaining,0)) ORDER BY s.user_id) FROM table_seats s WHERE s.table_id=fixture.u(305) AND s.left_at IS NULL),'promo_playthrough','[]'::jsonb,'insurance','[]'::jsonb,'rake',NULL,'bbj_contribution',NULL,'pending_addons',jsonb_build_object('enabled',true,'max_buy_in',1000));
 result:=fn_ca_commit_hand_settlement(fixture.u(305),n,stacks,0,0,NULL,0,hand,'[]','weekly-raked-native',fixture.u(602),obligations);
 PERFORM fixture.assert(result->>'success'='true' AND result->>'post_commit_obligations'='true','Actual current outer owner accepts hand and seals original obligations: '||result::text);
 RETURN result;
END $$;
SELECT fixture.commit_through_outer(1000703,true);
SELECT fixture.assert((SELECT manifest_id IS NOT NULL FROM cash_hand_provenance_receipts WHERE table_id=fixture.u(305) AND hand_number=1000703),'Red control has a real original predeal manifest');
SELECT fixture.assert(fn_pnl_cash_hand_evidence(fixture.u(305),1000703)->>'reason'='live_atomic_receipt_conflicts_with_original','Original reader wrongly refuses canonical outer-owner sealing');
SELECT fixture.assert((SELECT evidence->>'reason'='live_atomic_receipt_conflicts_with_original' FROM union_pnl_cash_outcomes WHERE table_id=fixture.u(305) AND hand_number=1000703),'Deferred weekly trigger reproduces the same actual outer-seal conflict');
