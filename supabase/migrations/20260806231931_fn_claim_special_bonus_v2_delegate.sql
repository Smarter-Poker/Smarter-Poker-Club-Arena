-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260806231931 "fn_claim_special_bonus_v2_delegate"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 20b549aea4e258338e25d0ac1e5fae6e of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

CREATE OR REPLACE FUNCTION public.fn_claim_special_bonus(p_bonus_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_uid      uuid := auth.uid();
  v_bonus    public.special_bonuses%ROWTYPE;
  v_amount   numeric;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'fn_claim_special_bonus requires an authenticated caller'
      USING ERRCODE = '28000';
  END IF;

  SELECT * INTO v_bonus
  FROM public.special_bonuses
  WHERE id = p_bonus_id AND user_id = v_uid
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;

  IF v_bonus.claimed THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_claimed');
  END IF;

  IF v_bonus.expires_at IS NOT NULL AND v_bonus.expires_at <= now() THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'expired');
  END IF;

  IF v_bonus.progress < v_bonus.target THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'requirements_not_met');
  END IF;

  v_amount := trunc(v_bonus.reward * 100) / 100;

  IF v_amount IS NULL OR v_amount <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'non_positive_reward');
  END IF;

  UPDATE public.special_bonuses
     SET claimed = true, claimed_at = now()
   WHERE id = p_bonus_id AND user_id = v_uid AND claimed = false;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_claimed');
  END IF;

  IF v_bonus.reward_type = 'chips' THEN
    IF NOT public.atomic_credit_wallet_and_log(
         v_uid,
         v_amount,
         'bonus',
         'Special bonus: ' || COALESCE(NULLIF(v_bonus.name, ''),
                                       NULLIF(v_bonus.title, ''),
                                       'reward'),
         NULL,
         NULL,
         v_bonus.id,
         'bonus:' || v_bonus.id::text
       ) THEN
      RAISE EXCEPTION 'fn_claim_special_bonus: credit failed for bonus %', v_bonus.id
        USING ERRCODE = '25000';
    END IF;

  ELSIF v_bonus.reward_type = 'vip_points' THEN
    PERFORM public.add_vip_points(v_uid, v_amount::integer);

  ELSE
    RAISE EXCEPTION 'fn_claim_special_bonus: unsupported reward_type %', v_bonus.reward_type
      USING ERRCODE = '22023';
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'reward_type', v_bonus.reward_type,
    'amount', v_amount
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_claim_special_bonus(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_claim_special_bonus(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.fn_claim_special_bonus(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_claim_special_bonus(uuid) TO service_role;
