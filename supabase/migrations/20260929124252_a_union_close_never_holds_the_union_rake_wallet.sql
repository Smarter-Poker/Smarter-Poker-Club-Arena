-- A union close never holds the union's rake wallet while it works.
--
-- Midway's weekly close (book 2026-09-21..28) stalled live play. Round 1
-- (fn_union_weekly_rakeback_close) took `SELECT ... FROM union_wallets ...
-- FOR UPDATE` on Midway's one union_wallets row before its heavy reads, then
-- updated it, and the transaction kept that row lock through rounds 2 and 3,
-- invoices and statements: minutes. Every Midway hand credits that same row
-- (atomic_distribute_rake: INSERT ... ON CONFLICT DO UPDATE union_wallets), so
-- every hand commit on every Midway table queued behind the close and hit its
-- 8s statement timeout (measured 2026-09-29 12:22-12:28Z: 19 blocked
-- sessions, all behind the close). fn_credit_treasury_zd4core also read the
-- club row FOR UPDATE, which blocks the FOR KEY SHARE every foreign-key check
-- on clubs takes (tournament_players updates in hand commits).
--
-- 1. Round 1 reads the union wallet without a lock. Its debit of the rake
--    wallet (and the retained share into the bank, with their journal rows,
--    ledger leg and receipt) moves into fn_union_close_post_rake_debit, a
--    single guarded UPDATE (rake_wallet >= the period total) whose before and
--    after balances are read under that update's own lock.
-- 2. Inside fn_union_settlement_cascade that debit is posted as the LAST write
--    of the cascade, so the row is held from then to commit only. Round 1
--    called on its own posts it inline, exactly as before; nothing else
--    changes. The cascade refuses to return success if round 1 posted and its
--    debit did not.
-- 3. fn_credit_treasury_zd4core locks the club row FOR NO KEY UPDATE: it only
--    changes chip_treasury and updated_at, which no unique index covers.
-- 4. fn_process_weekly_accounting_scope records PG_EXCEPTION_CONTEXT with a
--    failed union attempt, so an internal error names where it happened.
--
-- @live-proof: to_regprocedure('public.fn_union_close_post_rake_debit(jsonb)') IS NOT NULL AND position('app.union_close_defer_rake_debit' in pg_get_functiondef('public.fn_union_settlement_cascade(uuid,timestamptz,timestamptz)'::regprocedure)) > 0
-- Applied to production as version 20260929124252. Preimage-guarded.
-- unqualified-write-ok: ca_settlements because every "UPDATE ca_settlements" in this
--   file is a needle string inside a $n$ literal used to patch a function body
--   with replace(); the real statement keeps its WHERE clause in the patched
--   function. Nothing here is an UPDATE executed against the table.
SET LOCAL lock_timeout = '5s';

INSERT INTO public.ca_money_rpc_registry(proname,status,notes)
SELECT 'fn_union_close_post_rake_debit','approved',
 'The union rake wallet debit of an existing weekly union close (round 1), moved unchanged out of fn_union_weekly_rakeback_close so the cascade posts it as its last write: one guarded UPDATE of union_wallets, the same journal rows, the same retained-share ledger leg and receipt. No amounts, rates or recipients change.'
WHERE NOT EXISTS(SELECT 1 FROM public.ca_money_rpc_registry WHERE proname='fn_union_close_post_rake_debit');

