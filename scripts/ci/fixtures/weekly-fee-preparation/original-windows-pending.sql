CREATE OR REPLACE FUNCTION public.fn_accounting_close_windows_pending(p_union_id uuid, p_club_id uuid, p_period_start timestamp with time zone, p_period_end timestamp with time zone)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
-- True when this chunked close attempt had window work to do for the book's
-- next unpaid round (it then proved what its time allowed and the attempt ends
-- as a committed step); false when every window was already proved, the round
-- already has its receipt, or outside a chunked close attempt.
DECLARE v_kind text:=CASE WHEN p_union_id IS NOT NULL THEN 'union' ELSE 'club' END; v_scope uuid:=COALESCE(p_union_id,p_club_id);
 n_have bigint; n_expected bigint;
BEGIN
 IF COALESCE(current_setting('app.weekly_accounting_chunked',true),'')<>'on'
  OR NULLIF(current_setting('app.weekly_accounting_scope_deadline',true),'') IS NULL
  OR v_scope IS NULL OR (p_union_id IS NOT NULL AND p_club_id IS NOT NULL) THEN
  RETURN false;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.accounting_routed_settlement_runs r WHERE r.scope_kind=v_kind AND r.scope_id=v_scope
   AND r.period_start=p_period_start AND r.period_end=p_period_end AND r.round_no=2) THEN
 SELECT count(*) INTO n_expected FROM public.fn_accounting_close_windows(p_period_start,p_period_end);
 SELECT count(*) INTO n_have FROM public.fn_accounting_close_windows(p_period_start,p_period_end) w JOIN public.accounting_close_partials p
  ON p.kind='round2_'||v_kind||'_window' AND p.union_id=v_scope AND p.period_start=p_period_start AND p.period_end=p_period_end
  AND p.window_start=w.window_start AND p.window_end=w.window_end
  AND p.computed_at>=p_period_end AND p.computed_at>clock_timestamp()-public.fn_accounting_close_proof_lifetime();
 IF n_have<>n_expected THEN
  PERFORM public.fn_settle_accounting_commission_advance(v_kind,v_scope,p_period_start,p_period_end);
  RETURN true;
 END IF;
 END IF;
 -- ROUND 3 READ ONCE (20261003): a book whose round 3 has no receipt proves its
 -- week's round-3 windows and reads its certificates once
 -- (fn_settle_accounting_rakeback_advance) in attempts of their own.
 IF NOT EXISTS(SELECT 1 FROM public.accounting_routed_settlement_runs r WHERE r.scope_kind=v_kind AND r.scope_id=v_scope
   AND r.period_start=p_period_start AND r.period_end=p_period_end AND r.round_no=3)
  AND public.fn_settle_accounting_rakeback_advance(v_kind,v_scope,p_period_start,p_period_end) THEN
  RETURN true;
 END IF;
 RETURN false;
END $function$
