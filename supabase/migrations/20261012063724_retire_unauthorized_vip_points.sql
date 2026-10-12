-- Owner direction 2026-10-12: no reward points outside leaderboards.
-- Retire VIP earning/redemption at database boundaries; retain immutable history.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';
DO $predecessors$
BEGIN
  IF md5(pg_get_functiondef('public.claim_lucky_wheel_spin(uuid)'::regprocedure)) <> '57dc1fc121d09ee12125f4f3ca872169' THEN
    RAISE EXCEPTION 'VIP retirement predecessor drift: claim_lucky_wheel_spin(uuid)';
  END IF;
  IF md5(pg_get_functiondef('public.fn_award_vip_credit(uuid,numeric,text,uuid,text)'::regprocedure)) <> '29b7217ecae30238871d3a6e676e1bf6' THEN
    RAISE EXCEPTION 'VIP retirement predecessor drift: fn_award_vip_credit(uuid,numeric,text,uuid,text)';
  END IF;
  IF md5(pg_get_functiondef('public.fn_award_vip_points_from_rake()'::regprocedure)) <> '24028ae5df74069cadea2df80124569a' THEN
    RAISE EXCEPTION 'VIP retirement predecessor drift: fn_award_vip_points_from_rake()';
  END IF;
  IF md5(pg_get_functiondef('public.fn_redeem_vip_points(bigint,text,text)'::regprocedure)) <> 'da2a56ffd575319e17a7be1a23800b4c' THEN
    RAISE EXCEPTION 'VIP retirement predecessor drift: fn_redeem_vip_points(bigint,text,text)';
  END IF;
  IF md5(pg_get_functiondef('public.fn_vip_points_move_only_with_a_leg()'::regprocedure)) <> '55226b3b81d58170f83ec254fb5b663f' THEN
    RAISE EXCEPTION 'VIP retirement predecessor drift: fn_vip_points_move_only_with_a_leg()';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.oid IN (
      'public.fn_award_vip_credit(uuid,numeric,text,uuid,text)'::regprocedure,
      'public.fn_award_vip_points_from_rake()'::regprocedure,
      'public.fn_redeem_vip_points(bigint,text,text)'::regprocedure,
      'public.fn_vip_points_move_only_with_a_leg()'::regprocedure,
      'public.claim_lucky_wheel_spin(uuid)'::regprocedure
    ) AND (
      pg_get_userbyid(p.proowner) <> 'postgres'
      OR p.proacl::text IS DISTINCT FROM CASE
        WHEN p.proname = 'fn_redeem_vip_points' THEN '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'
        ELSE '{postgres=X/postgres,service_role=X/postgres}' END
    )
  ) THEN RAISE EXCEPTION 'VIP retirement owner/ACL predecessor drift'; END IF;
END;
$predecessors$;

CREATE OR REPLACE FUNCTION public.fn_award_vip_credit(p_user_id uuid, p_credit numeric, p_source_type text, p_source_id uuid, p_reason text)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
BEGIN
  IF NOT public.fn_caller_is_engine() THEN
    RAISE EXCEPTION 'fn_award_vip_credit is a server-side path' USING ERRCODE = '42501';
  END IF;
  -- Existing rake and tournament settlement callers must continue successfully.
  -- No balances, carry or journal legs are produced by this retired currency.
  RETURN 0;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_award_vip_points_from_rake()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