CREATE OR REPLACE FUNCTION public.fn_union_close_post_rake_debit(p jsonb)
RETURNS TABLE(rw_before numeric, rw_after numeric, cb_before numeric, cb_after numeric)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $f$
DECLARE
 u uuid:=(p->>'union_id')::uuid; sid uuid:=(p->>'settlement_id')::uuid;
 p_from timestamptz:=(p->>'period_start')::timestamptz; p_to timestamptz:=(p->>'period_end')::timestamptz;
 v_total numeric:=(p->>'period_total')::numeric; v_payout numeric:=(p->>'payout_total')::numeric;
 v_retained numeric:=(p->>'retained')::numeric; v_actor uuid:=(p->>'actor')::uuid;
 v_ledger_id uuid; v_prior jsonb; k text;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE='42501'; END IF;
 IF u IS NULL OR sid IS NULL OR p_from IS NULL OR p_to IS NULL OR v_total IS NULL OR v_payout IS NULL OR v_retained IS NULL
  OR v_total<=0 OR v_payout<0 OR v_retained<0 OR round(v_payout+v_retained,2)<>round(v_total,2)
  OR jsonb_typeof(p->'clubs') IS DISTINCT FROM 'array'
  OR (SELECT round(COALESCE(sum((c->>'payout')::numeric),0),2) FROM jsonb_array_elements(p->'clubs') c)<>round(v_payout,2)
  OR NOT EXISTS(SELECT 1 FROM public.ca_settlements s WHERE s.id=sid AND s.settlement_type='union_rakeback_close' AND s.union_id=u)
 THEN RAISE EXCEPTION 'union_close_rake_debit_invalid' USING ERRCODE='22023', DETAIL=p::text; END IF;
 SELECT jsonb_object_agg(x,current_setting(x,true)) INTO v_prior FROM unnest(ARRAY[
  'app.ledger_autoskip_clubs','app.ledger_autoskip_union_wallets','app.ledger_category',
  'app.ledger_counterparty','app.ledger_counterparty_entity','app.ledger_settlement'])x;
 PERFORM public.fn_ca_declare_ledger('rakeback','union_wallet',u,sid,NULL,ARRAY['union_wallets','clubs']);
 -- one debit per pot: the treasury pays the whole period; the retained
 -- share moves to the general bank
 UPDATE public.union_wallets
    SET rake_wallet       = rake_wallet - v_total,
        chip_balance      = chip_balance + v_retained,
        total_settlements = COALESCE(total_settlements, 0) + v_payout,
        updated_at        = now()
  WHERE union_id = u AND rake_wallet >= v_total
  RETURNING round(rake_wallet, 2), round(chip_balance, 2) INTO rw_after, cb_after;
 IF NOT FOUND THEN
  RAISE EXCEPTION 'insufficient_rake_treasury' USING ERRCODE='P0001',
   DETAIL=jsonb_build_object('union_id',u,'period_total',v_total,'settlement_id',sid)::text;
 END IF;
 rw_before:=round(rw_after+v_total,2); cb_before:=round(cb_after-v_retained,2);
 INSERT INTO public.union_wallet_transactions
   (union_id, club_id, amount, tx_type, wallet, direction, balance_after, notes)
 SELECT u, (c->>'club_id')::uuid, (c->>'payout')::numeric, 'rakeback', 'rake_wallet', 'debit', rw_after,
        'Weekly rakeback to club at the per-game-type rate (period '
          || to_char(p_from, 'YYYY-MM-DD') || '..' || to_char(p_to, 'YYYY-MM-DD') || ')'
   FROM jsonb_array_elements(p->'clubs') c ORDER BY c->>'club_id';
 IF v_retained > 0 THEN
  INSERT INTO public.union_wallet_transactions
    (union_id, amount, tx_type, wallet, direction, balance_after, notes)
  VALUES
    (u, v_retained, 'rake_hold', 'rake_wallet', 'debit', rw_after,
     'Union retained share + self-club rake, out of the rake treasury (period '
       || to_char(p_from, 'YYYY-MM-DD') || '..' || to_char(p_to, 'YYYY-MM-DD') || ')'),
    (u, v_retained, 'rake_hold', 'chip_balance', 'credit', cb_after,
     'Union retained share + self-club rake, into the general bank (period '
       || to_char(p_from, 'YYYY-MM-DD') || '..' || to_char(p_to, 'YYYY-MM-DD') || ')');
  INSERT INTO public.chip_ledger
    (performed_by, from_type, from_entity_id, to_type, to_entity_id,
     amount, category, union_id, description, idempotency_key, metadata)
  VALUES
    (v_actor, 'union_wallet', u, 'union_bank', u,
     v_retained, 'treasury_transfer', u,
     'Weekly union close ' || to_char(p_from, 'YYYY-MM-DD') || '..' || to_char(p_to, 'YYYY-MM-DD')
       || ': retained share ' || v_retained || ' of period rake ' || v_total
       || ' moves from the rake treasury to the general bank (clubs paid ' || v_payout || ')',
     'union_close:' || sid::text || ':retained',
     jsonb_build_object('settlement_id', sid, 'period_start', p_from, 'period_end', p_to,
                        'period_rake', v_total, 'payout_total', v_payout,
                        'clubs_paid', (p->>'clubs_paid')::int)) RETURNING id INTO v_ledger_id;
  IF NOT EXISTS(SELECT 1 FROM public.settlement_invoices i WHERE i.source_ledger_id=v_ledger_id AND i.status='paid'
    AND i.net_amount=v_retained AND i.chips_transferred AND i.message_sent
    AND EXISTS(SELECT 1 FROM public.accounting_invoice_deliveries d WHERE d.invoice_id=i.id)) THEN
   RAISE EXCEPTION 'union_retained_invoice_receipt_missing' USING ERRCODE='23514';
  END IF;
 END IF;
 FOR k IN SELECT jsonb_object_keys(v_prior) LOOP
  PERFORM set_config(k,COALESCE(v_prior->>k,''),true);
 END LOOP;
 RETURN NEXT;
