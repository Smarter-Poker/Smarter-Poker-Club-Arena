-- @live-proof: (smarter_private.original_inventory_proof_sources_match() AND position('treasury_gift' IN pg_get_functiondef('public.fn_union_pnl_original_flow_evidence(uuid,timestamptz,timestamptz)'::regprocedure))>0)
-- Original treasury-funded seats retain sponsor and beneficiary separately.
-- Seven real original flows and78 frozen hand outcomes are reproved without
-- changing money, original receipts or finite245 historical restoration cases.
-- Future original producers atomically retain the proof; old book generations
-- change only for late historical admissions, not every future live gift.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL search_path=public,pg_catalog;
SELECT pg_advisory_xact_lock(530090,1);

SET LOCAL lock_timeout='2s';
DO $repair$
DECLARE original text;patched text;anchor text;replacement text;rec record;
 full_hash text;window_hash text;award_hash text;advance_hash text;
BEGIN
 IF smarter_private.original_inventory_proof_sources_match() IS DISTINCT FROM true THEN RAISE EXCEPTION 'wallet_jackpot_original_authority_not_qualified';END IF;
 FOR rec IN SELECT * FROM(VALUES
 ('public.fn_union_pnl_original_flow_evidence(uuid,timestamptz,timestamptz)','f85d5f26253365ec1052b74ed23a14cc'),
 ('smarter_private.union_pnl_original_flow_evidence_window(uuid,timestamptz,timestamptz,timestamptz,timestamptz)','2c6795299ab0fd50fc2848e2b5fa19fb'))x(signature,body_md5) LOOP
  original:=pg_get_functiondef(to_regprocedure(rec.signature));
  IF md5(original) IS DISTINCT FROM rec.body_md5 THEN RAISE EXCEPTION 'wallet_jackpot_original_flow_owner_changed: %',rec.signature;END IF;
  patched:=original;
  anchor:=$anchor0$ ), matched AS ($anchor0$;replacement:=$replacement0$ ), bbj_wallet_matches AS MATERIALIZED (
  SELECT q.ledger_id,(q.l->>'club_id')::uuid club_id,r.user_id,r.amount,b.id payout_id
  FROM originals q
  JOIN public.bbj_payouts b ON b.id=CASE WHEN q.l->>'idempotency_key' ~ '^bbj:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN split_part(q.l->>'idempotency_key',':',2)::uuid END
  JOIN public.bbj_payout_recipients r ON r.payout_id=b.id AND r.user_id=(q.l->>'to_entity_id')::uuid
  JOIN public.wallet_credit_idempotency w ON w.key=q.l->>'idempotency_key' AND w.user_id=r.user_id AND w.amount=r.amount
  JOIN public.bbj_pools pool ON pool.id=b.pool_id
  WHERE q.tournament_id IS NULL AND q.l->>'category'='bbj_payout' AND q.l->>'status'='posted'
   AND q.l->>'from_type'='table_stack' AND q.l->>'to_type'='player_wallet'
   AND q.l->>'from_entity_id'=b.table_id::text AND q.l->>'table_id'=b.table_id::text
   AND q.l->>'id'=q.ledger_id::text AND q.l->>'idempotency_key'='bbj:'||b.id::text||':'||r.user_id::text
   AND q.game_scope->>'game_union_id'=p_union_id::text AND q.game_scope->>'asset'='chips' AND q.game_scope->'unit_scale'='2'::jsonb
   AND (pool.union_id=p_union_id OR (pool.union_id IS NULL AND pool.club_id::text=q.game_scope->>'host_club_id'))
   AND b.kind IN('main','mini') AND b.total_amount>0 AND b.total_amount=round(b.total_amount,2)
   AND b.created_at<=q.recognized_at AND r.created_at=w.created_at AND w.created_at>=b.created_at AND w.created_at<=q.recognized_at
   AND (SELECT count(*) FROM public.bbj_payout_recipients unique_recipient WHERE unique_recipient.payout_id=b.id AND unique_recipient.user_id=r.user_id)=1
   AND r.amount=(q.l->>'amount')::numeric AND r.amount>0 AND r.amount=round(r.amount,2)
   AND r.amount::text NOT IN('NaN','Infinity','-Infinity')
   AND (SELECT count(*) FROM public.chip_transactions t WHERE t.transaction_type='bbj_payout' AND t.table_id=b.table_id
     AND t.to_user_id=r.user_id AND t.club_id=(q.l->>'club_id')::uuid AND t.amount=r.amount AND t.created_at=w.created_at)=1
   AND (SELECT count(*) FROM public.chip_ledger bank WHERE bank.status='posted' AND bank.category='bbj_payout'
     AND bank.from_type='bbj_pool' AND bank.from_entity_id=b.pool_id AND bank.to_type='table_stack' AND bank.to_entity_id=b.table_id
     AND bank.amount=b.total_amount AND bank.idempotency_key=CASE WHEN b.kind='mini' THEN 'bbj_mini:'||b.pool_id::text||':'||b.table_id::text||':'||b.hand_number::text ELSE 'bbj_payout:'||b.id::text END)=1
   AND (SELECT coalesce(sum(p.amount),0) FROM public.bbj_payout_recipients p WHERE p.payout_id=b.id)
      +(SELECT coalesce(sum(u.amount),0) FROM public.bbj_unclaimed_shares u WHERE u.payout_id=b.id AND u.paid_at IS NULL)=b.total_amount
   AND (NOT EXISTS(SELECT FROM public.bbj_unclaimed_shares u WHERE u.payout_id=b.id AND u.user_id=r.user_id)
     OR (SELECT count(*) FROM public.bbj_unclaimed_shares u WHERE u.payout_id=b.id AND u.user_id=r.user_id AND u.amount=r.amount
       AND u.pool_id=b.pool_id AND u.table_id=b.table_id AND u.paid_at=w.created_at
       AND (SELECT count(*) FROM public.chip_ledger parked WHERE parked.status='posted' AND parked.category='bbj_payout'
         AND parked.from_type='table_stack' AND parked.from_entity_id=b.table_id AND parked.to_type='bbj_pool' AND parked.to_entity_id=b.pool_id
         AND parked.amount=r.amount AND parked.idempotency_key='bbj_park:bbj:'||b.id::text||':'||r.user_id::text)=1
       AND (SELECT count(*) FROM public.chip_ledger redeemed WHERE redeemed.status='posted' AND redeemed.category='bbj_payout'
         AND redeemed.from_type='bbj_pool' AND redeemed.from_entity_id=b.pool_id AND redeemed.to_type='table_stack' AND redeemed.to_entity_id=b.table_id
         AND redeemed.amount=r.amount AND redeemed.idempotency_key='bbj_redeem:'||b.id::text||':'||r.user_id::text)=1)=1)
 ), matched AS ($replacement0$;
  IF (length(patched)-length(replace(patched,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'wallet_jackpot_flow_anchor_0_changed';END IF;
  patched:=replace(patched,anchor,replacement);
  anchor:=$anchor1$late.delta late_delta
$anchor1$;replacement:=$replacement1$late.delta late_delta,j.club_id bbj_club,j.user_id bbj_user,j.payout_id bbj_payout
$replacement1$;
  IF (length(patched)-length(replace(patched,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'wallet_jackpot_flow_anchor_1_changed';END IF;
  patched:=replace(patched,anchor,replacement);
  anchor:=$anchor2$  FROM originals q
  LEFT JOIN LATERAL ($anchor2$;replacement:=$replacement2$  FROM originals q
  LEFT JOIN bbj_wallet_matches j ON j.ledger_id=q.ledger_id
  LEFT JOIN LATERAL ($replacement2$;
  IF (length(patched)-length(replace(patched,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'wallet_jackpot_flow_anchor_2_changed';END IF;
  patched:=replace(patched,anchor,replacement);
  anchor:=$anchor3$SELECT *,CASE WHEN late_count=1 THEN$anchor3$;replacement:=$replacement3$SELECT *,CASE WHEN bbj_payout IS NOT NULL THEN 'cash_return' WHEN late_count=1 THEN$replacement3$;
  IF (length(patched)-length(replace(patched,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'wallet_jackpot_flow_anchor_3_changed';END IF;
  patched:=replace(patched,anchor,replacement);
  anchor:=$anchor4$COALESCE(late_club,cash_club,$anchor4$;replacement:=$replacement4$COALESCE(bbj_club,late_club,cash_club,$replacement4$;
  IF (length(patched)-length(replace(patched,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'wallet_jackpot_flow_anchor_4_changed';END IF;
  patched:=replace(patched,anchor,replacement);
  anchor:=$anchor5$COALESCE(late_user,cash_user,$anchor5$;replacement:=$replacement5$COALESCE(bbj_user,late_user,cash_user,$replacement5$;
  IF (length(patched)-length(replace(patched,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'wallet_jackpot_flow_anchor_5_changed';END IF;
  patched:=replace(patched,anchor,replacement);
  anchor:=$anchor6$WHEN 'cash_return' THEN (owners=1 OR moved_club IS NOT NULL OR (refunds=1 AND l->>'category'='player_funding'))$anchor6$;replacement:=$replacement6$WHEN 'cash_return' THEN (bbj_payout IS NOT NULL OR owners=1 OR moved_club IS NOT NULL OR (refunds=1 AND l->>'category'='player_funding'))$replacement6$;
  IF (length(patched)-length(replace(patched,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'wallet_jackpot_flow_anchor_6_changed';END IF;
  patched:=replace(patched,anchor,replacement);
  anchor:=$anchor7$OR (l->>'category'='player_funding' AND refunds=1 AND refund_club=owner_club AND refund_user=owner_user))$anchor7$;replacement:=$replacement7$OR (l->>'category'='player_funding' AND refunds=1 AND refund_club=owner_club AND refund_user=owner_user)
     OR (l->>'category'='bbj_payout' AND bbj_payout IS NOT NULL AND bbj_club=owner_club AND bbj_user=owner_user))$replacement7$;
  IF (length(patched)-length(replace(patched,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'wallet_jackpot_flow_anchor_7_changed';END IF;
  patched:=replace(patched,anchor,replacement);
  EXECUTE patched;
  IF pg_get_functiondef(to_regprocedure(rec.signature)) IS DISTINCT FROM patched THEN RAISE EXCEPTION 'wallet_jackpot_flow_postimage_changed';END IF;
 END LOOP;
 original:=pg_get_functiondef('public.fn_union_pnl_week_bbj_stack_awards(uuid,timestamptz,timestamptz)'::regprocedure);
 IF md5(original)<>'f64af6d87150bd89f2c3635f0d060506' THEN RAISE EXCEPTION 'wallet_jackpot_original_award_owner_changed';END IF;
 anchor:=$award_anchor$AS $function$
 SELECT$award_anchor$;replacement:=$award_replacement$AS $function$
 WITH originals AS MATERIALIZED (
 SELECT q.*,q.ledger_snapshot l,(q.game_scope->>'tournament_id')::uuid tournament_id
 FROM public.bbj_payout_recipients rr JOIN public.bbj_payouts bp ON bp.id=rr.payout_id
 JOIN public.wallet_credit_idempotency wi ON wi.key='bbj:'||bp.id::text||':'||rr.user_id::text
 JOIN public.chip_ledger cl ON cl.idempotency_key=wi.key
 JOIN public.union_pnl_original_flows q ON q.ledger_id=cl.id
 WHERE rr.created_at>=p_start AND rr.created_at<p_end AND q.recognized_at>=p_start AND q.recognized_at<p_end
  AND q.game_scope->>'game_union_id'=p_union_id::text
 ), bbj_wallet_matches AS MATERIALIZED (
  SELECT q.ledger_id,(q.l->>'club_id')::uuid club_id,r.user_id,r.amount,b.id payout_id
  FROM originals q
  JOIN public.bbj_payouts b ON b.id=CASE WHEN q.l->>'idempotency_key' ~ '^bbj:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN split_part(q.l->>'idempotency_key',':',2)::uuid END
  JOIN public.bbj_payout_recipients r ON r.payout_id=b.id AND r.user_id=(q.l->>'to_entity_id')::uuid
  JOIN public.wallet_credit_idempotency w ON w.key=q.l->>'idempotency_key' AND w.user_id=r.user_id AND w.amount=r.amount
  JOIN public.bbj_pools pool ON pool.id=b.pool_id
  WHERE q.tournament_id IS NULL AND q.l->>'category'='bbj_payout' AND q.l->>'status'='posted'
   AND q.l->>'from_type'='table_stack' AND q.l->>'to_type'='player_wallet'
   AND q.l->>'from_entity_id'=b.table_id::text AND q.l->>'table_id'=b.table_id::text
   AND q.l->>'id'=q.ledger_id::text AND q.l->>'idempotency_key'='bbj:'||b.id::text||':'||r.user_id::text
   AND q.game_scope->>'game_union_id'=p_union_id::text AND q.game_scope->>'asset'='chips' AND q.game_scope->'unit_scale'='2'::jsonb
   AND (pool.union_id=p_union_id OR (pool.union_id IS NULL AND pool.club_id::text=q.game_scope->>'host_club_id'))
   AND b.kind IN('main','mini') AND b.total_amount>0 AND b.total_amount=round(b.total_amount,2)
   AND b.created_at<=q.recognized_at AND r.created_at=w.created_at AND w.created_at>=b.created_at AND w.created_at<=q.recognized_at
   AND (SELECT count(*) FROM public.bbj_payout_recipients unique_recipient WHERE unique_recipient.payout_id=b.id AND unique_recipient.user_id=r.user_id)=1
   AND r.amount=(q.l->>'amount')::numeric AND r.amount>0 AND r.amount=round(r.amount,2)
   AND r.amount::text NOT IN('NaN','Infinity','-Infinity')
   AND (SELECT count(*) FROM public.chip_transactions t WHERE t.transaction_type='bbj_payout' AND t.table_id=b.table_id
     AND t.to_user_id=r.user_id AND t.club_id=(q.l->>'club_id')::uuid AND t.amount=r.amount AND t.created_at=w.created_at)=1
   AND (SELECT count(*) FROM public.chip_ledger bank WHERE bank.status='posted' AND bank.category='bbj_payout'
     AND bank.from_type='bbj_pool' AND bank.from_entity_id=b.pool_id AND bank.to_type='table_stack' AND bank.to_entity_id=b.table_id
     AND bank.amount=b.total_amount AND bank.idempotency_key=CASE WHEN b.kind='mini' THEN 'bbj_mini:'||b.pool_id::text||':'||b.table_id::text||':'||b.hand_number::text ELSE 'bbj_payout:'||b.id::text END)=1
   AND (SELECT coalesce(sum(p.amount),0) FROM public.bbj_payout_recipients p WHERE p.payout_id=b.id)
      +(SELECT coalesce(sum(u.amount),0) FROM public.bbj_unclaimed_shares u WHERE u.payout_id=b.id AND u.paid_at IS NULL)=b.total_amount
   AND (NOT EXISTS(SELECT FROM public.bbj_unclaimed_shares u WHERE u.payout_id=b.id AND u.user_id=r.user_id)
     OR (SELECT count(*) FROM public.bbj_unclaimed_shares u WHERE u.payout_id=b.id AND u.user_id=r.user_id AND u.amount=r.amount
       AND u.pool_id=b.pool_id AND u.table_id=b.table_id AND u.paid_at=w.created_at
       AND (SELECT count(*) FROM public.chip_ledger parked WHERE parked.status='posted' AND parked.category='bbj_payout'
         AND parked.from_type='table_stack' AND parked.from_entity_id=b.table_id AND parked.to_type='bbj_pool' AND parked.to_entity_id=b.pool_id
         AND parked.amount=r.amount AND parked.idempotency_key='bbj_park:bbj:'||b.id::text||':'||r.user_id::text)=1
       AND (SELECT count(*) FROM public.chip_ledger redeemed WHERE redeemed.status='posted' AND redeemed.category='bbj_payout'
         AND redeemed.from_type='bbj_pool' AND redeemed.from_entity_id=b.pool_id AND redeemed.to_type='table_stack' AND redeemed.to_entity_id=b.table_id
         AND redeemed.amount=r.amount AND redeemed.idempotency_key='bbj_redeem:'||b.id::text||':'||r.user_id::text)=1)=1)
 )
 SELECT$award_replacement$;
 IF (length(original)-length(replace(original,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'wallet_jackpot_award_anchor_changed';END IF;
 patched:=replace(original,anchor,replacement);
 anchor:=$felt_anchor$  AND NOT EXISTS(SELECT 1 FROM public.wallet_credit_idempotency w
   WHERE w.key='bbj:'||r.payout_id::text||':'||r.user_id::text)$felt_anchor$;replacement:=anchor||$felt_guard$
  AND NOT EXISTS(SELECT FROM public.chip_ledger wallet_leg WHERE wallet_leg.idempotency_key='bbj:'||r.payout_id::text||':'||r.user_id::text AND wallet_leg.to_type='player_wallet')$felt_guard$;
 IF (length(patched)-length(replace(patched,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'wallet_jackpot_felt_distinction_changed';END IF;
 patched:=replace(patched,anchor,replacement);
 anchor:=E'\n$function$';replacement:=$award_tail$
 UNION ALL SELECT j.club_id,j.user_id,j.amount,j.payout_id FROM bbj_wallet_matches j
$function$$award_tail$;
 IF (length(patched)-length(replace(patched,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'wallet_jackpot_award_tail_changed';END IF;
 patched:=replace(patched,anchor,replacement);EXECUTE patched;
 IF pg_get_functiondef('public.fn_union_pnl_week_bbj_stack_awards(uuid,timestamptz,timestamptz)'::regprocedure) IS DISTINCT FROM patched THEN RAISE EXCEPTION 'wallet_jackpot_award_postimage_changed';END IF;
 full_hash:=md5(pg_get_functiondef('public.fn_union_pnl_original_flow_evidence(uuid,timestamptz,timestamptz)'::regprocedure));
 window_hash:=md5(pg_get_functiondef('smarter_private.union_pnl_original_flow_evidence_window(uuid,timestamptz,timestamptz,timestamptz,timestamptz)'::regprocedure));
 award_hash:=md5(pg_get_functiondef('public.fn_union_pnl_week_bbj_stack_awards(uuid,timestamptz,timestamptz)'::regprocedure));
 original:=pg_get_functiondef('public.fn_accounting_union_earned_plan_advance(uuid,timestamptz,timestamptz)'::regprocedure);
 IF md5(original)<>'5c300c969c21d66eb235cfccd3e512fd' THEN RAISE EXCEPTION 'wallet_jackpot_original_advance_changed';END IF;
 anchor:='f85d5f26253365ec1052b74ed23a14cc';
 IF (length(original)-length(replace(original,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'wallet_jackpot_advance_anchor_changed';END IF;
 patched:=replace(original,anchor,full_hash);EXECUTE patched;
 IF pg_get_functiondef('public.fn_accounting_union_earned_plan_advance(uuid,timestamptz,timestamptz)'::regprocedure) IS DISTINCT FROM patched THEN RAISE EXCEPTION 'wallet_jackpot_advance_postimage_changed';END IF;
 advance_hash:=md5(patched);
 -- Retain every original forty-source pin and strengthen the authority with
 -- the three actual transitive consumers newly qualified by this migration.
 original:=pg_get_functiondef('smarter_private.original_inventory_proof_sources_match()'::regprocedure);
 IF md5(original)<>'f820daba5e091e35cb69c55b2518ed4e' THEN RAISE EXCEPTION 'wallet_jackpot_original_source_authority_changed';END IF;
 anchor:='f85d5f26253365ec1052b74ed23a14cc';
 IF (length(original)-length(replace(original,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'wallet_jackpot_source_pin_changed';END IF;
 patched:=replace(original,anchor,full_hash);
 IF position('SELECT count(*)=40 AND' IN patched)=0 THEN RAISE EXCEPTION 'wallet_jackpot_source_count_changed';END IF;
 patched:=replace(patched,'SELECT count(*)=40 AND','SELECT count(*)=43 AND');
 anchor:=$pin_end$)x(signature,body_md5)$pin_end$;
 IF (length(patched)-length(replace(patched,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'wallet_jackpot_source_list_changed';END IF;
 replacement:=format(',(''smarter_private.union_pnl_original_flow_evidence_window(uuid,timestamptz,timestamptz,timestamptz,timestamptz)'',''%s''),(''public.fn_union_pnl_week_bbj_stack_awards(uuid,timestamptz,timestamptz)'',''%s''),(''public.fn_accounting_union_earned_plan_advance(uuid,timestamptz,timestamptz)'',''%s''))x(signature,body_md5)',window_hash,award_hash,advance_hash);
 patched:=replace(patched,anchor,replacement);EXECUTE patched;
 IF pg_get_functiondef('smarter_private.original_inventory_proof_sources_match()'::regprocedure) IS DISTINCT FROM patched OR smarter_private.original_inventory_proof_sources_match() IS DISTINCT FROM true THEN RAISE EXCEPTION 'wallet_jackpot_qualified_source_authority_failed';END IF;
END $repair$;

DO $original$BEGIN
IF smarter_private.original_inventory_proof_sources_match() IS DISTINCT FROM true THEN RAISE EXCEPTION 'treasury_original_sources_unqualified';END IF;
IF md5(pg_get_functiondef(to_regprocedure('public.fn_union_pnl_original_flow_evidence(uuid,timestamptz,timestamptz)'))) IS DISTINCT FROM '9fcc88f4dcac9b27ebff0faac48d4bc3' OR (SELECT proowner FROM pg_proc WHERE oid=to_regprocedure('public.fn_union_pnl_original_flow_evidence(uuid,timestamptz,timestamptz)')) IS DISTINCT FROM 'postgres'::regrole THEN RAISE EXCEPTION 'treasury_original_owner_changed: public.fn_union_pnl_original_flow_evidence(uuid,timestamptz,timestamptz)';END IF;
IF md5(pg_get_functiondef(to_regprocedure('smarter_private.union_pnl_original_flow_evidence_window(uuid,timestamptz,timestamptz,timestamptz,timestamptz)'))) IS DISTINCT FROM 'a64e78117d5193d480df13f80cdb0c0d' OR (SELECT proowner FROM pg_proc WHERE oid=to_regprocedure('smarter_private.union_pnl_original_flow_evidence_window(uuid,timestamptz,timestamptz,timestamptz,timestamptz)')) IS DISTINCT FROM 'postgres'::regrole THEN RAISE EXCEPTION 'treasury_original_owner_changed: smarter_private.union_pnl_original_flow_evidence_window(uuid,timestamptz,timestamptz,timestamptz,timestamptz)';END IF;
IF md5(pg_get_functiondef(to_regprocedure('public.fn_accounting_union_earned_plan_advance(uuid,timestamptz,timestamptz)'))) IS DISTINCT FROM '39e03b23e15eddcdc06c497dafed9731' OR (SELECT proowner FROM pg_proc WHERE oid=to_regprocedure('public.fn_accounting_union_earned_plan_advance(uuid,timestamptz,timestamptz)')) IS DISTINCT FROM 'postgres'::regrole THEN RAISE EXCEPTION 'treasury_original_owner_changed: public.fn_accounting_union_earned_plan_advance(uuid,timestamptz,timestamptz)';END IF;
IF md5(pg_get_functiondef(to_regprocedure('public.fn_union_pnl_cash_outcome_accepted(union_pnl_cash_outcomes)'))) IS DISTINCT FROM 'f1d7fbfbe0bcebb63579b19bc3143a95' OR (SELECT proowner FROM pg_proc WHERE oid=to_regprocedure('public.fn_union_pnl_cash_outcome_accepted(union_pnl_cash_outcomes)')) IS DISTINCT FROM 'postgres'::regrole THEN RAISE EXCEPTION 'treasury_original_owner_changed: public.fn_union_pnl_cash_outcome_accepted(union_pnl_cash_outcomes)';END IF;
IF md5(pg_get_functiondef(to_regprocedure('public.fn_union_pnl_week_hand_lines(uuid,timestamptz,timestamptz,boolean)'))) IS DISTINCT FROM '0c69388b1406858f3bed04f54639fab6' OR (SELECT proowner FROM pg_proc WHERE oid=to_regprocedure('public.fn_union_pnl_week_hand_lines(uuid,timestamptz,timestamptz,boolean)')) IS DISTINCT FROM 'postgres'::regrole THEN RAISE EXCEPTION 'treasury_original_owner_changed: public.fn_union_pnl_week_hand_lines(uuid,timestamptz,timestamptz,boolean)';END IF;
IF md5(pg_get_functiondef(to_regprocedure('smarter_private.weekly_hand_parts_witness(uuid,timestamptz,timestamptz,boolean)'))) IS DISTINCT FROM '491323192dc49931df7c36e4699eac9a' OR (SELECT proowner FROM pg_proc WHERE oid=to_regprocedure('smarter_private.weekly_hand_parts_witness(uuid,timestamptz,timestamptz,boolean)')) IS DISTINCT FROM 'postgres'::regrole THEN RAISE EXCEPTION 'treasury_original_owner_changed: smarter_private.weekly_hand_parts_witness(uuid,timestamptz,timestamptz,boolean)';END IF;
IF md5(pg_get_functiondef(to_regprocedure('smarter_private.weekly_hand_parts_read(uuid,timestamptz,timestamptz,text,boolean)'))) IS DISTINCT FROM '1ecd757e644477bb02400a17b53edd32' OR (SELECT proowner FROM pg_proc WHERE oid=to_regprocedure('smarter_private.weekly_hand_parts_read(uuid,timestamptz,timestamptz,text,boolean)')) IS DISTINCT FROM 'postgres'::regrole THEN RAISE EXCEPTION 'treasury_original_owner_changed: smarter_private.weekly_hand_parts_read(uuid,timestamptz,timestamptz,text,boolean)';END IF;
IF to_regprocedure('smarter_private.original_treasury_witness_immutable()') IS NOT NULL THEN RAISE EXCEPTION 'treasury_original_owner_changed: smarter_private.original_treasury_witness_immutable()';END IF;
IF to_regprocedure('smarter_private.original_treasury_gift_evidence(uuid)') IS NOT NULL THEN RAISE EXCEPTION 'treasury_original_owner_changed: smarter_private.original_treasury_gift_evidence(uuid)';END IF;
IF to_regprocedure('smarter_private.admit_original_treasury_gift(uuid)') IS NOT NULL THEN RAISE EXCEPTION 'treasury_original_owner_changed: smarter_private.admit_original_treasury_gift(uuid)';END IF;
IF to_regprocedure('smarter_private.original_treasury_return_evidence(uuid)') IS NOT NULL THEN RAISE EXCEPTION 'treasury_original_owner_changed: smarter_private.original_treasury_return_evidence(uuid)';END IF;
IF to_regprocedure('smarter_private.admit_original_treasury_return(uuid)') IS NOT NULL THEN RAISE EXCEPTION 'treasury_original_owner_changed: smarter_private.admit_original_treasury_return(uuid)';END IF;
IF to_regprocedure('smarter_private.cash_initial_funding_receipt(uuid)') IS NOT NULL THEN RAISE EXCEPTION 'treasury_original_owner_changed: smarter_private.cash_initial_funding_receipt(uuid)';END IF;
IF to_regprocedure('smarter_private.original_treasury_participant_gift(jsonb,uuid,timestamptz)') IS NOT NULL THEN RAISE EXCEPTION 'treasury_original_owner_changed: smarter_private.original_treasury_participant_gift(jsonb,uuid,timestamptz)';END IF;
IF to_regprocedure('smarter_private.original_treasury_cash_outcome_evidence(jsonb)') IS NOT NULL THEN RAISE EXCEPTION 'treasury_original_owner_changed: smarter_private.original_treasury_cash_outcome_evidence(jsonb)';END IF;
IF md5(pg_get_functiondef(to_regprocedure('public.fn_horse_seat_from_treasury(uuid,uuid,integer,numeric,uuid)'))) IS DISTINCT FROM '4a7cee2cfecdf7a36446c169f754ccd0' OR (SELECT proowner FROM pg_proc WHERE oid=to_regprocedure('public.fn_horse_seat_from_treasury(uuid,uuid,integer,numeric,uuid)')) IS DISTINCT FROM 'postgres'::regrole THEN RAISE EXCEPTION 'treasury_original_owner_changed: public.fn_horse_seat_from_treasury(uuid,uuid,integer,numeric,uuid)';END IF;
IF md5(pg_get_functiondef(to_regprocedure('public.fn_cash_record_original_funding(text,text,uuid,uuid,uuid,uuid,uuid,numeric,numeric,uuid)'))) IS DISTINCT FROM '7ee6659572a38ef014952b4559f6167a' OR (SELECT proowner FROM pg_proc WHERE oid=to_regprocedure('public.fn_cash_record_original_funding(text,text,uuid,uuid,uuid,uuid,uuid,numeric,numeric,uuid)')) IS DISTINCT FROM 'postgres'::regrole THEN RAISE EXCEPTION 'treasury_original_owner_changed: public.fn_cash_record_original_funding(text,text,uuid,uuid,uuid,uuid,uuid,numeric,numeric,uuid)';END IF;
IF md5(pg_get_functiondef(to_regprocedure('public.fn_cash_original_funding_lineage(uuid,uuid,uuid,uuid,timestamptz,timestamptz,boolean)'))) IS DISTINCT FROM 'bb74ae7693dc40b812fce685cfc3c294' OR (SELECT proowner FROM pg_proc WHERE oid=to_regprocedure('public.fn_cash_original_funding_lineage(uuid,uuid,uuid,uuid,timestamptz,timestamptz,boolean)')) IS DISTINCT FROM 'postgres'::regrole THEN RAISE EXCEPTION 'treasury_original_owner_changed: public.fn_cash_original_funding_lineage(uuid,uuid,uuid,uuid,timestamptz,timestamptz,boolean)';END IF;
IF md5(pg_get_functiondef(to_regprocedure('public.fn_pnl_cash_hand_evidence(uuid,bigint)'))) IS DISTINCT FROM '865391e842ed009b45ec7727efe7e85b' OR (SELECT proowner FROM pg_proc WHERE oid=to_regprocedure('public.fn_pnl_cash_hand_evidence(uuid,bigint)')) IS DISTINCT FROM 'postgres'::regrole THEN RAISE EXCEPTION 'treasury_original_owner_changed: public.fn_pnl_cash_hand_evidence(uuid,bigint)';END IF;
IF md5(pg_get_functiondef(to_regprocedure('public.fn_cash_capture_hand_manifest(uuid,bigint,jsonb,text,uuid)'))) IS DISTINCT FROM 'c2f77a64af658e91c4cf0e8d6ade6ee2' OR (SELECT proowner FROM pg_proc WHERE oid=to_regprocedure('public.fn_cash_capture_hand_manifest(uuid,bigint,jsonb,text,uuid)')) IS DISTINCT FROM 'postgres'::regrole THEN RAISE EXCEPTION 'treasury_original_owner_changed: public.fn_cash_capture_hand_manifest(uuid,bigint,jsonb,text,uuid)';END IF;
IF md5(pg_get_functiondef(to_regprocedure('public.fn_cash_earning_club(uuid,uuid,uuid,uuid,uuid)'))) IS DISTINCT FROM 'b1c21e14021e0e2e7bba28048dcec90e' OR (SELECT proowner FROM pg_proc WHERE oid=to_regprocedure('public.fn_cash_earning_club(uuid,uuid,uuid,uuid,uuid)')) IS DISTINCT FROM 'postgres'::regrole THEN RAISE EXCEPTION 'treasury_original_owner_changed: public.fn_cash_earning_club(uuid,uuid,uuid,uuid,uuid)';END IF;
IF md5(pg_get_functiondef(to_regprocedure('public.fn_ca_cash_seat_club(uuid,uuid)'))) IS DISTINCT FROM 'b2a3de2d916158c859ea41cad150d653' OR (SELECT proowner FROM pg_proc WHERE oid=to_regprocedure('public.fn_ca_cash_seat_club(uuid,uuid)')) IS DISTINCT FROM 'postgres'::regrole THEN RAISE EXCEPTION 'treasury_original_owner_changed: public.fn_ca_cash_seat_club(uuid,uuid)';END IF;
IF md5(pg_get_functiondef(to_regprocedure('public.fn_union_pnl_boundary(uuid,timestamptz)'))) IS DISTINCT FROM 'f3fc54538eb2c19a049c79ce77bfb705' OR (SELECT proowner FROM pg_proc WHERE oid=to_regprocedure('public.fn_union_pnl_boundary(uuid,timestamptz)')) IS DISTINCT FROM 'postgres'::regrole THEN RAISE EXCEPTION 'treasury_original_owner_changed: public.fn_union_pnl_boundary(uuid,timestamptz)';END IF;
IF md5(pg_get_functiondef(to_regprocedure('smarter_private.original_inventory_basis_generation()'))) IS DISTINCT FROM 'dbf5a3a18da9339ba60083cb2d3aea4c' OR (SELECT proowner FROM pg_proc WHERE oid=to_regprocedure('smarter_private.original_inventory_basis_generation()')) IS DISTINCT FROM 'postgres'::regrole THEN RAISE EXCEPTION 'treasury_original_owner_changed: smarter_private.original_inventory_basis_generation()';END IF;
IF md5(pg_get_functiondef(to_regprocedure('public.fn_horse_seat_from_treasury_before_maintenance_gate(uuid,uuid,integer,numeric,uuid)'))) IS DISTINCT FROM '858f5b0c0fc52bec310b8a6630ee5b44' OR (SELECT proowner FROM pg_proc WHERE oid=to_regprocedure('public.fn_horse_seat_from_treasury_before_maintenance_gate(uuid,uuid,integer,numeric,uuid)')) IS DISTINCT FROM 'postgres'::regrole THEN RAISE EXCEPTION 'treasury_original_owner_changed: public.fn_horse_seat_from_treasury_before_maintenance_gate(uuid,uuid,integer,numeric,uuid)';END IF;
IF md5(pg_get_functiondef(to_regprocedure('public.fn_claim_entry_purchase_receipt(text,text,jsonb)'))) IS DISTINCT FROM '0d1183a2a50441a6a582ea2e5cbb5d2a' OR (SELECT proowner FROM pg_proc WHERE oid=to_regprocedure('public.fn_claim_entry_purchase_receipt(text,text,jsonb)')) IS DISTINCT FROM 'postgres'::regrole THEN RAISE EXCEPTION 'treasury_original_owner_changed: public.fn_claim_entry_purchase_receipt(text,text,jsonb)';END IF;
IF to_regprocedure('smarter_private.original_treasury_seat_money_core(uuid,uuid,integer,numeric,uuid)') IS NOT NULL THEN RAISE EXCEPTION 'treasury_original_owner_changed: smarter_private.original_treasury_seat_money_core(uuid,uuid,integer,numeric,uuid)';END IF;
IF(SELECT proacl::text FROM pg_proc WHERE oid=to_regprocedure('public.fn_horse_seat_from_treasury_before_maintenance_gate(uuid,uuid,integer,numeric,uuid)'))IS DISTINCT FROM '{postgres=X/postgres}' THEN RAISE EXCEPTION 'treasury_common_entry_owner_acl_changed';END IF;
IF(SELECT proacl::text FROM pg_proc WHERE oid=to_regprocedure('public.fn_claim_entry_purchase_receipt(text,text,jsonb)'))IS DISTINCT FROM '{postgres=X/postgres}' THEN RAISE EXCEPTION 'treasury_common_entry_owner_acl_changed';END IF;
IF(SELECT proacl::text FROM pg_proc WHERE oid=to_regprocedure('public.fn_ca_cash_seat_club(uuid,uuid)'))IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' THEN RAISE EXCEPTION 'treasury_original_public_owner_acl_changed: fn_ca_cash_seat_club(uuid,uuid)';END IF;
IF(SELECT proacl::text FROM pg_proc WHERE oid=to_regprocedure('public.fn_cash_earning_club(uuid,uuid,uuid,uuid,uuid)'))IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' THEN RAISE EXCEPTION 'treasury_original_public_owner_acl_changed: fn_cash_earning_club(uuid,uuid,uuid,uuid,uuid)';END IF;
IF(SELECT proacl::text FROM pg_proc WHERE oid=to_regprocedure('public.fn_cash_original_funding_lineage(uuid,uuid,uuid,uuid,timestamp with time zone,timestamp with time zone,boolean)'))IS DISTINCT FROM '{postgres=X/postgres}' THEN RAISE EXCEPTION 'treasury_original_public_owner_acl_changed: fn_cash_original_funding_lineage(uuid,uuid,uuid,uuid,timestamp with time zone,timestamp with time zone,boolean)';END IF;
IF(SELECT proacl::text FROM pg_proc WHERE oid=to_regprocedure('public.fn_horse_seat_from_treasury(uuid,uuid,integer,numeric,uuid)'))IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' THEN RAISE EXCEPTION 'treasury_original_public_owner_acl_changed: fn_horse_seat_from_treasury(uuid,uuid,integer,numeric,uuid)';END IF;
IF(SELECT proacl::text FROM pg_proc WHERE oid=to_regprocedure('public.fn_horse_seat_from_treasury_before_maintenance_gate(uuid,uuid,integer,numeric,uuid)'))IS DISTINCT FROM '{postgres=X/postgres}' THEN RAISE EXCEPTION 'treasury_original_public_owner_acl_changed: fn_horse_seat_from_treasury_before_maintenance_gate(uuid,uuid,integer,numeric,uuid)';END IF;
IF(SELECT proacl::text FROM pg_proc WHERE oid=to_regprocedure('public.fn_pnl_cash_hand_evidence(uuid,bigint)'))IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' THEN RAISE EXCEPTION 'treasury_original_public_owner_acl_changed: fn_pnl_cash_hand_evidence(uuid,bigint)';END IF;
IF(SELECT proacl::text FROM pg_proc WHERE oid=to_regprocedure('public.fn_union_pnl_boundary(uuid,timestamp with time zone)'))IS DISTINCT FROM '{postgres=X/postgres}' THEN RAISE EXCEPTION 'treasury_original_public_owner_acl_changed: fn_union_pnl_boundary(uuid,timestamp with time zone)';END IF;
IF(SELECT proacl::text FROM pg_proc WHERE oid=to_regprocedure('public.fn_union_pnl_cash_outcome_accepted(union_pnl_cash_outcomes)'))IS DISTINCT FROM '{postgres=X/postgres}' THEN RAISE EXCEPTION 'treasury_original_public_owner_acl_changed: fn_union_pnl_cash_outcome_accepted(union_pnl_cash_outcomes)';END IF;
IF(SELECT proacl::text FROM pg_proc WHERE oid=to_regprocedure('public.fn_union_pnl_original_flow_evidence(uuid,timestamp with time zone,timestamp with time zone)'))IS DISTINCT FROM '{postgres=X/postgres}' THEN RAISE EXCEPTION 'treasury_original_public_owner_acl_changed: fn_union_pnl_original_flow_evidence(uuid,timestamp with time zone,timestamp with time zone)';END IF;
IF(SELECT proacl::text FROM pg_proc WHERE oid=to_regprocedure('public.fn_union_pnl_week_hand_lines(uuid,timestamp with time zone,timestamp with time zone,boolean)'))IS DISTINCT FROM '{postgres=X/postgres}' THEN RAISE EXCEPTION 'treasury_original_public_owner_acl_changed: fn_union_pnl_week_hand_lines(uuid,timestamp with time zone,timestamp with time zone,boolean)';END IF;
IF(SELECT proacl::text FROM pg_proc WHERE oid=to_regprocedure('public.fn_cash_capture_hand_manifest(uuid,bigint,jsonb,text,uuid)'))IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' THEN RAISE EXCEPTION 'treasury_original_public_owner_acl_changed: fn_cash_capture_hand_manifest(uuid,bigint,jsonb,text,uuid)';END IF;
IF(SELECT proacl::text FROM pg_proc WHERE oid=to_regprocedure('public.fn_cash_record_original_funding(text,text,uuid,uuid,uuid,uuid,uuid,numeric,numeric,uuid)'))IS DISTINCT FROM '{postgres=X/postgres}' THEN RAISE EXCEPTION 'treasury_original_public_owner_acl_changed: fn_cash_record_original_funding(text,text,uuid,uuid,uuid,uuid,uuid,numeric,numeric,uuid)';END IF;
IF(SELECT proacl::text FROM pg_proc WHERE oid=to_regprocedure('public.fn_claim_entry_purchase_receipt(text,text,jsonb)'))IS DISTINCT FROM '{postgres=X/postgres}' THEN RAISE EXCEPTION 'treasury_original_public_owner_acl_changed: fn_claim_entry_purchase_receipt(text,text,jsonb)';END IF;
END$original$;

SET LOCAL timezone='UTC';CREATE SCHEMA IF NOT EXISTS smarter_private;
-- Qualified original authority. Original financial witnesses, never a replacement funding debit.
CREATE TABLE smarter_private.original_treasury_funding_witnesses(
 ledger_id uuid PRIMARY KEY,kind text NOT NULL CHECK(kind IN('gift','return')),
 source jsonb NOT NULL,source_fingerprint text NOT NULL,historical_late boolean NOT NULL,
 admitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(jsonb_typeof(source)='object'),CHECK(length(source_fingerprint)=32));
CREATE UNIQUE INDEX original_treasury_gift_occupancy_once ON smarter_private.original_treasury_funding_witnesses((source#>>'{seat_event,after_row,occupancy_id}')) WHERE kind='gift';
CREATE UNIQUE INDEX original_treasury_return_occupancy_once ON smarter_private.original_treasury_funding_witnesses((source#>>'{seat_event,before_row,occupancy_id}')) WHERE kind='return';
REVOKE ALL ON smarter_private.original_treasury_funding_witnesses FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION smarter_private.original_treasury_witness_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'original_treasury_witness_is_immutable' USING ERRCODE='55000';END$$;
-- Installation time is current, immutable, and independent of an old gift's
-- transaction timestamp. Future atomic gifts never change closed-book bases.
CREATE TABLE smarter_private.original_treasury_funding_cutover(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),installed_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(installed_at)));
INSERT INTO smarter_private.original_treasury_funding_cutover DEFAULT VALUES;
REVOKE ALL ON smarter_private.original_treasury_funding_cutover FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER original_treasury_cutover_immutable BEFORE UPDATE OR DELETE ON smarter_private.original_treasury_funding_cutover FOR EACH ROW EXECUTE FUNCTION smarter_private.original_treasury_witness_immutable();
CREATE TRIGGER original_treasury_cutover_no_truncate BEFORE TRUNCATE ON smarter_private.original_treasury_funding_cutover FOR EACH STATEMENT EXECUTE FUNCTION smarter_private.original_treasury_witness_immutable();
-- Finite pre-cutover admission journal, separate from future live witnesses.
-- Global closed-book generation reads this bounded table, never all live gifts.
CREATE TABLE smarter_private.original_treasury_historical_admissions(ledger_id uuid PRIMARY KEY,kind text NOT NULL CHECK(kind IN('gift','return')),source_fingerprint text NOT NULL CHECK(length(source_fingerprint)=32),admitted_at timestamptz NOT NULL DEFAULT clock_timestamp());
REVOKE ALL ON smarter_private.original_treasury_historical_admissions FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER original_treasury_historical_immutable BEFORE UPDATE OR DELETE ON smarter_private.original_treasury_historical_admissions FOR EACH ROW EXECUTE FUNCTION smarter_private.original_treasury_witness_immutable();
CREATE TRIGGER original_treasury_historical_no_truncate BEFORE TRUNCATE ON smarter_private.original_treasury_historical_admissions FOR EACH STATEMENT EXECUTE FUNCTION smarter_private.original_treasury_witness_immutable();
CREATE TRIGGER original_treasury_witness_immutable BEFORE UPDATE OR DELETE ON smarter_private.original_treasury_funding_witnesses FOR EACH ROW EXECUTE FUNCTION smarter_private.original_treasury_witness_immutable();
CREATE TRIGGER original_treasury_witness_no_truncate BEFORE TRUNCATE ON smarter_private.original_treasury_funding_witnesses FOR EACH STATEMENT EXECUTE FUNCTION smarter_private.original_treasury_witness_immutable();

CREATE FUNCTION smarter_private.original_treasury_gift_evidence(p_ledger uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public SET timezone='UTC' AS $gift$
DECLARE w smarter_private.original_treasury_funding_witnesses%ROWTYPE;src jsonb;l jsonb;e jsonb;r jsonb;j jsonb;f jsonb;
 uid uuid;bank uuid;club uuid;tid uuid;sid uuid;occ uuid;joined timestamptz;amt numeric;n bigint;cutover_at timestamptz;
BEGIN
 SELECT * INTO w FROM smarter_private.original_treasury_funding_witnesses WHERE ledger_id=p_ledger AND kind='gift';
 IF NOT FOUND OR w.source_fingerprint IS DISTINCT FROM md5(w.source::text) THEN RETURN NULL;END IF;
 src:=w.source;l:=src->'ledger';e:=src->'seat_event';r:=src->'entry';j:=src->'journal';f:=src->'flow';
 SELECT installed_at INTO STRICT cutover_at FROM smarter_private.original_treasury_funding_cutover WHERE singleton;
 IF w.historical_late IS DISTINCT FROM ((f->>'recognized_at')::timestamptz<cutover_at)
  OR (w.historical_late AND NOT EXISTS(SELECT FROM smarter_private.original_treasury_historical_admissions h WHERE h.ledger_id=w.ledger_id AND h.kind=w.kind AND h.source_fingerprint=w.source_fingerprint))
  OR (NOT w.historical_late AND EXISTS(SELECT FROM smarter_private.original_treasury_historical_admissions h WHERE h.ledger_id=w.ledger_id)) THEN RETURN NULL;END IF;
 SELECT count(*) INTO n FROM public.chip_ledger q WHERE q.id=p_ledger AND to_jsonb(q)=l;
 IF n<>1 THEN RETURN NULL;END IF;
 uid:=(l#>>'{metadata,user_id}')::uuid;bank:=(l->>'from_entity_id')::uuid;tid:=(l->>'table_id')::uuid;
 club:=(e#>>'{after_row,club_id}')::uuid;sid:=(e#>>'{after_row,id}')::uuid;occ:=(e#>>'{after_row,occupancy_id}')::uuid;
 joined:=(e#>>'{after_row,joined_at}')::timestamptz;amt:=(l->>'amount')::numeric;
 IF uid IS NULL OR bank IS NULL OR club IS NULL OR tid IS NULL OR sid IS NULL OR occ IS NULL OR joined IS NULL OR NOT isfinite(joined)
  OR l->>'status' IS DISTINCT FROM 'posted' OR l->>'category' IS DISTINCT FROM 'horse_funding'
  OR l->>'from_type' IS DISTINCT FROM 'club_treasury' OR l->>'club_id' IS DISTINCT FROM bank::text
  OR l->>'to_type' IS DISTINCT FROM 'table_stack' OR l->>'to_entity_id' IS DISTINCT FROM tid::text
  OR l#>>'{metadata,door}' IS DISTINCT FROM 'fn_horse_seat_from_treasury'
  OR l->>'idempotency_key' IS DISTINCT FROM 'horse_fund:'||(l#>>'{metadata,op_id}')
  OR NULLIF(l#>>'{metadata,op_id}','') IS NULL
  OR amt IS NULL OR amt<=0 OR amt<>round(amt,2) OR amt::text IN('NaN','Infinity','-Infinity')
  OR e->>'source_name' IS DISTINCT FROM 'table_seats' OR e->>'operation' IS DISTINCT FROM 'INSERT'
  OR e->'before_row' IS DISTINCT FROM 'null'::jsonb OR e#>>'{after_row,left_at}' IS NOT NULL
  OR e->>'row_id' IS DISTINCT FROM sid::text OR e#>>'{after_row,user_id}' IS DISTINCT FROM uid::text
  OR e#>>'{after_row,table_id}' IS DISTINCT FROM tid::text OR (e#>>'{after_row,stack}')::numeric IS DISTINCT FROM amt
  OR (l->>'created_at')::timestamptz IS DISTINCT FROM joined
  OR f->>'ledger_id' IS DISTINCT FROM p_ledger::text OR f->'ledger_snapshot' IS DISTINCT FROM l
  OR f->>'transaction_id' IS DISTINCT FROM e->>'transaction_id'
  OR f#>>'{game_scope,asset}' IS DISTINCT FROM 'chips' OR f#>'{game_scope,unit_scale}' IS DISTINCT FROM '2'::jsonb
  OR f#>'{game_scope,tournament_id}' IS DISTINCT FROM 'null'::jsonb
  OR f#>>'{game_scope,host_club_id}' IS DISTINCT FROM bank::text
  OR src#>>'{frame,transaction_id}' IS DISTINCT FROM e->>'transaction_id'
  OR src#>'{frame,observed_at}' IS DISTINCT FROM f->'recognized_at'
 THEN RETURN NULL;END IF;
 SELECT count(*) INTO n FROM public.entry_purchase_idempotency_receipts q
  WHERE q.key_domain='horse_funding' AND q.idempotency_key=l#>>'{metadata,op_id}' AND to_jsonb(q)=r;
 IF n<>1 OR r->'response' IS NULL OR r->'response'='null'::jsonb OR r#>>'{response,success}' IS DISTINCT FROM 'true'
  OR r->>'completed_at' IS NULL OR r->>'claimed_at' IS NULL
  OR (r->>'completed_at')::timestamptz IS DISTINCT FROM joined OR (r->>'claimed_at')::timestamptz IS DISTINCT FROM joined
  OR r#>>'{request,door}' IS DISTINCT FROM 'fn_horse_seat_from_treasury'
  OR r#>>'{request,user_id}' IS DISTINCT FROM uid::text OR r#>>'{request,table_id}' IS DISTINCT FROM tid::text
  OR (r#>>'{request,amount}')::numeric IS DISTINCT FROM amt
  OR NULLIF(r#>>'{request,seat_number}','') IS NULL OR (r#>>'{request,seat_number}')::integer NOT BETWEEN 1 AND 10 THEN RETURN NULL;END IF;
 SELECT count(*) INTO n FROM public.chip_transactions q WHERE q.id=(j->>'id')::uuid AND to_jsonb(q)=j;
 IF n<>1 OR j->>'transaction_type' IS DISTINCT FROM 'horse_treasury_funding'
  OR j->>'club_id' IS DISTINCT FROM bank::text OR j->>'to_user_id' IS DISTINCT FROM uid::text OR j->>'from_user_id' IS NOT NULL
  OR (j->>'amount')::numeric IS DISTINCT FROM amt OR (j->>'balance_after')::numeric IS DISTINCT FROM (r#>>'{response,treasury_after}')::numeric
  OR (j->>'created_at')::timestamptz IS DISTINCT FROM joined THEN RETURN NULL;END IF;
 -- When original volatile inventory is still present it must be byte-exact;
 -- the admitted original event/frame survives its normal later retirement.
 IF EXISTS(SELECT FROM public.union_pnl_inventory_events q WHERE q.event_id=(e->>'event_id')::bigint AND to_jsonb(q) IS DISTINCT FROM e)
  OR EXISTS(SELECT FROM public.union_pnl_original_flows q WHERE q.ledger_id=p_ledger AND to_jsonb(q) IS DISTINCT FROM f)
  OR EXISTS(SELECT FROM public.union_pnl_transaction_frames q WHERE q.transaction_id=(e->>'transaction_id')::xid8 AND to_jsonb(q) IS DISTINCT FROM src->'frame') THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('status','proven','ledger_id',p_ledger,'earning_club',club,'sponsor_bank_club',bank,'user_id',uid,
  'table_id',tid,'seat_id',sid,'occupancy_id',occ,'seat_joined_at',joined,'operation_key',l#>>'{metadata,op_id}','amount',amt,'asset','chips','unit_scale',2,
  'bank_balance_after',j->'balance_after','original_event_id',e->'event_id','original_transaction_id',e->'transaction_id','source_fingerprint',w.source_fingerprint);
EXCEPTION WHEN no_data_found OR invalid_text_representation OR numeric_value_out_of_range OR datetime_field_overflow THEN RETURN NULL;
END $gift$;
REVOKE ALL ON FUNCTION smarter_private.original_treasury_gift_evidence(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION smarter_private.admit_original_treasury_gift(p_ledger uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET timezone='UTC' AS $admit$
DECLARE l public.chip_ledger%ROWTYPE;f public.union_pnl_original_flows%ROWTYPE;e public.union_pnl_inventory_events%ROWTYPE;
 fr public.union_pnl_transaction_frames%ROWTYPE;r public.entry_purchase_idempotency_receipts%ROWTYPE;j public.chip_transactions%ROWTYPE;
 src jsonb;proof jsonb;n bigint;cutover_at timestamptz;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('original_treasury_gift:'||p_ledger::text,0));
 IF EXISTS(SELECT FROM smarter_private.original_treasury_funding_witnesses WHERE ledger_id=p_ledger) THEN
  proof:=smarter_private.original_treasury_gift_evidence(p_ledger);
  IF proof IS NULL THEN RAISE EXCEPTION 'original_treasury_gift_retained_witness_invalid' USING ERRCODE='23514';END IF;RETURN proof;
 END IF;
 SELECT * INTO STRICT l FROM public.chip_ledger WHERE id=p_ledger;
 SELECT * INTO STRICT f FROM public.union_pnl_original_flows WHERE ledger_id=p_ledger;
 SELECT count(*) INTO n FROM public.union_pnl_inventory_events q WHERE q.transaction_id=f.transaction_id AND q.source_name='table_seats' AND q.operation='INSERT'
  AND q.before_row IS NULL AND q.after_row->>'user_id'=l.metadata->>'user_id' AND q.after_row->>'table_id'=l.table_id::text;
 IF n<>1 THEN RAISE EXCEPTION 'original_treasury_gift_exact_seat_insert_required' USING ERRCODE='23514';END IF;
 SELECT * INTO STRICT e FROM public.union_pnl_inventory_events q WHERE q.transaction_id=f.transaction_id AND q.source_name='table_seats' AND q.operation='INSERT'
  AND q.before_row IS NULL AND q.after_row->>'user_id'=l.metadata->>'user_id' AND q.after_row->>'table_id'=l.table_id::text;
 SELECT * INTO STRICT fr FROM public.union_pnl_transaction_frames WHERE transaction_id=f.transaction_id;
 SELECT * INTO STRICT r FROM public.entry_purchase_idempotency_receipts WHERE key_domain='horse_funding' AND idempotency_key=l.metadata->>'op_id';
 SELECT count(*) INTO n FROM public.chip_transactions q WHERE q.club_id=l.from_entity_id AND q.to_user_id=(l.metadata->>'user_id')::uuid
  AND q.from_user_id IS NULL AND q.transaction_type='horse_treasury_funding' AND q.amount=l.amount AND q.created_at=l.created_at
  AND q.balance_after=(r.response->>'treasury_after')::numeric;
 IF n<>1 THEN RAISE EXCEPTION 'original_treasury_gift_unique_bank_journal_required' USING ERRCODE='23514';END IF;
 SELECT * INTO STRICT j FROM public.chip_transactions q WHERE q.club_id=l.from_entity_id AND q.to_user_id=(l.metadata->>'user_id')::uuid
  AND q.from_user_id IS NULL AND q.transaction_type='horse_treasury_funding' AND q.amount=l.amount AND q.created_at=l.created_at
  AND q.balance_after=(r.response->>'treasury_after')::numeric;
 src:=jsonb_build_object('ledger',to_jsonb(l),'flow',to_jsonb(f),'seat_event',to_jsonb(e),'frame',to_jsonb(fr),'entry',to_jsonb(r),'journal',to_jsonb(j));
 SELECT installed_at INTO STRICT cutover_at FROM smarter_private.original_treasury_funding_cutover WHERE singleton;
 INSERT INTO smarter_private.original_treasury_funding_witnesses(ledger_id,kind,source,source_fingerprint,historical_late) VALUES(p_ledger,'gift',src,md5(src::text),f.recognized_at<cutover_at);
 IF f.recognized_at<cutover_at THEN INSERT INTO smarter_private.original_treasury_historical_admissions(ledger_id,kind,source_fingerprint)VALUES(p_ledger,'gift',md5(src::text));END IF;
 proof:=smarter_private.original_treasury_gift_evidence(p_ledger);
 IF proof IS NULL THEN RAISE EXCEPTION 'original_treasury_gift_proof_refused' USING ERRCODE='23514';END IF;
 RETURN proof;
END $admit$;
REVOKE ALL ON FUNCTION smarter_private.admit_original_treasury_gift(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION smarter_private.original_treasury_return_evidence(p_ledger uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public SET timezone='UTC' AS $return$
DECLARE w smarter_private.original_treasury_funding_witnesses%ROWTYPE;src jsonb;l jsonb;e jsonb;b jsonb;a jsonb;f jsonb;j jsonb;g jsonb;lineage jsonb;
 uid uuid;tid uuid;club uuid;amt numeric;at_time timestamptz;n bigint;cutover_at timestamptz;
BEGIN
 SELECT * INTO w FROM smarter_private.original_treasury_funding_witnesses WHERE ledger_id=p_ledger AND kind='return';
 IF NOT FOUND OR w.source_fingerprint IS DISTINCT FROM md5(w.source::text) THEN RETURN NULL;END IF;
 src:=w.source;l:=src->'ledger';e:=src->'seat_event';b:=e->'before_row';a:=e->'after_row';f:=src->'flow';j:=src->'journal';
 SELECT installed_at INTO STRICT cutover_at FROM smarter_private.original_treasury_funding_cutover WHERE singleton;
 IF w.historical_late IS DISTINCT FROM ((f->>'recognized_at')::timestamptz<cutover_at)
  OR (w.historical_late AND NOT EXISTS(SELECT FROM smarter_private.original_treasury_historical_admissions h WHERE h.ledger_id=w.ledger_id AND h.kind=w.kind AND h.source_fingerprint=w.source_fingerprint))
  OR (NOT w.historical_late AND EXISTS(SELECT FROM smarter_private.original_treasury_historical_admissions h WHERE h.ledger_id=w.ledger_id)) THEN RETURN NULL;END IF;
 uid:=(l->>'to_entity_id')::uuid;tid:=(l->>'table_id')::uuid;club:=(l->>'club_id')::uuid;amt:=(l->>'amount')::numeric;at_time:=(l->>'created_at')::timestamptz;
 SELECT count(*) INTO n FROM public.chip_ledger q WHERE id=p_ledger AND to_jsonb(q)=l;
 IF n<>1 OR uid IS NULL OR tid IS NULL OR club IS NULL OR at_time IS NULL OR NOT isfinite(at_time)
  OR l->>'status' IS DISTINCT FROM 'posted' OR l->>'category' NOT IN('cashout','table_cashout','refund')
  OR l->>'from_type' IS DISTINCT FROM 'table_stack' OR l->>'from_entity_id' IS DISTINCT FROM tid::text
  OR l->>'to_type' IS DISTINCT FROM 'player_wallet' OR amt IS NULL OR amt<=0 OR amt<>round(amt,2) OR amt::text IN('NaN','Infinity','-Infinity')
  OR e->>'source_name' IS DISTINCT FROM 'table_seats' OR e->>'operation' IS DISTINCT FROM 'UPDATE'
  OR b->>'id' IS NULL OR b->>'occupancy_id' IS NULL OR b->>'joined_at' IS NULL OR b->>'left_at' IS NOT NULL
  OR e->>'row_id' IS DISTINCT FROM b->>'id' OR b->>'user_id' IS DISTINCT FROM uid::text OR b->>'table_id' IS DISTINCT FROM tid::text
  OR b->>'club_id' IS DISTINCT FROM club::text OR (b->>'stack')::numeric IS DISTINCT FROM amt
  OR a-'left_at' IS DISTINCT FROM b-'left_at' OR (a->>'left_at')::timestamptz IS DISTINCT FROM at_time
  OR f->>'ledger_id' IS DISTINCT FROM p_ledger::text OR f->'ledger_snapshot' IS DISTINCT FROM l
  OR f->>'transaction_id' IS DISTINCT FROM e->>'transaction_id'
  OR f#>>'{game_scope,asset}' IS DISTINCT FROM 'chips' OR f#>'{game_scope,unit_scale}' IS DISTINCT FROM '2'::jsonb
  OR f#>'{game_scope,tournament_id}' IS DISTINCT FROM 'null'::jsonb
  OR src#>>'{frame,transaction_id}' IS DISTINCT FROM e->>'transaction_id'
  OR src#>'{frame,observed_at}' IS DISTINCT FROM f->'recognized_at' THEN RETURN NULL;END IF;
 g:=smarter_private.original_treasury_gift_evidence((src->>'gift_ledger_id')::uuid);
 IF g->>'status' IS DISTINCT FROM 'proven' OR g->>'earning_club' IS DISTINCT FROM club::text OR g->>'user_id' IS DISTINCT FROM uid::text
  OR g->>'table_id' IS DISTINCT FROM tid::text OR g->>'seat_id' IS DISTINCT FROM b->>'id'
  OR g->>'occupancy_id' IS DISTINCT FROM b->>'occupancy_id' OR (g->>'seat_joined_at')::timestamptz IS DISTINCT FROM (b->>'joined_at')::timestamptz
  OR (g->>'seat_joined_at')::timestamptz>=at_time THEN RETURN NULL;END IF;
 SELECT count(*) INTO n FROM public.wallet_transactions q WHERE id=(j->>'id')::uuid AND to_jsonb(q)=j;
 IF n<>1 OR j->>'type' IS DISTINCT FROM 'credit' OR j->>'wallet_type' IS DISTINCT FROM 'PLAYER' OR j->>'category' IS DISTINCT FROM 'cashout'
  OR j->>'user_id' IS DISTINCT FROM uid::text OR j->>'table_id' IS DISTINCT FROM tid::text
  OR (j->>'amount')::numeric IS DISTINCT FROM amt OR (j->>'created_at')::timestamptz IS DISTINCT FROM at_time
  OR j->>'balance_after' IS NULL THEN RETURN NULL;END IF;
 lineage:=public.fn_cash_original_funding_lineage(uid,tid,(b->>'id')::uuid,(b->>'occupancy_id')::uuid,(b->>'joined_at')::timestamptz,(f->>'recognized_at')::timestamptz,true);
 IF lineage->'issues' IS DISTINCT FROM '[]'::jsonb OR lineage->'moves' IS DISTINCT FROM '[]'::jsonb
  OR EXISTS(SELECT FROM jsonb_array_elements(lineage->'funding_receipts') r WHERE r->>'funding_club_id' IS DISTINCT FROM club::text) THEN RETURN NULL;END IF;
 IF EXISTS(SELECT FROM public.union_pnl_inventory_events q WHERE event_id=(e->>'event_id')::bigint AND to_jsonb(q) IS DISTINCT FROM e)
  OR EXISTS(SELECT FROM public.union_pnl_original_flows q WHERE ledger_id=p_ledger AND to_jsonb(q) IS DISTINCT FROM f)
  OR EXISTS(SELECT FROM public.union_pnl_transaction_frames q WHERE transaction_id=(e->>'transaction_id')::xid8 AND to_jsonb(q) IS DISTINCT FROM src->'frame') THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('status','proven','ledger_id',p_ledger,'earning_club',club,'user_id',uid,'amount',amt,'table_id',tid,
  'seat_id',b->'id','occupancy_id',b->'occupancy_id','seat_joined_at',b->'joined_at','gift_ledger_id',g->'ledger_id',
  'asset','chips','unit_scale',2,'funding_lineage',lineage,'original_event_id',e->'event_id','original_transaction_id',e->'transaction_id','source_fingerprint',w.source_fingerprint);
EXCEPTION WHEN no_data_found OR invalid_text_representation OR numeric_value_out_of_range OR datetime_field_overflow THEN RETURN NULL;
END $return$;
REVOKE ALL ON FUNCTION smarter_private.original_treasury_return_evidence(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION smarter_private.admit_original_treasury_return(p_ledger uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET timezone='UTC' AS $admitreturn$
DECLARE l public.chip_ledger%ROWTYPE;f public.union_pnl_original_flows%ROWTYPE;e public.union_pnl_inventory_events%ROWTYPE;
 fr public.union_pnl_transaction_frames%ROWTYPE;j public.wallet_transactions%ROWTYPE;gid uuid;src jsonb;proof jsonb;n bigint;cutover_at timestamptz;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('original_treasury_return:'||p_ledger::text,0));
 IF EXISTS(SELECT FROM smarter_private.original_treasury_funding_witnesses WHERE ledger_id=p_ledger) THEN
  proof:=smarter_private.original_treasury_return_evidence(p_ledger);
  IF proof IS NULL THEN RAISE EXCEPTION 'original_treasury_return_retained_witness_invalid' USING ERRCODE='23514';END IF;RETURN proof;
 END IF;
 SELECT * INTO STRICT l FROM public.chip_ledger WHERE id=p_ledger;
 SELECT * INTO STRICT f FROM public.union_pnl_original_flows WHERE ledger_id=p_ledger;
 SELECT count(*) INTO n FROM public.union_pnl_inventory_events q WHERE transaction_id=f.transaction_id AND source_name='table_seats' AND operation='UPDATE'
  AND before_row->>'user_id'=l.to_entity_id::text AND before_row->>'table_id'=l.table_id::text AND before_row->>'left_at' IS NULL
  AND (after_row->>'left_at')::timestamptz=l.created_at;
 IF n<>1 THEN RAISE EXCEPTION 'original_treasury_return_exact_seat_exit_required' USING ERRCODE='23514';END IF;
 SELECT * INTO STRICT e FROM public.union_pnl_inventory_events q WHERE transaction_id=f.transaction_id AND source_name='table_seats' AND operation='UPDATE'
  AND before_row->>'user_id'=l.to_entity_id::text AND before_row->>'table_id'=l.table_id::text AND before_row->>'left_at' IS NULL
  AND (after_row->>'left_at')::timestamptz=l.created_at;
 SELECT * INTO STRICT fr FROM public.union_pnl_transaction_frames WHERE transaction_id=f.transaction_id;
 SELECT count(*),min(w.ledger_id::text)::uuid INTO n,gid FROM smarter_private.original_treasury_funding_witnesses w
  CROSS JOIN LATERAL smarter_private.original_treasury_gift_evidence(w.ledger_id) g
  WHERE w.kind='gift' AND g->>'status'='proven' AND g->>'occupancy_id'=e.before_row->>'occupancy_id'
   AND g->>'seat_id'=e.before_row->>'id' AND g->>'user_id'=l.to_entity_id::text AND g->>'table_id'=l.table_id::text;
 IF n<>1 THEN RAISE EXCEPTION 'original_treasury_return_unique_initial_gift_required' USING ERRCODE='23514';END IF;
 SELECT count(*) INTO n FROM public.wallet_transactions q WHERE user_id=l.to_entity_id AND table_id=l.table_id AND amount=l.amount
  AND type='credit' AND wallet_type='PLAYER' AND category='cashout' AND created_at=l.created_at;
 IF n<>1 THEN RAISE EXCEPTION 'original_treasury_return_unique_wallet_journal_required' USING ERRCODE='23514';END IF;
 SELECT * INTO STRICT j FROM public.wallet_transactions q WHERE user_id=l.to_entity_id AND table_id=l.table_id AND amount=l.amount
  AND type='credit' AND wallet_type='PLAYER' AND category='cashout' AND created_at=l.created_at;
 src:=jsonb_build_object('ledger',to_jsonb(l),'flow',to_jsonb(f),'seat_event',to_jsonb(e),'frame',to_jsonb(fr),'journal',to_jsonb(j),'gift_ledger_id',gid);
 SELECT installed_at INTO STRICT cutover_at FROM smarter_private.original_treasury_funding_cutover WHERE singleton;
 INSERT INTO smarter_private.original_treasury_funding_witnesses(ledger_id,kind,source,source_fingerprint,historical_late) VALUES(p_ledger,'return',src,md5(src::text),f.recognized_at<cutover_at);
 IF f.recognized_at<cutover_at THEN INSERT INTO smarter_private.original_treasury_historical_admissions(ledger_id,kind,source_fingerprint)VALUES(p_ledger,'return',md5(src::text));END IF;
 proof:=smarter_private.original_treasury_return_evidence(p_ledger);
 IF proof IS NULL THEN RAISE EXCEPTION 'original_treasury_return_proof_refused' USING ERRCODE='23514';END IF;RETURN proof;
END $admitreturn$;
REVOKE ALL ON FUNCTION smarter_private.admit_original_treasury_return(uuid) FROM PUBLIC,anon,authenticated,service_role;

-- Existing buy-ins keep their original classification. Treasury top-ups are
-- not initial admissions: only the original seat-INSERT gift can be initial.
CREATE FUNCTION smarter_private.cash_initial_funding_receipt(p_receipt uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public SET timezone='UTC' AS $initial$
DECLARE f public.cash_participant_funding_receipts%ROWTYPE;g jsonb;
BEGIN
 SELECT * INTO f FROM public.cash_participant_funding_receipts WHERE id=p_receipt;
 IF NOT FOUND THEN RETURN false;END IF;
 IF f.operation_kind='buyin' THEN RETURN true;END IF;
 IF f.operation_kind IS DISTINCT FROM 'horse_funding' OR f.pending_addon_id IS NOT NULL THEN RETURN false;END IF;
 g:=smarter_private.original_treasury_gift_evidence(f.source_ledger_id);
 RETURN g->>'status'='proven' AND f.user_id::text=g->>'user_id' AND f.table_id::text=g->>'table_id'
  AND f.seat_id::text=g->>'seat_id' AND f.occupancy_id::text=g->>'occupancy_id'
  AND f.seat_joined_at=(g->>'seat_joined_at')::timestamptz AND f.recorded_at=f.seat_joined_at
  AND f.funding_club_id::text=g->>'earning_club' AND f.account_type='club_treasury'
  AND f.account_entity_id::text=g->>'sponsor_bank_club' AND f.asset='chips' AND f.unit_scale=2
  AND f.amount=(g->>'amount')::numeric AND f.balance_before-f.balance_after=f.amount
  AND f.operation_key=g->>'operation_key';
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR datetime_field_overflow THEN RETURN false;
END $initial$;
REVOKE ALL ON FUNCTION smarter_private.cash_initial_funding_receipt(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION smarter_private.original_treasury_participant_gift(p_participant jsonb,p_table uuid,p_captured timestamptz) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public SET timezone='UTC' AS $participant$
DECLARE g jsonb;n bigint;
BEGIN
 SELECT count(*),jsonb_agg(v)->0 INTO n,g FROM smarter_private.original_treasury_funding_witnesses w
 CROSS JOIN LATERAL smarter_private.original_treasury_gift_evidence(w.ledger_id) v
 WHERE w.kind='gift' AND v->>'status'='proven' AND v->>'table_id'=p_table::text
  AND v->>'user_id'=p_participant->>'user_id' AND v->>'seat_id'=p_participant->>'seat_id'
  AND v->>'occupancy_id'=p_participant->>'occupancy_id'
  AND (v->>'seat_joined_at')::timestamptz=(p_participant->>'seat_joined_at')::timestamptz
  AND (v->>'seat_joined_at')::timestamptz<=p_captured;
 IF n<>1 THEN RETURN NULL;END IF;RETURN g;
EXCEPTION WHEN no_data_found OR invalid_text_representation OR numeric_value_out_of_range OR datetime_field_overflow THEN RETURN NULL;
END $participant$;
REVOKE ALL ON FUNCTION smarter_private.original_treasury_participant_gift(jsonb,uuid,timestamptz) FROM PUBLIC,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.fn_cash_record_original_funding(p_kind text, p_key text, p_user uuid, p_table uuid, p_ledger uuid, p_wallet uuid, p_club uuid, p_amount numeric, p_after numeric, p_pending uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE s public.table_seats%ROWTYPE; l public.chip_ledger%ROWTYPE;
 c public.clubs%ROWTYPE; v_id uuid;g jsonb;gift boolean:=false;
BEGIN
 SELECT * INTO STRICT l FROM public.chip_ledger WHERE id=p_ledger;
 SELECT * INTO STRICT s FROM public.table_seats WHERE table_id=p_table AND user_id=p_user AND left_at IS NULL FOR SHARE;
 SELECT * INTO STRICT c FROM public.clubs WHERE id=p_club;
 IF p_kind='horse_funding' AND l.metadata->>'door'='fn_horse_seat_from_treasury' THEN
  g:=smarter_private.original_treasury_gift_evidence(p_ledger);
  gift:=COALESCE(g->>'status'='proven' AND g->>'user_id'=p_user::text AND g->>'table_id'=p_table::text
   AND g->>'seat_id'=s.id::text AND g->>'occupancy_id'=s.occupancy_id::text
   AND (g->>'seat_joined_at')::timestamptz=s.joined_at AND g->>'earning_club'=p_club::text
   AND g->>'sponsor_bank_club'=l.from_entity_id::text AND g->>'operation_key'=p_key
   AND (g->>'amount')::numeric=p_amount AND (g->>'bank_balance_after')::numeric=p_after AND p_pending IS NULL,false);
  IF NOT gift THEN RAISE EXCEPTION 'Original treasury seat gift proof required' USING ERRCODE='23514';END IF;
 END IF;
 IF s.occupancy_id IS NULL OR s.joined_at IS NULL
  OR c.asset IS DISTINCT FROM 'chips' OR (l.club_id IS DISTINCT FROM p_club AND NOT gift)
  OR l.amount IS DISTINCT FROM p_amount OR l.to_type IS DISTINCT FROM 'table_stack'
  OR l.to_entity_id IS DISTINCT FROM p_table OR l.category IS DISTINCT FROM p_kind
  OR l.from_type IS DISTINCT FROM (CASE WHEN p_kind='horse_funding' THEN 'club_treasury' ELSE 'player_wallet' END)
  OR (l.from_entity_id IS DISTINCT FROM (CASE WHEN p_kind='horse_funding' THEN p_club ELSE p_user END) AND NOT gift)
 THEN RAISE EXCEPTION 'Original cash funding debit identity mismatch' USING ERRCODE='23514'; END IF;
 IF p_kind<>'horse_funding' AND NOT EXISTS(SELECT 1 FROM public.wallet_transactions w
  WHERE w.id=p_wallet AND w.user_id=p_user AND w.table_id=p_table AND w.type='debit'
    AND w.category=p_kind AND w.amount=p_amount AND w.balance_after=p_after) THEN
  RAISE EXCEPTION 'Original cash funding wallet journal mismatch' USING ERRCODE='23514';
 END IF;
 INSERT INTO public.cash_participant_funding_receipts(operation_kind,operation_key,user_id,table_id,
  seat_id,occupancy_id,seat_joined_at,source_ledger_id,wallet_transaction_id,account_type,
  account_entity_id,funding_club_id,funding_union_id,asset,amount,balance_before,balance_after,pending_addon_id)
 VALUES(p_kind,p_key,p_user,p_table,s.id,s.occupancy_id,s.joined_at,l.id,p_wallet,l.from_type,
  l.from_entity_id,p_club,c.union_id,c.asset,p_amount,p_after+p_amount,p_after,p_pending) RETURNING id INTO v_id;
 RETURN v_id;
END $function$;
CREATE OR REPLACE FUNCTION public.fn_horse_seat_from_treasury(p_table_id uuid, p_user_id uuid, p_seat_number integer, p_amount numeric, p_op_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_request jsonb;
  v_response jsonb;
  v_ledger uuid;
  v_gift jsonb;
BEGIN
  p_op_id:=COALESCE(p_op_id,gen_random_uuid());
  PERFORM pg_advisory_xact_lock_shared(530090, 1);

  v_request := jsonb_build_object(
    'door', 'fn_horse_seat_from_treasury',
    'table_id', p_table_id,
    'user_id', p_user_id,
    'seat_number', p_seat_number,
    'amount', p_amount
  );
  v_response := public.fn_claim_entry_purchase_receipt(
    'horse_funding', p_op_id::text, v_request
  );
  IF NOT COALESCE((v_response->>'claimed')::boolean, false) THEN
    RETURN v_response->'response';
  END IF;

  IF p_op_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.chip_ledger l
     WHERE l.idempotency_key = 'horse_fund:' || p_op_id::text
  ) THEN
    RAISE EXCEPTION
      'IDEMPOTENCY_RECEIPT_UNBOUND: this historical horse key has no exact response receipt'
      USING ERRCODE = '55000';
  END IF;

  IF public.fn_entry_purchases_frozen() THEN
    PERFORM public.fn_release_entry_purchase_claim(
      'horse_funding', p_op_id::text, v_request
    );
    RETURN jsonb_build_object(
      'success', false,
      'deferred', true,
      'error', 'PLATFORM_FROZEN: scheduled maintenance has deferred this horse seat'
    );
  END IF;
  PERFORM public.fn_assert_cash_chip_purchase_table(p_table_id);
  v_response := public.fn_horse_seat_from_treasury_before_maintenance_gate(
    p_table_id, p_user_id, p_seat_number, p_amount, p_op_id
  );
  IF NOT COALESCE((v_response->>'success')::boolean, false) THEN
    PERFORM public.fn_release_entry_purchase_claim(
      'horse_funding', p_op_id::text, v_request
    );
    RETURN v_response;
  END IF;
  v_response:=public.fn_record_entry_purchase_receipt(
    'horse_funding', p_op_id::text, v_request, v_response
  );
  SELECT id INTO STRICT v_ledger FROM public.chip_ledger WHERE idempotency_key='horse_fund:'||p_op_id::text;
  v_gift:=smarter_private.admit_original_treasury_gift(v_ledger);
  PERFORM public.fn_cash_record_original_funding('horse_funding',p_op_id::text,p_user_id,p_table_id,v_ledger,NULL,
    (v_gift->>'earning_club')::uuid,p_amount,(v_gift->>'bank_balance_after')::numeric,NULL);
  RETURN v_response;
END;
$function$;
CREATE OR REPLACE FUNCTION public.fn_cash_original_funding_lineage(p_user uuid, p_table uuid, p_seat uuid, p_occupancy uuid, p_join timestamp with time zone, p_at timestamp with time zone, p_boundary boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET "TimeZone" TO 'UTC'
AS $function$
DECLARE m public.cash_seat_move_receipts%ROWTYPE; f public.cash_participant_funding_receipts%ROWTYPE;
 l public.chip_ledger%ROWTYPE; a public.cash_funding_application_receipts%ROWTYPE;
 current_table uuid:=p_table; current_occupancy uuid:=p_occupancy;
 seen uuid[]:=ARRAY[]::uuid[]; ids uuid[]:=ARRAY[]::uuid[]; refs jsonb:='[]'; moves jsonb:='[]'; issues jsonb:='[]';
 cutoff timestamptz:=p_at; cutoff_transaction xid8; move_at timestamptz;
 move_club uuid; n integer; depth integer:=0;
BEGIN
 IF p_user IS NULL OR p_table IS NULL OR p_seat IS NULL OR p_occupancy IS NULL
  OR p_join IS NULL OR NOT isfinite(p_join) OR p_at IS NULL OR NOT isfinite(p_at) THEN
  RETURN jsonb_build_object('version',1,'observed_at',p_at,'funding_receipts',refs,'moves',moves,'issues',jsonb_build_array('cash_lineage_identity_missing'));
 END IF;
 LOOP
  IF current_occupancy=ANY(seen) OR depth>64 THEN
   issues:=issues||'"cash_move_cycle_or_depth_unproven"'::jsonb; EXIT;
  END IF;
  seen:=array_append(seen,current_occupancy);
  FOR f IN SELECT r.* FROM public.cash_participant_funding_receipts r
   LEFT JOIN public.union_pnl_transaction_frames b ON b.transaction_id=r.transaction_id
   WHERE r.occupancy_id=current_occupancy AND (CASE WHEN p_boundary THEN COALESCE(b.observed_at,r.recorded_at) ELSE r.recorded_at END)<p_at
    AND ((CASE WHEN p_boundary THEN COALESCE(b.observed_at,r.recorded_at) ELSE r.recorded_at END)<=cutoff OR r.transaction_id=cutoff_transaction)
   ORDER BY r.recorded_at,r.id LOOP
   IF f.id=ANY(ids) OR f.user_id IS DISTINCT FROM p_user OR f.table_id IS DISTINCT FROM current_table
    OR (depth=0 AND (f.seat_id IS DISTINCT FROM p_seat OR f.seat_joined_at IS DISTINCT FROM p_join))
    OR (move_club IS NOT NULL AND f.funding_club_id IS DISTINCT FROM move_club)
    OR (f.account_type='player_wallet' AND f.account_entity_id IS DISTINCT FROM f.user_id)
    OR (f.account_type='club_treasury' AND f.account_entity_id IS DISTINCT FROM f.funding_club_id AND NOT (f.operation_kind='horse_funding' AND smarter_private.cash_initial_funding_receipt(f.id) IS TRUE))
    OR f.asset IS DISTINCT FROM 'chips' OR f.unit_scale<>2 OR NOT isfinite(f.recorded_at)
    OR f.amount<=0 OR f.amount<>round(f.amount,2) OR f.amount::text IN ('NaN','Infinity','-Infinity')
    OR f.balance_before-f.balance_after IS DISTINCT FROM f.amount THEN
    issues:=issues||'"cash_lineage_funding_identity_invalid"'::jsonb;
   END IF;
   SELECT * INTO l FROM public.chip_ledger WHERE id=f.source_ledger_id;
   IF NOT FOUND OR l.status IS DISTINCT FROM 'posted' OR (l.club_id IS DISTINCT FROM f.funding_club_id AND NOT (f.operation_kind='horse_funding' AND smarter_private.cash_initial_funding_receipt(f.id) IS TRUE))
    OR l.from_type IS DISTINCT FROM f.account_type OR l.from_entity_id IS DISTINCT FROM f.account_entity_id
    OR l.to_type IS DISTINCT FROM 'table_stack' OR l.to_entity_id IS DISTINCT FROM f.table_id
    OR l.category IS DISTINCT FROM f.operation_kind OR l.amount IS DISTINCT FROM f.amount THEN
    issues:=issues||'"cash_lineage_original_debit_invalid"'::jsonb;
   END IF;
   IF f.pending_addon_id IS NOT NULL AND NOT p_boundary THEN
    SELECT * INTO a FROM public.cash_funding_application_receipts WHERE funding_receipt_id=f.id;
    IF NOT FOUND OR a.original_occupancy_id IS DISTINCT FROM f.occupancy_id
     OR NOT isfinite(a.applied_at) OR a.applied+a.refunded IS DISTINCT FROM f.amount
     OR (a.applied>0 AND a.applied_occupancy_id IS DISTINCT FROM f.occupancy_id) THEN
     issues:=issues||'"pending_funding_application_unproven"'::jsonb;
    END IF;
   END IF;
   ids:=array_append(ids,f.id);
   refs:=refs||jsonb_build_array(jsonb_build_object('id',f.id,'account_type',f.account_type,
    'account_entity_id',f.account_entity_id,'funding_club_id',f.funding_club_id,'funding_union_id',f.funding_union_id,
    'pending_addon_id',f.pending_addon_id));
  END LOOP;
  SELECT count(*) INTO n FROM public.cash_seat_move_receipts r LEFT JOIN public.union_pnl_transaction_frames b ON b.transaction_id=r.transaction_id
   WHERE r.destination_occupancy_id=current_occupancy AND (CASE WHEN p_boundary THEN COALESCE(b.observed_at,r.created_at) ELSE r.created_at END)<p_at;
  IF n=0 THEN EXIT; END IF;
  IF n<>1 THEN issues:=issues||'"cash_move_destination_fork"'::jsonb; EXIT; END IF;
  SELECT r.* INTO m FROM public.cash_seat_move_receipts r LEFT JOIN public.union_pnl_transaction_frames b ON b.transaction_id=r.transaction_id
   WHERE r.destination_occupancy_id=current_occupancy AND (CASE WHEN p_boundary THEN COALESCE(b.observed_at,r.created_at) ELSE r.created_at END)<p_at;
  SELECT observed_at INTO move_at FROM public.union_pnl_transaction_frames WHERE transaction_id=m.transaction_id;
  IF p_boundary AND (m.transaction_id IS NULL OR move_at IS NULL) THEN
   issues:=issues||'"cash_move_original_transaction_frame_missing"'::jsonb;
  END IF;
  IF m.player_id IS DISTINCT FROM p_user OR m.to_table_id IS DISTINCT FROM current_table
   OR m.source_occupancy_id=ANY(seen) OR m.from_table_id=m.to_table_id
   OR m.club_id IS NULL OR (move_club IS NOT NULL AND m.club_id IS DISTINCT FROM move_club)
   OR m.amount<=0 OR m.amount<>round(m.amount,2) OR m.amount::text IN ('NaN','Infinity','-Infinity')
   OR NOT isfinite(m.created_at) OR (CASE WHEN p_boundary THEN COALESCE(move_at,m.created_at) ELSE m.created_at END)>cutoff
   OR (move_at IS NOT NULL AND (NOT isfinite(move_at) OR move_at>=p_at))
   OR jsonb_typeof(m.receipt) IS DISTINCT FROM 'object' OR m.receipt->>'ok' IS DISTINCT FROM 'true'
   OR m.receipt->>'move_id' IS DISTINCT FROM m.move_id::text OR m.receipt->>'player_id' IS DISTINCT FROM p_user::text
   OR m.receipt->>'from_table_id' IS DISTINCT FROM m.from_table_id::text
   OR m.receipt->>'to_table_id' IS DISTINCT FROM m.to_table_id::text
   OR m.receipt->>'source_seat_number' IS DISTINCT FROM m.from_seat_number::text
   OR m.receipt->>'to_seat_number' IS DISTINCT FROM m.to_seat_number::text
   OR m.receipt->>'source_occupancy_id' IS DISTINCT FROM m.source_occupancy_id::text
   OR m.receipt->>'destination_occupancy_id' IS DISTINCT FROM m.destination_occupancy_id::text
   OR public.fn_pnl_evidence_cents(m.receipt->'stack') IS DISTINCT FROM m.amount
   OR m.receipt->>'idempotency_key' IS DISTINCT FROM 'seatmove:'||m.move_id::text
   OR (SELECT count(*) FROM public.cash_seat_move_receipts r LEFT JOIN public.union_pnl_transaction_frames b ON b.transaction_id=r.transaction_id WHERE r.source_occupancy_id=m.source_occupancy_id AND (CASE WHEN p_boundary THEN COALESCE(b.observed_at,r.created_at) ELSE r.created_at END)<p_at)<>1 THEN
   issues:=issues||'"cash_move_original_receipt_invalid"'::jsonb; EXIT;
  END IF;
  moves:=moves||jsonb_build_array(to_jsonb(m));
  move_club:=m.club_id; current_table:=m.from_table_id; current_occupancy:=m.source_occupancy_id;
  cutoff:=CASE WHEN p_boundary THEN COALESCE(move_at,m.created_at) ELSE m.created_at END; cutoff_transaction:=m.transaction_id; depth:=depth+1;
 END LOOP;
 -- Every retained source must agree with the exact custody club through all moves.
 IF move_club IS NOT NULL AND EXISTS(SELECT 1 FROM jsonb_array_elements(refs) r WHERE r->>'funding_club_id' IS DISTINCT FROM move_club::text) THEN
  issues:=issues||'"cash_move_original_funding_club_mismatch"'::jsonb;
 END IF;
 RETURN jsonb_build_object('version',1,'observed_at',p_at,'funding_receipts',refs,'moves',moves,'issues',issues);
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR datetime_field_overflow THEN
 RETURN jsonb_build_object('version',1,'observed_at',p_at,'funding_receipts','[]'::jsonb,'moves',moves,'issues',jsonb_build_array('cash_move_malformed_original_evidence'));
END $function$;
CREATE OR REPLACE FUNCTION public.fn_pnl_cash_hand_evidence(p_table_id uuid, p_hand_number bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_gift jsonb;v_gift_users uuid[]:=ARRAY[]::uuid[];v_gift_resolved boolean:=false;v_posthand_original jsonb; a public.hand_atomic_commits%ROWTYPE; v_live_atomic jsonb; p public.cash_hand_provenance_receipts%ROWTYPE;
 m public.cash_hand_participant_manifests%ROWTYPE; f public.cash_participant_funding_receipts%ROWTYPE;
 l public.chip_ledger%ROWTYPE; app public.cash_funding_application_receipts%ROWTYPE;
 v_lineage jsonb; v_lineage_at timestamptz; x jsonb; y jsonb; submitted jsonb; original jsonb; ref jsonb; v_request jsonb; v_stack_hand uuid; v_people jsonb:='[]';
 v_issues jsonb:='[]'; v_seen uuid[]:=ARRAY[]::uuid[]; v_funding_seen uuid[];
 v_user uuid; v_club uuid; v_account jsonb; v_funding_account jsonb;
 v_before numeric; v_after numeric; v_delta numeric:=0; v_rake numeric; v_bbj numeric; v_inflow numeric;
 v_initial integer; v_owned boolean; v_population boolean:=false;
BEGIN
 v_posthand_original:=smarter_private.posthand_escrow_certified_evidence(p_table_id,p_hand_number);
 IF v_posthand_original IS NOT NULL THEN RETURN v_posthand_original;END IF;
 SELECT * INTO p FROM public.cash_hand_provenance_receipts WHERE table_id=p_table_id AND hand_number=p_hand_number;
 IF NOT FOUND THEN RETURN jsonb_build_object('status','blocked','basis_certified',false,
  'all_players_included',false,'reason','original_cash_provenance_missing'); END IF;
 IF jsonb_typeof(p.atomic_receipt) IS DISTINCT FROM 'object'
  OR p.atomic_receipt->>'table_id' IS DISTINCT FROM p_table_id::text
  OR p.atomic_receipt->>'hand_number' IS DISTINCT FROM p_hand_number::text THEN
  RETURN jsonb_build_object('status','blocked','basis_certified',false,'all_players_included',false,
   'reason','retained_atomic_receipt_missing'); END IF;
 SELECT * INTO a FROM jsonb_populate_record(NULL::public.hand_atomic_commits,p.atomic_receipt);
 SELECT to_jsonb(live) INTO v_live_atomic FROM public.hand_atomic_commits live
  WHERE table_id=p_table_id AND hand_number=p_hand_number;
 IF FOUND AND NOT smarter_private.horse_cash_retained_atomic_matches(p_table_id,p_hand_number,p.atomic_receipt,v_live_atomic,p.accepted_request) THEN
  RETURN jsonb_build_object('status','blocked','basis_certified',false,'all_players_included',false,
   'reason','live_atomic_receipt_conflicts_with_original'); END IF;
 v_request:=a.stack_result->'request';
 IF a.committed_at IS NULL OR NOT isfinite(a.committed_at)
  OR a.stack_result->'success' IS DISTINCT FROM 'true'::jsonb
  OR a.stack_result->>'mode' IS DISTINCT FROM 'delta'
  OR jsonb_typeof(v_request->'stacks') IS DISTINCT FROM 'array'
  OR NOT a.stack_result ? 'tournament_id' OR a.stack_result->'tournament_id' IS DISTINCT FROM 'null'::jsonb THEN
  RETURN jsonb_build_object('status','blocked','basis_certified',false,'all_players_included',false,
   'reason','accepted_cash_delta_request_missing');
 END IF;
 IF p.version<>1 OR p.hand_id IS DISTINCT FROM a.hand_id OR p.payload_hash IS DISTINCT FROM a.payload_hash
  OR p.accepted_at IS NULL OR NOT isfinite(p.accepted_at) OR p.accepted_at<a.committed_at
  OR jsonb_typeof(p.accepted_request) IS DISTINCT FROM 'object'
  OR p.accepted_request->>'table_id' IS DISTINCT FROM p_table_id::text
  OR p.accepted_request->>'hand_number' IS DISTINCT FROM p_hand_number::text
  OR NOT smarter_private.horse_cash_retained_request_matches(p_table_id,p_hand_number,a.payload_hash,p.accepted_request)
  OR jsonb_typeof(p.accepted_request->'stacks') IS DISTINCT FROM 'array'
  OR p.manifest_id IS NULL OR jsonb_typeof(p.participants) IS DISTINCT FROM 'array'
  OR jsonb_typeof(p.issues) IS DISTINCT FROM 'array' THEN
  RETURN jsonb_build_object('status','blocked','basis_certified',false,'all_players_included',false,
   'reason','accepted_cash_provenance_link_missing');
 END IF;
 SELECT * INTO m FROM public.cash_hand_participant_manifests WHERE id=p.manifest_id;
 IF NOT FOUND OR m.table_id IS DISTINCT FROM p_table_id OR m.hand_number IS DISTINCT FROM p_hand_number
  OR m.captured_at IS NULL OR NOT isfinite(m.captured_at) OR m.captured_at>p.accepted_at
  OR m.game_scope IS DISTINCT FROM p.game_scope OR jsonb_typeof(m.participants) IS DISTINCT FROM 'array'
  OR jsonb_array_length(m.participants)<>jsonb_array_length(p.participants)
  OR jsonb_array_length(p.participants)<>jsonb_array_length(v_request->'stacks')
  OR jsonb_array_length(p.participants)<>jsonb_array_length(p.accepted_request->'stacks')
  OR (SELECT count(DISTINCT value->>'user_id') FROM jsonb_array_elements(v_request->'stacks'))<>jsonb_array_length(p.participants)
  OR (SELECT count(DISTINCT value->>'user_id') FROM jsonb_array_elements(p.accepted_request->'stacks'))<>jsonb_array_length(p.participants)
  OR (SELECT count(DISTINCT value->>'user_id') FROM jsonb_array_elements(m.participants))<>jsonb_array_length(p.participants)
  OR jsonb_array_length(p.participants)<2 OR jsonb_array_length(p.participants)>10
  OR p.all_players_included IS DISTINCT FROM true THEN
  RETURN jsonb_build_object('status','blocked','basis_certified',false,'all_players_included',false,
   'reason','original_cash_population_link_missing');
 END IF;
 v_stack_hand:=(a.stack_result->>'hand_id')::uuid;
 IF p.stack_claim->>'table_id' IS DISTINCT FROM p_table_id::text
  OR p.stack_claim->>'hand_id' IS DISTINCT FROM v_stack_hand::text
  OR p.stack_claim->>'status' IS DISTINCT FROM 'succeeded'
  OR (p.stack_claim->>'completed_at') IS NULL OR p.stack_claim->'result' IS DISTINCT FROM a.stack_result
  OR p.stack_settlement->>'table_id' IS DISTINCT FROM p_table_id::text
  OR p.stack_settlement->>'hand_id' IS DISTINCT FROM v_stack_hand::text
  OR p.stack_settlement->>'settlement_type' IS DISTINCT FROM 'hand_stacks'
  OR p.stack_settlement->>'state' IS DISTINCT FROM 'final'
  OR EXISTS(SELECT 1 FROM public.settlement_idempotency_keys k WHERE k.table_id=p_table_id AND k.hand_id=v_stack_hand
    AND (k.status IS DISTINCT FROM 'succeeded' OR smarter_private.horse_settlement_original_result(k.table_id,k.hand_id,k.result) IS DISTINCT FROM a.stack_result OR k.completed_at IS NULL))
  OR EXISTS(SELECT 1 FROM public.ca_settlements c WHERE c.table_id=p_table_id AND c.hand_id=v_stack_hand
    AND c.settlement_type='hand_stacks' AND c.state IS DISTINCT FROM 'final') THEN
  v_issues:=v_issues||'"accepted_stack_receipt_link_missing"'::jsonb;
 END IF;
 -- Only the exact missing original admission can be resolved by its retained
 -- original treasury gift. Every other captured defect remains a refusal.
 IF p.status='uncertified' AND p.funding_provenance_complete=false AND m.funding_provenance_complete=false
  AND p.issues=m.issues AND jsonb_array_length(p.issues)>0 THEN
  FOR x IN SELECT value FROM jsonb_array_elements(p.participants) LOOP
   v_gift:=smarter_private.original_treasury_participant_gift(x,p_table_id,m.captured_at);
   IF v_gift->>'status'='proven' THEN v_gift_users:=array_append(v_gift_users,(x->>'user_id')::uuid);END IF;
  END LOOP;
  v_gift_resolved:=NOT EXISTS(SELECT FROM jsonb_array_elements(p.issues) i
   WHERE NOT EXISTS(SELECT FROM unnest(v_gift_users) u WHERE i=jsonb_build_object('reason','original_admission_funding_missing','user_id',u)));
 END IF;
 IF (p.status IS DISTINCT FROM 'captured' OR p.funding_provenance_complete IS DISTINCT FROM true
  OR m.funding_provenance_complete IS DISTINCT FROM true OR p.issues<>'[]'::jsonb OR m.issues<>'[]'::jsonb) AND NOT v_gift_resolved THEN
  v_issues:=v_issues||'"original_cash_funding_incomplete"'::jsonb||p.issues;
 END IF;
 IF jsonb_typeof(p.game_scope) IS DISTINCT FROM 'object'
  OR NOT p.game_scope ?& ARRAY['host_club_id','game_union_id','is_private','tournament_id','asset','unit_scale']
  OR p.game_scope->>'asset' IS DISTINCT FROM 'chips' OR p.game_scope->'unit_scale' IS DISTINCT FROM '2'::jsonb
  OR p.game_scope->'tournament_id' IS DISTINCT FROM 'null'::jsonb
  OR jsonb_typeof(p.game_scope->'is_private') IS DISTINCT FROM 'boolean'
  OR (p.game_scope->'is_private'='true'::jsonb AND p.game_scope->'game_union_id' IS DISTINCT FROM 'null'::jsonb)
  OR (p.game_scope->'is_private'='false'::jsonb AND (p.game_scope->>'game_union_id') IS NULL) THEN
  v_issues:=v_issues||'"historical_game_asset_and_union_receipt_invalid"'::jsonb;
 END IF;
 FOR x IN SELECT value FROM jsonb_array_elements(p.participants) LOOP
  v_user:=(x->>'user_id')::uuid;
  SELECT value INTO y FROM jsonb_array_elements(v_request->'stacks') WHERE value->>'user_id'=x->>'user_id';
  SELECT value INTO submitted FROM jsonb_array_elements(p.accepted_request->'stacks') WHERE value->>'user_id'=x->>'user_id';
  SELECT value INTO original FROM jsonb_array_elements(m.participants) WHERE value->>'user_id'=x->>'user_id';
  v_before:=public.fn_pnl_evidence_cents(x->'stack_before'); v_after:=public.fn_pnl_evidence_cents(x->'stack_after');
  IF v_user IS NULL OR v_user=ANY(v_seen) OR y IS NULL OR original IS NULL
   OR submitted IS NULL OR original IS DISTINCT FROM (x-'stack_after'-'poker_delta')
   OR v_before IS NULL OR v_after IS NULL OR v_before<0 OR v_after<0
   OR public.fn_pnl_evidence_cents(x->'poker_delta') IS DISTINCT FROM v_after-v_before
   OR public.fn_pnl_evidence_cents(y->'stack_before') IS DISTINCT FROM v_before
   OR public.fn_pnl_evidence_cents(y->'stack') IS DISTINCT FROM v_after
   OR y->>'seat_id' IS DISTINCT FROM x->>'seat_id'
   OR public.fn_pnl_evidence_cents(submitted->'stack_before') IS DISTINCT FROM v_before
   OR public.fn_pnl_evidence_cents(submitted->'stack') IS DISTINCT FROM v_after
   OR submitted->>'seat_id' IS DISTINCT FROM x->>'seat_id'
   OR submitted->>'occupancy_id' IS DISTINCT FROM x->>'occupancy_id'
   OR (submitted->>'seat_joined_at')::timestamptz IS DISTINCT FROM (x->>'seat_joined_at')::timestamptz
   OR (y->>'seat_joined_at')::timestamptz IS DISTINCT FROM (x->>'seat_joined_at')::timestamptz
   OR submitted->>'funding_manifest_id' IS DISTINCT FROM p.manifest_id::text THEN
   RETURN jsonb_build_object('status','blocked','basis_certified',false,'all_players_included',false,
    'reason','original_cash_participant_mismatch');
  END IF;
  v_seen:=array_append(v_seen,v_user); v_delta:=v_delta+v_after-v_before;
  v_gift:=smarter_private.original_treasury_participant_gift(x,p_table_id,m.captured_at);
  v_owned:=true; v_initial:=0; v_club:=NULL; v_account:=NULL; v_funding_seen:=ARRAY[]::uuid[];
  v_lineage:=NULL;
  IF x ? 'funding_lineage' THEN
   v_lineage_at:=(x#>>'{funding_lineage,observed_at}')::timestamptz;
   IF v_lineage_at IS NULL OR NOT isfinite(v_lineage_at) OR v_lineage_at>m.captured_at THEN v_owned:=false; END IF;
   v_lineage:=public.fn_cash_original_funding_lineage(v_user,p_table_id,(x->>'seat_id')::uuid,
    (x->>'occupancy_id')::uuid,(x->>'seat_joined_at')::timestamptz,v_lineage_at,false);
   IF v_lineage IS DISTINCT FROM x->'funding_lineage' OR v_lineage->'issues'<>'[]'::jsonb
    OR v_lineage->'funding_receipts' IS DISTINCT FROM x->'funding_receipts' THEN v_owned:=false; END IF;
  END IF;
  IF v_gift->>'status'='proven' THEN
   v_club:=(v_gift->>'earning_club')::uuid;
   IF NOT EXISTS(SELECT FROM jsonb_array_elements(x->'funding_receipts') r WHERE smarter_private.cash_initial_funding_receipt((r->>'id')::uuid) IS TRUE) THEN v_initial:=1;END IF;
  END IF;
  IF jsonb_typeof(x->'funding_receipts') IS DISTINCT FROM 'array'  OR x->'funding_receipts'='[]'::jsonb THEN
   IF v_gift->>'status' IS DISTINCT FROM 'proven' OR jsonb_typeof(x->'funding_receipts') IS DISTINCT FROM 'array' THEN v_owned:=false;END IF;
  ELSE
   FOR ref IN SELECT value FROM jsonb_array_elements(x->'funding_receipts') LOOP
    SELECT * INTO f FROM public.cash_participant_funding_receipts WHERE id=(ref->>'id')::uuid;
    IF NOT FOUND THEN v_owned:=false; CONTINUE; END IF;
    IF f.id=ANY(v_funding_seen) THEN v_owned:=false; END IF;
    v_funding_seen:=array_append(v_funding_seen,f.id);
    v_funding_account:=jsonb_build_array(f.funding_club_id,f.funding_union_id,f.asset);
    IF v_gift->>'status'='proven' AND f.funding_club_id IS DISTINCT FROM (v_gift->>'earning_club')::uuid THEN v_owned:=false;END IF;
    IF v_account IS NULL THEN v_account:=v_funding_account; v_club:=f.funding_club_id;
    ELSIF v_account IS DISTINCT FROM v_funding_account THEN v_owned:=false; END IF;
    IF smarter_private.cash_initial_funding_receipt(f.id) IS TRUE THEN v_initial:=v_initial+1; END IF;
    IF f.user_id IS DISTINCT FROM v_user OR (v_lineage IS NULL AND (f.table_id IS DISTINCT FROM p_table_id
     OR f.seat_id::text IS DISTINCT FROM x->>'seat_id' OR f.occupancy_id::text IS DISTINCT FROM x->>'occupancy_id'
     OR f.seat_joined_at IS DISTINCT FROM (x->>'seat_joined_at')::timestamptz))
     OR f.recorded_at>m.captured_at OR NOT isfinite(f.recorded_at) OR f.asset<>'chips' OR f.unit_scale<>2
     OR f.account_type IS DISTINCT FROM ref->>'account_type'
     OR f.account_entity_id::text IS DISTINCT FROM ref->>'account_entity_id'
     OR f.funding_club_id::text IS DISTINCT FROM ref->>'funding_club_id'
     OR f.funding_union_id::text IS DISTINCT FROM ref->>'funding_union_id'
     OR f.pending_addon_id::text IS DISTINCT FROM ref->>'pending_addon_id'
     OR f.amount<=0 OR f.amount<>round(f.amount,2) OR f.amount::text IN ('NaN','Infinity','-Infinity')
     OR f.balance_before-f.balance_after IS DISTINCT FROM f.amount THEN v_owned:=false; END IF;
    SELECT * INTO l FROM public.chip_ledger WHERE id=f.source_ledger_id;
    IF NOT FOUND OR l.status IS DISTINCT FROM 'posted' OR (l.club_id IS DISTINCT FROM f.funding_club_id AND NOT (f.operation_kind='horse_funding' AND smarter_private.cash_initial_funding_receipt(f.id) IS TRUE))
     OR l.from_type IS DISTINCT FROM f.account_type OR l.from_entity_id IS DISTINCT FROM f.account_entity_id
     OR l.to_type IS DISTINCT FROM 'table_stack' OR l.to_entity_id IS DISTINCT FROM f.table_id
     OR l.category IS DISTINCT FROM f.operation_kind OR l.amount IS DISTINCT FROM f.amount THEN v_owned:=false; END IF;
    IF f.pending_addon_id IS NOT NULL THEN
     SELECT * INTO app FROM public.cash_funding_application_receipts WHERE pending_addon_id=f.pending_addon_id;
     IF NOT FOUND OR app.funding_receipt_id IS DISTINCT FROM f.id OR app.original_occupancy_id IS DISTINCT FROM f.occupancy_id
      OR NOT isfinite(app.applied_at) OR app.applied+app.refunded IS DISTINCT FROM f.amount
      OR (app.applied>0 AND app.applied_occupancy_id IS DISTINCT FROM f.occupancy_id) THEN v_owned:=false; END IF;
    END IF;
   END LOOP;
  END IF;
  IF v_initial<>1 THEN v_owned:=false; END IF;
  IF NOT v_owned THEN v_issues:=v_issues||jsonb_build_array(jsonb_build_object('reason','participant_earning_ownership_receipt_invalid','user_id',v_user)); END IF;
  v_people:=v_people||jsonb_build_array(jsonb_build_object('user_id',v_user,'is_horse',x->'is_horse',
   'observed_stack_delta',v_after-v_before,'earning_club_id',CASE WHEN v_owned THEN v_club ELSE NULL END,
   'ownership_certified',v_owned,'ownership_scope','original_chip_funding_club','funding_receipt_ids',to_jsonb(v_funding_seen))||CASE WHEN v_gift->>'status'='proven' THEN jsonb_build_object('original_treasury_gift',v_gift) ELSE '{}'::jsonb END);
 END LOOP;
 v_population:=true;
 v_rake:=public.fn_pnl_evidence_cents(v_request->'rake'); v_bbj:=public.fn_pnl_evidence_cents(v_request->'bbj');
 v_inflow:=public.fn_pnl_evidence_cents(v_request->'inflow');
 IF v_request->'rake'='null'::jsonb THEN v_rake:=0; END IF;
 IF v_request->'bbj'='null'::jsonb THEN v_bbj:=0; END IF;
 IF v_request->'inflow'='null'::jsonb THEN v_inflow:=0; END IF;
 IF v_rake IS NULL OR v_bbj IS NULL OR v_inflow IS NULL OR v_rake<0 OR v_bbj<0
  OR public.fn_pnl_evidence_cents(coalesce(NULLIF(p.accepted_request->'rake','null'::jsonb),'0'::jsonb)) IS DISTINCT FROM v_rake
  OR public.fn_pnl_evidence_cents(coalesce(NULLIF(p.accepted_request->'bbj','null'::jsonb),'0'::jsonb)) IS DISTINCT FROM v_bbj
  OR public.fn_pnl_evidence_cents(coalesce(NULLIF(p.accepted_request->'inflow','null'::jsonb),'0'::jsonb)) IS DISTINCT FROM v_inflow
  OR v_rake IS DISTINCT FROM p.rake OR v_bbj IS DISTINCT FROM p.bbj OR v_inflow IS DISTINCT FROM p.signed_external_net THEN
  v_issues:=v_issues||'"hand_conservation_inputs_missing"'::jsonb;
 ELSIF v_delta+v_rake+v_bbj<>v_inflow THEN v_issues:=v_issues||'"hand_delta_conservation_mismatch"'::jsonb;
 END IF;
 -- Signed insurance/external movements conserve but need their own bank linkage.
 IF v_inflow<>0 THEN v_issues:=v_issues||'"external_bank_receipt_not_certified"'::jsonb; END IF;
 RETURN jsonb_build_object('status',CASE WHEN v_issues='[]'::jsonb THEN 'ready' ELSE 'blocked' END,
  'basis_certified',v_issues='[]'::jsonb,'scope','single_accepted_cash_hand','payment_authorized',false,
  'hand_id',a.hand_id,'table_id',p_table_id,'hand_number',p_hand_number,'observed_commit_at',a.committed_at,
  'observed_delta_total',v_delta,'participants',v_people,'issues',v_issues,'game_scope',p.game_scope,
  'current_seats_used',false,'current_membership_used',false,'all_players_included',v_population);
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR datetime_field_overflow THEN
 RETURN jsonb_build_object('status','blocked','basis_certified',false,'all_players_included',false,'reason','malformed_original_cash_evidence');
END $function$;
CREATE OR REPLACE FUNCTION public.fn_cash_capture_hand_manifest(p_table_id uuid, p_hand_number bigint, p_participants jsonb, p_instance_id text, p_lease_generation uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE t public.tables%ROWTYPE; h public.clubs%ROWTYPE; s public.table_seats%ROWTYPE;
 prior public.cash_hand_participant_manifests%ROWTYPE;
 x jsonb; v_users uuid[]:=ARRAY[]::uuid[]; v_occupancies uuid[]:=ARRAY[]::uuid[];
 v_roster jsonb:='[]'; v_request jsonb; v_scope jsonb; v_issues jsonb:='[]';
 v_lineage jsonb; v_funding jsonb; v_initial integer; v_accounts integer; v_id uuid; v_user uuid;
 v_seat uuid; v_occupancy uuid; v_join timestamptz; v_before numeric; v_complete boolean:=true;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'Engine authority required' USING ERRCODE='42501'; END IF;
 IF p_table_id IS NULL OR p_hand_number IS NULL OR p_hand_number<1000000
 OR jsonb_typeof(p_participants) IS DISTINCT FROM 'array' OR jsonb_array_length(p_participants)<2
 OR jsonb_array_length(p_participants)>10 OR p_instance_id IS NULL OR p_lease_generation IS NULL THEN
  RAISE EXCEPTION 'Invalid original cash manifest' USING ERRCODE='22023'; END IF;
 PERFORM 1 FROM public.engine_table_leases l WHERE l.table_id=p_table_id
  AND l.instance_id=p_instance_id AND l.lease_generation=p_lease_generation AND l.protocol_version=2
  AND l.heartbeat_at>=clock_timestamp()-make_interval(secs=>public.fn_engine_lease_stale_seconds()) FOR KEY SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Original cash manifest lease stale' USING ERRCODE='55000'; END IF;
 SELECT jsonb_agg(value ORDER BY value->>'user_id') INTO v_request FROM jsonb_array_elements(p_participants);
 SELECT * INTO prior FROM public.cash_hand_participant_manifests WHERE table_id=p_table_id AND hand_number=p_hand_number;
 IF FOUND THEN
  IF prior.request IS DISTINCT FROM v_request OR prior.lease_instance_id IS DISTINCT FROM p_instance_id
   OR prior.lease_generation IS DISTINCT FROM p_lease_generation THEN
   RAISE EXCEPTION 'Original cash manifest identity reused' USING ERRCODE='22023'; END IF;
  RETURN jsonb_build_object('version',1,'manifest_id',prior.id,'funding_provenance_complete',prior.funding_provenance_complete,'issues',prior.issues);
 END IF;
 SELECT * INTO STRICT t FROM public.tables WHERE id=p_table_id FOR SHARE;
 IF t.tournament_id IS NOT NULL THEN RAISE EXCEPTION 'Tournament chips are not cash provenance' USING ERRCODE='22023'; END IF;
 SELECT * INTO h FROM public.clubs WHERE id=t.club_id;
 v_scope:=jsonb_build_object('host_club_id',t.club_id,'game_union_id',CASE WHEN t.is_private THEN NULL ELSE t.union_id END,
  'is_private',t.is_private,'tournament_id',t.tournament_id,'asset',h.asset,'unit_scale',2);
 IF h.id IS NULL OR h.asset IS DISTINCT FROM 'chips' OR t.is_private IS NULL
  OR (NOT t.is_private AND t.union_id IS NULL) THEN
  v_issues:=v_issues||'"game_asset_or_union_scope_unproven"'::jsonb; v_complete:=false; END IF;
 FOR x IN SELECT value FROM jsonb_array_elements(v_request) LOOP
  v_user:=(x->>'user_id')::uuid; v_seat:=(x->>'seat_id')::uuid;
  v_occupancy:=(x->>'occupancy_id')::uuid; v_join:=(x->>'seat_joined_at')::timestamptz;
  v_before:=(x->>'stack_before')::numeric;
  IF v_user IS NULL OR v_seat IS NULL OR v_occupancy IS NULL OR v_join IS NULL
   OR NOT isfinite(v_join) OR v_user=ANY(v_users) OR v_occupancy=ANY(v_occupancies)
   OR jsonb_typeof(x->'is_horse') IS DISTINCT FROM 'boolean' OR jsonb_typeof(x->'stack_before') IS DISTINCT FROM 'number'
   OR v_before IS NULL OR v_before<0 OR v_before<>round(v_before,2)
   OR v_before::text IN ('NaN','Infinity','-Infinity') THEN
   RAISE EXCEPTION 'Invalid or duplicate cash participant' USING ERRCODE='22023'; END IF;
  v_users:=array_append(v_users,v_user); v_occupancies:=array_append(v_occupancies,v_occupancy);
  SELECT * INTO s FROM public.table_seats WHERE id=v_seat AND table_id=p_table_id AND user_id=v_user
   AND occupancy_id=v_occupancy AND joined_at=v_join AND left_at IS NULL FOR SHARE;
  IF NOT FOUND OR s.stack IS DISTINCT FROM v_before THEN
   v_issues:=v_issues||jsonb_build_array(jsonb_build_object('reason','original_seat_or_starting_stack_unproven','user_id',v_user));
   v_complete:=false;
  END IF;
  v_lineage:=public.fn_cash_original_funding_lineage(v_user,p_table_id,v_seat,v_occupancy,v_join,clock_timestamp(),false);
  v_funding:=v_lineage->'funding_receipts';
  SELECT count(*) FILTER(WHERE smarter_private.cash_initial_funding_receipt(f.id) IS TRUE),count(DISTINCT (f.funding_club_id,f.funding_union_id,f.asset))
   INTO v_initial,v_accounts FROM jsonb_array_elements(v_funding) ref
   JOIN public.cash_participant_funding_receipts f ON f.id=(ref->>'id')::uuid;
  IF v_lineage->'issues'<>'[]'::jsonb THEN
   v_issues:=v_issues||jsonb_build_array(jsonb_build_object('reason','original_cash_move_lineage_unproven','user_id',v_user,'details',v_lineage->'issues'));
   v_complete:=false;
  END IF;
  IF v_initial<>1 OR v_accounts<>1 THEN
   v_issues:=v_issues||jsonb_build_array(jsonb_build_object('reason',CASE WHEN v_initial<>1 THEN 'original_admission_funding_missing' ELSE 'mixed_funding_account_ownership_unproven' END,'user_id',v_user));
   v_complete:=false;
  END IF;
  IF EXISTS(SELECT 1 FROM public.cash_participant_funding_receipts f
    LEFT JOIN public.cash_funding_application_receipts a ON a.funding_receipt_id=f.id
    WHERE f.id IN(SELECT (ref->>'id')::uuid FROM jsonb_array_elements(v_funding) ref) AND f.pending_addon_id IS NOT NULL
     AND (a.pending_addon_id IS NULL OR (a.applied>0 AND a.applied_occupancy_id IS DISTINCT FROM f.occupancy_id))) THEN
   v_issues:=v_issues||jsonb_build_array(jsonb_build_object('reason','pending_funding_application_unproven','user_id',v_user));
   v_complete:=false;
  END IF;
  v_roster:=v_roster||jsonb_build_array(jsonb_build_object('user_id',v_user,'seat_id',v_seat,
   'seat_joined_at',x->>'seat_joined_at','occupancy_id',v_occupancy,'stack_before',v_before,
   'is_horse',(x->>'is_horse')::boolean,'funding_receipts',v_funding,'funding_lineage',v_lineage));
 END LOOP;
 INSERT INTO public.cash_hand_participant_manifests(table_id,hand_number,lease_instance_id,lease_generation,
  request,game_scope,participants,issues,funding_provenance_complete)
 VALUES(p_table_id,p_hand_number,p_instance_id,p_lease_generation,v_request,v_scope,v_roster,v_issues,v_complete)
 RETURNING id INTO v_id;
 RETURN jsonb_build_object('version',1,'manifest_id',v_id,'funding_provenance_complete',v_complete,'issues',v_issues);
END $function$;
CREATE OR REPLACE FUNCTION public.fn_cash_earning_club(p_hand_id uuid, p_table_id uuid, p_player_id uuid, p_source_club uuid, p_union_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE started timestamptz;clubs uuid[];chair uuid[];paid uuid[];
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE='42501'; END IF;
 IF p_hand_id IS NULL OR p_table_id IS NULL OR p_player_id IS NULL OR p_source_club IS NULL THEN
  RAISE EXCEPTION 'cash_earning_identity_missing' USING ERRCODE='23514'; END IF;
 SELECT h.started_at INTO started FROM public.hand_history h WHERE h.id=p_hand_id AND h.table_id=p_table_id;
 -- Original off-chair custody exists only in the accepted native hand's
 -- transaction. Never derive ownership from today's replacement chair.
 IF started IS NOT NULL AND isfinite(started) AND started<=transaction_timestamp() THEN
  SELECT array_agg(DISTINCT r.funding_club_id) INTO clubs
  FROM smarter_private.retired_cash_hand_custody r
  JOIN smarter_private.retired_cash_hand_qualification q USING(submission_id)
  JOIN smarter_private.hand_submissions s USING(submission_id)
  JOIN smarter_private.hand_submission_handoffs h USING(submission_id)
  JOIN public.hand_atomic_commits a ON a.hand_id=r.submission_id
   AND a.table_id=r.table_id AND a.hand_number=r.hand_number
  WHERE r.submission_id=p_hand_id AND r.table_id=p_table_id AND r.user_id=p_player_id
   AND r.state='consumed' AND r.transaction_id=txid_current()
   AND h.transaction_id=r.transaction_id AND h.request_hash=r.request_hash
   AND s.request_hash=r.request_hash AND q.request_hash=r.request_hash
   AND r.accepted_time_bank=r.original_time_bank AND r.settlement_id IS NOT NULL
   AND (q.table_id,q.hand_number)=(r.table_id,r.hand_number)
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(q.expected->'participants') e
    WHERE (e#>>'{stack,user_id}')::uuid=r.user_id
     AND (e#>>'{stack,seat_id}')::uuid=r.seat_id
     AND (e#>>'{stack,occupancy_id}')::uuid=r.occupancy_id
     AND (e#>>'{stack,seat_joined_at}')::timestamptz=r.seat_joined_at
     AND (e#>>'{stack,stack_before}')::numeric=r.stack_before
     AND (e#>>'{stack,stack}')::numeric=r.stack_after
     AND (e->>'funding_club_id')::uuid=r.funding_club_id);
  IF cardinality(clubs)=1 AND clubs[1] IS NOT NULL
   AND EXISTS(SELECT 1 FROM public.clubs c WHERE c.id=clubs[1]
    AND (c.is_union IS NOT TRUE OR (p_union_id IS NOT NULL AND (c.id=p_union_id OR c.union_id=p_union_id))))
  THEN RETURN clubs[1]; END IF;
 END IF;
 -- Funding must exist by the persisted actual hand start. The logical formed_at
 -- supplied by the engine can precede the transaction that opens its slot.
 -- A pooled Lightning hand is funded by its original pool/cash session,
 -- not a physical chair at the synthetic host table. Anchor seats can be
 -- elsewhere or already gone by settlement; their session is retained.
 IF EXISTS(SELECT 1 FROM public.lightning_hand h
   WHERE h.hand_history_id=p_hand_id AND h.host_table_id=p_table_id) THEN
  IF started IS NULL OR NOT isfinite(started) OR started>transaction_timestamp() THEN
   RAISE EXCEPTION 'cash_hand_start_not_recorded' USING ERRCODE='23514'; END IF;
  -- The earning club is the club whose wallet funded the anchor chair, as
  -- for every Classic chair. cash_player_session.club_id is the TABLE's club,
  -- which on a union-hosted game is the union itself, not the funding club.
  SELECT array_agg(DISTINCT s.club_id) FILTER (WHERE s.club_id IS NOT NULL),
         array_agg(DISTINCT r.funding_club_id) FILTER (WHERE r.funding_club_id IS NOT NULL),
         array_agg(DISTINCT cs.club_id)
    INTO chair, paid, clubs
   FROM public.lightning_hand h
   JOIN public.lightning_hand_player hp ON hp.hand_id=h.hand_id
    AND hp.player_id=p_player_id AND hp.cluster_id=h.cluster_id AND hp.cluster_epoch=h.cluster_epoch
   JOIN public.lightning_pool_slot sl ON sl.id=hp.pool_slot_id AND sl.player_id=hp.player_id
    AND sl.cluster_id=h.cluster_id AND sl.cluster_epoch=h.cluster_epoch
   JOIN public.lightning_pool_session ps ON ps.id=sl.pool_session_id AND ps.player_id=hp.player_id
    AND ps.cluster_id=h.cluster_id AND ps.cluster_epoch=h.cluster_epoch
   JOIN public.cash_player_session cs ON cs.id=ps.cash_player_session_id AND cs.player_id=hp.player_id
   LEFT JOIN public.table_seats s ON s.id=ps.anchor_seat_id AND s.user_id=hp.player_id
    AND s.joined_at<=started AND (s.left_at IS NULL OR s.left_at>started)
   -- A chair row can be gone by settlement; its buy-in receipt is immutable.
   LEFT JOIN LATERAL (
    SELECT f.funding_club_id FROM public.cash_participant_funding_receipts f
     WHERE smarter_private.cash_initial_funding_receipt(f.id) IS TRUE AND f.table_id=cs.table_id
      AND (f.account_entity_id=hp.player_id OR (f.operation_kind='horse_funding' AND smarter_private.cash_initial_funding_receipt(f.id) IS TRUE))
      AND f.user_id=hp.player_id AND f.seat_id=ps.anchor_seat_id
      AND f.seat_joined_at<=ps.entered_at AND f.recorded_at<=started
     ORDER BY f.seat_joined_at DESC, f.recorded_at DESC, f.id DESC LIMIT 1) r ON true
   WHERE h.hand_history_id=p_hand_id AND h.host_table_id=p_table_id
    AND h.formed_at<=started AND ps.entered_at<=started AND sl.opened_at<=started
    AND cs.opened_at<=started
    AND (ps.exited_at IS NULL OR ps.exited_at>started)
    AND (sl.closed_at IS NULL OR sl.closed_at>started)
    AND (cs.closed_at IS NULL OR cs.closed_at>started);
  IF cardinality(chair)=1
   AND EXISTS(SELECT 1 FROM public.clubs c WHERE c.id=chair[1]
    AND (c.is_union IS NOT TRUE OR (p_union_id IS NOT NULL AND (c.id=p_union_id OR c.union_id=p_union_id))))
  THEN RETURN chair[1]; END IF;
  IF chair IS NULL AND cardinality(paid)=1
   AND EXISTS(SELECT 1 FROM public.clubs c WHERE c.id=paid[1]
    AND (c.is_union IS NOT TRUE OR (p_union_id IS NOT NULL AND (c.id=p_union_id OR c.union_id=p_union_id))))
  THEN RETURN paid[1]; END IF;
  -- No unambiguous funding chair: the original session reader, unchanged.
  IF cardinality(clubs)=1 AND clubs[1] IS NOT NULL
   AND EXISTS(SELECT 1 FROM public.clubs c WHERE c.id=clubs[1]
    AND (c.is_union IS NOT TRUE OR (p_union_id IS NOT NULL AND (c.id=p_union_id OR c.union_id=p_union_id))))
  THEN RETURN clubs[1]; END IF;
  IF p_union_id IS NOT NULL THEN
   RAISE EXCEPTION 'cash_earning_seat_provenance_missing_or_ambiguous' USING ERRCODE='23514'; END IF;
  RETURN NULL;
 END IF;
 IF p_union_id IS NULL THEN
  -- Private games may admit a seat funded by another club. Preserve the
  -- actual club at the hand's start; the host only identifies the bank route.
  -- This reader runs before banking an already accepted hand. Unknown seat
  -- evidence must therefore stay NULL, not abort its bank obligation or invent
  -- host ownership. The existing source worker durably refuses that NULL or
  -- an unsupported cross-club liability after the exact bank receipt exists.
  IF started IS NULL OR NOT isfinite(started) OR started>transaction_timestamp() THEN RETURN NULL; END IF;
  SELECT array_agg(DISTINCT s.club_id) INTO clubs FROM public.table_seats s
   WHERE s.table_id=p_table_id AND s.user_id=p_player_id
    AND s.joined_at<=started AND (s.left_at IS NULL OR s.left_at>started);
  -- An overlapping unknown-club seat also makes the evidence ambiguous.
  IF cardinality(clubs) IS DISTINCT FROM 1 OR clubs[1] IS NULL
   OR NOT EXISTS(SELECT 1 FROM public.clubs c WHERE c.id=clubs[1] AND c.is_union IS NOT TRUE)
  THEN RETURN NULL; END IF;
  RETURN clubs[1];
 END IF;
 -- Preserve the existing shared-union validation and failure contract.
 IF started IS NULL OR started>transaction_timestamp() THEN RAISE EXCEPTION 'cash_hand_start_not_recorded' USING ERRCODE='23514'; END IF;
 SELECT array_agg(DISTINCT s.club_id) INTO clubs FROM public.table_seats s
  WHERE s.table_id=p_table_id AND s.user_id=p_player_id AND s.club_id IS NOT NULL
   AND s.joined_at<=started AND (s.left_at IS NULL OR s.left_at>started);
 IF cardinality(clubs) IS DISTINCT FROM 1
  OR NOT EXISTS(SELECT 1 FROM public.clubs c WHERE c.id=clubs[1]
   AND (c.is_union IS NOT TRUE OR c.id=p_union_id OR c.union_id=p_union_id))
 THEN RAISE EXCEPTION 'cash_earning_seat_provenance_missing_or_ambiguous' USING ERRCODE='23514'; END IF;
 RETURN clubs[1];
END $function$;
CREATE OR REPLACE FUNCTION public.fn_ca_cash_seat_club(p_table uuid, p_user uuid)
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(
    (SELECT s.club_id FROM public.table_seats s
      WHERE s.table_id = p_table AND s.user_id = p_user AND s.left_at IS NULL
        AND s.club_id IS NOT NULL LIMIT 1),
    (SELECT x.funding_club_id FROM public.cash_participant_funding_receipts x
      WHERE smarter_private.cash_initial_funding_receipt(x.id) IS TRUE AND x.table_id = p_table AND x.user_id = p_user
      ORDER BY x.seat_joined_at DESC NULLS LAST LIMIT 1));
$function$;
CREATE OR REPLACE FUNCTION public.fn_union_pnl_boundary(p_union_id uuid, p_at timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE inv jsonb; holdings jsonb:='[]'; issues jsonb:='[]'; s jsonb; t jsonb; f record; tr record;
 lineage jsonb; owned uuid; owners int; initial int; value numeric; entries int; first_op text;
 nonchips boolean; changed boolean; returned numeric; res_club uuid; res_amount numeric; v_proj boolean;
 seat_rows int; seat_value numeric; seat_club uuid; seat_credits int; original_receivables jsonb;
BEGIN
 inv:=public.fn_union_pnl_inventory_as_of_admitted(p_at);
 IF inv->>'status' IS DISTINCT FROM 'observed' THEN RETURN jsonb_build_object('status','blocked','inventory',inv,'holdings',holdings); END IF;
 FOR s IN SELECT x->'row' FROM jsonb_array_elements(COALESCE(inv#>'{population,table_seats}','[]')) x
  WHERE EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(inv#>'{population,tables}','[]')) y
   WHERE y#>>'{row,id}'=x#>>'{row,table_id}' AND y#>>'{row,union_id}'=p_union_id::text) LOOP
  lineage:=public.fn_cash_original_funding_lineage((s->>'user_id')::uuid,(s->>'table_id')::uuid,
   (s->>'id')::uuid,(s->>'occupancy_id')::uuid,(s->>'joined_at')::timestamptz,p_at,true);
  SELECT count(*) FILTER(WHERE smarter_private.cash_initial_funding_receipt(r.id) IS TRUE),count(DISTINCT (r.funding_club_id,r.funding_union_id,r.asset)),min(r.funding_club_id::text)::uuid
   INTO initial,owners,owned FROM jsonb_array_elements(lineage->'funding_receipts') ref
   JOIN public.cash_participant_funding_receipts r ON r.id=(ref->>'id')::uuid;
  value:=public.fn_pnl_evidence_cents(s->'stack');
  IF lineage->'issues'<>'[]'::jsonb OR initial<>1 OR owners<>1 OR owned IS NULL OR value IS NULL OR value<0 THEN
   issues:=issues||jsonb_build_array(jsonb_build_object('reason','cash_boundary_original_funding_missing_or_ambiguous','seat_id',s->'id'));
  ELSE
   holdings:=holdings||jsonb_build_array(jsonb_build_object('club_id',owned,'user_id',s->'user_id','amount',value,'kind','cash_stack','source_id',s->'id'));
  END IF;
 END LOOP;
 -- Money awaiting the original add-on application is still held for its
 -- original funding account. It must not appear as a poker loss at midnight.
 FOR f IN
  SELECT r.*,r.amount-CASE WHEN COALESCE(af.observed_at,a.applied_at)<p_at THEN a.applied+a.refunded ELSE 0 END AS held
  FROM public.cash_participant_funding_receipts r
  LEFT JOIN public.cash_funding_application_receipts a ON a.funding_receipt_id=r.id
  LEFT JOIN public.union_pnl_transaction_frames rf ON rf.transaction_id=r.transaction_id
  LEFT JOIN public.union_pnl_transaction_frames af ON af.transaction_id=a.transaction_id
  WHERE r.pending_addon_id IS NOT NULL AND COALESCE(rf.observed_at,r.recorded_at)<p_at
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(inv#>'{population,tables}','[]')) y
    WHERE y#>>'{row,id}'=r.table_id::text AND y#>>'{row,union_id}'=p_union_id::text)
 LOOP
  IF f.held<0 OR f.funding_club_id IS NULL THEN
   issues:=issues||jsonb_build_array(jsonb_build_object('reason','pending_funding_boundary_invalid','source_id',f.id));
  ELSIF f.held>0 THEN
   holdings:=holdings||jsonb_build_array(jsonb_build_object('club_id',f.funding_club_id,'user_id',f.user_id,'amount',f.held,'kind','pending_cash_funding','source_id',f.id));
  END IF;
 END LOOP;
 -- Preserve the established realized-settlement rule: original gross entry
 -- less money already returned is deferred while a tournament remains open.
 -- This is not market value, ICM, or a new allocation of the prize pool.
 -- First inventory operations come from union_pnl_inventory_touches once its
 -- backfill is complete (20260929044303), else from the wide events.
 v_proj:=public.fn_union_pnl_projection_ready('inventory_touches');
 FOR t IN SELECT x->'row' FROM jsonb_array_elements(COALESCE(inv#>'{population,tournaments}','[]')) x
  WHERE x#>>'{row,union_id}'=p_union_id::text LOOP
  first_op:=public.fn_union_pnl_first_inventory_operation('tournaments',(t->>'id')::uuid,v_proj);
  -- A tournament captured as the baseline (it existed before the original
  -- inventory capture) is read only when every registration of its original
  -- population carries a valid opening resolution for this boundary
  -- (union_pnl_opening_registration_resolutions: its entry re-proved from the
  -- posted chip ledger, bound to these exact population rows). Otherwise it is
  -- refused exactly as before.
  IF first_op IS DISTINCT FROM 'INSERT' AND (first_op IS DISTINCT FROM 'baseline' OR EXISTS(
    SELECT 1 FROM jsonb_array_elements(COALESCE(inv#>'{population,tournament_players}','[]')) y(x)
    WHERE y.x#>>'{row,tournament_id}'=t->>'id'
     AND public.fn_union_pnl_first_inventory_operation('tournament_players',(y.x#>>'{row,id}')::uuid,v_proj) IS DISTINCT FROM 'INSERT'
     AND NOT EXISTS(SELECT 1 FROM public.fn_union_pnl_opening_registration_resolution(p_union_id,p_at,t,y.x->'row')))) THEN
   issues:=issues||jsonb_build_array(jsonb_build_object('reason','open_tournament_precedes_original_population','tournament_id',t->'id')); CONTINUE;
  END IF;
  -- One set-based read per open tournament (it was four queries per seat,
  -- two of them full scans of every tournament credit): the same original
  -- entry, instrument, owner-change and returned-credit facts, per
  -- registration, in the population's order.
  FOR s,entries,owners,owned,value,nonchips,changed,returned,res_club,res_amount IN
   WITH players AS MATERIALIZED (
    SELECT y.x->'row' s,y.o ord,(y.x#>>'{row,id}')::uuid registration_id,(y.x#>>'{row,user_id}')::uuid user_id
    FROM jsonb_array_elements(COALESCE(inv#>'{population,tournament_players}','[]')) WITH ORDINALITY y(x,o)
    WHERE y.x#>>'{row,tournament_id}'=t->>'id'
   ), credits AS MATERIALIZED (
    -- fn_union_pnl_tournament_returns(t,NULL,NULL,p_at): every credit of this
    -- tournament observed before the boundary; the registration filter that
    -- function applied per call is applied per player below.
    SELECT c.user_id,c.credited_club_id,c.amount,c.entry_receipt_ids,true same_tournament
    FROM public.tournament_accounting_credit_receipts c
    JOIN public.union_pnl_transaction_frames b ON b.transaction_id=c.transaction_id
    WHERE c.tournament_id=(t->>'id')::uuid AND b.observed_at<p_at
    UNION ALL
    SELECT r2.user_id,r2.source_wallet_club_id,r2.amount_paid_now,ARRAY[r.id],false
    FROM public.tournament_refund_tranches r2
    JOIN public.tournament_participant_funding_receipts r ON r.entitlement_id=r2.entitlement_id
    JOIN public.union_pnl_transaction_frames b ON b.transaction_id=r2.transaction_id
    WHERE r2.tournament_id=(t->>'id')::uuid AND b.observed_at<p_at
     AND NOT EXISTS(SELECT 1 FROM public.tournament_accounting_credit_receipts c WHERE c.ledger_id=r2.credit_ledger_id)
   ) SELECT p.s,e.entries,e.owners,e.owned,e.value,
    EXISTS(SELECT 1 FROM public.tournament_participant_funding_receipts r WHERE r.tournament_id=(t->>'id')::uuid AND r.registration_id=p.registration_id AND r.asset<>'chips'),
    k.changed,k.returned,rr.owning_club_id,rr.deferred_amount
   FROM players p
   CROSS JOIN LATERAL (SELECT count(*) entries,count(DISTINCT public.fn_union_pnl_tournament_entry_club_of(r.asset,r.amount,r.funding_club_id,r.ledger_id,r.entitlement_id,r.registration_snapshot)) owners,
     min(public.fn_union_pnl_tournament_entry_club_of(r.asset,r.amount,r.funding_club_id,r.ledger_id,r.entitlement_id,r.registration_snapshot)::text)::uuid owned,sum(r.amount) value
    FROM public.tournament_participant_funding_receipts r
    JOIN public.union_pnl_transaction_frames b ON b.transaction_id=r.transaction_id
    WHERE r.tournament_id=(t->>'id')::uuid AND r.registration_id=p.registration_id AND b.observed_at<p_at AND r.asset='chips') e
   CROSS JOIN LATERAL (SELECT COALESCE(bool_or(c.credited_club_id<>e.owned),false) changed,sum(c.amount) returned
    FROM credits c WHERE c.user_id=p.user_id
     AND EXISTS(SELECT 1 FROM public.tournament_participant_funding_receipts r
      WHERE r.registration_id=p.registration_id AND r.id=ANY(c.entry_receipt_ids)
       AND (NOT c.same_tournament OR r.tournament_id=(t->>'id')::uuid))) k
   LEFT JOIN LATERAL (SELECT q.owning_club_id,q.deferred_amount
    FROM public.fn_union_pnl_opening_registration_resolution(p_union_id,p_at,t,p.s) q WHERE first_op='baseline') rr ON true
   ORDER BY p.ord
  LOOP
   -- In a baseline tournament a resolved registration is carried at its
   -- re-proved original entry less its returns before the boundary.
   IF res_club IS NOT NULL THEN
    holdings:=holdings||jsonb_build_array(jsonb_build_object('club_id',res_club,'user_id',s->'user_id','amount',res_amount,
     'kind','deferred_tournament_result','source_id',s->'id','basis','opening_registration_resolution'));
    CONTINUE;
   END IF;
   -- A satellite-won seat (20261007001000) has no entry receipt: it was
   -- never charged to a wallet. It is held at the value its one funding row
   -- moved into this prize liability, for the club that funded the seat.
   IF entries=0 AND NOT nonchips AND s->>'source_satellite_id' IS NOT NULL THEN
    SELECT count(*),sum(l.amount) INTO seat_rows,seat_value FROM public.chip_ledger l
     WHERE l.status='posted' AND l.row_hash IS NOT NULL AND l.created_at<p_at
      AND l.to_type='prize_liability' AND l.to_entity_id=(t->>'id')::uuid
      AND l.metadata->>'registration_id'=s->>'id' AND l.metadata->>'user_id'=s->>'user_id'
      AND ((l.category='tournament_buyin' AND l.from_type='prize_liability' AND l.from_entity_id=(s->>'source_satellite_id')::uuid
        AND l.metadata->>'kind'='satellite_seat_pool_transfer')
       OR (l.category='ticket_redeem' AND l.from_type='escrow' AND l.metadata->>'kind'='tournament_entry_ticket_admission'
        AND l.metadata->>'source_satellite_id'=s->>'source_satellite_id'));
    seat_club:=public.fn_union_pnl_satellite_seat_owner((s->>'id')::uuid,(t->>'id')::uuid);
    SELECT (SELECT count(*) FROM public.tournament_accounting_credit_receipts c
      JOIN public.union_pnl_transaction_frames b ON b.transaction_id=c.transaction_id
      WHERE c.tournament_id=(t->>'id')::uuid AND c.user_id::text=s->>'user_id' AND b.observed_at<p_at)
     +(SELECT count(*) FROM public.tournament_refund_tranches r2
      JOIN public.union_pnl_transaction_frames b ON b.transaction_id=r2.transaction_id
      WHERE r2.tournament_id=(t->>'id')::uuid AND r2.user_id::text=s->>'user_id' AND b.observed_at<p_at)
     INTO seat_credits;
    IF seat_rows=1 AND seat_value>0 AND seat_club IS NOT NULL AND seat_credits=0 THEN
     holdings:=holdings||jsonb_build_array(jsonb_build_object('club_id',seat_club,'user_id',s->'user_id','amount',seat_value,
      'kind','deferred_tournament_result','source_id',s->'id','basis','satellite_seat'));
     CONTINUE;
    END IF;
   END IF;
   IF entries=0 OR owners<>1 OR owned IS NULL OR nonchips THEN
    issues:=issues||jsonb_build_array(jsonb_build_object('reason','open_tournament_original_instrument_or_earning_club_missing','registration_id',s->'id')); CONTINUE;
   END IF;
   IF changed THEN
    issues:=issues||jsonb_build_array(jsonb_build_object('reason','open_tournament_credit_owner_changed','registration_id',s->'id')); CONTINUE;
   END IF;
   value:=value-COALESCE(returned,0);
   holdings:=holdings||jsonb_build_array(jsonb_build_object('club_id',owned,'user_id',s->'user_id','amount',value,'kind','deferred_tournament_result','source_id',s->'id'));
  END LOOP;
 END LOOP;
 IF p_union_id='fade0000-0000-0000-0000-000000000001'::uuid AND p_at>='2026-10-12 07:00:00Z'::timestamptz THEN
  original_receivables:=smarter_private.original_erased_cash_receivables(p_union_id,p_at);
  IF original_receivables->>'status' IS DISTINCT FROM 'ready' THEN
   issues:=issues||jsonb_build_array(jsonb_build_object('reason','original_erased_receivable_unproven','evidence',original_receivables));
  ELSE
   IF EXISTS(SELECT 1 FROM jsonb_array_elements(holdings) existing JOIN jsonb_array_elements(original_receivables->'holdings') owed
    ON existing->>'source_id'=owed->>'source_id') THEN
    issues:=issues||jsonb_build_array(jsonb_build_object('reason','original_erased_receivable_double_count_refused'));
   ELSE holdings:=holdings||(original_receivables->'holdings');END IF;
  END IF;
 END IF;
 RETURN jsonb_build_object('status',CASE WHEN issues='[]'::jsonb THEN 'ready' ELSE 'blocked' END,'boundary',p_at,
  'inventory',inv,'holdings',holdings,'issues',issues,'tournament_basis','original_realized_settlement_deferred_while_open');
END $function$;
CREATE OR REPLACE FUNCTION smarter_private.original_inventory_basis_generation()
 RETURNS text
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
 SET "TimeZone" TO 'UTC'
AS $function$
DECLARE r jsonb; receipt jsonb; c record; proofs text;source_hash text;source_count bigint;discharges jsonb:='[]';treasury text;tw record;tp jsonb;
BEGIN
 IF (SELECT count(*) FROM smarter_private.original_inventory_restoration_cases) IS DISTINCT FROM 245::bigint
 OR (SELECT count(*) FROM smarter_private.original_inventory_restoration_certificates WHERE boundary='2026-10-12 07:00:00Z') IS DISTINCT FROM 245::bigint
 OR smarter_private.original_inventory_proof_sources_match() IS DISTINCT FROM true THEN RETURN NULL;END IF;
 -- Deduplicate shared original authorities; no 4x family source scan.
 FOR r IN SELECT DISTINCT x FROM smarter_private.original_inventory_restoration_cases k CROSS JOIN LATERAL jsonb_array_elements(k.source_refs)x LOOP
 IF r->>'md5' IS NULL OR smarter_private.original_inventory_source_ref_md5(r) IS DISTINCT FROM r->>'md5' THEN RETURN NULL;END IF;
 END LOOP;
 FOR c IN SELECT * FROM smarter_private.original_inventory_restoration_cases WHERE family='erased_cash_receivable' ORDER BY event_id LOOP
 receipt:=smarter_private.original_erased_cash_base_discharge_receipt(c.event_id,md5((c.original_witness-'original_table_scope'-'original_manifest_scope')::text));
 IF receipt->>'status' NOT IN('pending','discharged') OR receipt->>'status' IS NULL THEN RETURN NULL;END IF;
 discharges:=discharges||jsonb_build_array(jsonb_build_object('event_id',c.event_id,'receipt',receipt));
 END LOOP;
 SELECT md5(string_agg(event_id::text||':'||witness_md5||':'||proof_md5,'|' ORDER BY event_id)) INTO proofs
 FROM smarter_private.original_inventory_restoration_certificates WHERE boundary='2026-10-12 07:00:00Z';
 SELECT count(to_regprocedure(signature)),md5(string_agg(signature||':'||md5(pg_get_functiondef(to_regprocedure(signature))),'|' ORDER BY signature)) INTO source_count,source_hash FROM(VALUES ('public.fn_union_pnl_boundary(uuid,timestamptz)'),('public.fn_union_pnl_original_flow_evidence(uuid,timestamptz,timestamptz)'),('public.fn_union_pnl_evidence_report(uuid,timestamptz,timestamptz)'),('smarter_private.original_inventory_basis_generation()'),('smarter_private.original_inventory_proof_sources_match()'))s(signature);
 IF source_count IS DISTINCT FROM 5::bigint OR source_hash IS NULL OR proofs IS NULL THEN RETURN NULL;END IF;
 -- A newly admitted original treasury witness is a new proof input. Old
 -- derived blocked parts must be recomputed by their existing generation owner.
 FOR tw IN SELECT ledger_id,kind FROM smarter_private.original_treasury_historical_admissions ORDER BY ledger_id LOOP
  tp:=CASE tw.kind WHEN 'gift' THEN smarter_private.original_treasury_gift_evidence(tw.ledger_id)
   WHEN 'return' THEN smarter_private.original_treasury_return_evidence(tw.ledger_id) END;
  IF tp->>'status' IS DISTINCT FROM 'proven' THEN RETURN NULL;END IF;
 END LOOP;
 SELECT md5(COALESCE(string_agg(ledger_id::text||':'||kind||':'||source_fingerprint,'|' ORDER BY ledger_id),'no-original-treasury-witnesses')) INTO treasury
 FROM smarter_private.original_treasury_historical_admissions;
 RETURN 'original-inventory-245-v1:'||md5(source_hash||'|'||proofs||'|'||discharges::text||'|'||treasury);
END $function$;
CREATE FUNCTION smarter_private.original_treasury_cash_outcome_evidence(p_outcome jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public SET timezone='UTC' AS $outcome$
DECLARE old jsonb:=p_outcome->'evidence';fresh jsonb;part jsonb;original jsonb;giftusers uuid[]:=ARRAY[]::uuid[];n bigint;p public.cash_hand_provenance_receipts%ROWTYPE;
BEGIN
 p_outcome:=jsonb_set(p_outcome,'{recognized_at}',to_jsonb((p_outcome->>'recognized_at')::timestamptz));
 SELECT count(*) INTO n FROM public.union_pnl_cash_outcomes o WHERE o.table_id=(p_outcome->>'table_id')::uuid
  AND o.hand_number=(p_outcome->>'hand_number')::bigint AND to_jsonb(o)=p_outcome;
 IF n<>1 OR old->>'status' IS DISTINCT FROM 'blocked' OR old->'basis_certified' IS DISTINCT FROM 'false'::jsonb
  OR old->'all_players_included' IS DISTINCT FROM 'true'::jsonb OR old->'game_scope' IS DISTINCT FROM p_outcome->'game_scope'
  OR old->>'hand_id' IS DISTINCT FROM p_outcome->>'hand_id' OR old->>'table_id' IS DISTINCT FROM p_outcome->>'table_id'
  OR old->>'hand_number' IS DISTINCT FROM p_outcome->>'hand_number' OR jsonb_typeof(old->'participants') IS DISTINCT FROM 'array'
  OR jsonb_typeof(old->'issues') IS DISTINCT FROM 'array' THEN RETURN NULL;END IF;
 SELECT * INTO STRICT p FROM public.cash_hand_provenance_receipts WHERE table_id=(p_outcome->>'table_id')::uuid AND hand_number=(p_outcome->>'hand_number')::bigint;
 IF p.hand_id::text IS DISTINCT FROM p_outcome->>'hand_id' OR p.payload_hash IS DISTINCT FROM p_outcome->>'payload_hash'
  OR (old->>'accepted_rake')::numeric IS DISTINCT FROM p.rake OR (old->>'accepted_bbj')::numeric IS DISTINCT FROM p.bbj
  OR (old->>'accepted_external_net')::numeric IS DISTINCT FROM p.signed_external_net THEN RETURN NULL;END IF;
 fresh:=public.fn_pnl_cash_hand_evidence(p.table_id,p.hand_number);
 IF fresh->>'status' IS DISTINCT FROM 'ready' OR fresh->'basis_certified' IS DISTINCT FROM 'true'::jsonb
  OR fresh->'all_players_included' IS DISTINCT FROM 'true'::jsonb OR fresh->'payment_authorized' IS DISTINCT FROM 'false'::jsonb
  OR fresh->'game_scope' IS DISTINCT FROM p_outcome->'game_scope' OR fresh->'hand_id' IS DISTINCT FROM old->'hand_id'
  OR fresh->'observed_delta_total' IS DISTINCT FROM old->'observed_delta_total'
  OR (fresh->>'observed_commit_at')::timestamptz IS DISTINCT FROM (old->>'observed_commit_at')::timestamptz
  OR fresh->'current_seats_used' IS DISTINCT FROM 'false'::jsonb OR fresh->'current_membership_used' IS DISTINCT FROM 'false'::jsonb
  OR jsonb_array_length(fresh->'participants')<>jsonb_array_length(old->'participants') THEN RETURN NULL;END IF;
 FOR part IN SELECT value FROM jsonb_array_elements(fresh->'participants') LOOP
  SELECT count(*),jsonb_agg(v)->0 INTO n,original FROM jsonb_array_elements(old->'participants') v WHERE v->>'user_id'=part->>'user_id';
  IF n<>1 THEN RETURN NULL;END IF;
  IF part#>>'{original_treasury_gift,status}'='proven' THEN
   IF original->'ownership_certified' IS DISTINCT FROM 'false'::jsonb OR original->'earning_club_id' IS DISTINCT FROM 'null'::jsonb
    OR original-ARRAY['ownership_certified','earning_club_id'] IS DISTINCT FROM part-ARRAY['ownership_certified','earning_club_id','original_treasury_gift'] THEN RETURN NULL;END IF;
   giftusers:=array_append(giftusers,(part->>'user_id')::uuid);
  ELSIF original IS DISTINCT FROM part THEN RETURN NULL;END IF;
 END LOOP;
 IF cardinality(giftusers)=0 OR (SELECT count(*)FROM jsonb_array_elements(old->'issues')i WHERE i='"original_cash_funding_incomplete"'::jsonb)<>1
  OR EXISTS(SELECT FROM jsonb_array_elements(old->'issues')i WHERE i<>'"original_cash_funding_incomplete"'::jsonb AND NOT EXISTS(
   SELECT FROM unnest(giftusers)u CROSS JOIN(VALUES('original_admission_funding_missing'),('participant_earning_ownership_receipt_invalid'))reason(v)
   WHERE i=jsonb_build_object('reason',reason.v,'user_id',u)))
  OR EXISTS(SELECT FROM unnest(giftusers)u CROSS JOIN(VALUES('original_admission_funding_missing'),('participant_earning_ownership_receipt_invalid'))reason(v)
   WHERE (SELECT count(*)FROM jsonb_array_elements(old->'issues')i WHERE i=jsonb_build_object('reason',reason.v,'user_id',u))<>1) THEN RETURN NULL;END IF;
 RETURN old||fresh||jsonb_build_object('original_treasury_outcome_proof',jsonb_build_object('original_outcome_md5',md5(p_outcome::text),'original_evidence_md5',md5(old::text),'original_payload_hash',p.payload_hash,'gift_users',to_jsonb(giftusers)));
EXCEPTION WHEN no_data_found OR invalid_text_representation OR numeric_value_out_of_range OR datetime_field_overflow THEN RETURN NULL;
END $outcome$;
REVOKE ALL ON FUNCTION smarter_private.original_treasury_cash_outcome_evidence(jsonb) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION smarter_private.original_treasury_seat_money_core(p_table_id uuid, p_user_id uuid, p_seat_number integer, p_amount numeric, p_op_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_club_id uuid;
  v_treasury numeric;
  v_st text;
  v_msg text;
  v_floor numeric;
  v_min numeric;
  v_max numeric;
  v_eff numeric;
BEGIN
  PERFORM set_config('app.money_path', 'fn_horse_seat_from_treasury', true); -- CHIP STANDARD C2: sanctioned seat creator (trg_ca_guard_seat_creation)
  IF p_table_id IS NULL OR p_user_id IS NULL OR p_seat_number IS NULL OR p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'table, user, seat and positive amount required');
  END IF;

  /* A KEYED CALL IS ANSWERED ONCE. The engine funds a rebuy from a bust it
     has already seen; a retry after a lost response must not fund it twice.
     With no key this is the old behaviour exactly. */
  IF p_op_id IS NOT NULL AND EXISTS (
       SELECT 1 FROM public.chip_ledger WHERE idempotency_key = 'horse_fund:' || p_op_id::text) THEN
    RETURN jsonb_build_object('success', true, 'replayed', true, 'op_id', p_op_id);
  END IF;

  SELECT club_id, min_buy_in, max_buy_in INTO v_club_id, v_min, v_max FROM tables WHERE id = p_table_id;
  IF v_club_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'table has no club');
  END IF;

  IF NOT public.fn_actor_can_manage_club_treasury(v_club_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'not authorized to seat from club treasury');
  END IF;

  -- CHIP CONTINUITY (I7): the same floor a human meets at atomic_table_buyin.
  PERFORM pg_advisory_xact_lock(hashtextextended('table_cap:' || p_user_id::text, 0));
  v_floor := public.fn_cash_rejoin_floor(p_user_id, p_table_id);
  IF v_max IS NOT NULL AND v_max > 0 AND p_amount > GREATEST(v_max, COALESCE(v_floor, 0)) THEN
    RETURN jsonb_build_object('success', false, 'error', 'BUYIN_ABOVE_MAX');
  END IF;
  IF v_floor IS NOT NULL THEN
    v_eff := GREATEST(COALESCE(v_min, 0), v_floor);
    -- The return floor is never reduced to the ordinary maximum.
    IF p_amount < v_eff THEN
      RETURN jsonb_build_object('success', false, 'error', 'BUYIN_BELOW_FLOOR', 'required', v_eff);
    END IF;
  END IF;

  SELECT COALESCE(chip_treasury, 0) INTO v_treasury FROM clubs WHERE id = v_club_id FOR UPDATE;
  IF v_treasury IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'club not found');
  END IF;
  IF v_treasury < p_amount THEN
    RETURN jsonb_build_object('success', false, 'error', 'insufficient club treasury',
                              'treasury', v_treasury, 'needed', p_amount);
  END IF;

  BEGIN
    INSERT INTO table_seats (table_id, user_id, seat_number, stack, is_sitting_out)
    VALUES (p_table_id, p_user_id, p_seat_number, p_amount, false);
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('success', false, 'error', 'seat already taken');
  END;

  -- CHIP CONTINUITY: the session opens with the seat, baseline = this buy-in.
  PERFORM public.fn_cash_session_open(p_user_id, p_table_id, p_amount);

  PERFORM set_config('app.ledger_autoskip_clubs', '1', true);
  UPDATE clubs SET chip_treasury = COALESCE(chip_treasury, 0) - p_amount, updated_at = NOW()
  WHERE id = v_club_id;
  PERFORM set_config('app.ledger_autoskip_clubs', '0', true);

  INSERT INTO chip_transactions (
    id, club_id, from_user_id, to_user_id, amount, transaction_type, notes, balance_after, created_at
  ) VALUES (
    gen_random_uuid(), v_club_id, NULL, p_user_id, p_amount,
    'horse_treasury_funding', 'Horse seated + funded from club treasury',
    v_treasury - p_amount, NOW()
  );

  BEGIN
    /* PHASE 7.2 (2026-09-06): the leg NAMES THE PLAYER and carries the
       caller's key when it has one. Before this a horse funding said only
       that a table was funded: 9,252 legs in seven days, none naming the
       seat, so no per-seat audit could read them and a replay could not be
       told from a second horse buying in for the same amount at the same
       table. The key is optional: without it nothing changes but the name. */
    INSERT INTO public.chip_ledger
      (performed_by, from_type, from_entity_id, to_type, to_entity_id,
       amount, category, club_id, table_id, description, idempotency_key, metadata)
    VALUES (
      COALESCE(auth.uid(), '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),
      'club_treasury', v_club_id,
      'table_stack',   p_table_id,
      p_amount, 'horse_funding', v_club_id, p_table_id,
      'Seated + funded from club treasury (fn_horse_seat_from_treasury) for ' || p_user_id::text,
      CASE WHEN p_op_id IS NULL THEN NULL ELSE 'horse_fund:' || p_op_id::text END,
      jsonb_build_object('user_id', p_user_id, 'op_id', p_op_id, 'door', 'fn_horse_seat_from_treasury'));
  EXCEPTION WHEN OTHERS THEN
      -- A journal failure must abort the enclosing chip movement.
      -- Preserve SQLSTATE so the existing caller can retry the whole operation.
      RAISE;
    END;

  RETURN jsonb_build_object('success', true, 'treasury_after', v_treasury - p_amount);
END;
$function$;

REVOKE ALL ON FUNCTION smarter_private.original_treasury_seat_money_core(uuid,uuid,integer,numeric,uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.fn_claim_entry_purchase_receipt(p_key_domain text, p_idempotency_key text, p_request jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_request jsonb;
  v_response jsonb;
BEGIN
  IF p_idempotency_key IS NULL OR length(btrim(p_idempotency_key)) = 0 THEN
    RETURN jsonb_build_object('claimed', true);
  END IF;

  INSERT INTO public.entry_purchase_idempotency_receipts
    (key_domain, idempotency_key, request)
  VALUES (p_key_domain, p_idempotency_key, p_request)
  ON CONFLICT (key_domain, idempotency_key) DO NOTHING
  RETURNING request, response INTO v_request, v_response;
  IF FOUND THEN
    -- Same original successful claim; the marker is transaction-local proof
    -- for the treasury common leaf, including old outer bodies queued at entry.
    IF p_key_domain='horse_funding' AND p_request->>'door'='fn_horse_seat_from_treasury' THEN
      PERFORM set_config('app.original_treasury_entry_claim',jsonb_build_object(
       'domain',p_key_domain,'key',p_idempotency_key,'request_md5',md5(p_request::text),
       'transaction_id',pg_current_xact_id()::text)::text,true);
    END IF;
    RETURN jsonb_build_object('claimed', true);
  END IF;

  /* The unique-index wait above cannot observe an uncommitted placeholder.
     A committed placeholder without a response means some code violated the
     same-transaction contract, so it is corruption-not permission to rerun
     a money core. */
  SELECT r.request, r.response
    INTO STRICT v_request, v_response
    FROM public.entry_purchase_idempotency_receipts r
   WHERE r.key_domain = p_key_domain
     AND r.idempotency_key = p_idempotency_key;
  IF v_request IS DISTINCT FROM p_request THEN
    RAISE EXCEPTION
      'IDEMPOTENCY_KEY_REUSED: % key is already bound to a different entry purchase',
      p_key_domain
      USING ERRCODE = '22023';
  END IF;
  IF v_response IS NULL THEN
    RAISE EXCEPTION
      'INCOMPLETE_IDEMPOTENCY_RECEIPT: % key was committed without its response',
      p_key_domain
      USING ERRCODE = '55000';
  END IF;
  RETURN jsonb_build_object('claimed', false, 'response', v_response);
END;
$function$
;
CREATE OR REPLACE FUNCTION public.fn_horse_seat_from_treasury_before_maintenance_gate(p_table_id uuid,p_user_id uuid,p_seat_number integer,p_amount numeric,p_op_id uuid DEFAULT NULL::uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,extensions AS $function$
DECLARE request jsonb;receipt public.entry_purchase_idempotency_receipts%ROWTYPE;
 response jsonb;claim jsonb;expected_claim jsonb;ledger_id uuid;gift jsonb;internal_key boolean:=p_op_id IS NULL;
BEGIN
 -- Existing supported entry gate, also for a direct privileged leaf call.
 PERFORM pg_advisory_xact_lock_shared(530090,1);
 p_op_id:=COALESCE(p_op_id,gen_random_uuid());
 request:=jsonb_build_object('door','fn_horse_seat_from_treasury','table_id',p_table_id,
  'user_id',p_user_id,'seat_number',p_seat_number,'amount',p_amount);
 IF internal_key THEN
  claim:=public.fn_claim_entry_purchase_receipt('horse_funding',p_op_id::text,request);
  IF NOT COALESCE((claim->>'claimed')::boolean,false) THEN RETURN claim->'response';END IF;
 END IF;
 SELECT * INTO receipt FROM public.entry_purchase_idempotency_receipts
  WHERE key_domain='horse_funding' AND idempotency_key=p_op_id::text FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'original_treasury_entry_claim_missing' USING ERRCODE='55000';END IF;
 IF receipt.request IS DISTINCT FROM request THEN RAISE EXCEPTION 'original_treasury_entry_request_disagrees' USING ERRCODE='22023';END IF;
 IF receipt.response IS NOT NULL THEN RETURN receipt.response;END IF;
 expected_claim:=jsonb_build_object('domain','horse_funding','key',p_op_id::text,
  'request_md5',md5(request::text),'transaction_id',pg_current_xact_id()::text);
 claim:=NULLIF(current_setting('app.original_treasury_entry_claim',true),'')::jsonb;
 IF claim IS DISTINCT FROM expected_claim THEN RAISE EXCEPTION 'original_treasury_entry_claim_not_owned' USING ERRCODE='55000';END IF;
 response:=smarter_private.original_treasury_seat_money_core(p_table_id,p_user_id,p_seat_number,p_amount,p_op_id);
 IF NOT COALESCE((response->>'success')::boolean,false) THEN
  PERFORM public.fn_release_entry_purchase_claim('horse_funding',p_op_id::text,request);
  PERFORM set_config('app.original_treasury_entry_claim','',true);
  RETURN response;
 END IF;
 response:=public.fn_record_entry_purchase_receipt('horse_funding',p_op_id::text,request,response);
 SELECT id INTO STRICT ledger_id FROM public.chip_ledger WHERE idempotency_key='horse_fund:'||p_op_id::text;
 gift:=smarter_private.admit_original_treasury_gift(ledger_id);
 PERFORM public.fn_cash_record_original_funding('horse_funding',p_op_id::text,p_user_id,p_table_id,ledger_id,NULL,
  (gift->>'earning_club')::uuid,p_amount,(gift->>'bank_balance_after')::numeric,NULL);
 PERFORM set_config('app.original_treasury_entry_claim','',true);
 RETURN response;
END$function$;

CREATE OR REPLACE FUNCTION public.fn_horse_seat_from_treasury(p_table_id uuid, p_user_id uuid, p_seat_number integer, p_amount numeric, p_op_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_request jsonb;
  v_response jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock_shared(530090, 1);

  v_request := jsonb_build_object(
    'door', 'fn_horse_seat_from_treasury',
    'table_id', p_table_id,
    'user_id', p_user_id,
    'seat_number', p_seat_number,
    'amount', p_amount
  );
  v_response := public.fn_claim_entry_purchase_receipt(
    'horse_funding', p_op_id::text, v_request
  );
  IF NOT COALESCE((v_response->>'claimed')::boolean, false) THEN
    RETURN v_response->'response';
  END IF;

  IF p_op_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.chip_ledger l
     WHERE l.idempotency_key = 'horse_fund:' || p_op_id::text
  ) THEN
    RAISE EXCEPTION
      'IDEMPOTENCY_RECEIPT_UNBOUND: this historical horse key has no exact response receipt'
      USING ERRCODE = '55000';
  END IF;

  IF public.fn_entry_purchases_frozen() THEN
    PERFORM public.fn_release_entry_purchase_claim(
      'horse_funding', p_op_id::text, v_request
    );
    RETURN jsonb_build_object(
      'success', false,
      'deferred', true,
      'error', 'PLATFORM_FROZEN: scheduled maintenance has deferred this horse seat'
    );
  END IF;
  PERFORM public.fn_assert_cash_chip_purchase_table(p_table_id);
  v_response := public.fn_horse_seat_from_treasury_before_maintenance_gate(
    p_table_id, p_user_id, p_seat_number, p_amount, p_op_id
  );
  IF NOT COALESCE((v_response->>'success')::boolean, false) THEN
    PERFORM public.fn_release_entry_purchase_claim(
      'horse_funding', p_op_id::text, v_request
    );
    RETURN v_response;
  END IF;
  RETURN public.fn_record_entry_purchase_receipt(
    'horse_funding', p_op_id::text, v_request, v_response
  );
END;
$function$
;

CREATE OR REPLACE FUNCTION public.fn_accounting_union_earned_plan_advance(p_union_id uuid, p_start timestamp with time zone, p_end timestamp with time zone)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE w record; r record; began timestamptz; proved boolean:=false;
 stop_at timestamptz; v_generation text; v_bad bigint; v_flows jsonb; v_windows bigint; v_fresh bigint;v_hand_projected boolean;v_hand_witness jsonb;v_hand_groups jsonb;
BEGIN
 IF COALESCE(current_setting('app.weekly_accounting_chunked',true),'')<>'on'
  OR current_setting('app.accounting_close_memo',true) IS DISTINCT FROM 'on'
  OR NULLIF(current_setting('app.weekly_accounting_scope_deadline',true),'') IS NULL
  OR p_union_id IS NULL OR p_start IS NULL OR p_end IS NULL OR NOT isfinite(p_start) OR NOT isfinite(p_end) OR p_start>=p_end
  OR p_end>clock_timestamp() THEN
  RETURN NULL;
 END IF;
 began:=NULLIF(current_setting('app.weekly_accounting_scope_deadline',true),'')::timestamptz
  -COALESCE(NULLIF(current_setting('app.weekly_accounting_scope_budget',true),''),'8 minutes')::interval;
 -- THE STATEMENT'S OWN CLOCK (20261015b): an attempt can begin late in its
 -- tick (job 272 visits other scopes first in the same 240 s statement), so a
 -- proving loop also stops a minute before the statement itself would be
 -- cancelled, not only 120 s after the attempt began.
 stop_at:=began+interval '120 seconds';
 IF current_setting('statement_timeout') NOT IN ('0','0ms') THEN
  stop_at:=LEAST(stop_at,statement_timestamp()+current_setting('statement_timeout')::interval-interval '60 seconds');
 END IF;
 IF public.fn_accounting_close_certificate('earned_plan',p_union_id,p_start,p_end) IS NULL THEN
 DELETE FROM public.accounting_close_partials WHERE computed_at<clock_timestamp()-interval '8 days';
 FOR w IN SELECT * FROM public.fn_accounting_close_windows(p_start,p_end) ORDER BY 1 LOOP
  CONTINUE WHEN EXISTS(SELECT 1 FROM public.accounting_close_partials p WHERE p.kind='earned_plan_window' AND p.union_id=p_union_id
   AND p.period_start=p_start AND p.period_end=p_end AND p.window_start=w.window_start AND p.window_end=w.window_end
   AND p.computed_at>=p_end AND p.computed_at>clock_timestamp()-public.fn_accounting_close_proof_lifetime());
  IF proved AND clock_timestamp()>stop_at THEN RETURN false; END IF;
  SELECT * INTO r FROM public.fn_accounting_union_earned_plan_window(p_union_id,w.window_start,w.window_end);
  IF NOT FOUND THEN
   -- v3 over the same window refuses exactly what it refuses in the week.
   PERFORM public.fn_accounting_union_earned_plan_v3(p_union_id,w.window_start,w.window_end);
   RAISE EXCEPTION 'union_earned_plan_window_unproved' USING ERRCODE='55000',
    DETAIL=jsonb_build_object('union_id',p_union_id,'period_start',p_start,'period_end',p_end,'window_start',w.window_start,'window_end',w.window_end)::text;
  END IF;
  INSERT INTO public.accounting_close_partials(kind,union_id,period_start,period_end,window_start,window_end,value,cash_ids,cash_md5,fee_ids,fee_md5,computed_at)
  VALUES('earned_plan_window',p_union_id,p_start,p_end,w.window_start,w.window_end,r.value,r.cash_ids,r.cash_md5,r.fee_ids,r.fee_md5,clock_timestamp())
  ON CONFLICT(kind,union_id,period_start,period_end,window_start) DO UPDATE SET window_end=EXCLUDED.window_end,value=EXCLUDED.value,
   cash_ids=EXCLUDED.cash_ids,cash_md5=EXCLUDED.cash_md5,fee_ids=EXCLUDED.fee_ids,fee_md5=EXCLUDED.fee_md5,computed_at=EXCLUDED.computed_at;
  proved:=true;
 END LOOP;
 -- PROVING WINDOWS IS A WHOLE ATTEMPT (20261015): an attempt that proved a
 -- window ends here, even when it proved the last one, so the closing boundary
 -- and every later step start the next attempt with the whole budget.
 IF proved THEN RETURN false; END IF;
 END IF;
 -- THE WEEK'S ORIGINAL FLOWS ARE PROVED TWO HOURS AT A TIME (20261015b).
 -- fn_union_pnl_evidence_report proves the week's original money flows in one
 -- statement (814,510 flows for the 2026-10-05 week: 162 s alone, 2 GB of
 -- temporary files), which cannot fit an attempt of job 272's 240 s statement
 -- once the attempt's preparation and the tick's other scopes have run, so
 -- every attempt that reached it was cancelled and rolled back. The same proof
 -- is made here one plan window at a time (each flow is proved from its own
 -- row and the week's bounds, so the windows partition the week exactly), kept
 -- as partials like the earned-plan windows, and assembled into the very
 -- certificate the report reads, in an attempt of its own. Only while the
 -- report and the week proof are the reviewed definitions, the window proof is
 -- derived from; otherwise the report proves the week itself, as before.
 IF p_union_id='fade0000-0000-0000-0000-000000000001'::uuid AND p_end>='2026-10-12 07:00Z'::timestamptz THEN
  v_generation:=COALESCE(smarter_private.original_inventory_basis_generation(),'original-inventory-245:unqualified');
 END IF;
 IF v_generation IS NOT DISTINCT FROM 'original-inventory-245:unqualified'
  OR md5(pg_get_functiondef('public.fn_union_pnl_original_flow_evidence(uuid,timestamp with time zone,timestamp with time zone)'::regprocedure))<>'0998b0c974aac59fbd4914eef394f1c7'
  OR md5(pg_get_functiondef('public.fn_union_pnl_evidence_report(uuid,timestamp with time zone,timestamp with time zone)'::regprocedure))<>'c4a17522149bfd879342ccc68dec98f9'
 THEN RETURN true;END IF;
 IF smarter_private.inventory_basis_cache_read(v_generation,false,'pnl_flows',p_union_id,p_start,p_end) IS NOT NULL
 OR smarter_private.inventory_basis_cache_read(v_generation,true,'pnl_flows',p_union_id,p_start,p_end) IS NOT NULL THEN
 -- Original hand proof progresses only after original flow proof, in its own attempt.
 IF md5(pg_get_functiondef('smarter_private.weekly_hand_parts_witness(uuid,timestamptz,timestamptz,boolean)'::regprocedure)) IS DISTINCT FROM 'a3b1c75ad2b122dc0b0fede8a66813c8'
 OR md5(pg_get_functiondef('smarter_private.weekly_hand_parts_reduce(uuid,timestamptz,timestamptz,boolean)'::regprocedure)) IS DISTINCT FROM '97fc255997a2faeac593b5b1f5420d4c'
 OR md5(pg_get_functiondef('smarter_private.weekly_hand_parts_read(uuid,timestamptz,timestamptz,text,boolean)'::regprocedure)) IS DISTINCT FROM 'd427fd27d163ba72a7dc3cd50866163d'
 THEN RAISE EXCEPTION 'weekly_hand_parts_owner_changed';END IF;
 IF (SELECT count(*) FROM pg_proc WHERE oid IN('smarter_private.weekly_hand_parts_witness(uuid,timestamptz,timestamptz,boolean)'::regprocedure,'smarter_private.weekly_hand_parts_reduce(uuid,timestamptz,timestamptz,boolean)'::regprocedure,'smarter_private.weekly_hand_parts_read(uuid,timestamptz,timestamptz,text,boolean)'::regprocedure)
  AND proowner='postgres'::regrole AND NOT prosecdef AND provolatile='s' AND proacl::text='{postgres=X/postgres}' AND proconfig=ARRAY['search_path=pg_catalog, public, smarter_private']) IS DISTINCT FROM 3::bigint THEN RAISE EXCEPTION 'weekly_hand_parts_owner_authority_changed';END IF;
 v_hand_projected:=public.fn_union_pnl_projection_ready('cash_outcome_touches');
 IF EXISTS(SELECT FROM public.accounting_close_partials p WHERE p.kind='pnl_hands_window' AND p.union_id=p_union_id AND p.period_start=p_start AND p.period_end=p_end
 AND NOT EXISTS(SELECT FROM public.fn_accounting_close_windows(p_start,p_end)cw WHERE cw.window_start=p.window_start)) THEN RAISE EXCEPTION 'weekly_hand_parts_noncanonical_window';END IF;
 FOR w IN SELECT * FROM public.fn_accounting_close_windows(p_start,p_end) ORDER BY 1 LOOP
  v_hand_witness:=smarter_private.weekly_hand_parts_witness(p_union_id,w.window_start,w.window_end,v_hand_projected);
  CONTINUE WHEN EXISTS(SELECT FROM public.accounting_close_partials p WHERE p.kind='pnl_hands_window' AND p.union_id=p_union_id AND p.period_start=p_start AND p.period_end=p_end AND p.window_start=w.window_start AND p.window_end=w.window_end
   AND p.computed_at>=p_end AND p.computed_at>clock_timestamp()-public.fn_accounting_close_proof_lifetime()
   AND p.computed_at<=clock_timestamp() AND jsonb_typeof(p.value->'groups')='array' AND p.value->>'groups_md5'=md5((p.value->'groups')::text)
   AND p.value->>'generation' IS NOT DISTINCT FROM v_generation AND p.value->'projected' IS NOT DISTINCT FROM to_jsonb(v_hand_projected)
   AND p.value->>'contract' IS NOT DISTINCT FROM '9dee2921c7b956281be61a3eb9d7df6e' AND p.value->'witness' IS NOT DISTINCT FROM v_hand_witness);
  IF proved AND clock_timestamp()>stop_at THEN RETURN false;END IF;
  DELETE FROM public.accounting_close_certificates WHERE union_id=p_union_id AND period_start=p_start AND period_end=p_end AND kind IN('pnl_clubs','pnl_clubs_problem');
  v_hand_groups:=smarter_private.weekly_hand_parts_reduce(p_union_id,w.window_start,w.window_end,v_hand_projected);
  IF v_hand_witness IS DISTINCT FROM smarter_private.weekly_hand_parts_witness(p_union_id,w.window_start,w.window_end,v_hand_projected) THEN RAISE EXCEPTION 'weekly_hand_parts_sources_changed_during_window';END IF;
  INSERT INTO public.accounting_close_partials(kind,union_id,period_start,period_end,window_start,window_end,value,computed_at)
  VALUES('pnl_hands_window',p_union_id,p_start,p_end,w.window_start,w.window_end,jsonb_build_object('generation',v_generation,'projected',v_hand_projected,'contract','9dee2921c7b956281be61a3eb9d7df6e','witness',v_hand_witness,'groups',v_hand_groups,'groups_md5',md5(v_hand_groups::text)),clock_timestamp())
  ON CONFLICT(kind,union_id,period_start,period_end,window_start) DO UPDATE SET window_end=EXCLUDED.window_end,value=EXCLUDED.value,cash_ids=NULL,cash_md5=NULL,fee_ids=NULL,fee_md5=NULL,computed_at=EXCLUDED.computed_at;
  proved:=true;
 END LOOP;
 IF proved THEN RETURN false;END IF;
 IF smarter_private.weekly_hand_parts_read(p_union_id,p_start,p_end,v_generation,v_hand_projected) IS NULL THEN RETURN false;END IF;
 RETURN true;
 END IF;
 FOR w IN SELECT * FROM public.fn_accounting_close_windows(p_start,p_end) ORDER BY 1 LOOP
  -- A window that found a problem is re-proved after an hour, as the report
  -- re-proves a week whose flows found one.
  CONTINUE WHEN EXISTS(SELECT 1 FROM public.accounting_close_partials p WHERE p.kind='pnl_flows_window' AND p.union_id=p_union_id
   AND p.period_start=p_start AND p.period_end=p_end AND p.window_start=w.window_start AND p.window_end=w.window_end
   AND p.computed_at>=p_end AND p.computed_at>clock_timestamp()-public.fn_accounting_close_proof_lifetime()
   AND (p.value->>'bad'='0' OR p.computed_at>clock_timestamp()-interval '1 hour')
   AND p.value->>'generation' IS NOT DISTINCT FROM v_generation);
  IF proved AND clock_timestamp()>stop_at THEN RETURN false; END IF;
  SELECT count(*) FILTER(WHERE NOT f.valid),COALESCE(jsonb_agg(to_jsonb(f)),'[]') INTO v_bad,v_flows
   FROM smarter_private.union_pnl_original_flow_evidence_window(p_union_id,p_start,p_end,w.window_start,w.window_end) f;
  INSERT INTO public.accounting_close_partials(kind,union_id,period_start,period_end,window_start,window_end,value,computed_at)
  VALUES('pnl_flows_window',p_union_id,p_start,p_end,w.window_start,w.window_end,
   jsonb_build_object('generation',v_generation,'bad',v_bad,'flows',v_flows),clock_timestamp())
  ON CONFLICT(kind,union_id,period_start,period_end,window_start) DO UPDATE SET window_end=EXCLUDED.window_end,value=EXCLUDED.value,
   cash_ids=NULL,cash_md5=NULL,fee_ids=NULL,fee_md5=NULL,computed_at=EXCLUDED.computed_at;
  proved:=true;
 END LOOP;
 IF proved THEN RETURN false; END IF;
 -- Every window is fresh: the week's flows are its windows' flows and the two
 -- whole-week return families, the same rows the week proof returns.
 SELECT count(*),count(p.window_start) INTO v_windows,v_fresh
  FROM public.fn_accounting_close_windows(p_start,p_end) cw
  LEFT JOIN public.accounting_close_partials p ON p.kind='pnl_flows_window' AND p.union_id=p_union_id
   AND p.period_start=p_start AND p.period_end=p_end AND p.window_start=cw.window_start AND p.window_end=cw.window_end
   AND p.computed_at>=p_end AND p.computed_at>clock_timestamp()-public.fn_accounting_close_proof_lifetime()
   AND (p.value->>'bad'='0' OR p.computed_at>clock_timestamp()-interval '1 hour')
   AND p.value->>'generation' IS NOT DISTINCT FROM v_generation;
 IF v_windows=0 OR v_fresh<>v_windows THEN RETURN false; END IF;
 WITH parts AS MATERIALIZED (
  SELECT p.value FROM public.fn_accounting_close_windows(p_start,p_end) cw
  JOIN public.accounting_close_partials p ON p.kind='pnl_flows_window' AND p.union_id=p_union_id
   AND p.period_start=p_start AND p.period_end=p_end AND p.window_start=cw.window_start AND p.window_end=cw.window_end
 ), tails AS MATERIALIZED (
  SELECT t.* FROM smarter_private.original_restoration_cash_returns(p_union_id,p_start,p_end) t(ledger_id,club_id,user_id,buyins,cashouts,kind,valid)
  UNION ALL
  SELECT t.* FROM smarter_private.original_erased_cash_discharge_returns(p_union_id,p_start,p_end) t(ledger_id,club_id,user_id,buyins,cashouts,kind,valid)
 ) SELECT COALESCE((SELECT sum((value->>'bad')::bigint) FROM parts),0)+(SELECT count(*) FILTER(WHERE NOT valid) FROM tails),
  COALESCE((SELECT jsonb_agg(x.flow) FROM (SELECT e.flow FROM parts CROSS JOIN LATERAL jsonb_array_elements(parts.value->'flows') e(flow)
   UNION ALL SELECT to_jsonb(t) FROM tails t) x),'[]')
 INTO v_bad,v_flows;
 IF v_bad=0 THEN PERFORM smarter_private.inventory_basis_cache_write(v_generation,'pnl_flows',p_union_id,p_start,p_end,jsonb_build_object('bad',v_bad,'flows',v_flows));
 ELSE PERFORM smarter_private.inventory_basis_cache_write(v_generation,'pnl_flows_problem',p_union_id,p_start,p_end,jsonb_build_object('bad',v_bad,'flows',v_flows)); END IF;
 -- Assembling the certificate is the attempt's step; the report reads it next.
 RETURN false;
END $function$
;
CREATE OR REPLACE FUNCTION public.fn_union_pnl_cash_outcome_accepted(o union_pnl_cash_outcomes)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT effective.evidence->'all_players_included' IS NOT DISTINCT FROM 'true'::jsonb
  AND effective.evidence->'game_scope' IS NOT DISTINCT FROM o.game_scope
  AND ((effective.evidence->>'status' IS NOT DISTINCT FROM 'ready' AND effective.evidence->'basis_certified' IS NOT DISTINCT FROM 'true'::jsonb)
   OR EXISTS(SELECT 1 FROM public.union_pnl_cash_outcome_resolutions r WHERE r.table_id=o.table_id AND r.hand_number=o.hand_number
    AND r.hand_id=o.hand_id AND r.outcome_payload_hash=o.payload_hash AND r.outcome_evidence_md5=md5(o.evidence::text))
   OR EXISTS(SELECT 1 FROM public.union_pnl_cash_outcomes actual
     WHERE actual.table_id=o.table_id AND actual.hand_number=o.hand_number
      AND to_jsonb(actual) IS NOT DISTINCT FROM to_jsonb(o)
      AND smarter_private.posthand_escrow_certified_evidence(o.table_id,o.hand_number) IS NOT NULL))
 FROM LATERAL (SELECT COALESCE(CASE WHEN o.evidence->>'status'='blocked' THEN smarter_private.original_treasury_cash_outcome_evidence(to_jsonb(o)) END,o.evidence) evidence) effective
$function$
;
CREATE OR REPLACE FUNCTION public.fn_union_pnl_original_flow_evidence(p_union_id uuid, p_start timestamp with time zone, p_end timestamp with time zone)
 RETURNS TABLE(ledger_id uuid, club_id uuid, user_id uuid, buyins numeric, cashouts numeric, kind text, valid boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
 WITH originals AS MATERIALIZED (
  SELECT q.*,q.ledger_snapshot l,(q.game_scope->>'tournament_id')::uuid tournament_id
  FROM public.union_pnl_original_flows q WHERE q.game_scope->>'game_union_id'=p_union_id::text
   AND q.recognized_at>=p_start AND q.recognized_at<p_end
 ), rf_original_keys AS MATERIALIZED (
  SELECT DISTINCT q.transaction_id,(q.l->>'table_id')::uuid table_id,
   (q.l->>'club_id')::uuid club_id,(q.l->>'to_entity_id')::uuid user_id,(q.l->>'amount')::numeric amount
  FROM originals q
  WHERE q.tournament_id IS NULL AND q.l->>'from_type'='table_stack'
   AND q.l->>'to_type'='player_wallet' AND q.l->>'category'='player_funding'
 ), rf_original_matches AS MATERIALIZED (
  SELECT k.transaction_id,k.table_id,k.club_id,k.user_id,k.amount,count(*) refunds,
   min(o.funding_club_id::text)::uuid club,min(o.user_id::text)::uuid player
  FROM rf_original_keys k
  JOIN public.cash_funding_application_receipts a ON a.transaction_id=k.transaction_id
   AND a.refunded>0 AND a.refunded=k.amount
  JOIN public.cash_participant_funding_receipts o ON o.id=a.funding_receipt_id
  WHERE a.pending_addon_id IS NOT DISTINCT FROM o.pending_addon_id AND a.original_occupancy_id=o.occupancy_id
   AND o.table_id=k.table_id AND o.account_type='player_wallet' AND o.account_entity_id=k.user_id
   AND o.funding_club_id=k.club_id AND o.user_id=k.user_id
  GROUP BY k.transaction_id,k.table_id,k.club_id,k.user_id,k.amount
 ), bbj_wallet_matches AS MATERIALIZED (
  SELECT q.ledger_id,(q.l->>'club_id')::uuid club_id,r.user_id,r.amount,b.id payout_id
  FROM originals q
  JOIN public.bbj_payouts b ON b.id=CASE WHEN q.l->>'idempotency_key' ~ '^bbj:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN split_part(q.l->>'idempotency_key',':',2)::uuid END
  JOIN public.bbj_payout_recipients r ON r.payout_id=b.id AND r.user_id=(q.l->>'to_entity_id')::uuid
  JOIN public.wallet_credit_idempotency w ON w.key=q.l->>'idempotency_key' AND w.user_id=r.user_id AND w.amount=r.amount
  JOIN public.bbj_pools pool ON pool.id=b.pool_id
  WHERE q.tournament_id IS NULL AND q.l->>'category'='bbj_payout' AND q.l->>'status'='posted'
   AND q.l->>'from_type'='table_stack' AND q.l->>'to_type'='player_wallet'
   AND q.l->>'from_entity_id'=b.table_id::text AND q.l->>'table_id'=b.table_id::text
   AND q.l->>'id'=q.ledger_id::text AND q.l->>'idempotency_key'='bbj:'||b.id::text||':'||r.user_id::text
   AND q.game_scope->>'game_union_id'=p_union_id::text AND q.game_scope->>'asset'='chips' AND q.game_scope->'unit_scale'='2'::jsonb
   AND (pool.union_id=p_union_id OR (pool.union_id IS NULL AND pool.club_id::text=q.game_scope->>'host_club_id'))
   AND b.kind IN('main','mini') AND b.total_amount>0 AND b.total_amount=round(b.total_amount,2)
   AND b.created_at<=q.recognized_at AND r.created_at=w.created_at AND w.created_at>=b.created_at AND w.created_at<=q.recognized_at
   AND (SELECT count(*) FROM public.bbj_payout_recipients unique_recipient WHERE unique_recipient.payout_id=b.id AND unique_recipient.user_id=r.user_id)=1
   AND r.amount=(q.l->>'amount')::numeric AND r.amount>0 AND r.amount=round(r.amount,2)
   AND r.amount::text NOT IN('NaN','Infinity','-Infinity')
   AND (SELECT count(*) FROM public.chip_transactions t WHERE t.transaction_type='bbj_payout' AND t.table_id=b.table_id
     AND t.to_user_id=r.user_id AND t.club_id=(q.l->>'club_id')::uuid AND t.amount=r.amount AND t.created_at=w.created_at)=1
   AND (SELECT count(*) FROM public.chip_ledger bank WHERE bank.status='posted' AND bank.category='bbj_payout'
     AND bank.from_type='bbj_pool' AND bank.from_entity_id=b.pool_id AND bank.to_type='table_stack' AND bank.to_entity_id=b.table_id
     AND bank.amount=b.total_amount AND bank.idempotency_key=CASE WHEN b.kind='mini' THEN 'bbj_mini:'||b.pool_id::text||':'||b.table_id::text||':'||b.hand_number::text ELSE 'bbj_payout:'||b.id::text END)=1
   AND (SELECT coalesce(sum(p.amount),0) FROM public.bbj_payout_recipients p WHERE p.payout_id=b.id)
      +(SELECT coalesce(sum(u.amount),0) FROM public.bbj_unclaimed_shares u WHERE u.payout_id=b.id AND u.paid_at IS NULL)=b.total_amount
   AND (NOT EXISTS(SELECT FROM public.bbj_unclaimed_shares u WHERE u.payout_id=b.id AND u.user_id=r.user_id)
     OR (SELECT count(*) FROM public.bbj_unclaimed_shares u WHERE u.payout_id=b.id AND u.user_id=r.user_id AND u.amount=r.amount
       AND u.pool_id=b.pool_id AND u.table_id=b.table_id AND u.paid_at=w.created_at
       AND (SELECT count(*) FROM public.chip_ledger parked WHERE parked.status='posted' AND parked.category='bbj_payout'
         AND parked.from_type='table_stack' AND parked.from_entity_id=b.table_id AND parked.to_type='bbj_pool' AND parked.to_entity_id=b.pool_id
         AND parked.amount=r.amount AND parked.idempotency_key='bbj_park:bbj:'||b.id::text||':'||r.user_id::text)=1
       AND (SELECT count(*) FROM public.chip_ledger redeemed WHERE redeemed.status='posted' AND redeemed.category='bbj_payout'
         AND redeemed.from_type='bbj_pool' AND redeemed.from_entity_id=b.pool_id AND redeemed.to_type='table_stack' AND redeemed.to_entity_id=b.table_id
         AND redeemed.amount=r.amount AND redeemed.idempotency_key='bbj_redeem:'||b.id::text||':'||r.user_id::text)=1)=1)
 ), matched AS (
  SELECT q.*,gift.proof treasury_gift,returned.proof treasury_return,f.id cash_funding_id,f.funding_club_id cash_club,f.user_id cash_user,f.amount cash_amount,
   e.id entry_id,e.funding_club_id entry_club,e.user_id entry_user,e.amount entry_amount,
   c.ledger_id credit_id,c.credited_club_id credit_club,c.user_id credit_user,c.amount credit_amount,
   ret.owners,ret.funding_club_id return_club,ret.user_id return_user,mv.moved_club,mv.moved_user,
   COALESCE(rf.refunds,0) refunds,rf.club refund_club,rf.player refund_user,te.refund_ent,te.refund_ent_user,te.refund_ent_club,late.n late_count,late.club late_club,late.player late_user,late.delta late_delta,j.club_id bbj_club,j.user_id bbj_user,j.payout_id bbj_payout
  FROM originals q
  LEFT JOIN LATERAL (SELECT smarter_private.original_treasury_gift_evidence(q.ledger_id) proof
   WHERE q.tournament_id IS NULL AND q.l->>'category'='horse_funding'
    AND q.l->>'from_type'='club_treasury' AND q.l->>'to_type'='table_stack') gift ON true
  LEFT JOIN LATERAL (SELECT smarter_private.original_treasury_return_evidence(q.ledger_id) proof
   WHERE q.tournament_id IS NULL AND q.l->>'category' IN('cashout','table_cashout','refund')
    AND q.l->>'from_type'='table_stack' AND q.l->>'to_type'='player_wallet') returned ON true
  LEFT JOIN bbj_wallet_matches j ON j.ledger_id=q.ledger_id
  LEFT JOIN LATERAL (
   SELECT count(*) n,min(p.club_id::text)::uuid club,min(p.user_id::text)::uuid player,min(p.delta) delta
   FROM (SELECT q.ledger_id WHERE q.tournament_id IS NULL
    AND q.l->>'category'='settlement' AND q.l->>'idempotency_key' LIKE 'late_seat_settle:%' OFFSET 0) eligible
   CROSS JOIN LATERAL public.fn_union_pnl_prove_late_settlement(eligible.ledger_id) p
  ) late ON true
  -- One-time filter (20261001): a probe only for the flows that can match.
  LEFT JOIN LATERAL (SELECT f.* FROM public.cash_participant_funding_receipts f
   WHERE q.tournament_id IS NULL AND f.source_ledger_id=q.ledger_id OFFSET 0) f ON true
  LEFT JOIN LATERAL (SELECT e.* FROM public.tournament_participant_funding_receipts e
   WHERE q.tournament_id IS NOT NULL AND e.ledger_id=q.ledger_id AND e.asset='chips' AND q.tournament_id=e.tournament_id OFFSET 0) e ON true
  -- fn_union_pnl_tournament_returns(q.tournament_id,NULL,p_start,p_end) for
  -- this flow's ledger only: its two branches verbatim, keyed by the ledger.
  LEFT JOIN LATERAL (
   SELECT c.ledger_id,c.tournament_id,c.user_id,c.credited_club_id,c.amount
   FROM public.tournament_accounting_credit_receipts c
   JOIN public.union_pnl_transaction_frames b ON b.transaction_id=c.transaction_id
   WHERE q.tournament_id IS NOT NULL AND c.ledger_id=q.ledger_id AND c.tournament_id=q.tournament_id
    AND b.observed_at>=p_start AND b.observed_at<p_end
   UNION ALL
   SELECT t.credit_ledger_id,t.tournament_id,t.user_id,t.source_wallet_club_id,t.amount_paid_now
   FROM public.tournament_refund_tranches t
   JOIN public.tournament_participant_funding_receipts r ON r.entitlement_id=t.entitlement_id
   JOIN public.union_pnl_transaction_frames b ON b.transaction_id=t.transaction_id
   WHERE q.tournament_id IS NOT NULL AND t.credit_ledger_id=q.ledger_id AND t.tournament_id=q.tournament_id
    AND b.observed_at>=p_start AND b.observed_at<p_end
    AND NOT EXISTS(SELECT 1 FROM public.tournament_accounting_credit_receipts c2 WHERE c2.ledger_id=t.credit_ledger_id)
  ) c ON true
  LEFT JOIN LATERAL (
   SELECT count(DISTINCT (r.funding_club_id,r.user_id)) owners,min(r.funding_club_id::text)::uuid funding_club_id,min(r.user_id::text)::uuid user_id
   FROM public.cash_participant_funding_receipts r
   WHERE r.table_id=(q.l->>'table_id')::uuid AND smarter_private.cash_initial_funding_receipt(r.id)
    AND q.tournament_id IS NULL AND q.l->>'from_type'='table_stack'
    AND ((r.account_type=q.l->>'to_type' AND r.account_entity_id=(q.l->>'to_entity_id')::uuid) OR (r.operation_kind='horse_funding' AND r.account_type='club_treasury' AND r.user_id=(q.l->>'to_entity_id')::uuid AND smarter_private.cash_initial_funding_receipt(r.id)))
    AND r.funding_club_id=(q.l->>'club_id')::uuid
    AND (EXISTS(SELECT 1 FROM public.union_pnl_inventory_events i WHERE i.transaction_id=q.transaction_id AND i.source_name='table_seats'
      AND COALESCE(i.after_row,i.before_row)->>'occupancy_id'=r.occupancy_id::text
      AND COALESCE(i.after_row,i.before_row)->>'table_id'=r.table_id::text)
     OR EXISTS(SELECT 1 FROM public.cash_funding_application_receipts a JOIN public.cash_participant_funding_receipts original ON original.id=a.funding_receipt_id
       WHERE a.transaction_id=q.transaction_id AND original.occupancy_id=r.occupancy_id AND a.refunded=(q.l->>'amount')::numeric))
  ) ret ON true
  -- A seat cashed out after it arrived by a table move holds chips whose
  -- original buy-in is on the source occupancy, not this one. The occupancy
  -- the cash-out vacated (its seat row in the same original transaction,
  -- carrying exactly the cashed-out stack) is traced through its move receipts
  -- by fn_cash_original_funding_lineage, the proof the boundaries and hands
  -- already use; the owner is its one original buy-in's club and player.
  LEFT JOIN LATERAL (
   SELECT CASE WHEN lin.v->'issues'='[]'::jsonb AND jsonb_array_length(lin.v->'moves')>0 AND own.receipts>0 AND own.buyins=1
     AND own.clubs=1 AND own.users=1 AND own.club::text=q.l->>'club_id' AND own.player::text=q.l->>'to_entity_id'
     THEN own.club END moved_club,
    CASE WHEN lin.v->'issues'='[]'::jsonb AND jsonb_array_length(lin.v->'moves')>0 AND own.receipts>0 AND own.buyins=1
     AND own.clubs=1 AND own.users=1 AND own.club::text=q.l->>'club_id' AND own.player::text=q.l->>'to_entity_id'
     THEN own.player END moved_user
   FROM (SELECT min(i.before_row::text)::jsonb seat,count(*) n FROM public.union_pnl_inventory_events i
     WHERE q.tournament_id IS NULL AND q.l->>'from_type'='table_stack' AND q.l->>'to_type'='player_wallet'
      AND ret.owners IS DISTINCT FROM 1
      AND i.transaction_id=q.transaction_id AND i.source_name='table_seats' AND i.before_row->>'table_id'=q.l->>'table_id'
      AND i.before_row->>'user_id'=q.l->>'to_entity_id' AND i.before_row->'left_at'='null'::jsonb
      AND i.after_row->>'left_at' IS NOT NULL) s
   CROSS JOIN LATERAL (SELECT public.fn_cash_original_funding_lineage((s.seat->>'user_id')::uuid,(s.seat->>'table_id')::uuid,(s.seat->>'id')::uuid,
     (s.seat->>'occupancy_id')::uuid,(s.seat->>'joined_at')::timestamptz,q.recognized_at,false) v) lin
   CROSS JOIN LATERAL (SELECT count(*) receipts,count(*) FILTER(WHERE smarter_private.cash_initial_funding_receipt(r.id)) buyins,count(DISTINCT r.funding_club_id) clubs,
     count(DISTINCT r.user_id) users,min(r.funding_club_id::text)::uuid club,min(r.user_id::text)::uuid player
    FROM jsonb_array_elements(lin.v->'funding_receipts') ref JOIN public.cash_participant_funding_receipts r ON r.id=(ref->>'id')::uuid) own
   WHERE q.tournament_id IS NULL AND q.l->>'from_type'='table_stack' AND q.l->>'to_type'='player_wallet' AND ret.owners IS DISTINCT FROM 1
    AND s.n=1 AND public.fn_pnl_evidence_cents(s.seat->'stack') IS NOT DISTINCT FROM (q.l->>'amount')::numeric
  ) mv ON true
  -- A pending add-on returned unapplied is a refund of this player's own
  -- escrowed chips. Its wallet credit can carry no refund category: it runs
  -- inside the hand's post-commit obligations, after atomic_distribute_rake
  -- has declared that transaction's ledger context, so the audit labels it
  -- player_funding under the rake settlement. The application receipt
  -- written in the same transaction proves it: exactly one refund of this
  -- amount from a funding receipt of this player, club and table.
  LEFT JOIN LATERAL (
   SELECT r.refunds,r.club,r.player FROM rf_original_matches r
   WHERE q.tournament_id IS NULL AND q.l->>'from_type'='table_stack'
    AND q.l->>'to_type'='player_wallet' AND q.l->>'category'='player_funding'
    AND r.transaction_id=q.transaction_id AND r.table_id=(q.l->>'table_id')::uuid
    AND r.club_id=(q.l->>'club_id')::uuid AND r.user_id=(q.l->>'to_entity_id')::uuid
    AND r.amount=(q.l->>'amount')::numeric
  ) rf ON true
  -- A seat won in a satellite and later refunded by the target tournament
  -- (cancelled, or the seat released) pays the seat's value back to the
  -- player's wallet from the target's prize liability. That seat was never a
  -- wallet-funded entry of the target, so no tournament credit receipt exists
  -- for it; its proof is the refund entitlement the payout is keyed by: same
  -- tournament, player, wallet club and gross, and the seat's owning club as
  -- resolved from its satellite registration.
  LEFT JOIN LATERAL (
   SELECT t.id refund_ent,t.user_id refund_ent_user,t.refund_wallet_club_id refund_ent_club
   FROM public.tournament_refund_entitlements t
   WHERE q.tournament_id IS NOT NULL AND t.tournament_id=q.tournament_id
    AND q.l->>'idempotency_key'='tourney:'||t.tournament_id::text||':refund-entitlement:'||t.id::text
    AND t.entitlement_kind IN('satellite_seat','wallet_charge','tournament_ticket') AND t.gross=(q.l->>'amount')::numeric
    AND t.user_id::text=q.l->>'to_entity_id' AND t.refund_wallet_club_id::text=q.l->>'club_id'
    AND q.l->>'from_type'='prize_liability' AND q.l->>'to_type'='player_wallet' AND q.l->>'category'='refund'
    AND CASE t.entitlement_kind
     WHEN 'satellite_seat' THEN public.fn_union_pnl_satellite_seat_owner(t.registration_id,NULL)=t.refund_wallet_club_id
     -- A pre-capture wallet entry refunded by cancellation (20261006154000):
     -- its entitlement's source ledger is the entry proven at the opening
     -- boundary of the refund's own week, for this exact registration, club
     -- and gross.
     WHEN 'wallet_charge' THEN t.source_ledger_id IS NOT NULL AND (SELECT count(*) FROM public.union_pnl_opening_registration_resolutions r
       WHERE r.boundary=public.fn_union_week_start(q.recognized_at) AND r.union_id=p_union_id AND r.tournament_id=t.tournament_id AND r.user_id=t.user_id
        AND r.owning_club_id=t.refund_wallet_club_id AND r.entries=1 AND r.entry_amount=t.gross AND r.returned=0
        AND r.proof_md5=md5(r.proof::text)
        AND r.proof->'entry_ledger' @> jsonb_build_array(jsonb_build_object('ledger_id',t.source_ledger_id::text)))=1
     WHEN 'tournament_ticket' THEN t.charge_category='tournament_ticket'
      AND t.evidence_kind='atomic_tournament_ticket' AND t.escrow_bucket='ticket_gross'
      AND q.l->>'from_entity_id'=t.tournament_id::text
      AND NOT EXISTS(SELECT 1 FROM public.tournament_tickets replacement WHERE replacement.source_refund_entitlement_id=t.id)
      AND (SELECT count(*) FROM public.tournament_refund_entitlements duplicate WHERE duplicate.source_ticket_id=t.source_ticket_id)=1
      AND (SELECT count(*) FROM public.tournament_refund_tranches tr
       WHERE tr.entitlement_id=t.id AND tr.credit_ledger_id=q.ledger_id AND tr.transaction_id=q.transaction_id
        AND tr.tournament_id=t.tournament_id AND tr.user_id=t.user_id AND tr.source_wallet_club_id=t.refund_wallet_club_id
        AND tr.idempotency_key=q.l->>'idempotency_key' AND tr.amount_paid_before=0 AND tr.amount_paid_now=t.gross
        AND tr.refund_prize=t.refund_prize AND tr.refund_bounty=t.refund_bounty AND tr.refund_fee=t.refund_fee)=1
      AND (SELECT count(*) FROM public.tournament_refund_tranches tr WHERE tr.entitlement_id=t.id)=1
      AND (SELECT count(*) FROM public.tournament_tickets tk
       JOIN public.chip_ledger admission ON admission.id=t.source_ledger_id
       JOIN public.tournament_satellite_awards a ON a.ticket_id=tk.id
       JOIN public.tournament_satellite_settlements h ON h.tournament_id=a.tournament_id
       JOIN public.tournament_payouts p ON p.id=a.payout_id
       JOIN public.chip_ledger issue ON issue.idempotency_key=a.idempotency_key||':ticket_escrow'
       WHERE tk.id=t.source_ticket_id AND tk.holder_id=t.user_id AND tk.club_id=t.refund_wallet_club_id
        AND tk.status='redeemed' AND tk.redemption_mode='tournament_entry_only' AND tk.cancelled_at IS NULL
        AND tk.value=t.gross AND tk.entry_prize=t.refund_prize AND tk.entry_bounty=t.refund_bounty AND tk.entry_fee=t.refund_fee
        AND t.gross=t.refund_prize+t.refund_bounty+t.refund_fee
        AND tk.source_tournament_id=t.tournament_id AND tk.source_satellite_id=t.source_satellite_id
        -- Only the original direct award is admitted here. A replacement
        -- ticket still requires its distinct original refund disposition.
        AND tk.source_refund_entitlement_id IS NULL
        AND a.tournament_id=tk.source_satellite_id AND a.place=tk.source_satellite_award_place
        AND a.user_id=t.user_id AND a.delivery_kind='ticket' AND a.amount=t.gross AND a.payout_source='satellite_ticket'
        AND p.tournament_id=a.tournament_id AND p.user_id=a.user_id AND p.amount=a.amount
        AND p.source=a.payout_source AND p.idempotency_key=a.idempotency_key
        AND (p.position=a.place OR h.receipt_version>=3)
        AND h.target_id=t.tournament_id AND h.ticket_cost=t.gross
        AND h.target_buy_in=tk.entry_prize+tk.entry_bounty AND h.target_fee=tk.entry_fee
        AND issue.status='posted' AND issue.category='ticket_issue' AND issue.amount=t.gross
        AND issue.club_id=tk.club_id AND issue.tournament_id=a.tournament_id
        AND issue.from_type='prize_liability' AND issue.from_entity_id=a.tournament_id
        AND issue.to_type='escrow' AND issue.to_entity_id=tk.id
        AND issue.metadata->>'kind'='direct_satellite_entry_ticket'
        AND issue.metadata->>'ticket_id'=tk.id::text AND issue.metadata->>'payout_id'=p.id::text
        AND issue.metadata->>'user_id'=t.user_id::text
        AND issue.metadata->>'satellite_target_id'=t.tournament_id::text
        AND COALESCE(issue.metadata->>'position',issue.metadata->>'award_slot')=a.place::text
        AND NOT EXISTS(SELECT 1 FROM public.wallet_credit_idempotency w WHERE w.key=a.idempotency_key)
        AND (SELECT count(*) FROM public.chip_transactions x
          WHERE x.transaction_type='tournament_ticket_issue' AND x.club_id=tk.club_id
           AND x.from_user_id IS NULL AND x.to_user_id=t.user_id AND x.amount=t.gross
           AND x.metadata->>'ticket_id'=tk.id::text AND x.metadata->>'ledger_id'=issue.id::text
           AND x.metadata->>'payout_id'=p.id::text AND x.metadata->>'idempotency_key'=a.idempotency_key
           AND x.metadata->>'source_tournament_id'=t.tournament_id::text
           AND x.metadata->>'source_satellite_id'=a.tournament_id::text
           AND x.metadata->>'source_award_place'=a.place::text)=1
        AND admission.status='posted' AND admission.category='ticket_redeem' AND admission.amount=t.gross
        AND admission.club_id=tk.club_id AND admission.tournament_id=t.tournament_id
        AND admission.from_type='escrow' AND admission.from_entity_id=tk.id
        AND admission.to_type='prize_liability' AND admission.to_entity_id=t.tournament_id
        AND admission.idempotency_key='ticket:'||tk.id::text||':tournament:'||t.tournament_id::text||':entry'
        AND admission.metadata->>'kind'='tournament_entry_ticket_admission'
        AND admission.metadata->>'ticket_id'=tk.id::text AND admission.metadata->>'user_id'=t.user_id::text
        AND admission.metadata->>'registration_id'=t.registration_id::text
        AND admission.metadata->>'source_tournament_id'=t.tournament_id::text
        AND admission.metadata->>'source_satellite_id'=t.source_satellite_id::text
        AND admission.metadata->'entry_prize'=to_jsonb(t.refund_prize)
        AND admission.metadata->'entry_bounty'=to_jsonb(t.refund_bounty)
        AND admission.metadata->'entry_fee'=to_jsonb(t.refund_fee))=1
     ELSE false END
  ) te ON true
 ), projected AS (
  SELECT *,CASE WHEN bbj_payout IS NOT NULL THEN 'cash_return' WHEN late_count=1 THEN 'cash_late_settlement' WHEN treasury_gift->>'status'='proven' THEN 'cash_funding' WHEN treasury_return->>'status'='proven' THEN 'cash_return' WHEN cash_funding_id IS NOT NULL THEN 'cash_funding' WHEN owners=1 OR moved_club IS NOT NULL OR refunds=1 THEN 'cash_return'
    WHEN entry_id IS NOT NULL THEN 'tournament_funding' WHEN credit_id IS NOT NULL OR refund_ent IS NOT NULL THEN 'tournament_return' ELSE 'unsupported' END k,
   COALESCE(bbj_club,late_club,(treasury_gift->>'earning_club')::uuid,(treasury_return->>'earning_club')::uuid,cash_club,CASE WHEN moved_club IS NOT NULL THEN moved_club WHEN owners=1 THEN return_club ELSE refund_club END,entry_club,credit_club,refund_ent_club) owner_club,
   COALESCE(bbj_user,late_user,(treasury_gift->>'user_id')::uuid,(treasury_return->>'user_id')::uuid,cash_user,CASE WHEN moved_club IS NOT NULL THEN moved_user WHEN owners=1 THEN return_user ELSE refund_user END,entry_user,credit_user,refund_ent_user) owner_user
  FROM matched
 ) SELECT ledger_id,owner_club,owner_user,
  CASE WHEN k='cash_late_settlement' AND late_delta<0 THEN -late_delta WHEN k IN('cash_funding','tournament_funding') THEN (l->>'amount')::numeric ELSE 0 END,
  CASE WHEN k='cash_late_settlement' AND late_delta>0 THEN late_delta WHEN k IN('cash_return','tournament_return') THEN (l->>'amount')::numeric ELSE 0 END,k,
  (l->>'status'='posted' AND public.fn_pnl_evidence_cents(l->'amount')>0 AND owner_club IS NOT NULL AND owner_user IS NOT NULL
   AND (owner_club::text=l->>'club_id' OR (treasury_gift->>'status'='proven' AND treasury_gift->>'ledger_id'=ledger_id::text AND treasury_gift->>'sponsor_bank_club'=l->>'club_id' AND treasury_gift->>'earning_club'=owner_club::text)) AND game_scope->>'asset'='chips' AND game_scope->'unit_scale'='2'::jsonb
   AND CASE k
    WHEN 'cash_late_settlement' THEN late_count=1 AND abs(late_delta)=(l->>'amount')::numeric
    WHEN 'cash_funding' THEN (cash_amount=(l->>'amount')::numeric OR (treasury_gift->>'status'='proven' AND (treasury_gift->>'amount')::numeric=(l->>'amount')::numeric)) AND l->>'to_type'='table_stack' AND l->>'category' IN('buyin','rebuy','addon','horse_funding')
    WHEN 'cash_return' THEN ((treasury_return->>'status'='proven' AND (treasury_return->>'amount')::numeric=(l->>'amount')::numeric) OR bbj_payout IS NOT NULL OR owners=1 OR moved_club IS NOT NULL OR (refunds=1 AND l->>'category'='player_funding')) AND l->>'from_type'='table_stack' AND (l->>'category' IN('cashout','table_cashout','refund')
     OR (l->>'category'='player_funding' AND refunds=1 AND refund_club=owner_club AND refund_user=owner_user)
     OR (l->>'category'='bbj_payout' AND bbj_payout IS NOT NULL AND bbj_club=owner_club AND bbj_user=owner_user))
    WHEN 'tournament_funding' THEN entry_amount=(l->>'amount')::numeric AND l->>'to_type'='prize_liability' AND l->>'category' IN('tournament_buyin','rebuy','addon')
    WHEN 'tournament_return' THEN (credit_amount=(l->>'amount')::numeric OR (credit_id IS NULL AND refund_ent IS NOT NULL)) AND l->>'from_type'='prize_liability' AND l->>'category' IN('tournament_prize','prize','bounty','refund','tournament_refund')
    ELSE false END) IS TRUE
 FROM projected
 UNION ALL SELECT * FROM smarter_private.original_restoration_cash_returns(p_union_id,p_start,p_end)
 UNION ALL SELECT * FROM smarter_private.original_erased_cash_discharge_returns(p_union_id,p_start,p_end);
$function$
;
CREATE OR REPLACE FUNCTION public.fn_union_pnl_week_hand_lines(p_union_id uuid, p_start timestamp with time zone, p_end timestamp with time zone, p_projected boolean)
 RETURNS TABLE(hand_accepted_rake text, hand_participants jsonb)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
 IF p_projected THEN
  RETURN QUERY SELECT h.accepted_rake,
   CASE WHEN h.shaped AND cert.hand_number IS NOT NULL THEN public.fn_union_pnl_posthand_escrow_touch(h) ELSE COALESCE(gift.evidence->'participants',h.participants) END
   FROM public.union_pnl_cash_outcome_touches h
   LEFT JOIN public.union_pnl_cash_outcomes original ON original.table_id=h.table_id AND original.hand_number=h.hand_number
   LEFT JOIN LATERAL (SELECT CASE WHEN original.evidence->>'status'='blocked' AND original.recognized_at=h.recognized_at AND original.game_scope->>'game_union_id'=h.game_union_id AND original.evidence->>'accepted_rake'=h.accepted_rake AND public.fn_union_pnl_compact_participants(original.evidence->'participants')=h.participants THEN smarter_private.original_treasury_cash_outcome_evidence(to_jsonb(original)) END evidence) gift ON true
   LEFT JOIN smarter_private.posthand_escrow_certificates cert ON (cert.table_id,cert.hand_number)=(h.table_id,h.hand_number)
   WHERE h.game_union_id=p_union_id::text AND h.recognized_at>=p_start AND h.recognized_at<p_end;
 ELSE
  RETURN QUERY SELECT COALESCE(gift.evidence,o.evidence)->>'accepted_rake',
   CASE WHEN cert.hand_number IS NOT NULL THEN public.fn_union_pnl_posthand_escrow_participants(o) ELSE COALESCE(gift.evidence,o.evidence)->'participants' END
   FROM public.union_pnl_cash_outcomes o
   CROSS JOIN LATERAL (SELECT CASE WHEN o.evidence->>'status'='blocked' THEN smarter_private.original_treasury_cash_outcome_evidence(to_jsonb(o)) END evidence) gift
   LEFT JOIN smarter_private.posthand_escrow_certificates cert ON (cert.table_id,cert.hand_number)=(o.table_id,o.hand_number)
   WHERE o.game_scope->>'game_union_id'=p_union_id::text AND o.recognized_at>=p_start AND o.recognized_at<p_end;
 END IF;
END $function$
;
CREATE OR REPLACE FUNCTION smarter_private.union_pnl_original_flow_evidence_window(p_union_id uuid, p_start timestamp with time zone, p_end timestamp with time zone, p_window_start timestamp with time zone, p_window_end timestamp with time zone)
 RETURNS TABLE(ledger_id uuid, club_id uuid, user_id uuid, buyins numeric, cashouts numeric, kind text, valid boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
 WITH originals AS MATERIALIZED (
  SELECT q.*,q.ledger_snapshot l,(q.game_scope->>'tournament_id')::uuid tournament_id
  FROM public.union_pnl_original_flows q WHERE q.game_scope->>'game_union_id'=p_union_id::text
   AND q.recognized_at>=p_start AND q.recognized_at<p_end
   AND q.recognized_at>=p_window_start AND q.recognized_at<p_window_end
 ), rf_original_keys AS MATERIALIZED (
  SELECT DISTINCT q.transaction_id,(q.l->>'table_id')::uuid table_id,
   (q.l->>'club_id')::uuid club_id,(q.l->>'to_entity_id')::uuid user_id,(q.l->>'amount')::numeric amount
  FROM originals q
  WHERE q.tournament_id IS NULL AND q.l->>'from_type'='table_stack'
   AND q.l->>'to_type'='player_wallet' AND q.l->>'category'='player_funding'
 ), rf_original_matches AS MATERIALIZED (
  SELECT k.transaction_id,k.table_id,k.club_id,k.user_id,k.amount,count(*) refunds,
   min(o.funding_club_id::text)::uuid club,min(o.user_id::text)::uuid player
  FROM rf_original_keys k
  JOIN public.cash_funding_application_receipts a ON a.transaction_id=k.transaction_id
   AND a.refunded>0 AND a.refunded=k.amount
  JOIN public.cash_participant_funding_receipts o ON o.id=a.funding_receipt_id
  WHERE a.pending_addon_id IS NOT DISTINCT FROM o.pending_addon_id AND a.original_occupancy_id=o.occupancy_id
   AND o.table_id=k.table_id AND o.account_type='player_wallet' AND o.account_entity_id=k.user_id
   AND o.funding_club_id=k.club_id AND o.user_id=k.user_id
  GROUP BY k.transaction_id,k.table_id,k.club_id,k.user_id,k.amount
 ), bbj_wallet_matches AS MATERIALIZED (
  SELECT q.ledger_id,(q.l->>'club_id')::uuid club_id,r.user_id,r.amount,b.id payout_id
  FROM originals q
  JOIN public.bbj_payouts b ON b.id=CASE WHEN q.l->>'idempotency_key' ~ '^bbj:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN split_part(q.l->>'idempotency_key',':',2)::uuid END
  JOIN public.bbj_payout_recipients r ON r.payout_id=b.id AND r.user_id=(q.l->>'to_entity_id')::uuid
  JOIN public.wallet_credit_idempotency w ON w.key=q.l->>'idempotency_key' AND w.user_id=r.user_id AND w.amount=r.amount
  JOIN public.bbj_pools pool ON pool.id=b.pool_id
  WHERE q.tournament_id IS NULL AND q.l->>'category'='bbj_payout' AND q.l->>'status'='posted'
   AND q.l->>'from_type'='table_stack' AND q.l->>'to_type'='player_wallet'
   AND q.l->>'from_entity_id'=b.table_id::text AND q.l->>'table_id'=b.table_id::text
   AND q.l->>'id'=q.ledger_id::text AND q.l->>'idempotency_key'='bbj:'||b.id::text||':'||r.user_id::text
   AND q.game_scope->>'game_union_id'=p_union_id::text AND q.game_scope->>'asset'='chips' AND q.game_scope->'unit_scale'='2'::jsonb
   AND (pool.union_id=p_union_id OR (pool.union_id IS NULL AND pool.club_id::text=q.game_scope->>'host_club_id'))
   AND b.kind IN('main','mini') AND b.total_amount>0 AND b.total_amount=round(b.total_amount,2)
   AND b.created_at<=q.recognized_at AND r.created_at=w.created_at AND w.created_at>=b.created_at AND w.created_at<=q.recognized_at
   AND (SELECT count(*) FROM public.bbj_payout_recipients unique_recipient WHERE unique_recipient.payout_id=b.id AND unique_recipient.user_id=r.user_id)=1
   AND r.amount=(q.l->>'amount')::numeric AND r.amount>0 AND r.amount=round(r.amount,2)
   AND r.amount::text NOT IN('NaN','Infinity','-Infinity')
   AND (SELECT count(*) FROM public.chip_transactions t WHERE t.transaction_type='bbj_payout' AND t.table_id=b.table_id
     AND t.to_user_id=r.user_id AND t.club_id=(q.l->>'club_id')::uuid AND t.amount=r.amount AND t.created_at=w.created_at)=1
   AND (SELECT count(*) FROM public.chip_ledger bank WHERE bank.status='posted' AND bank.category='bbj_payout'
     AND bank.from_type='bbj_pool' AND bank.from_entity_id=b.pool_id AND bank.to_type='table_stack' AND bank.to_entity_id=b.table_id
     AND bank.amount=b.total_amount AND bank.idempotency_key=CASE WHEN b.kind='mini' THEN 'bbj_mini:'||b.pool_id::text||':'||b.table_id::text||':'||b.hand_number::text ELSE 'bbj_payout:'||b.id::text END)=1
   AND (SELECT coalesce(sum(p.amount),0) FROM public.bbj_payout_recipients p WHERE p.payout_id=b.id)
      +(SELECT coalesce(sum(u.amount),0) FROM public.bbj_unclaimed_shares u WHERE u.payout_id=b.id AND u.paid_at IS NULL)=b.total_amount
   AND (NOT EXISTS(SELECT FROM public.bbj_unclaimed_shares u WHERE u.payout_id=b.id AND u.user_id=r.user_id)
     OR (SELECT count(*) FROM public.bbj_unclaimed_shares u WHERE u.payout_id=b.id AND u.user_id=r.user_id AND u.amount=r.amount
       AND u.pool_id=b.pool_id AND u.table_id=b.table_id AND u.paid_at=w.created_at
       AND (SELECT count(*) FROM public.chip_ledger parked WHERE parked.status='posted' AND parked.category='bbj_payout'
         AND parked.from_type='table_stack' AND parked.from_entity_id=b.table_id AND parked.to_type='bbj_pool' AND parked.to_entity_id=b.pool_id
         AND parked.amount=r.amount AND parked.idempotency_key='bbj_park:bbj:'||b.id::text||':'||r.user_id::text)=1
       AND (SELECT count(*) FROM public.chip_ledger redeemed WHERE redeemed.status='posted' AND redeemed.category='bbj_payout'
         AND redeemed.from_type='bbj_pool' AND redeemed.from_entity_id=b.pool_id AND redeemed.to_type='table_stack' AND redeemed.to_entity_id=b.table_id
         AND redeemed.amount=r.amount AND redeemed.idempotency_key='bbj_redeem:'||b.id::text||':'||r.user_id::text)=1)=1)
 ), matched AS (
  SELECT q.*,gift.proof treasury_gift,returned.proof treasury_return,f.id cash_funding_id,f.funding_club_id cash_club,f.user_id cash_user,f.amount cash_amount,
   e.id entry_id,e.funding_club_id entry_club,e.user_id entry_user,e.amount entry_amount,
   c.ledger_id credit_id,c.credited_club_id credit_club,c.user_id credit_user,c.amount credit_amount,
   ret.owners,ret.funding_club_id return_club,ret.user_id return_user,mv.moved_club,mv.moved_user,
   COALESCE(rf.refunds,0) refunds,rf.club refund_club,rf.player refund_user,te.refund_ent,te.refund_ent_user,te.refund_ent_club,late.n late_count,late.club late_club,late.player late_user,late.delta late_delta,j.club_id bbj_club,j.user_id bbj_user,j.payout_id bbj_payout
  FROM originals q
  LEFT JOIN LATERAL (SELECT smarter_private.original_treasury_gift_evidence(q.ledger_id) proof
   WHERE q.tournament_id IS NULL AND q.l->>'category'='horse_funding'
    AND q.l->>'from_type'='club_treasury' AND q.l->>'to_type'='table_stack') gift ON true
  LEFT JOIN LATERAL (SELECT smarter_private.original_treasury_return_evidence(q.ledger_id) proof
   WHERE q.tournament_id IS NULL AND q.l->>'category' IN('cashout','table_cashout','refund')
    AND q.l->>'from_type'='table_stack' AND q.l->>'to_type'='player_wallet') returned ON true
  LEFT JOIN bbj_wallet_matches j ON j.ledger_id=q.ledger_id
  LEFT JOIN LATERAL (
   SELECT count(*) n,min(p.club_id::text)::uuid club,min(p.user_id::text)::uuid player,min(p.delta) delta
   FROM (SELECT q.ledger_id WHERE q.tournament_id IS NULL
    AND q.l->>'category'='settlement' AND q.l->>'idempotency_key' LIKE 'late_seat_settle:%' OFFSET 0) eligible
   CROSS JOIN LATERAL public.fn_union_pnl_prove_late_settlement(eligible.ledger_id) p
  ) late ON true
  -- One-time filter (20261001): a probe only for the flows that can match.
  LEFT JOIN LATERAL (SELECT f.* FROM public.cash_participant_funding_receipts f
   WHERE q.tournament_id IS NULL AND f.source_ledger_id=q.ledger_id OFFSET 0) f ON true
  LEFT JOIN LATERAL (SELECT e.* FROM public.tournament_participant_funding_receipts e
   WHERE q.tournament_id IS NOT NULL AND e.ledger_id=q.ledger_id AND e.asset='chips' AND q.tournament_id=e.tournament_id OFFSET 0) e ON true
  -- fn_union_pnl_tournament_returns(q.tournament_id,NULL,p_start,p_end) for
  -- this flow's ledger only: its two branches verbatim, keyed by the ledger.
  LEFT JOIN LATERAL (
   SELECT c.ledger_id,c.tournament_id,c.user_id,c.credited_club_id,c.amount
   FROM public.tournament_accounting_credit_receipts c
   JOIN public.union_pnl_transaction_frames b ON b.transaction_id=c.transaction_id
   WHERE q.tournament_id IS NOT NULL AND c.ledger_id=q.ledger_id AND c.tournament_id=q.tournament_id
    AND b.observed_at>=p_start AND b.observed_at<p_end
   UNION ALL
   SELECT t.credit_ledger_id,t.tournament_id,t.user_id,t.source_wallet_club_id,t.amount_paid_now
   FROM public.tournament_refund_tranches t
   JOIN public.tournament_participant_funding_receipts r ON r.entitlement_id=t.entitlement_id
   JOIN public.union_pnl_transaction_frames b ON b.transaction_id=t.transaction_id
   WHERE q.tournament_id IS NOT NULL AND t.credit_ledger_id=q.ledger_id AND t.tournament_id=q.tournament_id
    AND b.observed_at>=p_start AND b.observed_at<p_end
    AND NOT EXISTS(SELECT 1 FROM public.tournament_accounting_credit_receipts c2 WHERE c2.ledger_id=t.credit_ledger_id)
  ) c ON true
  LEFT JOIN LATERAL (
   SELECT count(DISTINCT (r.funding_club_id,r.user_id)) owners,min(r.funding_club_id::text)::uuid funding_club_id,min(r.user_id::text)::uuid user_id
   FROM public.cash_participant_funding_receipts r
   WHERE r.table_id=(q.l->>'table_id')::uuid AND smarter_private.cash_initial_funding_receipt(r.id)
    AND q.tournament_id IS NULL AND q.l->>'from_type'='table_stack'
    AND ((r.account_type=q.l->>'to_type' AND r.account_entity_id=(q.l->>'to_entity_id')::uuid) OR (r.operation_kind='horse_funding' AND r.account_type='club_treasury' AND r.user_id=(q.l->>'to_entity_id')::uuid AND smarter_private.cash_initial_funding_receipt(r.id)))
    AND r.funding_club_id=(q.l->>'club_id')::uuid
    AND (EXISTS(SELECT 1 FROM public.union_pnl_inventory_events i WHERE i.transaction_id=q.transaction_id AND i.source_name='table_seats'
      AND COALESCE(i.after_row,i.before_row)->>'occupancy_id'=r.occupancy_id::text
      AND COALESCE(i.after_row,i.before_row)->>'table_id'=r.table_id::text)
     OR EXISTS(SELECT 1 FROM public.cash_funding_application_receipts a JOIN public.cash_participant_funding_receipts original ON original.id=a.funding_receipt_id
       WHERE a.transaction_id=q.transaction_id AND original.occupancy_id=r.occupancy_id AND a.refunded=(q.l->>'amount')::numeric))
  ) ret ON true
  -- A seat cashed out after it arrived by a table move holds chips whose
  -- original buy-in is on the source occupancy, not this one. The occupancy
  -- the cash-out vacated (its seat row in the same original transaction,
  -- carrying exactly the cashed-out stack) is traced through its move receipts
  -- by fn_cash_original_funding_lineage, the proof the boundaries and hands
  -- already use; the owner is its one original buy-in's club and player.
  LEFT JOIN LATERAL (
   SELECT CASE WHEN lin.v->'issues'='[]'::jsonb AND jsonb_array_length(lin.v->'moves')>0 AND own.receipts>0 AND own.buyins=1
     AND own.clubs=1 AND own.users=1 AND own.club::text=q.l->>'club_id' AND own.player::text=q.l->>'to_entity_id'
     THEN own.club END moved_club,
    CASE WHEN lin.v->'issues'='[]'::jsonb AND jsonb_array_length(lin.v->'moves')>0 AND own.receipts>0 AND own.buyins=1
     AND own.clubs=1 AND own.users=1 AND own.club::text=q.l->>'club_id' AND own.player::text=q.l->>'to_entity_id'
     THEN own.player END moved_user
   FROM (SELECT min(i.before_row::text)::jsonb seat,count(*) n FROM public.union_pnl_inventory_events i
     WHERE q.tournament_id IS NULL AND q.l->>'from_type'='table_stack' AND q.l->>'to_type'='player_wallet'
      AND ret.owners IS DISTINCT FROM 1
      AND i.transaction_id=q.transaction_id AND i.source_name='table_seats' AND i.before_row->>'table_id'=q.l->>'table_id'
      AND i.before_row->>'user_id'=q.l->>'to_entity_id' AND i.before_row->'left_at'='null'::jsonb
      AND i.after_row->>'left_at' IS NOT NULL) s
   CROSS JOIN LATERAL (SELECT public.fn_cash_original_funding_lineage((s.seat->>'user_id')::uuid,(s.seat->>'table_id')::uuid,(s.seat->>'id')::uuid,
     (s.seat->>'occupancy_id')::uuid,(s.seat->>'joined_at')::timestamptz,q.recognized_at,false) v) lin
   CROSS JOIN LATERAL (SELECT count(*) receipts,count(*) FILTER(WHERE smarter_private.cash_initial_funding_receipt(r.id)) buyins,count(DISTINCT r.funding_club_id) clubs,
     count(DISTINCT r.user_id) users,min(r.funding_club_id::text)::uuid club,min(r.user_id::text)::uuid player
    FROM jsonb_array_elements(lin.v->'funding_receipts') ref JOIN public.cash_participant_funding_receipts r ON r.id=(ref->>'id')::uuid) own
   WHERE q.tournament_id IS NULL AND q.l->>'from_type'='table_stack' AND q.l->>'to_type'='player_wallet' AND ret.owners IS DISTINCT FROM 1
    AND s.n=1 AND public.fn_pnl_evidence_cents(s.seat->'stack') IS NOT DISTINCT FROM (q.l->>'amount')::numeric
  ) mv ON true
  -- A pending add-on returned unapplied is a refund of this player's own
  -- escrowed chips. Its wallet credit can carry no refund category: it runs
  -- inside the hand's post-commit obligations, after atomic_distribute_rake
  -- has declared that transaction's ledger context, so the audit labels it
  -- player_funding under the rake settlement. The application receipt
  -- written in the same transaction proves it: exactly one refund of this
  -- amount from a funding receipt of this player, club and table.
  LEFT JOIN LATERAL (
   SELECT r.refunds,r.club,r.player FROM rf_original_matches r
   WHERE q.tournament_id IS NULL AND q.l->>'from_type'='table_stack'
    AND q.l->>'to_type'='player_wallet' AND q.l->>'category'='player_funding'
    AND r.transaction_id=q.transaction_id AND r.table_id=(q.l->>'table_id')::uuid
    AND r.club_id=(q.l->>'club_id')::uuid AND r.user_id=(q.l->>'to_entity_id')::uuid
    AND r.amount=(q.l->>'amount')::numeric
  ) rf ON true
  -- A seat won in a satellite and later refunded by the target tournament
  -- (cancelled, or the seat released) pays the seat's value back to the
  -- player's wallet from the target's prize liability. That seat was never a
  -- wallet-funded entry of the target, so no tournament credit receipt exists
  -- for it; its proof is the refund entitlement the payout is keyed by: same
  -- tournament, player, wallet club and gross, and the seat's owning club as
  -- resolved from its satellite registration.
  LEFT JOIN LATERAL (
   SELECT t.id refund_ent,t.user_id refund_ent_user,t.refund_wallet_club_id refund_ent_club
   FROM public.tournament_refund_entitlements t
   WHERE q.tournament_id IS NOT NULL AND t.tournament_id=q.tournament_id
    AND q.l->>'idempotency_key'='tourney:'||t.tournament_id::text||':refund-entitlement:'||t.id::text
    AND t.entitlement_kind IN('satellite_seat','wallet_charge','tournament_ticket') AND t.gross=(q.l->>'amount')::numeric
    AND t.user_id::text=q.l->>'to_entity_id' AND t.refund_wallet_club_id::text=q.l->>'club_id'
    AND q.l->>'from_type'='prize_liability' AND q.l->>'to_type'='player_wallet' AND q.l->>'category'='refund'
    AND CASE t.entitlement_kind
     WHEN 'satellite_seat' THEN public.fn_union_pnl_satellite_seat_owner(t.registration_id,NULL)=t.refund_wallet_club_id
     -- A pre-capture wallet entry refunded by cancellation (20261006154000):
     -- its entitlement's source ledger is the entry proven at the opening
     -- boundary of the refund's own week, for this exact registration, club
     -- and gross.
     WHEN 'wallet_charge' THEN t.source_ledger_id IS NOT NULL AND (SELECT count(*) FROM public.union_pnl_opening_registration_resolutions r
       WHERE r.boundary=public.fn_union_week_start(q.recognized_at) AND r.union_id=p_union_id AND r.tournament_id=t.tournament_id AND r.user_id=t.user_id
        AND r.owning_club_id=t.refund_wallet_club_id AND r.entries=1 AND r.entry_amount=t.gross AND r.returned=0
        AND r.proof_md5=md5(r.proof::text)
        AND r.proof->'entry_ledger' @> jsonb_build_array(jsonb_build_object('ledger_id',t.source_ledger_id::text)))=1
     WHEN 'tournament_ticket' THEN t.charge_category='tournament_ticket'
      AND t.evidence_kind='atomic_tournament_ticket' AND t.escrow_bucket='ticket_gross'
      AND q.l->>'from_entity_id'=t.tournament_id::text
      AND NOT EXISTS(SELECT 1 FROM public.tournament_tickets replacement WHERE replacement.source_refund_entitlement_id=t.id)
      AND (SELECT count(*) FROM public.tournament_refund_entitlements duplicate WHERE duplicate.source_ticket_id=t.source_ticket_id)=1
      AND (SELECT count(*) FROM public.tournament_refund_tranches tr
       WHERE tr.entitlement_id=t.id AND tr.credit_ledger_id=q.ledger_id AND tr.transaction_id=q.transaction_id
        AND tr.tournament_id=t.tournament_id AND tr.user_id=t.user_id AND tr.source_wallet_club_id=t.refund_wallet_club_id
        AND tr.idempotency_key=q.l->>'idempotency_key' AND tr.amount_paid_before=0 AND tr.amount_paid_now=t.gross
        AND tr.refund_prize=t.refund_prize AND tr.refund_bounty=t.refund_bounty AND tr.refund_fee=t.refund_fee)=1
      AND (SELECT count(*) FROM public.tournament_refund_tranches tr WHERE tr.entitlement_id=t.id)=1
      AND (SELECT count(*) FROM public.tournament_tickets tk
       JOIN public.chip_ledger admission ON admission.id=t.source_ledger_id
       JOIN public.tournament_satellite_awards a ON a.ticket_id=tk.id
       JOIN public.tournament_satellite_settlements h ON h.tournament_id=a.tournament_id
       JOIN public.tournament_payouts p ON p.id=a.payout_id
       JOIN public.chip_ledger issue ON issue.idempotency_key=a.idempotency_key||':ticket_escrow'
       WHERE tk.id=t.source_ticket_id AND tk.holder_id=t.user_id AND tk.club_id=t.refund_wallet_club_id
        AND tk.status='redeemed' AND tk.redemption_mode='tournament_entry_only' AND tk.cancelled_at IS NULL
        AND tk.value=t.gross AND tk.entry_prize=t.refund_prize AND tk.entry_bounty=t.refund_bounty AND tk.entry_fee=t.refund_fee
        AND t.gross=t.refund_prize+t.refund_bounty+t.refund_fee
        AND tk.source_tournament_id=t.tournament_id AND tk.source_satellite_id=t.source_satellite_id
        -- Only the original direct award is admitted here. A replacement
        -- ticket still requires its distinct original refund disposition.
        AND tk.source_refund_entitlement_id IS NULL
        AND a.tournament_id=tk.source_satellite_id AND a.place=tk.source_satellite_award_place
        AND a.user_id=t.user_id AND a.delivery_kind='ticket' AND a.amount=t.gross AND a.payout_source='satellite_ticket'
        AND p.tournament_id=a.tournament_id AND p.user_id=a.user_id AND p.amount=a.amount
        AND p.source=a.payout_source AND p.idempotency_key=a.idempotency_key
        AND (p.position=a.place OR h.receipt_version>=3)
        AND h.target_id=t.tournament_id AND h.ticket_cost=t.gross
        AND h.target_buy_in=tk.entry_prize+tk.entry_bounty AND h.target_fee=tk.entry_fee
        AND issue.status='posted' AND issue.category='ticket_issue' AND issue.amount=t.gross
        AND issue.club_id=tk.club_id AND issue.tournament_id=a.tournament_id
        AND issue.from_type='prize_liability' AND issue.from_entity_id=a.tournament_id
        AND issue.to_type='escrow' AND issue.to_entity_id=tk.id
        AND issue.metadata->>'kind'='direct_satellite_entry_ticket'
        AND issue.metadata->>'ticket_id'=tk.id::text AND issue.metadata->>'payout_id'=p.id::text
        AND issue.metadata->>'user_id'=t.user_id::text
        AND issue.metadata->>'satellite_target_id'=t.tournament_id::text
        AND COALESCE(issue.metadata->>'position',issue.metadata->>'award_slot')=a.place::text
        AND NOT EXISTS(SELECT 1 FROM public.wallet_credit_idempotency w WHERE w.key=a.idempotency_key)
        AND (SELECT count(*) FROM public.chip_transactions x
          WHERE x.transaction_type='tournament_ticket_issue' AND x.club_id=tk.club_id
           AND x.from_user_id IS NULL AND x.to_user_id=t.user_id AND x.amount=t.gross
           AND x.metadata->>'ticket_id'=tk.id::text AND x.metadata->>'ledger_id'=issue.id::text
           AND x.metadata->>'payout_id'=p.id::text AND x.metadata->>'idempotency_key'=a.idempotency_key
           AND x.metadata->>'source_tournament_id'=t.tournament_id::text
           AND x.metadata->>'source_satellite_id'=a.tournament_id::text
           AND x.metadata->>'source_award_place'=a.place::text)=1
        AND admission.status='posted' AND admission.category='ticket_redeem' AND admission.amount=t.gross
        AND admission.club_id=tk.club_id AND admission.tournament_id=t.tournament_id
        AND admission.from_type='escrow' AND admission.from_entity_id=tk.id
        AND admission.to_type='prize_liability' AND admission.to_entity_id=t.tournament_id
        AND admission.idempotency_key='ticket:'||tk.id::text||':tournament:'||t.tournament_id::text||':entry'
        AND admission.metadata->>'kind'='tournament_entry_ticket_admission'
        AND admission.metadata->>'ticket_id'=tk.id::text AND admission.metadata->>'user_id'=t.user_id::text
        AND admission.metadata->>'registration_id'=t.registration_id::text
        AND admission.metadata->>'source_tournament_id'=t.tournament_id::text
        AND admission.metadata->>'source_satellite_id'=t.source_satellite_id::text
        AND admission.metadata->'entry_prize'=to_jsonb(t.refund_prize)
        AND admission.metadata->'entry_bounty'=to_jsonb(t.refund_bounty)
        AND admission.metadata->'entry_fee'=to_jsonb(t.refund_fee))=1
     ELSE false END
  ) te ON true
 ), projected AS (
  SELECT *,CASE WHEN bbj_payout IS NOT NULL THEN 'cash_return' WHEN late_count=1 THEN 'cash_late_settlement' WHEN treasury_gift->>'status'='proven' THEN 'cash_funding' WHEN treasury_return->>'status'='proven' THEN 'cash_return' WHEN cash_funding_id IS NOT NULL THEN 'cash_funding' WHEN owners=1 OR moved_club IS NOT NULL OR refunds=1 THEN 'cash_return'
    WHEN entry_id IS NOT NULL THEN 'tournament_funding' WHEN credit_id IS NOT NULL OR refund_ent IS NOT NULL THEN 'tournament_return' ELSE 'unsupported' END k,
   COALESCE(bbj_club,late_club,(treasury_gift->>'earning_club')::uuid,(treasury_return->>'earning_club')::uuid,cash_club,CASE WHEN moved_club IS NOT NULL THEN moved_club WHEN owners=1 THEN return_club ELSE refund_club END,entry_club,credit_club,refund_ent_club) owner_club,
   COALESCE(bbj_user,late_user,(treasury_gift->>'user_id')::uuid,(treasury_return->>'user_id')::uuid,cash_user,CASE WHEN moved_club IS NOT NULL THEN moved_user WHEN owners=1 THEN return_user ELSE refund_user END,entry_user,credit_user,refund_ent_user) owner_user
  FROM matched
 ) SELECT ledger_id,owner_club,owner_user,
  CASE WHEN k='cash_late_settlement' AND late_delta<0 THEN -late_delta WHEN k IN('cash_funding','tournament_funding') THEN (l->>'amount')::numeric ELSE 0 END,
  CASE WHEN k='cash_late_settlement' AND late_delta>0 THEN late_delta WHEN k IN('cash_return','tournament_return') THEN (l->>'amount')::numeric ELSE 0 END,k,
  (l->>'status'='posted' AND public.fn_pnl_evidence_cents(l->'amount')>0 AND owner_club IS NOT NULL AND owner_user IS NOT NULL
   AND (owner_club::text=l->>'club_id' OR (treasury_gift->>'status'='proven' AND treasury_gift->>'ledger_id'=ledger_id::text AND treasury_gift->>'sponsor_bank_club'=l->>'club_id' AND treasury_gift->>'earning_club'=owner_club::text)) AND game_scope->>'asset'='chips' AND game_scope->'unit_scale'='2'::jsonb
   AND CASE k
    WHEN 'cash_late_settlement' THEN late_count=1 AND abs(late_delta)=(l->>'amount')::numeric
    WHEN 'cash_funding' THEN (cash_amount=(l->>'amount')::numeric OR (treasury_gift->>'status'='proven' AND (treasury_gift->>'amount')::numeric=(l->>'amount')::numeric)) AND l->>'to_type'='table_stack' AND l->>'category' IN('buyin','rebuy','addon','horse_funding')
    WHEN 'cash_return' THEN ((treasury_return->>'status'='proven' AND (treasury_return->>'amount')::numeric=(l->>'amount')::numeric) OR bbj_payout IS NOT NULL OR owners=1 OR moved_club IS NOT NULL OR (refunds=1 AND l->>'category'='player_funding')) AND l->>'from_type'='table_stack' AND (l->>'category' IN('cashout','table_cashout','refund')
     OR (l->>'category'='player_funding' AND refunds=1 AND refund_club=owner_club AND refund_user=owner_user)
     OR (l->>'category'='bbj_payout' AND bbj_payout IS NOT NULL AND bbj_club=owner_club AND bbj_user=owner_user))
    WHEN 'tournament_funding' THEN entry_amount=(l->>'amount')::numeric AND l->>'to_type'='prize_liability' AND l->>'category' IN('tournament_buyin','rebuy','addon')
    WHEN 'tournament_return' THEN (credit_amount=(l->>'amount')::numeric OR (credit_id IS NULL AND refund_ent IS NOT NULL)) AND l->>'from_type'='prize_liability' AND l->>'category' IN('tournament_prize','prize','bounty','refund','tournament_refund')
    ELSE false END) IS TRUE
 FROM projected
;
$function$
;
CREATE OR REPLACE FUNCTION smarter_private.weekly_hand_parts_read(p_union uuid, p_start timestamp with time zone, p_end timestamp with time zone, p_generation text, p_projected boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
DECLARE w record;p record;groups jsonb:='[]';n bigint;expected bigint;
BEGIN
 IF current_setting('app.weekly_accounting_chunked',true) IS DISTINCT FROM 'on' OR current_setting('app.accounting_close_memo',true) IS DISTINCT FROM 'on' THEN RETURN NULL;END IF;
 IF p_generation IS NULL OR p_generation='original-inventory-245:unqualified' THEN RETURN NULL;END IF;
 SELECT count(*) INTO expected FROM public.fn_accounting_close_windows(p_start,p_end);
 SELECT count(*) INTO n FROM public.accounting_close_partials WHERE kind='pnl_hands_window' AND union_id=p_union AND period_start=p_start AND period_end=p_end;
 IF expected=0 OR n<>expected THEN RETURN NULL;END IF;
 FOR w IN SELECT * FROM public.fn_accounting_close_windows(p_start,p_end) ORDER BY 1 LOOP
 SELECT * INTO p FROM public.accounting_close_partials WHERE kind='pnl_hands_window' AND union_id=p_union AND period_start=p_start AND period_end=p_end AND window_start=w.window_start;
 IF NOT FOUND OR p.window_end IS DISTINCT FROM w.window_end OR p.computed_at<p_end OR p.computed_at<=clock_timestamp()-public.fn_accounting_close_proof_lifetime()
 OR p.value->>'generation' IS DISTINCT FROM p_generation OR p.value->'projected' IS DISTINCT FROM to_jsonb(p_projected)
 OR p.computed_at>clock_timestamp() OR jsonb_typeof(p.value->'groups') IS DISTINCT FROM 'array' OR p.value->>'groups_md5' IS DISTINCT FROM md5((p.value->'groups')::text)
 OR p.value->>'contract' IS DISTINCT FROM '9dee2921c7b956281be61a3eb9d7df6e'
 OR p.value->'witness' IS DISTINCT FROM smarter_private.weekly_hand_parts_witness(p_union,w.window_start,w.window_end,p_projected)
 THEN RETURN NULL;END IF;
 groups:=groups||(p.value->'groups');
 END LOOP;
 RETURN(SELECT COALESCE(jsonb_agg(to_jsonb(q) ORDER BY kind,club_id,user_id),'[]'::jsonb) FROM(
 SELECT kind,club_id,user_id,sum(delta)delta,sum(hands)::bigint hands,sum(rake)rake
 FROM jsonb_to_recordset(groups)x(kind integer,club_id uuid,user_id uuid,delta numeric,hands bigint,rake numeric)GROUP BY kind,club_id,user_id)q);
END $function$
;
CREATE OR REPLACE FUNCTION smarter_private.weekly_hand_parts_witness(p_union uuid, p_start timestamp with time zone, p_end timestamp with time zone, p_projected boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
DECLARE n bigint;
BEGIN
 IF current_setting('session_replication_role') IS DISTINCT FROM 'origin'
 OR smarter_private.original_inventory_proof_sources_match() IS DISTINCT FROM true THEN RAISE EXCEPTION 'weekly_hand_parts_original_sources_unqualified';END IF;
 SELECT count(*) INTO n FROM (VALUES ('public.fn_union_pnl_projection_ready(text)','5f643c03d3595c20354d753087988476'),('public.fn_union_pnl_week_hand_lines(uuid,timestamp with time zone,timestamp with time zone,boolean)','9dee2921c7b956281be61a3eb9d7df6e'),('public.fn_accounting_close_windows(timestamp with time zone,timestamp with time zone)','349f940293dfe6175faae2787840ede1'),('public.fn_union_pnl_posthand_escrow_participants(union_pnl_cash_outcomes)','2db7263f8d42e2e0e5a45b42b7198e4d'),('public.fn_union_pnl_posthand_escrow_touch(union_pnl_cash_outcome_touches)','e51decda42bbe46dd90aaf1bd3119023'),('public.fn_accounting_close_proof_lifetime()','80e026be0041fd1bdb04114c87ec368c'),('public.fn_union_pnl_linked_cash_outcomes(uuid,timestamptz,timestamptz)','0c3a826553e9ef65a03030c3ef78eaaf'),('public.fn_union_pnl_inventory_immutable()','307d83a1ee3d912bade24c48144aa801'),('smarter_private.posthand_escrow_certificate_immutable()','14b1ddb37d4e3e83a9a42a34438e4b6e'))x(signature,hash) JOIN pg_proc p ON p.oid=to_regprocedure(x.signature)
 WHERE p.proowner='postgres'::regrole AND md5(pg_get_functiondef(p.oid))=x.hash;
 IF n IS DISTINCT FROM 9::bigint THEN RAISE EXCEPTION 'weekly_hand_parts_original_owners_changed';END IF;
 SELECT count(*) INTO n FROM(VALUES ('public.union_pnl_cash_outcomes','original_pnl_immutable',58,'public.fn_union_pnl_inventory_immutable()'),('public.union_pnl_cash_outcome_touches','original_pnl_immutable',58,'public.fn_union_pnl_inventory_immutable()'),('public.union_pnl_cash_outcome_link_resolutions','original_pnl_immutable',58,'public.fn_union_pnl_inventory_immutable()'),('smarter_private.posthand_escrow_certificates','posthand_escrow_certificate_immutable',31,'smarter_private.posthand_escrow_certificate_immutable()'),('smarter_private.posthand_escrow_certificates','posthand_escrow_certificate_no_truncate',34,'smarter_private.posthand_escrow_certificate_immutable()'))x(rel,name,kind,fn) JOIN pg_trigger t ON t.tgrelid=to_regclass(x.rel) AND t.tgname=x.name
 WHERE NOT t.tgisinternal AND t.tgenabled IN('O','A') AND t.tgtype=x.kind AND t.tgfoid=to_regprocedure(x.fn) AND t.tgqual IS NULL AND t.tgnargs=0;
 IF n IS DISTINCT FROM 5::bigint THEN RAISE EXCEPTION 'weekly_hand_parts_append_only_contract_changed';END IF;
 IF p_projected IS DISTINCT FROM public.fn_union_pnl_projection_ready('cash_outcome_touches') THEN RAISE EXCEPTION 'weekly_hand_parts_projection_changed';END IF;
 RETURN jsonb_build_object('ordinary_count',CASE WHEN p_projected THEN
 (SELECT count(*) FROM public.union_pnl_cash_outcome_touches h WHERE h.game_union_id=p_union::text AND h.recognized_at>=p_start AND h.recognized_at<p_end)
 ELSE (SELECT count(*) FROM public.union_pnl_cash_outcomes h WHERE h.game_scope->>'game_union_id'=p_union::text AND h.recognized_at>=p_start AND h.recognized_at<p_end) END,
 -- Link ownership comes from the immutable resolution, while recognition comes
 -- from the original outcome, exactly as the original linked reader requires.
 'links',(SELECT count(*) FROM public.union_pnl_cash_outcome_link_resolutions r
 JOIN public.union_pnl_cash_outcomes o ON o.table_id=r.table_id AND o.hand_number=r.hand_number
 WHERE r.game_scope->>'game_union_id'=p_union::text AND o.recognized_at>=p_start AND o.recognized_at<p_end),
 -- Only certificates consulted by the ordinary reader can change this window.
 -- Linked outcomes carry their original resolved evidence and do not read these.
 'escrow_certificates',CASE WHEN p_projected THEN
 (SELECT count(*) FROM public.union_pnl_cash_outcome_touches h
 JOIN smarter_private.posthand_escrow_certificates c ON c.table_id=h.table_id AND c.hand_number=h.hand_number
 WHERE h.game_union_id=p_union::text AND h.recognized_at>=p_start AND h.recognized_at<p_end)
 ELSE(SELECT count(*) FROM public.union_pnl_cash_outcomes h
 JOIN smarter_private.posthand_escrow_certificates c ON c.table_id=h.table_id AND c.hand_number=h.hand_number
 WHERE h.game_scope->>'game_union_id'=p_union::text AND h.recognized_at>=p_start AND h.recognized_at<p_end)END);
END $function$
;

-- Preserve exact original public owner ACLs; these are not anonymous RPCs.
REVOKE ALL ON FUNCTION public.fn_ca_cash_seat_club(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_cash_seat_club(uuid,uuid) TO service_role;
REVOKE ALL ON FUNCTION public.fn_cash_earning_club(uuid,uuid,uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_cash_earning_club(uuid,uuid,uuid,uuid,uuid) TO service_role;
REVOKE ALL ON FUNCTION public.fn_cash_original_funding_lineage(uuid,uuid,uuid,uuid,timestamp with time zone,timestamp with time zone,boolean) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_horse_seat_from_treasury(uuid,uuid,integer,numeric,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_horse_seat_from_treasury(uuid,uuid,integer,numeric,uuid) TO service_role;
REVOKE ALL ON FUNCTION public.fn_horse_seat_from_treasury_before_maintenance_gate(uuid,uuid,integer,numeric,uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_pnl_cash_hand_evidence(uuid,bigint) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_pnl_cash_hand_evidence(uuid,bigint) TO service_role;
REVOKE ALL ON FUNCTION public.fn_union_pnl_boundary(uuid,timestamp with time zone) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_union_pnl_cash_outcome_accepted(public.union_pnl_cash_outcomes) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_union_pnl_original_flow_evidence(uuid,timestamp with time zone,timestamp with time zone) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_union_pnl_week_hand_lines(uuid,timestamp with time zone,timestamp with time zone,boolean) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_cash_capture_hand_manifest(uuid,bigint,jsonb,text,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_cash_capture_hand_manifest(uuid,bigint,jsonb,text,uuid) TO service_role;
REVOKE ALL ON FUNCTION public.fn_cash_record_original_funding(text,text,uuid,uuid,uuid,uuid,uuid,numeric,numeric,uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_claim_entry_purchase_receipt(text,text,jsonb) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION smarter_private.original_inventory_proof_sources_match()
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog'
AS $function$
 SELECT count(*)=65 AND bool_and(p.oid IS NOT NULL AND p.proowner='postgres'::regrole AND md5(pg_get_functiondef(p.oid)) IS NOT DISTINCT FROM x.body_md5)
 FROM(VALUES ('public.fn_union_pnl_inventory_state(timestamptz,timestamptz)','d77f5ad055ee433875efed7fd53bd25a'),('public.fn_union_pnl_inventory_population(timestamptz,timestamptz)','449f6f13feefe0d7e26e767a3465bc67'),('public.fn_union_pnl_inventory_as_of(timestamptz)','85513ff85d2b37ad04b79f89e125f1aa'),('smarter_private.original_retirement_boundary_proof(jsonb,timestamptz,timestamptz)','56457798f46f7c06a32b0e52915740a0'),('smarter_private.original_paired_seat_restoration_proof(jsonb,jsonb,timestamptz,timestamptz)','ada80c7f667ca7dad36cf223c80c3a6a'),('smarter_private.original_closed_tournament_rails_proof(jsonb,timestamptz)','a9319182a566e9917353765c414a1aa1'),('smarter_private.original_closed_player_proof(jsonb,timestamptz,timestamptz)','a441c3abe887cc4528268e347916d236'),('smarter_private.original_continued_chair_proof(jsonb,timestamptz,timestamptz)','8876018a8370a99f4012696cb264c740'),('smarter_private.original_returned_cash_base_proof(jsonb,timestamptz,timestamptz)','7ed06b6ccded0d6eb2bc3357742e360d'),('smarter_private.original_erased_cash_base_proof(jsonb,timestamptz)','a2d5ac28a5f07929ed99d6e871dddfa2'),('smarter_private.original_inventory_source_ref_md5(jsonb)','81fba77f13564999931e8a7a47cbd609'),('smarter_private.original_inventory_finite_witness(bigint)','0ef0a8a5b9e85633cf4bf8b0cd15c8d7'),('smarter_private.original_inventory_finite_family_proof(text,jsonb,timestamptz,timestamptz)','dd7861e20f4c90567a704cb2625962b8'),('smarter_private.original_erased_cash_base_request(bigint,text)','1467e44cc7f7871b34eff07f7038019d'),('public.fn_union_pnl_satellite_seat_owner(uuid,uuid)','3beddbfe1e3d204d1907b428d9358f08'),('public.fn_platform_frozen()','ec683805e052fceeae74789e82dce4cc'),('public.fn_active_maintenance_release_boundary()','05b537b57c9f51a5164e20a1cd0e67e0'),('smarter_private.original_inventory_case_insert_guard()','d9bcabf711efa4c81c0ae7567897b722'),('smarter_private.original_inventory_certificate_insert_guard()','d4956b2b4c0a58bb5dc57b35e3e884ce'),('smarter_private.original_inventory_restoration_immutable()','6c939d278f5fad857bd97437dfaa5f4d'),('smarter_private.certify_original_inventory_restoration(bigint,timestamptz)','f5db14badd4a6b07c0f4b82e2ec5cb1e'),('smarter_private.inventory_restoration_issue_accepted(jsonb,timestamptz)','fdba882b3557f6ffd1cc29129773ff04'),('public.fn_union_pnl_boundary(uuid,timestamptz)','5e4e878524a91518de209bc5e008db36'),('public.fn_union_pnl_original_flow_evidence(uuid,timestamptz,timestamptz)','0998b0c974aac59fbd4914eef394f1c7'),('public.fn_union_pnl_evidence_report(uuid,timestamptz,timestamptz)','c4a17522149bfd879342ccc68dec98f9'),('smarter_private.inventory_basis_cache_read(text,boolean,text,uuid,timestamptz,timestamptz)','058d499ade9d0609f83cc07d551b7f35'),('smarter_private.inventory_basis_cache_write(text,text,uuid,timestamptz,timestamptz,jsonb)','2c3f0af276c29f33d09cdb7ecd86df6a'),('smarter_private.original_inventory_basis_generation()','58dc20e1ba380ccb9b9dee8809731d33'),('public.fn_accounting_close_certificate(text,uuid,timestamptz,timestamptz)','7b4a5f4572a45db069b6058899614021'),('public.fn_accounting_close_problem(text,uuid,timestamptz,timestamptz)','9667c8b8c5aa74bf2ad2c57fbfa3991d'),('public.fn_accounting_close_certify(text,uuid,timestamptz,timestamptz,jsonb)','58501728a93f9f4534dbf26d26aba63f'),('public.fn_union_pnl_inventory_as_of_admitted(timestamptz)','d65a33c20fb224c1dc2cc1ecb8168940'),('smarter_private.original_erased_cash_base_expected_hash(bigint)','afe5941dd7c4bbcccbfadc5d65a4f447'),('smarter_private.original_erased_cash_base_discharge_receipt(bigint,text)','f2c22efcfd9231094732ca82edff9101'),('smarter_private.original_erased_cash_base_discharge_evidence_valid(bigint,text,jsonb)','d4bc8b8d57c9037805a735bc1bb2be21'),('smarter_private.original_erased_cash_base_discharge(bigint,text)','9e6fcbf606004b81353a7704b50f072f'),('smarter_private.original_erased_cash_receivables(uuid,timestamptz)','0c53bd1f7fd7d22117af340ee02769d6'),('smarter_private.original_erased_cash_discharge_returns(uuid,timestamptz,timestamptz)','2a41fe7ccedc2947cf3ab84cead2493c'),('smarter_private.original_restoration_cash_returns(uuid,timestamptz,timestamptz)','e7cecf308d34108e12c0006029c1a3fa'),('public.fn_union_week_start(timestamptz)','103f192a228084dad0e4268c36c82c4b'),('smarter_private.union_pnl_original_flow_evidence_window(uuid,timestamptz,timestamptz,timestamptz,timestamptz)','cefb154e19a245a5688dbc87fed141f5'),('public.fn_union_pnl_week_bbj_stack_awards(uuid,timestamptz,timestamptz)','faf875701e49db1cf99b481119e87404'),('public.fn_accounting_union_earned_plan_advance(uuid,timestamptz,timestamptz)','c9c79cce604c8f481772149fa2538ab2'),('smarter_private.original_treasury_witness_immutable()','f6326523741592230d149799b876e886'),('smarter_private.original_treasury_gift_evidence(uuid)','df84a641f40ee44d9db83e979398f9af'),('smarter_private.admit_original_treasury_gift(uuid)','07c857f67488e000ecbaf63e083c1c05'),('smarter_private.original_treasury_return_evidence(uuid)','3f2b8626b018cc5d22d9ebe9e6d3fb72'),('smarter_private.admit_original_treasury_return(uuid)','c51b45b085ac1a26f043711804ff8d00'),('smarter_private.cash_initial_funding_receipt(uuid)','e111dad7c0f5d5e3b74710053835caa4'),('smarter_private.original_treasury_participant_gift(jsonb,uuid,timestamptz)','95b9a25f9a422bb7d8df115f86bc5993'),('smarter_private.original_treasury_cash_outcome_evidence(jsonb)','12c94769bbcd6eb2c3349728cdc8512d'),('public.fn_horse_seat_from_treasury(uuid,uuid,integer,numeric,uuid)','4a7cee2cfecdf7a36446c169f754ccd0'),('public.fn_cash_record_original_funding(text,text,uuid,uuid,uuid,uuid,uuid,numeric,numeric,uuid)','d01404c53405fd1826de26e58b04f4b1'),('public.fn_cash_original_funding_lineage(uuid,uuid,uuid,uuid,timestamptz,timestamptz,boolean)','8269577929892d8634e32dcfac08ff77'),('public.fn_pnl_cash_hand_evidence(uuid,bigint)','43820fe60b759bd93f6838f908122c96'),('public.fn_cash_capture_hand_manifest(uuid,bigint,jsonb,text,uuid)','1a5e66c29d3d36e41752589d59daa478'),('public.fn_cash_earning_club(uuid,uuid,uuid,uuid,uuid)','2ba3a2891019b46e06b46b4c642e566a'),('public.fn_ca_cash_seat_club(uuid,uuid)','148f2246fc0ee3ab11cd86456765e419'),('public.fn_union_pnl_week_hand_lines(uuid,timestamptz,timestamptz,boolean)','9dee2921c7b956281be61a3eb9d7df6e'),('smarter_private.weekly_hand_parts_read(uuid,timestamptz,timestamptz,text,boolean)','d427fd27d163ba72a7dc3cd50866163d'),('smarter_private.weekly_hand_parts_witness(uuid,timestamptz,timestamptz,boolean)','a3b1c75ad2b122dc0b0fede8a66813c8'),('public.fn_claim_entry_purchase_receipt(text,text,jsonb)','4a10a4e1cfd2794046a6cb8ad1463de6'),('public.fn_horse_seat_from_treasury_before_maintenance_gate(uuid,uuid,integer,numeric,uuid)','ad64ff6223a433108f4f3625de1be3be'),('smarter_private.original_treasury_seat_money_core(uuid,uuid,integer,numeric,uuid)','d768afe805ed480569b44ef107d15675'),('public.fn_union_pnl_cash_outcome_accepted(public.union_pnl_cash_outcomes)','a7c0b003d24f5ae64cf440ce94d52d93'))x(signature,body_md5) LEFT JOIN pg_proc p ON p.oid=to_regprocedure(x.signature);
$function$
;
DO $qualified$BEGIN IF smarter_private.original_inventory_proof_sources_match() IS DISTINCT FROM true THEN PERFORM pg_catalog.set_config('search_path','pg_catalog',true);RAISE EXCEPTION 'treasury_qualified_original_sources_failed: %',(SELECT jsonb_agg(jsonb_build_object('signature',x.signature,'expected',x.body_md5,'actual',md5(pg_get_functiondef(p.oid)),'owner',p.proowner::regrole::text))FROM(VALUES ('public.fn_union_pnl_inventory_state(timestamptz,timestamptz)','d77f5ad055ee433875efed7fd53bd25a'),('public.fn_union_pnl_inventory_population(timestamptz,timestamptz)','449f6f13feefe0d7e26e767a3465bc67'),('public.fn_union_pnl_inventory_as_of(timestamptz)','85513ff85d2b37ad04b79f89e125f1aa'),('smarter_private.original_retirement_boundary_proof(jsonb,timestamptz,timestamptz)','56457798f46f7c06a32b0e52915740a0'),('smarter_private.original_paired_seat_restoration_proof(jsonb,jsonb,timestamptz,timestamptz)','ada80c7f667ca7dad36cf223c80c3a6a'),('smarter_private.original_closed_tournament_rails_proof(jsonb,timestamptz)','a9319182a566e9917353765c414a1aa1'),('smarter_private.original_closed_player_proof(jsonb,timestamptz,timestamptz)','a441c3abe887cc4528268e347916d236'),('smarter_private.original_continued_chair_proof(jsonb,timestamptz,timestamptz)','8876018a8370a99f4012696cb264c740'),('smarter_private.original_returned_cash_base_proof(jsonb,timestamptz,timestamptz)','7ed06b6ccded0d6eb2bc3357742e360d'),('smarter_private.original_erased_cash_base_proof(jsonb,timestamptz)','a2d5ac28a5f07929ed99d6e871dddfa2'),('smarter_private.original_inventory_source_ref_md5(jsonb)','81fba77f13564999931e8a7a47cbd609'),('smarter_private.original_inventory_finite_witness(bigint)','0ef0a8a5b9e85633cf4bf8b0cd15c8d7'),('smarter_private.original_inventory_finite_family_proof(text,jsonb,timestamptz,timestamptz)','dd7861e20f4c90567a704cb2625962b8'),('smarter_private.original_erased_cash_base_request(bigint,text)','1467e44cc7f7871b34eff07f7038019d'),('public.fn_union_pnl_satellite_seat_owner(uuid,uuid)','3beddbfe1e3d204d1907b428d9358f08'),('public.fn_platform_frozen()','ec683805e052fceeae74789e82dce4cc'),('public.fn_active_maintenance_release_boundary()','05b537b57c9f51a5164e20a1cd0e67e0'),('smarter_private.original_inventory_case_insert_guard()','d9bcabf711efa4c81c0ae7567897b722'),('smarter_private.original_inventory_certificate_insert_guard()','d4956b2b4c0a58bb5dc57b35e3e884ce'),('smarter_private.original_inventory_restoration_immutable()','6c939d278f5fad857bd97437dfaa5f4d'),('smarter_private.certify_original_inventory_restoration(bigint,timestamptz)','f5db14badd4a6b07c0f4b82e2ec5cb1e'),('smarter_private.inventory_restoration_issue_accepted(jsonb,timestamptz)','fdba882b3557f6ffd1cc29129773ff04'),('public.fn_union_pnl_boundary(uuid,timestamptz)','5e4e878524a91518de209bc5e008db36'),('public.fn_union_pnl_original_flow_evidence(uuid,timestamptz,timestamptz)','0998b0c974aac59fbd4914eef394f1c7'),('public.fn_union_pnl_evidence_report(uuid,timestamptz,timestamptz)','c4a17522149bfd879342ccc68dec98f9'),('smarter_private.inventory_basis_cache_read(text,boolean,text,uuid,timestamptz,timestamptz)','058d499ade9d0609f83cc07d551b7f35'),('smarter_private.inventory_basis_cache_write(text,text,uuid,timestamptz,timestamptz,jsonb)','2c3f0af276c29f33d09cdb7ecd86df6a'),('smarter_private.original_inventory_basis_generation()','58dc20e1ba380ccb9b9dee8809731d33'),('public.fn_accounting_close_certificate(text,uuid,timestamptz,timestamptz)','7b4a5f4572a45db069b6058899614021'),('public.fn_accounting_close_problem(text,uuid,timestamptz,timestamptz)','9667c8b8c5aa74bf2ad2c57fbfa3991d'),('public.fn_accounting_close_certify(text,uuid,timestamptz,timestamptz,jsonb)','58501728a93f9f4534dbf26d26aba63f'),('public.fn_union_pnl_inventory_as_of_admitted(timestamptz)','d65a33c20fb224c1dc2cc1ecb8168940'),('smarter_private.original_erased_cash_base_expected_hash(bigint)','afe5941dd7c4bbcccbfadc5d65a4f447'),('smarter_private.original_erased_cash_base_discharge_receipt(bigint,text)','f2c22efcfd9231094732ca82edff9101'),('smarter_private.original_erased_cash_base_discharge_evidence_valid(bigint,text,jsonb)','d4bc8b8d57c9037805a735bc1bb2be21'),('smarter_private.original_erased_cash_base_discharge(bigint,text)','9e6fcbf606004b81353a7704b50f072f'),('smarter_private.original_erased_cash_receivables(uuid,timestamptz)','0c53bd1f7fd7d22117af340ee02769d6'),('smarter_private.original_erased_cash_discharge_returns(uuid,timestamptz,timestamptz)','2a41fe7ccedc2947cf3ab84cead2493c'),('smarter_private.original_restoration_cash_returns(uuid,timestamptz,timestamptz)','e7cecf308d34108e12c0006029c1a3fa'),('public.fn_union_week_start(timestamptz)','103f192a228084dad0e4268c36c82c4b'),('smarter_private.union_pnl_original_flow_evidence_window(uuid,timestamptz,timestamptz,timestamptz,timestamptz)','cefb154e19a245a5688dbc87fed141f5'),('public.fn_union_pnl_week_bbj_stack_awards(uuid,timestamptz,timestamptz)','faf875701e49db1cf99b481119e87404'),('public.fn_accounting_union_earned_plan_advance(uuid,timestamptz,timestamptz)','c9c79cce604c8f481772149fa2538ab2'),('smarter_private.original_treasury_witness_immutable()','f6326523741592230d149799b876e886'),('smarter_private.original_treasury_gift_evidence(uuid)','df84a641f40ee44d9db83e979398f9af'),('smarter_private.admit_original_treasury_gift(uuid)','07c857f67488e000ecbaf63e083c1c05'),('smarter_private.original_treasury_return_evidence(uuid)','3f2b8626b018cc5d22d9ebe9e6d3fb72'),('smarter_private.admit_original_treasury_return(uuid)','c51b45b085ac1a26f043711804ff8d00'),('smarter_private.cash_initial_funding_receipt(uuid)','e111dad7c0f5d5e3b74710053835caa4'),('smarter_private.original_treasury_participant_gift(jsonb,uuid,timestamptz)','95b9a25f9a422bb7d8df115f86bc5993'),('smarter_private.original_treasury_cash_outcome_evidence(jsonb)','12c94769bbcd6eb2c3349728cdc8512d'),('public.fn_horse_seat_from_treasury(uuid,uuid,integer,numeric,uuid)','4a7cee2cfecdf7a36446c169f754ccd0'),('public.fn_cash_record_original_funding(text,text,uuid,uuid,uuid,uuid,uuid,numeric,numeric,uuid)','d01404c53405fd1826de26e58b04f4b1'),('public.fn_cash_original_funding_lineage(uuid,uuid,uuid,uuid,timestamptz,timestamptz,boolean)','8269577929892d8634e32dcfac08ff77'),('public.fn_pnl_cash_hand_evidence(uuid,bigint)','43820fe60b759bd93f6838f908122c96'),('public.fn_cash_capture_hand_manifest(uuid,bigint,jsonb,text,uuid)','1a5e66c29d3d36e41752589d59daa478'),('public.fn_cash_earning_club(uuid,uuid,uuid,uuid,uuid)','2ba3a2891019b46e06b46b4c642e566a'),('public.fn_ca_cash_seat_club(uuid,uuid)','148f2246fc0ee3ab11cd86456765e419'),('public.fn_union_pnl_week_hand_lines(uuid,timestamptz,timestamptz,boolean)','9dee2921c7b956281be61a3eb9d7df6e'),('smarter_private.weekly_hand_parts_read(uuid,timestamptz,timestamptz,text,boolean)','d427fd27d163ba72a7dc3cd50866163d'),('smarter_private.weekly_hand_parts_witness(uuid,timestamptz,timestamptz,boolean)','a3b1c75ad2b122dc0b0fede8a66813c8'),('public.fn_claim_entry_purchase_receipt(text,text,jsonb)','4a10a4e1cfd2794046a6cb8ad1463de6'),('public.fn_horse_seat_from_treasury_before_maintenance_gate(uuid,uuid,integer,numeric,uuid)','ad64ff6223a433108f4f3625de1be3be'),('smarter_private.original_treasury_seat_money_core(uuid,uuid,integer,numeric,uuid)','d768afe805ed480569b44ef107d15675'),('public.fn_union_pnl_cash_outcome_accepted(public.union_pnl_cash_outcomes)','a7c0b003d24f5ae64cf440ce94d52d93'))x(signature,body_md5)LEFT JOIN pg_proc p ON p.oid=to_regprocedure(x.signature)WHERE p.oid IS NULL OR p.proowner<>'postgres'::regrole OR md5(pg_get_functiondef(p.oid))IS DISTINCT FROM x.body_md5);END IF;END$qualified$;
COMMIT;