BEGIN
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_redeem_vip_points(p_cost bigint, p_reason text DEFAULT 'Reward redemption'::text, p_reward_id text DEFAULT NULL::text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
BEGIN
  RETURN jsonb_build_object('success', false, 'error', 'vip_points_retired');
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_vip_points_move_only_with_a_leg()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF COALESCE(NEW.current_points, 0) <> 0 OR COALESCE(NEW.lifetime_points, 0) <> 0 THEN
      RAISE EXCEPTION 'VIP points are retired' USING ERRCODE = 'P0403';
    END IF;
  ELSIF NEW.current_points IS DISTINCT FROM OLD.current_points
     OR NEW.lifetime_points IS DISTINCT FROM OLD.lifetime_points THEN
    RAISE EXCEPTION 'VIP points are retired' USING ERRCODE = 'P0403';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_guard_retired_vip_points_write()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public', 'pg_temp' AS $function$
BEGIN
  RAISE EXCEPTION 'VIP points are retired; historical records are read only' USING ERRCODE = 'P0403';
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_guard_retired_vip_points_write() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER zz_retired_vip_points_ledger BEFORE INSERT ON public.vip_points_ledger
FOR EACH ROW EXECUTE FUNCTION public.fn_guard_retired_vip_points_write();
CREATE TRIGGER zz_retired_vip_points_carry BEFORE INSERT OR UPDATE ON public.vip_points_carry
FOR EACH ROW EXECUTE FUNCTION public.fn_guard_retired_vip_points_write();
CREATE TRIGGER zz_retired_vip_reward_claims BEFORE INSERT ON public.vip_reward_claims
FOR EACH ROW EXECUTE FUNCTION public.fn_guard_retired_vip_points_write();

UPDATE public.vip_reward_catalog SET is_active = false WHERE is_active;
CREATE TRIGGER zz_retired_vip_reward_catalog BEFORE INSERT OR UPDATE ON public.vip_reward_catalog
FOR EACH ROW EXECUTE FUNCTION public.fn_guard_retired_vip_points_write();
UPDATE public.lucky_wheel_segments SET active = false WHERE active AND reward_type = 'vip_points';

CREATE OR REPLACE FUNCTION public.claim_lucky_wheel_spin(p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid    uuid;
  v_today  date := (now() AT TIME ZONE 'UTC')::date;
  v_last   date;
  v_pick   record;
  v_roll   numeric;
  v_acc    numeric := 0;
BEGIN
  IF COALESCE(auth.role(), '') = 'service_role' THEN
    v_uid := p_user_id;
  ELSE
    v_uid := auth.uid();
    IF v_uid IS NULL THEN
      RAISE EXCEPTION 'claim_lucky_wheel_spin requires an authenticated caller' USING ERRCODE = '28000';
    END IF;
    IF p_user_id IS NOT NULL AND p_user_id <> v_uid THEN
      RAISE EXCEPTION 'Cannot spin the wheel for another user';
    END IF;
  END IF;

  INSERT INTO public.user_lucky_wheel_spins (user_id, total_spins, updated_at)
  VALUES (v_uid, 0, now())
  ON CONFLICT (user_id) DO NOTHING;

  SELECT (last_spin_date AT TIME ZONE 'UTC')::date INTO v_last
    FROM public.user_lucky_wheel_spins WHERE user_id = v_uid FOR UPDATE;

  IF v_last IS NOT NULL AND v_last >= v_today THEN
    RAISE EXCEPTION 'Already spun today';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.lucky_wheel_segments WHERE active AND reward_type <> 'vip_points') THEN
    RAISE EXCEPTION 'No eligible wheel rewards configured';
  END IF;
  v_roll := random() * (SELECT sum(weight) FROM public.lucky_wheel_segments WHERE active AND reward_type <> 'vip_points');
  FOR v_pick IN SELECT * FROM public.lucky_wheel_segments WHERE active AND reward_type <> 'vip_points' ORDER BY id LOOP
    v_acc := v_acc + v_pick.weight;
    EXIT WHEN v_roll <= v_acc;
  END LOOP;

  UPDATE public.user_lucky_wheel_spins
     SET total_spins = total_spins + 1, last_spin_date = now(), updated_at = now()
   WHERE user_id = v_uid;

  IF v_pick.reward_type = 'chips' THEN
    IF NOT public.atomic_credit_wallet_and_log(
         v_uid, v_pick.amount, 'bonus',
         'Lucky wheel: ' || v_pick.id,
         NULL, NULL, NULL,
         'lucky_wheel:' || v_uid::text || ':' || v_today::text) THEN
      RAISE EXCEPTION 'lucky wheel credit failed';
    END IF;
  ELSIF v_pick.reward_type = 'diamonds' THEN
    PERFORM public.add_diamonds_to_balance(
      v_uid, v_pick.amount::integer, 'bonus', 'Lucky wheel: ' || v_pick.id,
      'lucky_wheel:' || v_uid::text || ':' || v_today::text);
  END IF;

  RETURN jsonb_build_object(
    'segmentId', v_pick.id, 'rewardType', v_pick.reward_type, 'amount', v_pick.amount);
END;
$function$;

-- Explicit source ACLs match the inspected production privileges.
REVOKE ALL ON FUNCTION public.fn_award_vip_credit(uuid,numeric,text,uuid,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_award_vip_credit(uuid,numeric,text,uuid,text) TO service_role;
REVOKE ALL ON FUNCTION public.fn_redeem_vip_points(bigint,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_redeem_vip_points(bigint,text,text) TO authenticated, service_role;
-- Existing function owners and ACLs remain unchanged by CREATE OR REPLACE.
COMMIT;

