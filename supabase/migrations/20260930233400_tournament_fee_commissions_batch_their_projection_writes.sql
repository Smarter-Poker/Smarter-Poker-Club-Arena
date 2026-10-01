-- An 85-source historical MTT fee recognition exceeds its five-second caller
-- budget. A self-aborting production profile measured 1.101s in the first 20
-- per-source commission posts alone. Each tier repeated statement rollups and
-- agent counter writes. Batch those existing writes at the recognition owner;
-- preserve every earned tier, amount, source key, real row/statement trigger,
-- closed-period refusal, bank proof, replay guard and downstream statistics.
-- No player wallet, prize, bounty, fee rate or historical record is rewritten.
-- The existing single-source function and all cash callers are unchanged.
BEGIN;
SET LOCAL statement_timeout='5s';
SET LOCAL lock_timeout='1s';
DO $guard$
BEGIN
 IF md5(pg_get_functiondef('public.fn_recognize_accounting_tournament_fees(uuid,timestamptz,uuid,uuid,uuid)'::regprocedure)) IS DISTINCT FROM '195878da781227b47753a28dbc7bc978'
  OR (SELECT pg_get_userbyid(proowner)<>'postgres' OR proacl::text IS DISTINCT FROM '{postgres=X/postgres}' FROM pg_proc WHERE oid='public.fn_recognize_accounting_tournament_fees(uuid,timestamptz,uuid,uuid,uuid)'::regprocedure)
 THEN RAISE EXCEPTION 'tournament commission batch predecessor changed: public.fn_recognize_accounting_tournament_fees(uuid,timestamptz,uuid,uuid,uuid)'; END IF;
 IF md5(pg_get_functiondef('public.fn_post_accounting_commission_source(uuid,text,timestamptz,jsonb)'::regprocedure)) IS DISTINCT FROM 'b647df60b45c25183638f4cdbaec57fd'
  OR (SELECT pg_get_userbyid(proowner)<>'postgres' OR proacl::text IS DISTINCT FROM '{postgres=X/postgres}' FROM pg_proc WHERE oid='public.fn_post_accounting_commission_source(uuid,text,timestamptz,jsonb)'::regprocedure)
 THEN RAISE EXCEPTION 'tournament commission batch predecessor changed: public.fn_post_accounting_commission_source(uuid,text,timestamptz,jsonb)'; END IF;
