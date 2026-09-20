BEGIN;
SET LOCAL statement_timeout='60s';
SET LOCAL request.jwt.claim.role='service_role';
SET LOCAL request.jwt.claims='{"role":"service_role"}';
CREATE FUNCTION pg_temp.assert_elimination(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'ELIMINATION FAIL: %',label; END IF;
RAISE NOTICE 'ELIMINATION PASS: %',label; END $$;
CREATE FUNCTION pg_temp.claim_elimination(n integer) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE c public.tournament_knockout_candidates; BEGIN
SELECT * INTO STRICT c FROM public.tournament_knockout_candidates WHERE hand_number=9720000+n;
IF n=4 THEN RETURN public.fn_eliminate_tournament_player_atomic(c.tournament_id,c.eliminated_user_id,2,0,0); END IF;
RETURN public.fn_claim_tournament_bounty_elimination(c.tournament_id,c.eliminated_user_id,2,0,c.table_id,c.hand_id,c.hand_number,c.seat_joined_at,NULL,NULL,0,false);
END $$;
CREATE TEMP TABLE park_before AS SELECT * FROM smarter_private.f06_operations WHERE source_table_id::text LIKE 'b7300000-%';
CREATE FUNCTION pg_temp.elimination_state() RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE names text; result jsonb:='{}'; value jsonb; BEGIN
 FOREACH names IN ARRAY ARRAY['public.tournament_players','public.table_seats','public.tournament_knockout_candidates',
 'public.tournament_bounty_obligations','public.tournament_bounties','public.wallet_transactions','public.wallet_credit_idempotency',
 'public.tournament_bounty_awards','public.tournament_bounty_award_recipients','public.tournament_bounty_chests',
 'public.tournament_escrow','public.club_members','public.chip_ledger',
 'smarter_private.f06_operations','smarter_private.f06_elimination_dispatch','smarter_private.f06_hand_dispatch','smarter_private.f06_dispatch'] LOOP
 EXECUTE format('SELECT coalesce(jsonb_agg(j ORDER BY j::text),''[]''::jsonb) FROM (SELECT to_jsonb(r) j FROM %s r) q',names) INTO value;
 result:=result||jsonb_build_object(names,value);
 END LOOP; RETURN result;
END $$;
SELECT pg_temp.assert_elimination(NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='smarter_private.f06_elimination_dispatch'::regclass AND contype='f'),'authorization table has no hot-table foreign key');
SELECT pg_temp.assert_elimination((SELECT relrowsecurity AND pg_get_userbyid(relowner)='postgres' FROM pg_class WHERE oid='smarter_private.f06_elimination_dispatch'::regclass)
 AND NOT has_table_privilege('service_role','smarter_private.f06_elimination_dispatch','INSERT')
 AND NOT has_table_privilege('authenticated','smarter_private.f06_elimination_dispatch','INSERT')
 AND NOT has_table_privilege('anon','smarter_private.f06_elimination_dispatch','INSERT'),'only postgres can mint private authorization');
DO $permissions$ BEGIN
 BEGIN
 SET LOCAL ROLE service_role;
 INSERT INTO smarter_private.f06_elimination_dispatch VALUES(txid_current(),'tournament_players',gen_random_uuid(),gen_random_uuid(),'{}','{}');
 RAISE EXCEPTION 'service role forged authorization';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 PERFORM pg_temp.assert_elimination(NOT EXISTS(SELECT 1 FROM smarter_private.f06_elimination_dispatch),'service role mint refused without leaked row');
END $permissions$;
-- Fault injection is confined to this rollback fixture. Neither stored money
-- authority nor source custody is weakened to obtain an accepted claim.
CREATE FUNCTION pg_temp.elimination_fault() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE mode text:=current_setting('fixture.elimination_fault',true); BEGIN
 IF NEW.status='eliminated' AND OLD.status='playing' THEN
  IF mode='image' THEN NEW.position:=99;
  ELSIF mode='candidate' AND TG_WHEN='BEFORE' OR mode='candidate_after' AND TG_WHEN='AFTER' THEN UPDATE public.tournament_knockout_candidates SET state='rebought' WHERE tournament_id=OLD.tournament_id AND eliminated_user_id=OLD.user_id AND state='pending';
  ELSIF mode='late_failure' AND TG_WHEN='AFTER' THEN RAISE EXCEPTION 'FIXTURE_AFTER_ELIMINATION_FAILURE';
  ELSIF mode='cas_miss' THEN RETURN NULL;
  END IF;
 END IF; RETURN NEW;