END
$f$;
REVOKE ALL ON FUNCTION public.fn_union_close_post_rake_debit(jsonb) FROM PUBLIC, anon, authenticated, service_role;

DO $mig$
DECLARE
 s1 regprocedure:='public.fn_union_weekly_rakeback_close(uuid,timestamptz,timestamptz)'::regprocedure;
 s2 regprocedure:='public.fn_union_settlement_cascade(uuid,timestamptz,timestamptz)'::regprocedure;
 s3 regprocedure:='public.fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure;
 s4 regprocedure:='public.fn_credit_treasury_zd4core(uuid,numeric,text,jsonb)'::regprocedure;
 d text; a int; b int; x text; startm text; endm text;
BEGIN
 -- ROUND 1 -------------------------------------------------------------
 d:=pg_get_functiondef(s1);
 IF md5(d)<>'a1c9fd8bc6a74bb3f71d944fdaed0973' THEN RAISE EXCEPTION 'round1 preimage %',md5(d); END IF;
 FOREACH x IN ARRAY ARRAY[
  $n$  SELECT * INTO v_wallet FROM union_wallets WHERE union_id = p_union_id FOR UPDATE;
$n$,
  $n$  v_actor        uuid;
$n$,
  $n$    UPDATE ca_settlements
       SET state = 'ledger_posted',$n$] LOOP
  IF (length(d)-length(replace(d,x,'')))/length(x)<>1 THEN RAISE EXCEPTION 'round1 needle count: %',x; END IF;
 END LOOP;
 d:=replace(d,$n$  SELECT * INTO v_wallet FROM union_wallets WHERE union_id = p_union_id FOR UPDATE;
$n$,$n$  -- LIVE CONTENTION (20260929): read, never lock. Every hand of this union
  -- credits this row; the debit below takes its lock at the last moment.
  SELECT * INTO v_wallet FROM union_wallets WHERE union_id = p_union_id;
$n$);
 d:=replace(d,$n$  v_actor        uuid;
$n$,$n$  v_actor        uuid;
  v_pending      jsonb;
  v_deferred     boolean := false;
$n$);
 startm:=$n$    -- one debit per pot: the treasury pays the whole period; the retained
    -- share moves to the general bank
    UPDATE union_wallets$n$;
 endm:=$n$        RAISE EXCEPTION 'union_retained_invoice_receipt_missing' USING ERRCODE='23514';
      END IF;
    END IF;
