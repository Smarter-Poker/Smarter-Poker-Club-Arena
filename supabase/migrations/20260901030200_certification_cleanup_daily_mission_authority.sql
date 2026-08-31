-- Keep the narrow reserved-fixture cleanup in sync with the new authority
-- receipts. These rows are removed before Auth so certification can prove no
-- outbox, dedupe, or milestone residue remains.

CREATE OR REPLACE FUNCTION public.cleanup_reserved_certification_account(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
SET statement_timeout = '10min'
AS $function$
DECLARE v_email text;
BEGIN
  SELECT email INTO v_email FROM auth.users WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    IF EXISTS (SELECT 1 FROM public.profiles WHERE id = p_user_id)
       OR EXISTS (SELECT 1 FROM public.users WHERE id = p_user_id) THEN
      RAISE EXCEPTION 'cannot verify certification marker for residual identity %', p_user_id
        USING ERRCODE = '42501';
    END IF;
    RETURN jsonb_build_object('success', true, 'already_removed', true);
  END IF;
  IF v_email NOT LIKE 'ca-customization-cert-%@example.invalid' THEN
    RAISE EXCEPTION 'refusing to remove non-certification identity %', p_user_id
      USING ERRCODE = '42501';
  END IF;

  DELETE FROM public.push_outbox WHERE recipient_user_id = p_user_id;
  DELETE FROM public.chip_transactions WHERE from_user_id = p_user_id OR to_user_id = p_user_id;
  DELETE FROM public.daily_mission_operations WHERE user_id = p_user_id;
  DELETE FROM public.daily_challenge_event_outbox WHERE user_id = p_user_id;
  DELETE FROM public.daily_challenge_progress_events WHERE user_id = p_user_id;
  DELETE FROM public.daily_challenge_milestone_claims WHERE user_id = p_user_id;
  DELETE FROM public.daily_challenge_claim_batches WHERE user_id = p_user_id;
  DELETE FROM public.user_daily_challenges WHERE user_id = p_user_id;
  DELETE FROM public.challenge_streak_state WHERE user_id = p_user_id;
  DELETE FROM public.user_notification_preferences WHERE user_id = p_user_id;
  DELETE FROM public.notifications WHERE user_id = p_user_id;
  DELETE FROM public.daily_challenge_dashboard_revisions WHERE user_id = p_user_id;
  DELETE FROM public.wallet_credit_idempotency WHERE user_id = p_user_id;
  DELETE FROM public.wallet_transactions WHERE user_id = p_user_id;
  DELETE FROM public.wallets WHERE user_id = p_user_id;
  DELETE FROM public.customization_operations WHERE user_id = p_user_id;
  DELETE FROM public.user_theme_settings WHERE user_id = p_user_id;
  DELETE FROM public.user_table_studio_preferences WHERE user_id = p_user_id;
  DELETE FROM public.theme_asset_unlocks WHERE user_id = p_user_id;
  DELETE FROM public.avatar_unlocks WHERE user_id = p_user_id;
  DELETE FROM public.feature_purchases WHERE user_id = p_user_id;
  DELETE FROM public.diamond_transactions WHERE user_id = p_user_id;
  DELETE FROM public.diamond_wallets WHERE user_id = p_user_id;
  DELETE FROM public.signup_errors WHERE user_id = p_user_id;
  DELETE FROM public.users WHERE id = p_user_id;
  DELETE FROM auth.users WHERE id = p_user_id;

  IF EXISTS (SELECT 1 FROM auth.users WHERE id = p_user_id)
     OR EXISTS (SELECT 1 FROM public.profiles WHERE id = p_user_id)
     OR EXISTS (SELECT 1 FROM public.users WHERE id = p_user_id) THEN
    RAISE EXCEPTION 'reserved certification identity % was not fully removed', p_user_id;
  END IF;
  RETURN jsonb_build_object(
    'success', true, 'already_removed', false, 'user_id', p_user_id
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.cleanup_reserved_certification_account(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_reserved_certification_account(uuid) TO service_role;