END $$;
CREATE TRIGGER "000_fixture_image" BEFORE UPDATE ON public.tournament_players FOR EACH ROW EXECUTE FUNCTION pg_temp.elimination_fault();
CREATE TRIGGER "zzz_fixture_failure" AFTER UPDATE ON public.tournament_players FOR EACH ROW EXECUTE FUNCTION pg_temp.elimination_fault();
DO $negative$ DECLARE n integer; mode text; before jsonb; r jsonb; c public.tournament_knockout_candidates; expected text; BEGIN
 FOR n IN 1..4 LOOP
  SELECT * INTO STRICT c FROM public.tournament_knockout_candidates WHERE hand_number=9720000+n;
  FOREACH mode IN ARRAY ARRAY['image','candidate','candidate_after','late_failure','cas_miss','custody','manifest','reused_seat','nonzero','missing_atomic','no_live_seat'] LOOP
   before:=pg_temp.elimination_state();
   BEGIN
    IF mode IN ('image','candidate','candidate_after','late_failure','cas_miss') THEN PERFORM set_config('fixture.elimination_fault',mode,true);
    ELSIF mode='custody' THEN UPDATE smarter_private.f06_operations SET custody_id=gen_random_uuid(),custody_generation=origin_generation WHERE source_table_id=c.table_id;
    ELSIF mode='manifest' THEN UPDATE smarter_private.f06_operations SET manifest='[]',state='begun' WHERE source_table_id=c.table_id;
    ELSE
     SET LOCAL session_replication_role=replica;
     IF mode='reused_seat' THEN UPDATE public.table_seats SET joined_at=clock_timestamp() WHERE id=c.seat_id;
     ELSIF mode='nonzero' THEN UPDATE public.tournament_players SET chips=1 WHERE tournament_id=c.tournament_id AND user_id=c.eliminated_user_id;
     ELSIF mode='missing_atomic' THEN DELETE FROM public.hand_atomic_commits WHERE hand_id=c.hand_id;
     ELSIF mode='no_live_seat' THEN UPDATE public.table_seats SET left_at=clock_timestamp(),status='left',active_game_scope=NULL,active_parent_key=NULL WHERE id=c.seat_id;
     END IF;
     SET LOCAL session_replication_role=origin;
    END IF;
    r:=pg_temp.claim_elimination(n);
    IF mode='no_live_seat' THEN
     IF r->>'ok' IS DISTINCT FROM 'true' OR r->>'claimed' IS DISTINCT FROM 'true' OR EXISTS(SELECT 1 FROM smarter_private.f06_elimination_dispatch) THEN
      RAISE EXCEPTION 'missing-seat claim did not complete cleanly: %',r; END IF;
    ELSIF mode IN ('reused_seat','nonzero','missing_atomic') THEN
     IF r->>'ok' IS DISTINCT FROM 'false' OR EXISTS(SELECT 1 FROM smarter_private.f06_elimination_dispatch) THEN RAISE EXCEPTION 'logical rejection failed: % %',mode,r; END IF;
    ELSE RAISE EXCEPTION 'expected exact source/authority refusal: % %',mode,r;
    END IF;
    RAISE EXCEPTION 'FIXTURE_ROLLBACK_AFTER_EXPECTED_RESULT' USING ERRCODE='P0999';
   EXCEPTION WHEN OTHERS THEN
    IF mode IN ('image','candidate','candidate_after','custody','manifest') AND SQLERRM='F06_SOURCE_EXCLUDED' THEN NULL;
    ELSIF mode='late_failure' AND SQLERRM='FIXTURE_AFTER_ELIMINATION_FAILURE' THEN NULL;
    ELSIF mode='cas_miss' AND SQLSTATE='40001' THEN NULL;
    ELSIF mode='missing_atomic' AND SQLERRM='REBUY_ATOMIC_HAND_REQUIRED: candidate is not the exact accepted zero hand' THEN NULL;
    ELSIF mode IN ('reused_seat','nonzero','missing_atomic','no_live_seat') AND SQLSTATE='P0999' THEN NULL;
    ELSE RAISE; END IF;
   END;
   PERFORM pg_temp.assert_elimination(pg_temp.elimination_state()=before,n||': '||mode||' leaves complete state/authorization unchanged');
  END LOOP;
  IF n<>4 THEN
   before:=pg_temp.elimination_state();
   r:=public.fn_claim_tournament_bounty_elimination(c.tournament_id,c.eliminated_user_id,2,0,c.table_id,gen_random_uuid(),c.hand_number,c.seat_joined_at,NULL,NULL,0,false);
   PERFORM pg_temp.assert_elimination(r->>'ok'='false' AND pg_temp.elimination_state()=before,n||': mismatched hand cannot mint authorization');
  END IF;
 END LOOP;
