CREATE OR REPLACE FUNCTION public.fn_midway_weekly_horse_promo(p_from timestamp with time zone, p_to timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
 v_midway constant uuid := 'fade0000-0000-0000-0000-000000000001';
 v_open numeric; v_budget numeric; v_cents bigint; v_n integer; v_i integer:=0;
 v_each bigint; v_extra bigint; v_amount numeric; v_paid numeric:=0; v_paid_n integer:=0;
 v_run uuid; v_op uuid; v_wallets jsonb; v_wallet jsonb; v_result jsonb; v_prior jsonb;
 v_saved jsonb; v_key text; v_note text;
 v_users uuid[]; v_user uuid; v_covered boolean;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'midway_promo_service_required' USING ERRCODE='42501'; END IF;
 IF p_from IS NULL OR p_to IS NULL
    OR p_from IS DISTINCT FROM public.fn_union_week_start(p_from)
    OR p_to IS DISTINCT FROM public.fn_union_week_start(p_from+interval '8 days')
    OR clock_timestamp()<public.fn_union_accounting_run_at(p_to)
    OR p_to<'2026-10-19 07:00:00+00'::timestamptz THEN
  RAISE EXCEPTION 'midway_promo_invalid_completed_week' USING ERRCODE='23514';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('midway-weekly-promo:'||extract(epoch FROM p_to)::text,0));
 SELECT result INTO v_prior FROM public.union_weekly_horse_promo_runs
  WHERE union_id=v_midway AND period_start=p_from AND period_end=p_to;
 IF FOUND THEN
  RETURN v_prior||jsonb_build_object('replayed',true);
 END IF;
 IF public.fn_platform_frozen() THEN RAISE EXCEPTION 'midway_promo_platform_frozen'; END IF;
 -- Take the existing stats-user gates before the bank and row locks.
 -- This is only a candidate keyset; the fresh post-bank cohort must be covered.
 SELECT COALESCE(array_agg(k.user_id ORDER BY k.user_id),ARRAY[]::uuid[]) INTO v_users
 FROM (
  SELECT DISTINCT m.user_id
   FROM public.club_members m JOIN public.profiles p ON p.id=m.user_id
   JOIN public.clubs c ON c.id=m.club_id
   WHERE c.union_id=v_midway
    AND ((c.id=v_midway AND c.is_union IS TRUE) OR EXISTS(
      SELECT 1 FROM public.union_clubs uc WHERE uc.club_id=c.id AND uc.union_id=v_midway))
    AND p.is_horse IS TRUE
    AND p.horse_status IS DISTINCT FROM 'disabled'
    AND m.is_active IS TRUE AND m.status IN('active','approved')
    AND m.membership_lifecycle_status='active' AND m.chip_balance<10000
 ) k;
 FOREACH v_user IN ARRAY v_users LOOP
  PERFORM pg_advisory_xact_lock(hashtextextended('player-stats-user:'||v_user::text,0));
 END LOOP;
 SELECT promo_wallet INTO v_open FROM public.union_wallets WHERE union_id=v_midway FOR UPDATE;
 IF v_open IS NULL OR v_open<0 THEN RAISE EXCEPTION 'midway_promo_wallet_invalid'; END IF;
 v_budget:=trunc(v_open/2,2); v_cents:=(v_budget*100)::bigint;
 -- Lock and snapshot each eligible CLUB wallet before calculating shares.
 -- No union-wide balance aggregate and no duplicate membership expansion.
 -- Coverage and every row lock use the same fresh statement snapshot.
 -- An expanded cohort takes no club/member/profile row locks and is retried
 -- only by the existing business caller's serialization handling.
 WITH eligible AS MATERIALIZED (
  SELECT m.club_id,m.user_id,m.chip_balance AS opening_balance
   FROM public.club_members m JOIN public.profiles p ON p.id=m.user_id
   JOIN public.clubs c ON c.id=m.club_id
   WHERE c.union_id=v_midway
    AND ((c.id=v_midway AND c.is_union IS TRUE) OR EXISTS(
      SELECT 1 FROM public.union_clubs uc WHERE uc.club_id=c.id AND uc.union_id=v_midway))
    AND p.is_horse IS TRUE
    AND p.horse_status IS DISTINCT FROM 'disabled'
    AND m.is_active IS TRUE AND m.status IN('active','approved')
    AND m.membership_lifecycle_status='active' AND m.chip_balance<10000
 ), coverage AS MATERIALIZED (
  SELECT COALESCE(bool_and(e.user_id=ANY(v_users)),true) AS covered FROM eligible e
 ), eligible_club_locks AS MATERIALIZED (
  SELECT c.id FROM public.clubs c
  JOIN (SELECT DISTINCT club_id FROM eligible) e ON e.club_id=c.id
  CROSS JOIN coverage k WHERE k.covered
  ORDER BY c.id FOR SHARE OF c
 ), club_barrier AS MATERIALIZED (
  SELECT k.covered,(SELECT count(*) FROM eligible_club_locks) AS locked_clubs FROM coverage k
 ), locked_wallets AS MATERIALIZED (
  SELECT m.club_id,m.user_id,m.chip_balance AS opening_balance
   FROM club_barrier b CROSS JOIN public.club_members m JOIN public.profiles p ON p.id=m.user_id
   JOIN public.clubs c ON c.id=m.club_id
   WHERE b.covered AND b.locked_clubs>=0
    AND EXISTS(SELECT 1 FROM eligible e WHERE e.club_id=m.club_id AND e.user_id=m.user_id)
    AND c.union_id=v_midway
    AND ((c.id=v_midway AND c.is_union IS TRUE) OR EXISTS(
      SELECT 1 FROM public.union_clubs uc WHERE uc.club_id=c.id AND uc.union_id=v_midway))
    AND p.is_horse IS TRUE
    AND p.horse_status IS DISTINCT FROM 'disabled'
    AND m.is_active IS TRUE AND m.status IN('active','approved')
    AND m.membership_lifecycle_status='active' AND m.chip_balance<10000
   ORDER BY m.user_id,m.club_id FOR UPDATE OF m FOR SHARE OF p,c
 )
 SELECT k.covered,COALESCE((SELECT jsonb_agg(to_jsonb(w) ORDER BY w.club_id,w.user_id)
  FROM locked_wallets w),'[]'::jsonb) INTO v_covered,v_wallets FROM coverage k;
 IF NOT v_covered THEN
  RAISE EXCEPTION 'midway_promo_eligible_cohort_changed' USING ERRCODE='40001';
 END IF;
 v_n:=jsonb_array_length(v_wallets); v_run:=gen_random_uuid();
 v_note:='Midway Weekly Promo Distribution: '||to_char(p_from AT TIME ZONE 'America/Los_Angeles','YYYY-MM-DD');
 INSERT INTO public.union_weekly_horse_promo_runs(id,union_id,period_start,period_end,opening_promo,budget,paid,eligible_wallets,paid_wallets,result)
 VALUES(v_run,v_midway,p_from,p_to,v_open,v_budget,0,v_n,0,'{}');
 -- Save/restore the caller's transaction-local ledger declaration.
 SELECT jsonb_object_agg(k,COALESCE(current_setting(k,true),'')) INTO v_saved FROM unnest(ARRAY[
  'app.ledger_category','app.ledger_counterparty','app.ledger_counterparty_entity',
  'app.ledger_settlement','app.ledger_idempotency_key','app.ledger_counterparty_label',
  'app.ledger_correlation','app.ledger_autoskip_union_wallets','app.ledger_autoskip_clubs'])k;
 -- A promo run owns its settlement identity, not the preceding rakeback round.
 PERFORM set_config('app.ledger_settlement',v_run::text,true);
 IF v_n>0 AND v_cents>0 THEN
  v_each:=v_cents/v_n; v_extra:=v_cents%v_n;
  FOR v_wallet IN SELECT value FROM jsonb_array_elements(v_wallets) LOOP
   v_i:=v_i+1; v_amount:=(v_each+CASE WHEN v_i<=v_extra THEN 1 ELSE 0 END)::numeric/100;
   IF v_amount=0 THEN CONTINUE; END IF;
   v_op:=md5('midway-weekly-promo:'||extract(epoch FROM p_to)::text||':'||(v_wallet->>'club_id')||':'||(v_wallet->>'user_id'))::uuid;
   v_result:=public.fn_promo_disburse('union',v_midway,'player',(v_wallet->>'user_id')::uuid,
    v_amount,v_note,(v_wallet->>'club_id')::uuid,v_op);
   IF v_result->>'success' IS DISTINCT FROM 'true' OR v_result->>'replayed'='true' THEN
    RAISE EXCEPTION 'midway_promo_disbursement_not_confirmed' USING DETAIL=v_result::text;
   END IF;
   INSERT INTO public.union_weekly_horse_promo_recipients(run_id,club_id,user_id,opening_balance,amount,balance_after,operation_id,transaction_id)
   VALUES(v_run,(v_wallet->>'club_id')::uuid,(v_wallet->>'user_id')::uuid,(v_wallet->>'opening_balance')::numeric,
    v_amount,(v_result->>'recipient_after')::numeric,v_op,(v_result->>'transaction_id')::uuid);
   v_paid:=v_paid+v_amount; v_paid_n:=v_paid_n+1;
  END LOOP;
 END IF;
 FOR v_key IN SELECT jsonb_object_keys(v_saved) LOOP PERFORM set_config(v_key,v_saved->>v_key,true); END LOOP;
 IF v_paid<>(CASE WHEN v_n>0 THEN v_budget ELSE 0 END)
    OR (SELECT promo_wallet FROM public.union_wallets WHERE union_id=v_midway)<>v_open-v_paid THEN
  RAISE EXCEPTION 'midway_promo_conservation_failed';
 END IF;
 v_result:=jsonb_build_object('success',true,'run_id',v_run,'opening_promo',v_open,'budget',v_budget,
  'paid',v_paid,'eligible_wallets',v_n,'paid_wallets',v_paid_n,'remaining_promo',v_open-v_paid,
  'eligibility','each_club_chip_balance_under_10000','reason',CASE WHEN v_n=0 THEN 'no_eligible_wallets' WHEN v_cents=0 THEN 'no_distributable_chips' ELSE 'paid' END);
 UPDATE public.union_weekly_horse_promo_runs SET paid=v_paid,paid_wallets=v_paid_n,result=v_result WHERE id=v_run;
 RETURN v_result||jsonb_build_object('replayed',false);
END $function$