$n$;
 IF (length(d)-length(replace(d,startm,'')))/length(startm)<>1 OR (length(d)-length(replace(d,endm,'')))/length(endm)<>1 THEN
  RAISE EXCEPTION 'round1 block markers'; END IF;
 a:=position(startm in d); b:=position(endm in d)+length(endm);
 IF b<=a THEN RAISE EXCEPTION 'round1 block order'; END IF;
 d:=substr(d,1,a-1)||$n$    -- THE UNION WALLET DEBIT (20260929): one guarded update in
    -- fn_union_close_post_rake_debit. Inside the weekly cascade it is posted as
    -- the cascade's last write, so the row every hand credits is held only
    -- from then to commit; called on its own, it is posted here, as before.
    v_pending := jsonb_build_object('union_id', p_union_id, 'settlement_id', v_sid,
      'period_start', p_period_start, 'period_end', p_period_end,
      'period_total', v_period_total, 'payout_total', v_payout_total, 'retained', v_retained,
      'clubs_paid', v_clubs_paid, 'actor', v_actor,
      'clubs', (SELECT COALESCE(jsonb_agg(jsonb_build_object('club_id', club_id, 'payout', payout) ORDER BY club_id), '[]'::jsonb)
                  FROM _uwrb WHERE club_id IS NOT NULL AND club_id <> p_union_id AND payout > 0));
    IF current_setting('app.union_close_defer_rake_debit', true) = v_sref THEN
      IF NULLIF(current_setting('app.union_close_pending_rake_debit', true), '') IS NOT NULL THEN
        RAISE EXCEPTION 'union_close_rake_debit_already_pending' USING ERRCODE='55000';
      END IF;
      PERFORM set_config('app.union_close_pending_rake_debit', v_pending::text, true);
      v_deferred := true;
      -- the union side is proved when it posts; the clubs side is proved below
      v_rw_before := 0; v_new_rw := -v_period_total; v_cb_before := 0; v_new_cb := v_retained;
    ELSE
      SELECT d.rw_before, d.rw_after, d.cb_before, d.cb_after INTO v_rw_before, v_new_rw, v_cb_before, v_new_cb
        FROM public.fn_union_close_post_rake_debit(v_pending) d;
    END IF;