END $negative$;
DROP TRIGGER "000_fixture_image" ON public.tournament_players;
DROP TRIGGER "zzz_fixture_failure" ON public.tournament_players;
DO $wrong_authorization$ DECLARE mode text;p public.tournament_players;c public.tournament_knockout_candidates;before jsonb; BEGIN
 SELECT * INTO STRICT c FROM public.tournament_knockout_candidates WHERE hand_number=9720001;
 SELECT * INTO STRICT p FROM public.tournament_players WHERE tournament_id=c.tournament_id AND user_id=c.eliminated_user_id;
 FOREACH mode IN ARRAY ARRAY['other_transaction','other_candidate','other_image'] LOOP
 before:=pg_temp.elimination_state();
 BEGIN
  -- Deliberate privileged fixture corruption. Actual API roles cannot create
  -- any row here, as the permission case above independently proves.
  INSERT INTO smarter_private.f06_elimination_dispatch(xid,relation_name,row_id,candidate_id,old_record,new_record)
  VALUES(CASE WHEN mode='other_transaction' THEN txid_current()-1 ELSE txid_current() END,'tournament_players',p.id,
   CASE WHEN mode='other_candidate' THEN (SELECT id FROM public.tournament_knockout_candidates WHERE hand_number=9720002) ELSE c.id END,
   to_jsonb(p),to_jsonb(p)||jsonb_build_object('status','eliminated','position',CASE WHEN mode='other_image' THEN 99 ELSE 2 END));
  UPDATE public.tournament_players SET status='eliminated',position=2 WHERE id=p.id;
  RAISE EXCEPTION 'mismatched private authorization admitted';
 EXCEPTION WHEN SQLSTATE '55000' THEN IF SQLERRM<>'F06_SOURCE_EXCLUDED' THEN RAISE; END IF; END;
 PERFORM pg_temp.assert_elimination(pg_temp.elimination_state()=before,mode||': private authorization mismatch refused atomically');
 END LOOP;
END $wrong_authorization$;
DO $cases$ DECLARE n integer;r jsonb;again jsonb; c public.tournament_knockout_candidates; BEGIN
 FOR n IN 1..4 LOOP
  SELECT * INTO STRICT c FROM public.tournament_knockout_candidates WHERE hand_number=9720000+n;
  BEGIN
   UPDATE public.tournament_players SET status='eliminated',position=2 WHERE tournament_id=c.tournament_id AND user_id=c.eliminated_user_id;
   RAISE EXCEPTION 'direct edit incorrectly admitted';
  EXCEPTION WHEN SQLSTATE '55000' THEN
   IF SQLERRM<>'F06_SOURCE_EXCLUDED' THEN RAISE; END IF;
  END;
  PERFORM pg_temp.assert_elimination((SELECT status='playing' FROM public.tournament_players WHERE tournament_id=c.tournament_id AND user_id=c.eliminated_user_id),n||': direct status edit remains refused');
  r:=pg_temp.claim_elimination(n);
  PERFORM pg_temp.assert_elimination(r->>'ok'='true' AND r->>'claimed'='true',n||': actual public accepted claim succeeds '||r);
  PERFORM pg_temp.assert_elimination((SELECT status='eliminated' AND position=2 AND chips=0 FROM public.tournament_players WHERE tournament_id=c.tournament_id AND user_id=c.eliminated_user_id),n||': exact zero registration eliminated');
  PERFORM pg_temp.assert_elimination((SELECT left_at IS NOT NULL AND stack=0 FROM public.table_seats WHERE id=c.seat_id),n||': exact zero seat closed');
  PERFORM pg_temp.assert_elimination(NOT EXISTS(SELECT 1 FROM smarter_private.f06_elimination_dispatch),n||': authorization consumed and cleaned');
  again:=pg_temp.claim_elimination(n);
  PERFORM pg_temp.assert_elimination(again->>'ok'='true' AND again->>'already'='true',n||': exact duplicate replay succeeds');
  PERFORM pg_temp.assert_elimination((SELECT state='eliminated' FROM public.tournament_knockout_candidates WHERE id=c.id),n||': causal candidate resolved');
  BEGIN
   UPDATE public.tournament_players SET status='playing' WHERE tournament_id=c.tournament_id AND user_id=c.eliminated_user_id;
   RAISE EXCEPTION 'authorization was reused after claim';
  EXCEPTION WHEN SQLSTATE '55000' THEN IF SQLERRM<>'F06_SOURCE_EXCLUDED' THEN RAISE; END IF; END;
  PERFORM pg_temp.assert_elimination(NOT EXISTS(SELECT 1 FROM smarter_private.f06_elimination_dispatch),n||': later same-transaction status edit refused');
 END LOOP;
