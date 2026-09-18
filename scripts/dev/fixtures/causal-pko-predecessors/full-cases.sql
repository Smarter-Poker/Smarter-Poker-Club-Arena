BEGIN;
SET LOCAL request.jwt.claim.role='service_role';
SET LOCAL request.jwt.claims='{"role":"service_role"}';
CREATE FUNCTION pg_temp.assert_watermark(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'WATERMARK FAIL: %',label; END IF;
RAISE NOTICE 'WATERMARK PASS: %',label; END $$;
CREATE FUNCTION pg_temp.claim_watermark(n integer) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE c public.tournament_knockout_candidates; BEGIN
 SELECT * INTO STRICT c FROM public.tournament_knockout_candidates WHERE hand_number=9720000+n;
 RETURN public.fn_claim_tournament_bounty_elimination(c.tournament_id,c.eliminated_user_id,6-n,0,c.table_id,c.hand_id,c.hand_number,c.seat_joined_at,NULL,NULL,0,false);
END $$;
CREATE FUNCTION pg_temp.watermark_state() RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE names text; result jsonb:='{}';v jsonb; BEGIN
 FOREACH names IN ARRAY ARRAY['tournament_players','table_seats','tournament_knockout_candidates','tournament_bounty_obligations','tournament_bounties','wallet_transactions','wallet_credit_idempotency','tournament_escrow','club_members','chip_ledger','tournament_pko_settlement_watermarks'] LOOP
 EXECUTE format('SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),''[]''::jsonb) FROM public.%I t',names) INTO v;
 result:=result||jsonb_build_object(names,v); END LOOP; RETURN result; END $$;
DO $$ DECLARE r jsonb;o uuid;before jsonb;shared boolean:=current_setting('fixture.watermark_shared')::boolean; BEGIN
 r:=pg_temp.claim_watermark(3);o:=(r->>'obligation_id')::uuid;
 PERFORM pg_temp.assert_watermark(r->>'ok'='true' AND o IS NOT NULL,'actual public later claim succeeds: '||r::text);
 r:=public.fn_collect_bounty_obligation(o);
 PERFORM pg_temp.assert_watermark(r->>'ok'='true' AND r->>'marker_verified'='true','actual later payout succeeds: '||r::text);
 before:=pg_temp.watermark_state();
 r:=pg_temp.claim_watermark(2);
 IF current_setting('fixture.watermark_repaired')='false' THEN
  PERFORM pg_temp.assert_watermark(r->>'ok'='false' AND r->>'reason'='pko_order_unproven' AND r->'watermark_proof'->>'reason'='watermark_shared_head_not_causally_prior','original public caller reproduces exact refusal');
  PERFORM pg_temp.assert_watermark(before=pg_temp.watermark_state(),'refused original caller preserves money and results');
 ELSE
  o:=(r->>'obligation_id')::uuid;
  PERFORM pg_temp.assert_watermark(r->>'ok'='true' AND o IS NOT NULL,'actual public earlier claim succeeds: '||r::text);
  r:=public.fn_collect_bounty_obligation(o);
  PERFORM pg_temp.assert_watermark(r->>'ok'='true' AND r->>'marker_verified'='true' AND (r->>'paid_cash')::numeric=2.5 AND (r->>'added_to_head')::numeric=2.5,'real wallet and carry exact payout: '||r::text);
  PERFORM pg_temp.assert_watermark((SELECT bounty_out=5 AND bounty_balance=15 FROM public.tournament_escrow WHERE tournament_id='b7200000-0000-4000-8000-000000000002'),'actual escrow conserves two cash halves');
  PERFORM pg_temp.assert_watermark((SELECT current_bounty=CASE WHEN shared THEN 10 ELSE 7.5 END AND bounty_winnings=CASE WHEN shared THEN 5 ELSE 2.5 END FROM public.tournament_players WHERE tournament_id='b7200000-0000-4000-8000-000000000002' AND user_id='b7100000-0000-4000-8000-000000000004'),'actual accumulated head and bounty winnings');
  PERFORM pg_temp.assert_watermark((SELECT chip_balance=CASE WHEN shared THEN 5 ELSE 2.5 END FROM public.club_members WHERE club_id='20000000-0000-0000-0000-000000000001' AND user_id='b7100000-0000-4000-8000-000000000004'),'actual member wallet receives exact cash');
  PERFORM pg_temp.assert_watermark((SELECT sum(bounty_amount-added_to_collector_bounty)=5 AND sum(added_to_collector_bounty)=5 AND count(*)=2 FROM public.tournament_bounties WHERE tournament_id='b7200000-0000-4000-8000-000000000002'),'immutable payout markers conserve head/cash');
  PERFORM pg_temp.assert_watermark((SELECT last_settled_hand_number=9720003 FROM public.tournament_pko_settlement_watermarks WHERE tournament_id='b7200000-0000-4000-8000-000000000002'),'original high watermark preserved');
  before:=pg_temp.watermark_state();r:=pg_temp.claim_watermark(2);
  PERFORM pg_temp.assert_watermark(r->>'ok'='true' AND r->>'already'='true' AND before=pg_temp.watermark_state(),'actual public claim duplicate is immutable');
  r:=public.fn_collect_bounty_obligation(o);
  PERFORM pg_temp.assert_watermark(r->>'already'='true' AND r->>'marker_verified'='true' AND before=pg_temp.watermark_state(),'actual collection duplicate is immutable');
 END IF;
END $$;
SELECT 'PKO_WATERMARK_PUBLIC_CASES_PASS';
ROLLBACK;
