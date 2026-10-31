-- Old unresolved BBJ receipts must not hide verified current-period results.
-- NULL means this window is incomplete, never zero. No old receipt is assigned,
-- excluded, credited or edited. New payouts retain their atomic owner + event.
-- Explicit client capability keeps older tabs from displaying NULL as zero.
-- @live-proof: position('club-arena-member-results/2' IN pg_get_functiondef('public.ca_club_member_jackpot_money(uuid,uuid,timestamptz,timestamptz,text)'::regprocedure))>0
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='15s';
DO $guard$ BEGIN
 IF md5(pg_get_functiondef('public.ca_club_member_jackpot_money(uuid,uuid,timestamptz,timestamptz,text)'::regprocedure))<>'d498e753999a906eee091906f6b297b6'
 THEN RAISE EXCEPTION 'Jackpot reporting preimage changed'; END IF;
END $guard$;
CREATE OR REPLACE FUNCTION public.ca_club_member_jackpot_money(
 p_club_id uuid,p_user_id uuid,p_from timestamptz,p_to timestamptz,p_variant text DEFAULT NULL
) RETURNS numeric LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $jackpot$
DECLARE v_amount numeric; v_unknown bigint;
BEGIN
 SELECT coalesce(sum(r.amount) FILTER(WHERE r.club_id=p_club_id),0),count(*) FILTER(WHERE r.club_id IS NULL)
 INTO v_amount,v_unknown FROM public.ca_paid_jackpot_reporting r
 WHERE r.user_id=p_user_id AND r.amount>0 AND NOT r.display_only
   AND (r.club_id=p_club_id OR r.club_id IS NULL)
   AND (p_from IS NULL OR r.created_at>=p_from) AND (p_to IS NULL OR r.created_at<p_to)
   AND public.fn_ca_launch_accounting_accepts(p_club_id,r.created_at)
   AND (p_variant IS NULL OR p_variant='all' OR r.game_variant=p_variant);
 IF v_unknown>0 THEN
  -- Only clients that render explicit partial totals may receive NULL. Older
  -- open tabs retain the visible error rather than coercing unknown to zero.
  IF coalesce(nullif(current_setting('request.headers',true),''),'{}')::jsonb
      ->>'x-client-info'='club-arena-member-results/2' THEN RETURN NULL; END IF;
  RAISE EXCEPTION 'Paid jackpot ownership evidence is unavailable' USING ERRCODE='55000';
 END IF;
 RETURN v_amount;
END $jackpot$;
REVOKE ALL ON FUNCTION public.ca_club_member_jackpot_money(uuid,uuid,timestamptz,timestamptz,text) FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
