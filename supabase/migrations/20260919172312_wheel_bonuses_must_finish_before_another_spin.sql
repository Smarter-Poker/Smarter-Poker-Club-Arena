-- Won bonuses are immediate play obligations, never a collection of saved spins.
-- Keep durable receipts for disconnect recovery and idempotency. Do not expire prizes.
BEGIN;
SET LOCAL lock_timeout='2s';
CREATE FUNCTION public.fn_wheel_bonus_unfinished(a public.wheel_bonus_awards)
RETURNS boolean LANGUAGE sql STABLE SET search_path=public AS $$
 SELECT a.status IN('pending','starting') OR (a.status='redeemed' AND
   CASE WHEN a.game='crash' THEN EXISTS(SELECT 1 FROM public.crash_rounds r WHERE r.commit_id=a.commit_id AND r.status='open')
   WHEN a.game IN('crossing','mines') THEN EXISTS(SELECT 1 FROM public.diamond_choice_rounds r WHERE r.commit_id=a.commit_id AND r.status='open')
   ELSE false END);
$$;
REVOKE ALL ON FUNCTION public.fn_wheel_bonus_unfinished(public.wheel_bonus_awards) FROM PUBLIC,anon,authenticated;
DO $$
DECLARE original text; needle text;
BEGIN
 SELECT pg_get_functiondef('public.fn_wheel_spin_v2(uuid,uuid,text,integer,text,uuid)'::regprocedure) INTO original;
 IF md5(original)<>'3bc67285782569d384a43fb4637b802c' THEN RAISE EXCEPTION 'Wheel admission preimage changed'; END IF;
 needle:=$old$  IF NOT public.fn_wheel_v2_enabled() THEN RETURN jsonb_build_object('ok',false,'error','The New Wheel Is Not Open Yet'); END IF;$old$;
 IF strpos(original,needle)=0 THEN RAISE EXCEPTION 'Wheel admission insertion point missing'; END IF;
 EXECUTE replace(original,needle,needle||$new$
  -- Receipt replay above remains possible. Serialize new entries across tabs.
  PERFORM pg_advisory_xact_lock(hashtextextended(v_user::text||':'||p_club_id::text,94614));
  IF EXISTS(SELECT 1 FROM public.wheel_bonus_awards unfinished_award WHERE unfinished_award.user_id=v_user AND unfinished_award.club_id=p_club_id AND public.fn_wheel_bonus_unfinished(unfinished_award)) THEN
    RETURN jsonb_build_object('ok',false,'error','Finish Your Bonus Game Before Another Spin');
  END IF;
$new$);
 SELECT pg_get_functiondef('public.fn_wheel_state_v2(uuid,integer)'::regprocedure) INTO original;
 IF md5(original)<>'79e6a22b514aba548eba012333a9b26c' THEN RAISE EXCEPTION 'Wheel state preimage changed'; END IF;
 needle:=$old$a.user_id=auth.uid() AND a.club_id=p_club_id AND a.status='pending'$old$;
 IF strpos(original,needle)=0 THEN RAISE EXCEPTION 'Wheel recovery selection missing'; END IF;
 EXECUTE replace(original,needle,$new$a.user_id=auth.uid() AND a.club_id=p_club_id AND public.fn_wheel_bonus_unfinished(a)$new$);
END $$;
COMMIT;