END $guard$;
CREATE OR REPLACE FUNCTION public.fn_recognize_accounting_tournament_fees(p_tournament_id uuid, p_recognized_at timestamp with time zone, p_bank_club_id uuid, p_union_wallet_transaction_id uuid, p_bank_journal_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE plan jsonb;prior record;source record;bank record;active_ids uuid[];refunded_ids uuid[];
 net_fee numeric;game_union uuid;rows_written int:=0;users_count int;source_count int;vip record;week_date date;batch_admitted boolean;
BEGIN
 IF p_recognized_at IS NULL OR p_recognized_at IS DISTINCT FROM transaction_timestamp() THEN
  RAISE EXCEPTION 'tournament_fee_original_recognition_transaction_required' USING ERRCODE='55000'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('accounting_tournament_recognition:'||p_tournament_id::text,0));
 PERFORM public.fn_lock_accounting_tournament_recognition_week(p_tournament_id,p_recognized_at);
 plan:=public.fn_accounting_tournament_fee_net_plan(p_tournament_id);
 SELECT * INTO prior FROM public.accounting_tournament_fee_recognitions WHERE tournament_id=p_tournament_id;
 IF FOUND THEN
  IF prior.source_fingerprint IS DISTINCT FROM plan->>'source_fingerprint' THEN
   RAISE EXCEPTION 'recognized_tournament_fee_sources_changed' USING ERRCODE='23514'; END IF;
  RETURN prior.plan||jsonb_build_object('status',prior.status,'payable',prior.status='recognized','replayed',true,'recognized_at',prior.recognized_at);
 END IF;
 net_fee:=(plan->>'net_fee')::numeric;game_union:=NULLIF(plan->>'union_id','')::uuid;
 IF p_bank_club_id IS NULL AND net_fee>0 THEN RAISE EXCEPTION 'tournament_fee_bank_club_required' USING ERRCODE='23514'; END IF;
 PERFORM public.fn_accounting_tournament_bank_proof(p_tournament_id,p_recognized_at,p_bank_club_id,game_union,net_fee,p_union_wallet_transaction_id,p_bank_journal_id);
 SELECT COALESCE(array_agg(value::uuid),'{}') INTO active_ids FROM jsonb_array_elements_text(plan->'active_source_ids');
 SELECT COALESCE(array_agg(value::uuid),'{}') INTO refunded_ids FROM jsonb_array_elements_text(plan->'refunded_source_ids');
 INSERT INTO public.accounting_tournament_fee_recognitions(tournament_id,recognized_at,status,net_rake,union_id,bank_club_id,
  union_wallet_transaction_id,bank_journal_id,source_fingerprint,plan)
 VALUES(p_tournament_id,p_recognized_at,CASE WHEN net_fee>0 THEN 'recognized' ELSE 'cancelled' END,net_fee,game_union,p_bank_club_id,
  p_union_wallet_transaction_id,p_bank_journal_id,plan->>'source_fingerprint',plan);
 INSERT INTO public.accounting_tournament_recognized_sources(source_id,tournament_id,recognized_at,disposition,rake_credit)
 SELECT s.id,p_tournament_id,p_recognized_at,CASE WHEN s.id=ANY(active_ids) THEN 'earned' ELSE 'refunded' END,
  CASE WHEN s.id=ANY(active_ids) THEN s.rake_credit ELSE 0 END
 FROM public.accounting_tournament_fee_sources s WHERE s.id=ANY(active_ids||refunded_ids);
 -- Only the existing historical owner admission excludes concurrent commission
 -- writers. Ordinary recognitions retain their exact per-source write order.
 batch_admitted:=EXISTS(SELECT 1 FROM pg_locks l WHERE l.locktype='relation'
  AND l.database=(SELECT oid FROM pg_database WHERE datname=current_database())
  AND l.relation='public.agent_commissions'::regclass AND l.pid=pg_backend_pid()
  AND l.granted AND l.mode IN('ShareRowExclusiveLock','ExclusiveLock','AccessExclusiveLock'));
 -- Post the same recorded tiers in one statement. Row guards and the real
 -- transition-table rollups still run; repeated per-tier rollup writes do not.
 IF batch_admitted AND EXISTS(SELECT 1 FROM public.accounting_tournament_fee_sources WHERE id=ANY(active_ids)) THEN
  IF NOT public.fn_caller_is_engine() THEN
   RAISE EXCEPTION 'service_role_required' USING ERRCODE='42501'; END IF;
  IF NOT isfinite(p_recognized_at) OR EXISTS(
   SELECT 1 FROM public.accounting_tournament_fee_sources s WHERE s.id=ANY(active_ids)
    AND jsonb_typeof(s.contract->'tiers') IS DISTINCT FROM 'array') THEN
   RAISE EXCEPTION 'invalid_accounting_commission_source' USING ERRCODE='22023'; END IF;
  -- Check every source, including an agreement with no payable tiers.
  IF EXISTS(SELECT 1 FROM public.accounting_tournament_fee_sources s
   JOIN public.agent_commission_settlements closed ON closed.club_id=(s.contract->>'club_id')::uuid
    AND p_recognized_at>=closed.period_start AND p_recognized_at<closed.period_end
   WHERE s.id=ANY(active_ids)) THEN
   RAISE EXCEPTION 'cash_accrual_closed_period_requires_adjustment' USING ERRCODE='23514'; END IF;
  INSERT INTO public.agent_commissions(club_id,user_id,amount,commission_rate,source_type,source_id,notes,created_at)
  SELECT (s.contract->>'club_id')::uuid,(tier.value->>'user_id')::uuid,
   (tier.value->>'amount')::numeric,(tier.value->>'rate')::numeric,
   'tournament_fee_accrual',s.id,
   'Commission from recorded earning agreement; tier '||(tier.value->>'depth'),p_recognized_at
  FROM public.accounting_tournament_fee_sources s
  CROSS JOIN LATERAL jsonb_array_elements(s.contract->'tiers') WITH ORDINALITY tier(value,ordinality)
  WHERE s.id=ANY(active_ids) AND (tier.value->>'amount')::numeric>0
  ORDER BY s.club_id,s.player_id,s.id,tier.ordinality;
  GET DIAGNOSTICS rows_written=ROW_COUNT;
  -- Counter credit belongs to EVERY tier, even a zero-commission tier.
  -- A retired/missing profile never suppresses its recorded user's liability.
  -- Preserve the old source/tier first-lock order before a grouped UPDATE.
  -- Zero-commission cash tiers also lock agents without a rollup row first.
  PERFORM a.id FROM public.accounting_tournament_fee_sources s
  CROSS JOIN LATERAL jsonb_array_elements(s.contract->'tiers') WITH ORDINALITY tier(value,ordinality)
  JOIN public.agents a ON a.id=(tier.value->>'agent_id')::uuid
   AND a.club_id=(s.contract->>'club_id')::uuid AND a.user_id=(tier.value->>'user_id')::uuid
  WHERE s.id=ANY(active_ids)
  ORDER BY s.club_id,s.player_id,s.id,tier.ordinality
  FOR NO KEY UPDATE OF a;
  UPDATE public.agents a SET
   lifetime_rake_generated=COALESCE(a.lifetime_rake_generated,0)+credits.rake_credit,
   weekly_rake_generated=COALESCE(a.weekly_rake_generated,0)+CASE
    WHEN public.fn_union_week_start(p_recognized_at)=public.fn_union_week_start(now())
    THEN credits.rake_credit ELSE 0 END,
   last_active_at=now(),updated_at=now()
  FROM (SELECT (tier.value->>'agent_id')::uuid agent_id,
    (s.contract->>'club_id')::uuid club_id,(tier.value->>'user_id')::uuid user_id,
    sum((s.contract->>'rake_credit')::numeric) rake_credit
   FROM public.accounting_tournament_fee_sources s
   CROSS JOIN LATERAL jsonb_array_elements(s.contract->'tiers') tier(value)
   WHERE s.id=ANY(active_ids)
   GROUP BY (tier.value->>'agent_id')::uuid,(s.contract->>'club_id')::uuid,(tier.value->>'user_id')::uuid) credits
  WHERE a.id=credits.agent_id AND a.club_id=credits.club_id AND a.user_id=credits.user_id;
 END IF;
 FOR source IN SELECT * FROM public.accounting_tournament_fee_sources WHERE id=ANY(active_ids) ORDER BY club_id,player_id,id LOOP
  IF NOT batch_admitted THEN
   rows_written:=rows_written+public.fn_post_accounting_commission_source(source.id,'tournament_fee_accrual',p_recognized_at,source.contract);
  END IF;
  -- Statistics use the real source record/player pair. The source credit is
  -- recognized once; a retry is guarded by the terminal recognition row above.
  PERFORM public.apply_rakeback_player_stats(source.rake_record_id,source.player_id,source.club_id,0,source.rake_credit);
 END LOOP;
 -- VIP already has a unique event/player source key. Preserve its original
 -- settlement-time grouping while giving it exact conserved contributor cents.
 FOR vip IN SELECT player_id,sum(rake_credit) credit FROM public.accounting_tournament_fee_sources
  WHERE id=ANY(active_ids) GROUP BY player_id ORDER BY player_id LOOP
  IF vip.credit>0 THEN PERFORM public.fn_award_vip_credit(vip.player_id,vip.credit,'tournament_rake',p_tournament_id,'Tournament rake generated'); END IF;
 END LOOP;
 week_date:=(public.fn_union_week_start(p_recognized_at) AT TIME ZONE 'America/Los_Angeles')::date;
 INSERT INTO public.accounting_period_recompute_requests(club_id,period_start,period_end,status)
 SELECT DISTINCT club_id,week_date,week_date+6,'pending' FROM public.accounting_tournament_fee_sources WHERE id=ANY(active_ids)
 ON CONFLICT(club_id,period_start,period_end) DO UPDATE SET status='pending',reason=NULL,last_result='{}'::jsonb,last_requested_at=transaction_timestamp();
 SELECT count(DISTINCT player_id),count(*) INTO users_count,source_count FROM public.accounting_tournament_fee_sources WHERE id=ANY(active_ids);
 RETURN plan||jsonb_build_object('status',CASE WHEN net_fee>0 THEN 'recognized' ELSE 'cancelled' END,
  'recognized_at',p_recognized_at,'payable',net_fee>0,'replayed',false,'commission_rows',rows_written,
  'attributed_users',users_count,'source_count',source_count,'attributed_chips',net_fee);
END $function$
;
REVOKE ALL ON FUNCTION public.fn_recognize_accounting_tournament_fees(uuid,timestamptz,uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
