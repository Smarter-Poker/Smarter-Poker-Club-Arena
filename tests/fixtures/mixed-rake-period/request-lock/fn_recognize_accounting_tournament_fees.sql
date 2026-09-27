CREATE OR REPLACE FUNCTION public.fn_recognize_accounting_tournament_fees(p_tournament_id uuid, p_recognized_at timestamp with time zone, p_bank_club_id uuid, p_union_wallet_transaction_id uuid, p_bank_journal_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE plan jsonb;prior record;source record;bank record;active_ids uuid[];refunded_ids uuid[];
 net_fee numeric;game_union uuid;rows_written int:=0;users_count int;source_count int;vip record;week_date date;
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
 FOR source IN SELECT * FROM public.accounting_tournament_fee_sources WHERE id=ANY(active_ids) ORDER BY club_id,player_id,id LOOP
  rows_written:=rows_written+public.fn_post_accounting_commission_source(source.id,'tournament_fee_accrual',p_recognized_at,source.contract);
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
