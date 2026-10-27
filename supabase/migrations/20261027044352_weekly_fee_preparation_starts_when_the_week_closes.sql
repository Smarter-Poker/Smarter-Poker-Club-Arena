-- @live-proof: (md5(pg_get_functiondef('public.fn_prepare_accounting_week(uuid,uuid,timestamp with time zone,timestamp with time zone)'::regprocedure))='62c444b0953cced8a4f3144fc86af51b' AND md5(pg_get_functiondef('public.fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure))='aa771409420704b6dd05cfaef9d2f8dc' AND md5(pg_get_functiondef('public.fn_weekly_close_first_visits_pending()'::regprocedure))='7185f43f5cb8dc23606ef5e486da9c5d')
-- Closed fee preparation starts at02; payment remains gated at04 Chicago.
-- Original fee-window owner and all financial writers remain unchanged.
BEGIN;
SET LOCAL lock_timeout='2s';
DO $wire_fees$
DECLARE d text;BEGIN
 d:=pg_get_functiondef('public.fn_prepare_accounting_week(uuid,uuid,timestamp with time zone,timestamp with time zone)'::regprocedure);
 IF md5(d)<>'e3940cd164188f2dfb38871308a232e2' THEN RAISE EXCEPTION 'weekly_fee_preparation_owner_changed: public.fn_prepare_accounting_week(uuid,uuid,timestamp with time zone,timestamp with time zone)';END IF;
 IF (length(d)-length(replace(d,$old0_0$ SELECT COALESCE(array_agg(c.club_id ORDER BY c.club_id),ARRAY[]::uuid[]) INTO clubs
$old0_0$,'')))/length($old0_0$ SELECT COALESCE(array_agg(c.club_id ORDER BY c.club_id),ARRAY[]::uuid[]) INTO clubs
$old0_0$)<>1 THEN RAISE EXCEPTION 'weekly_fee_preparation_anchor_changed';END IF;
 d:=replace(d,$old0_0$ SELECT COALESCE(array_agg(c.club_id ORDER BY c.club_id),ARRAY[]::uuid[]) INTO clubs
$old0_0$,$new0_0$ -- The fee windows belong to fee preparation, before later club books.
 -- Only enter the original advance when its fee prefix has missing work:
 -- that prefix ends its attempt before any P&L branch. Its proof, IDs, row
 -- hashes, refusal path and unchanged time budget remain authoritative.
 IF p_union_id IS NOT NULL
  AND COALESCE(current_setting('app.weekly_accounting_chunked',true),'')='on'
  AND current_setting('app.accounting_close_memo',true)='on'
  AND NULLIF(current_setting('app.weekly_accounting_scope_deadline',true),'') IS NOT NULL
  AND EXISTS(SELECT FROM public.accounting_cash_accrual_cutover WHERE singleton AND starts_at<=p_from)
  AND NOT EXISTS(SELECT FROM public.accounting_routed_settlement_runs r
   WHERE r.scope_kind='union' AND r.scope_id=p_union_id AND r.round_no=3
    AND r.period_start=p_from AND r.period_end=p_to)
  AND public.fn_accounting_close_certificate('earned_plan',p_union_id,p_from,p_to) IS NULL
  AND EXISTS(SELECT FROM public.fn_accounting_close_windows(p_from,p_to) w
   WHERE NOT EXISTS(SELECT FROM public.accounting_close_partials p
    WHERE p.kind='earned_plan_window' AND p.union_id=p_union_id
     AND p.period_start=p_from AND p.period_end=p_to
     AND p.window_start=w.window_start AND p.window_end=w.window_end
     AND p.computed_at>=p_to
     AND p.computed_at>clock_timestamp()-public.fn_accounting_close_proof_lifetime())) THEN
  IF public.fn_accounting_union_earned_plan_advance(p_union_id,p_from,p_to) IS DISTINCT FROM false THEN
   RAISE EXCEPTION 'earned_fee_window_advance_did_not_stop_after_fee_work' USING ERRCODE='55000';
  END IF;
  RETURN jsonb_build_object('success',false,'accounting_version',3,
   'union_id',p_union_id,'club_id',p_club_id,'period_start',p_from,'period_end',p_to,'clubs',0,
   'problems',jsonb_build_array(jsonb_build_object('reason','earned_fee_certification_in_progress')));
 END IF;
 SELECT COALESCE(array_agg(c.club_id ORDER BY c.club_id),ARRAY[]::uuid[]) INTO clubs
$new0_0$);
 EXECUTE d;
 IF md5(pg_get_functiondef('public.fn_prepare_accounting_week(uuid,uuid,timestamp with time zone,timestamp with time zone)'::regprocedure))<>'62c444b0953cced8a4f3144fc86af51b' THEN RAISE EXCEPTION 'weekly_fee_preparation_postimage_changed';END IF;
 d:=pg_get_functiondef('public.fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure);
 IF md5(d)<>'72ab1c8c7e8408119bf670db527e8e64' THEN RAISE EXCEPTION 'weekly_fee_preparation_owner_changed: public.fn_process_weekly_accounting_scope(uuid,uuid)';END IF;
 IF (length(d)-length(replace(d,$old1_0$  v_preparation jsonb; v_club record;$old1_0$,'')))/length($old1_0$  v_preparation jsonb; v_club record;$old1_0$)<>1 THEN RAISE EXCEPTION 'weekly_fee_preparation_anchor_changed';END IF;
 d:=replace(d,$old1_0$  v_preparation jsonb; v_club record;$old1_0$,$new1_0$  v_preparing_before_due boolean:=false;
  v_preparation jsonb; v_club record;$new1_0$);
 IF (length(d)-length(replace(d,$old1_1$v_now>=public.fn_union_accounting_run_at(public.fn_union_week_start(w.first_week+interval '8 days'))$old1_1$,'')))/length($old1_1$v_now>=public.fn_union_accounting_run_at(public.fn_union_week_start(w.first_week+interval '8 days'))$old1_1$)<>2 THEN RAISE EXCEPTION 'weekly_fee_preparation_anchor_changed';END IF;
 d:=replace(d,$old1_1$v_now>=public.fn_union_accounting_run_at(public.fn_union_week_start(w.first_week+interval '8 days'))$old1_1$,$new1_1$v_now>=CASE WHEN v_chunked THEN public.fn_union_week_start(w.first_week+interval '8 days') ELSE public.fn_union_accounting_run_at(public.fn_union_week_start(w.first_week+interval '8 days')) END$new1_1$);
 IF (length(d)-length(replace(d,$old1_2$v_now>=public.fn_union_accounting_run_at(public.fn_union_week_start(GREATEST(w.first_week,public.fn_club_settlement_floor_week(w.club_id))+interval '8 days'))$old1_2$,'')))/length($old1_2$v_now>=public.fn_union_accounting_run_at(public.fn_union_week_start(GREATEST(w.first_week,public.fn_club_settlement_floor_week(w.club_id))+interval '8 days'))$old1_2$)<>1 THEN RAISE EXCEPTION 'weekly_fee_preparation_anchor_changed';END IF;
 d:=replace(d,$old1_2$v_now>=public.fn_union_accounting_run_at(public.fn_union_week_start(GREATEST(w.first_week,public.fn_club_settlement_floor_week(w.club_id))+interval '8 days'))$old1_2$,$new1_2$v_now>=CASE WHEN v_chunked THEN public.fn_union_week_start(GREATEST(w.first_week,public.fn_club_settlement_floor_week(w.club_id))+interval '8 days') ELSE public.fn_union_accounting_run_at(public.fn_union_week_start(GREATEST(w.first_week,public.fn_club_settlement_floor_week(w.club_id))+interval '8 days')) END$new1_2$);
 IF (length(d)-length(replace(d,$old1_3$      IF v_now < v_due THEN EXIT; END IF;$old1_3$,'')))/length($old1_3$      IF v_now < v_due THEN EXIT; END IF;$old1_3$)<>1 THEN RAISE EXCEPTION 'weekly_fee_preparation_anchor_changed';END IF;
 d:=replace(d,$old1_3$      IF v_now < v_due THEN EXIT; END IF;$old1_3$,$new1_3$      v_preparing_before_due:=v_chunked AND v_end=v_to AND v_now>=v_end AND v_now<v_due;
      IF v_now < v_due AND NOT v_preparing_before_due THEN EXIT; END IF;$new1_3$);
 IF (length(d)-length(replace(d,$old1_4$        IF v_now<v_due THEN EXIT;END IF;$old1_4$,'')))/length($old1_4$        IF v_now<v_due THEN EXIT;END IF;$old1_4$)<>1 THEN RAISE EXCEPTION 'weekly_fee_preparation_anchor_changed';END IF;
 d:=replace(d,$old1_4$        IF v_now<v_due THEN EXIT;END IF;$old1_4$,$new1_4$        v_preparing_before_due:=v_chunked AND v_end=v_to AND v_now>=v_end AND v_now<v_due;
        IF v_now<v_due AND NOT v_preparing_before_due THEN EXIT;END IF;$new1_4$);
 IF (length(d)-length(replace(d,$old1_5$        IF v_chunked AND v_preparation->>'success' IS DISTINCT FROM 'true'
$old1_5$,'')))/length($old1_5$        IF v_chunked AND v_preparation->>'success' IS DISTINCT FROM 'true'
$old1_5$)<>1 THEN RAISE EXCEPTION 'weekly_fee_preparation_anchor_changed';END IF;
 d:=replace(d,$old1_5$        IF v_chunked AND v_preparation->>'success' IS DISTINCT FROM 'true'
$old1_5$,$new1_5$        IF v_preparing_before_due AND v_preparation->>'success'='true' THEN
          -- Closed-week commission/player proof windows advance before due.
          -- This original owner is nonfinancial; the04 money gate remains.
          PERFORM public.fn_accounting_close_windows_pending(v_union.id,NULL,v_from,v_end);
          v_result:=jsonb_build_object('success',false,'chunk_committed',true,'committed_round',0,'stage','prepared',
            'purpose','fees_before_due','union_id',v_union.id,'period_start',v_from,'period_end',v_end);
        ELSIF v_chunked AND v_preparation->>'success' IS DISTINCT FROM 'true'
$new1_5$);
 IF (length(d)-length(replace(d,$old1_6$          AND v_preparation#>'{problems,0,pnl_evidence,issues}'='["union_pnl_certification_in_progress"]'::jsonb THEN$old1_6$,'')))/length($old1_6$          AND v_preparation#>'{problems,0,pnl_evidence,issues}'='["union_pnl_certification_in_progress"]'::jsonb THEN$old1_6$)<>1 THEN RAISE EXCEPTION 'weekly_fee_preparation_anchor_changed';END IF;
 d:=replace(d,$old1_6$          AND v_preparation#>'{problems,0,pnl_evidence,issues}'='["union_pnl_certification_in_progress"]'::jsonb THEN$old1_6$,$new1_6$          AND (v_preparation#>'{problems,0,pnl_evidence,issues}'='["union_pnl_certification_in_progress"]'::jsonb
           OR v_preparation#>>'{problems,0,reason}'='earned_fee_certification_in_progress') THEN$new1_6$);
 IF (length(d)-length(replace(d,$old1_7$          IF v_chunked AND (CASE WHEN public.fn_accounting_preparation_calculating(v_preparation) THEN true$old1_7$,'')))/length($old1_7$          IF v_chunked AND (CASE WHEN public.fn_accounting_preparation_calculating(v_preparation) THEN true$old1_7$)<>1 THEN RAISE EXCEPTION 'weekly_fee_preparation_anchor_changed';END IF;
 d:=replace(d,$old1_7$          IF v_chunked AND (CASE WHEN public.fn_accounting_preparation_calculating(v_preparation) THEN true$old1_7$,$new1_7$          IF v_preparing_before_due AND v_preparation->>'success'='true' THEN
            PERFORM public.fn_accounting_close_windows_pending(NULL,v_club.id,v_from,v_end);
          END IF;
          IF v_chunked AND (CASE WHEN v_preparing_before_due THEN true
            WHEN public.fn_accounting_preparation_calculating(v_preparation) THEN true$new1_7$);
 IF (length(d)-length(replace(d,$old1_8$      SELECT result INTO v_previous FROM public.union_accounting_runs
$old1_8$,'')))/length($old1_8$      SELECT result INTO v_previous FROM public.union_accounting_runs
$old1_8$)<>1 THEN RAISE EXCEPTION 'weekly_fee_preparation_anchor_changed';END IF;
 d:=replace(d,$old1_8$      SELECT result INTO v_previous FROM public.union_accounting_runs
$old1_8$,$new1_8$      -- Older club books cannot withhold this week's unpaid earned fees.
      -- A complete canonical player-payment receipt is the prerequisite;
      -- unpaid older fees keep their chronological priority. Leave the old
      -- book/result untouched and return to it after current fees are paid.
      IF v_chunked AND v_end<v_to
       AND EXISTS(SELECT FROM public.accounting_routed_settlement_runs r
        WHERE r.scope_kind='union' AND r.scope_id=v_union.id AND r.period_start=v_from
         AND r.period_end=v_end AND r.round_no=3 AND r.result->>'success'='true'
         AND r.result->>'routing_version'='3' AND r.result->>'source_version'='2'
         AND r.result->'shortfalls'='0'::jsonb)
       AND NOT EXISTS(SELECT FROM public.accounting_routed_settlement_runs r
        WHERE r.scope_kind='union' AND r.scope_id=v_union.id AND r.period_end=v_to
         AND r.period_start=public.fn_union_prev_week_start(v_now) AND r.round_no=3
         AND r.result->>'success'='true' AND r.result->>'routing_version'='3'
         AND r.result->>'source_version'='2' AND r.result->'shortfalls'='0'::jsonb) THEN
        v_from:=v_end;CONTINUE;
      END IF;
      SELECT result INTO v_previous FROM public.union_accounting_runs
$new1_8$);
 IF (length(d)-length(replace(d,$old1_9$        SELECT result INTO v_previous FROM public.union_accounting_runs q
$old1_9$,'')))/length($old1_9$        SELECT result INTO v_previous FROM public.union_accounting_runs q
$old1_9$)<>1 THEN RAISE EXCEPTION 'weekly_fee_preparation_anchor_changed';END IF;
 d:=replace(d,$old1_9$        SELECT result INTO v_previous FROM public.union_accounting_runs q
$old1_9$,$new1_9$        -- A paid older standalone book also yields to current unpaid fees.
        IF v_chunked AND v_end<v_to
         AND EXISTS(SELECT FROM public.accounting_routed_settlement_runs r
          WHERE r.scope_kind='club' AND r.scope_id=v_club.id AND r.period_start=v_from
           AND r.period_end=v_end AND r.round_no=3 AND r.result->>'success'='true'
           AND r.result->>'routing_version'='3' AND r.result->>'source_version'='2'
           AND r.result->'shortfalls'='0'::jsonb)
         AND NOT EXISTS(SELECT FROM public.accounting_routed_settlement_runs r
          WHERE r.scope_kind='club' AND r.scope_id=v_club.id AND r.period_end=v_to
           AND r.period_start=public.fn_union_prev_week_start(v_now) AND r.round_no=3
           AND r.result->>'success'='true' AND r.result->>'routing_version'='3'
           AND r.result->>'source_version'='2' AND r.result->'shortfalls'='0'::jsonb) THEN
          v_from:=v_end;CONTINUE;
        END IF;
        SELECT result INTO v_previous FROM public.union_accounting_runs q
$new1_9$);
 EXECUTE d;
 IF md5(pg_get_functiondef('public.fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure))<>'aa771409420704b6dd05cfaef9d2f8dc' THEN RAISE EXCEPTION 'weekly_fee_preparation_postimage_changed';END IF;
 d:=pg_get_functiondef('public.fn_weekly_close_first_visits_pending()'::regprocedure);
 IF md5(d)<>'eb386885eb1a705358951fd94dbeca73' THEN RAISE EXCEPTION 'weekly_fee_preparation_owner_changed: public.fn_weekly_close_first_visits_pending()';END IF;
 IF (length(d)-length(replace(d,$old2_0$clock_timestamp() >= d.due AND clock_timestamp() < d.due$old2_0$,'')))/length($old2_0$clock_timestamp() >= d.due AND clock_timestamp() < d.due$old2_0$)<>1 THEN RAISE EXCEPTION 'weekly_fee_preparation_anchor_changed';END IF;
 d:=replace(d,$old2_0$clock_timestamp() >= d.due AND clock_timestamp() < d.due$old2_0$,$new2_0$clock_timestamp() >= d.wk AND clock_timestamp() < d.due$new2_0$);
 EXECUTE d;
 IF md5(pg_get_functiondef('public.fn_weekly_close_first_visits_pending()'::regprocedure))<>'7185f43f5cb8dc23606ef5e486da9c5d' THEN RAISE EXCEPTION 'weekly_fee_preparation_postimage_changed';END IF;
END $wire_fees$;
COMMIT;