END $cases$;
SELECT pg_temp.assert_elimination(NOT EXISTS((SELECT to_jsonb(o) FROM smarter_private.f06_operations o WHERE source_table_id::text LIKE 'b7300000-%') EXCEPT (SELECT to_jsonb(o) FROM park_before o)),'all source parks remain byte-identical');
SELECT pg_temp.assert_elimination(NOT EXISTS(SELECT 1 FROM smarter_private.f06_hand_dispatch) AND NOT EXISTS(SELECT 1 FROM smarter_private.f06_dispatch),'no fake hand or move dispatch');
DO $financial$ DECLARE n integer;c public.tournament_knockout_candidates;r jsonb;before jsonb;expected numeric; BEGIN
 FOR n IN 1..3 LOOP
 SELECT * INTO STRICT c FROM public.tournament_knockout_candidates WHERE hand_number=9720000+n;
 IF n=3 THEN
  before:=pg_temp.elimination_state();
  r:=public.fn_sweep_pending_tournament_bounties(c.tournament_id,20);
  PERFORM pg_temp.assert_elimination(r->>'processed'='0' AND r->>'pending'='1' AND pg_temp.elimination_state()=before,'mystery reveal grace preserves all money');
  -- Only advance the private fixture's scheduling instant; not its booked
  -- inventory, award, claimant, amount, phase or financial proof.
  UPDATE public.tournament_bounty_obligations SET next_attempt_at=now() WHERE tournament_id=c.tournament_id AND state='pending';
 END IF;
 r:=public.fn_sweep_pending_tournament_bounties(c.tournament_id,20);
 expected:=CASE WHEN n=2 THEN 2.5 ELSE 5 END;
 PERFORM pg_temp.assert_elimination(r->>'ok'='true' AND r->>'settled'='1' AND r->>'failed'='0'
 AND (SELECT count(*) FROM public.tournament_bounty_obligations WHERE tournament_id=c.tournament_id AND state='settled'
   AND head_amount=5 AND public.fn_bounty_obligation_has_complete_marker(id))=1,
 n||': real financial settlement has complete exact marker '||r);
 PERFORM pg_temp.assert_elimination((SELECT sum(amount) FROM public.wallet_transactions WHERE related_entity_id=c.tournament_id AND category='bounty')=expected,
 n||': exact booked bounty cash paid once');
 IF n=2 THEN
  PERFORM pg_temp.assert_elimination((SELECT current_bounty FROM public.tournament_players WHERE tournament_id=c.tournament_id AND user_id<>c.eliminated_user_id)=7.5,'PKO cash/head split unchanged');
 END IF;
 before:=pg_temp.elimination_state();
 r:=public.fn_sweep_pending_tournament_bounties(c.tournament_id,20);
 PERFORM pg_temp.assert_elimination(r->>'processed'='0' AND pg_temp.elimination_state()=before,n||': settlement replay changes no money or authorization');
 END LOOP;
END $financial$;
SET CONSTRAINTS ALL IMMEDIATE;
SELECT 'F06_ACCEPTED_ELIMINATION_PASS';
ROLLBACK;
