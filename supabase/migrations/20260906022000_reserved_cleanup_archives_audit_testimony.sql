-- 20260906015012 introduced the current-schema cleanup RPC while this repair
-- was in flight. Keep its complete deletion order, but replace its one direct
-- audit deletion with the immutable archive established at 20260906020000.

BEGIN;

CREATE OR REPLACE FUNCTION public.cleanup_reserved_certification_account(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
SET statement_timeout = '10min'
AS $function$
DECLARE
  v_email text;
  v_audit_count integer;
  v_archived_count integer;
BEGIN
  SELECT email INTO v_email FROM auth.users WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    IF EXISTS (SELECT 1 FROM public.profiles WHERE id = p_user_id)
       OR EXISTS (SELECT 1 FROM public.users WHERE id = p_user_id) THEN
      RAISE EXCEPTION 'Cannot Verify Certification Marker For Residual Identity %', p_user_id
        USING ERRCODE = '42501';
    END IF;
    RETURN jsonb_build_object('success', true, 'already_removed', true);
  END IF;
  IF v_email NOT LIKE 'ca-customization-cert-%@example.invalid' THEN
    RAISE EXCEPTION 'Refusing To Remove Non-Certification Identity %', p_user_id
      USING ERRCODE = '42501';
  END IF;
  IF public.fn_platform_frozen() THEN
    RETURN jsonb_build_object('success', false, 'reason', 'platform_is_frozen');
  END IF;

  PERFORM set_config(
    'app.ledger_maintenance',
    'certification-cleanup:20260906022000:' || p_user_id::text,
    true
  );
  PERFORM set_config('app.game_management_retention', 'on', true);

  DELETE FROM public.user_daily_challenges WHERE user_id = p_user_id;
  DELETE FROM public.challenge_streak_state WHERE user_id = p_user_id;
  DELETE FROM public.club_members WHERE user_id = p_user_id;

  DELETE FROM public.push_outbox WHERE recipient_user_id = p_user_id;
  DELETE FROM public.chip_transactions WHERE from_user_id = p_user_id OR to_user_id = p_user_id;
  DELETE FROM public.daily_mission_operations WHERE user_id = p_user_id;
  DELETE FROM public.daily_challenge_event_outbox WHERE user_id = p_user_id;
  DELETE FROM public.daily_challenge_progress_events WHERE user_id = p_user_id;
  DELETE FROM public.daily_challenge_milestone_claims WHERE user_id = p_user_id;
  DELETE FROM public.daily_challenge_claim_batches WHERE user_id = p_user_id;
  DELETE FROM public.user_notification_preferences WHERE user_id = p_user_id;
  DELETE FROM public.notifications WHERE user_id = p_user_id OR actor_id = p_user_id;
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
  DELETE FROM public.table_waitlist WHERE user_id = p_user_id;
  DELETE FROM public.rate_limits WHERE user_id = p_user_id;

  SELECT count(*) INTO v_audit_count
    FROM public.audit_trail WHERE actor_id = p_user_id;

  INSERT INTO public.ca_test_account_audit_archive
    (audit_id, actor_id, actor_email, audit_row)
  SELECT a.id, p_user_id, v_email, to_jsonb(a)
    FROM public.audit_trail a
   WHERE a.actor_id = p_user_id
  ON CONFLICT (audit_id) DO NOTHING;

  SELECT count(*) INTO v_archived_count
    FROM public.ca_test_account_audit_archive x
   WHERE x.audit_id IN (
     SELECT a.id FROM public.audit_trail a WHERE a.actor_id = p_user_id
   );
  IF v_archived_count <> v_audit_count THEN
    RAISE EXCEPTION
      'Reserved Certification Audit Archive Copied % Of % Rows For %',
      v_archived_count, v_audit_count, p_user_id;
  END IF;

  DELETE FROM public.audit_trail WHERE actor_id = p_user_id;
  DELETE FROM public.users WHERE id = p_user_id;
  DELETE FROM auth.users WHERE id = p_user_id;

  IF EXISTS (SELECT 1 FROM auth.users WHERE id = p_user_id)
     OR EXISTS (SELECT 1 FROM public.profiles WHERE id = p_user_id)
     OR EXISTS (SELECT 1 FROM public.users WHERE id = p_user_id) THEN
    RAISE EXCEPTION 'Reserved Certification Identity % Was Not Fully Removed', p_user_id;
  END IF;
  RETURN jsonb_build_object(
    'success', true,
    'already_removed', false,
    'user_id', p_user_id,
    'audit_rows_archived', v_audit_count
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.cleanup_reserved_certification_account(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_reserved_certification_account(uuid) TO service_role;

COMMENT ON FUNCTION public.cleanup_reserved_certification_account(uuid) IS
  'Removes only locked ca-customization-cert-* identities after preserving '
  'their complete audit rows in the immutable test-account audit archive.';

COMMIT;