$n$||substr(d,b);
 d:=replace(d,$n$    UPDATE ca_settlements
       SET state = 'ledger_posted',$n$,$n$    IF v_deferred THEN v_new_rw := NULL; v_new_cb := NULL; END IF;
    UPDATE ca_settlements
       SET state = 'ledger_posted',$n$);
 EXECUTE d;
 -- CASCADE -------------------------------------------------------------
 d:=pg_get_functiondef(s2);
 IF md5(d)<>'1adc53784a37e366e50cc01832df4521' THEN RAISE EXCEPTION 'cascade preimage %',md5(d); END IF;
 FOREACH x IN ARRAY ARRAY[
  $n$  v_sqlstate text; v_msg text; v_detail text; v_context text;
$n$,
  $n$  -- ROUND 1 - union rake treasury pays the clubs their 90%.
$n$,
  $n$  PERFORM set_config('app.union_accounting_validated_period',COALESCE(v_previous_validated,''),true);
  RETURN jsonb_build_object('success', true, 'union_id', p_union_id,$n$] LOOP
  IF (length(d)-length(replace(d,x,'')))/length(x)<>1 THEN RAISE EXCEPTION 'cascade needle count: %',x; END IF;
 END LOOP;
 d:=replace(d,$n$  v_sqlstate text; v_msg text; v_detail text; v_context text;
$n$,$n$  v_sqlstate text; v_msg text; v_detail text; v_context text;
  v_pending jsonb; v_posted record;
$n$);
 d:=replace(d,$n$  -- ROUND 1 - union rake treasury pays the clubs their 90%.
$n$,$n$  -- THE UNION WALLET IS DEBITED LAST (20260929): round 1 leaves its rake
  -- wallet debit pending for this exact book; it is posted below, after the
  -- statements, so live hands are never queued behind the close.
  PERFORM set_config('app.union_close_defer_rake_debit', p_union_id::text || ':'
    || to_char(v_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') || '..'
    || to_char(v_to AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), true);
  PERFORM set_config('app.union_close_pending_rake_debit', '', true);

  -- ROUND 1 - union rake treasury pays the clubs their 90%.
$n$);
 d:=replace(d,$n$  PERFORM set_config('app.union_accounting_validated_period',COALESCE(v_previous_validated,''),true);
  RETURN jsonb_build_object('success', true, 'union_id', p_union_id,$n$,$n$  PERFORM set_config('app.union_accounting_validated_period',COALESCE(v_previous_validated,''),true);
  v_pending := NULLIF(current_setting('app.union_close_pending_rake_debit', true), '')::jsonb;
  PERFORM set_config('app.union_close_defer_rake_debit', '', true);
  PERFORM set_config('app.union_close_pending_rake_debit', '', true);
  IF v_r1->>'success' = 'true' AND COALESCE((v_r1->>'period_rake')::numeric, 0) > 0 AND (v_pending IS NULL OR v_pending->>'settlement_id' IS DISTINCT FROM v_r1->>'settlement_id') THEN
    RAISE EXCEPTION 'union_close_rake_debit_not_pending' USING ERRCODE='55000';
  END IF;
  IF v_pending IS NOT NULL THEN
    IF v_r1->>'success' IS DISTINCT FROM 'true' THEN
      RAISE EXCEPTION 'union_close_rake_debit_without_round1' USING ERRCODE='55000';
    END IF;
    SELECT * INTO v_posted FROM public.fn_union_close_post_rake_debit(v_pending);
    v_r1 := v_r1 || jsonb_build_object('rake_wallet_after', v_posted.rw_after, 'chip_balance_after', v_posted.cb_after,
      'rake_debit_posted', 'last_write_of_cascade');
  END IF;
  RETURN jsonb_build_object('success', true, 'union_id', p_union_id,$n$);
 EXECUTE d;
 -- SCOPE: keep the context of a failed union attempt ---------------------
 d:=pg_get_functiondef(s3);
 IF md5(d)<>'6e8a3d775891ae1d4685231a07ff72d3' THEN RAISE EXCEPTION 'scope preimage %',md5(d); END IF;
 FOREACH x IN ARRAY ARRAY[
  $n$  v_msg text; v_detail text; v_state text;
$n$,
  $n$      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_msg=MESSAGE_TEXT,v_detail=PG_EXCEPTION_DETAIL,v_state=RETURNED_SQLSTATE;
        v_result:=jsonb_build_object('success',false,'error',v_msg,'sqlstate',v_state,'detail',v_detail);
      END;

      PERFORM public.fn_weekly_accounting_attempt_end();
      IF v_result->>'success'='true'$n$] LOOP
  IF (length(d)-length(replace(d,x,'')))/length(x)<>1 THEN RAISE EXCEPTION 'scope needle count: %',x; END IF;
 END LOOP;
 d:=replace(d,$n$  v_msg text; v_detail text; v_state text;
$n$,$n$  v_msg text; v_detail text; v_state text; v_context text;
$n$);
 d:=replace(d,$n$      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_msg=MESSAGE_TEXT,v_detail=PG_EXCEPTION_DETAIL,v_state=RETURNED_SQLSTATE;
        v_result:=jsonb_build_object('success',false,'error',v_msg,'sqlstate',v_state,'detail',v_detail);
      END;

      PERFORM public.fn_weekly_accounting_attempt_end();
      IF v_result->>'success'='true'$n$,$n$      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_msg=MESSAGE_TEXT,v_detail=PG_EXCEPTION_DETAIL,v_state=RETURNED_SQLSTATE,v_context=PG_EXCEPTION_CONTEXT;
        v_result:=jsonb_build_object('success',false,'error',v_msg,'sqlstate',v_state,'detail',v_detail,'context',left(v_context,4000));
      END;

      PERFORM public.fn_weekly_accounting_attempt_end();
      IF v_result->>'success'='true'$n$);
 EXECUTE d;
 -- CLUB TREASURY CREDIT: no key lock -------------------------------------
 d:=pg_get_functiondef(s4);
 IF md5(d)<>'a87a523506dba44227b63d1b38f8f128' THEN RAISE EXCEPTION 'treasury preimage %',md5(d); END IF;
 x:=$n$  FROM clubs WHERE id = p_club_id FOR UPDATE;$n$;
 IF (length(d)-length(replace(d,x,'')))/length(x)<>1 THEN RAISE EXCEPTION 'treasury needle count'; END IF;
 d:=replace(d,x,$n$  FROM clubs WHERE id = p_club_id FOR NO KEY UPDATE;$n$);
 EXECUTE d;
 -- POSTIMAGE ------------------------------------------------------------
 IF position('fn_union_close_post_rake_debit' in pg_get_functiondef(s1))=0
  OR position('FOR UPDATE;' in substr(pg_get_functiondef(s1),position('SELECT * INTO v_wallet' in pg_get_functiondef(s1)),120))>0
  OR position('UPDATE union_wallets' in pg_get_functiondef(s1))>0
  OR position('fn_union_close_post_rake_debit(v_pending)' in pg_get_functiondef(s2))=0
  OR position('v_context=PG_EXCEPTION_CONTEXT' in pg_get_functiondef(s3))=0
  OR position('FOR NO KEY UPDATE' in pg_get_functiondef(s4))=0 THEN
  RAISE EXCEPTION 'postimage check failed';
 END IF;
END
$mig$;
