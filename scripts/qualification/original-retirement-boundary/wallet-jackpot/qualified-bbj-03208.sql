-- @live-proof: (position('bbj_wallet_matches AS MATERIALIZED' IN pg_get_functiondef('public.fn_union_pnl_original_flow_evidence(uuid,timestamptz,timestamptz)'::regprocedure))>0 AND smarter_private.original_inventory_proof_sources_match())
-- Active weekly rakeback payout outage:84 original jackpot wallet credits,
-- 33,465.32 chips, are already paid and reconcile to their original pool,
-- recipient, idempotency and wallet journals. They were unsupported by the
-- weekly flow reader. Prove them as cash returns and include the SAME award
-- in game P&L, exactly as a share paid to the felt: wallet versus felt cannot
-- change the player's profit. No wallet, ledger, payout or original row changes.
BEGIN;
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
COMMIT;
