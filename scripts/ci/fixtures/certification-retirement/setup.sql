CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE SCHEMA auth;
CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,created_at timestamptz NOT NULL DEFAULT now()-interval '2 hours',deleted_at timestamptz,encrypted_password text DEFAULT 'isolated-fixture-hash');
CREATE TABLE auth.sessions(id uuid DEFAULT gen_random_uuid(),user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE);
CREATE TABLE auth.refresh_tokens(id bigint GENERATED ALWAYS AS IDENTITY,user_id varchar);
CREATE TABLE public.profiles(id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,email text,created_at timestamptz DEFAULT now()-interval '2 hours',role text DEFAULT 'user',is_admin boolean DEFAULT false,is_horse boolean DEFAULT false,diamond_balance numeric DEFAULT 500);
CREATE TABLE public.users(id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE);
CREATE TABLE public.chip_ledger(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),performed_by uuid REFERENCES auth.users(id),amount numeric);
CREATE INDEX idx_chip_ledger_performed_by ON public.chip_ledger(performed_by);
CREATE TABLE public.clubs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),owner_id uuid REFERENCES public.profiles(id));
CREATE TABLE public.unions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),owner_id uuid REFERENCES public.profiles(id));
CREATE TABLE public.agents(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid REFERENCES public.profiles(id));
CREATE TABLE public.club_members(club_id uuid,user_id uuid REFERENCES public.profiles(id),role text,chip_balance numeric DEFAULT 0,promo_balance numeric DEFAULT 0);
CREATE TABLE public.table_seats(id uuid DEFAULT gen_random_uuid(),user_id uuid REFERENCES public.profiles(id));
CREATE TABLE public.tournament_players(id uuid DEFAULT gen_random_uuid(),user_id uuid REFERENCES public.profiles(id));
CREATE TABLE public.wallets(id uuid DEFAULT gen_random_uuid(),user_id uuid REFERENCES public.profiles(id),balance numeric DEFAULT 0,locked_balance numeric DEFAULT 0);
CREATE TABLE public.diamond_wallets(id uuid DEFAULT gen_random_uuid(),user_id uuid REFERENCES public.profiles(id),balance numeric DEFAULT 500);
CREATE TABLE public.freeze_fixture(active boolean); INSERT INTO public.freeze_fixture VALUES(false);
CREATE FUNCTION public.fn_platform_frozen() RETURNS boolean LANGUAGE sql AS $$SELECT active FROM public.freeze_fixture$$;
CREATE TABLE public.ca_test_account_audit_archive(audit_id uuid PRIMARY KEY,actor_id uuid,actor_email text,audit_row jsonb);
CREATE TABLE public.accounting_conversations(id uuid DEFAULT gen_random_uuid(),user_id uuid,actor_id uuid,recipient_user_id uuid,from_user_id uuid,to_user_id uuid,recipient_id uuid,sender_id uuid,notification_id uuid);
CREATE TABLE public.accounting_invoice_deliveries(id uuid DEFAULT gen_random_uuid(),user_id uuid,actor_id uuid,recipient_user_id uuid,from_user_id uuid,to_user_id uuid,recipient_id uuid,sender_id uuid,notification_id uuid);
CREATE TABLE public.audit_trail(id uuid DEFAULT gen_random_uuid(),user_id uuid,actor_id uuid,recipient_user_id uuid,from_user_id uuid,to_user_id uuid,recipient_id uuid,sender_id uuid,notification_id uuid);
CREATE TABLE public.avatar_unlocks(id uuid DEFAULT gen_random_uuid(),user_id uuid,actor_id uuid,recipient_user_id uuid,from_user_id uuid,to_user_id uuid,recipient_id uuid,sender_id uuid,notification_id uuid);
CREATE TABLE public.challenge_streak_state(id uuid DEFAULT gen_random_uuid(),user_id uuid,actor_id uuid,recipient_user_id uuid,from_user_id uuid,to_user_id uuid,recipient_id uuid,sender_id uuid,notification_id uuid);
CREATE TABLE public.chip_transactions(id uuid DEFAULT gen_random_uuid(),user_id uuid,actor_id uuid,recipient_user_id uuid,from_user_id uuid,to_user_id uuid,recipient_id uuid,sender_id uuid,notification_id uuid);
CREATE TABLE public.customization_operations(id uuid DEFAULT gen_random_uuid(),user_id uuid,actor_id uuid,recipient_user_id uuid,from_user_id uuid,to_user_id uuid,recipient_id uuid,sender_id uuid,notification_id uuid);
CREATE TABLE public.daily_challenge_claim_batches(id uuid DEFAULT gen_random_uuid(),user_id uuid,actor_id uuid,recipient_user_id uuid,from_user_id uuid,to_user_id uuid,recipient_id uuid,sender_id uuid,notification_id uuid);
CREATE TABLE public.daily_challenge_dashboard_revisions(id uuid DEFAULT gen_random_uuid(),user_id uuid,actor_id uuid,recipient_user_id uuid,from_user_id uuid,to_user_id uuid,recipient_id uuid,sender_id uuid,notification_id uuid);
CREATE TABLE public.daily_challenge_event_outbox(id uuid DEFAULT gen_random_uuid(),user_id uuid,actor_id uuid,recipient_user_id uuid,from_user_id uuid,to_user_id uuid,recipient_id uuid,sender_id uuid,notification_id uuid);
CREATE TABLE public.daily_challenge_milestone_claims(id uuid DEFAULT gen_random_uuid(),user_id uuid,actor_id uuid,recipient_user_id uuid,from_user_id uuid,to_user_id uuid,recipient_id uuid,sender_id uuid,notification_id uuid);
CREATE TABLE public.daily_challenge_progress_events(id uuid DEFAULT gen_random_uuid(),user_id uuid,actor_id uuid,recipient_user_id uuid,from_user_id uuid,to_user_id uuid,recipient_id uuid,sender_id uuid,notification_id uuid);
CREATE TABLE public.daily_mission_operations(id uuid DEFAULT gen_random_uuid(),user_id uuid,actor_id uuid,recipient_user_id uuid,from_user_id uuid,to_user_id uuid,recipient_id uuid,sender_id uuid,notification_id uuid);
CREATE TABLE public.diamond_transactions(id uuid DEFAULT gen_random_uuid(),user_id uuid,actor_id uuid,recipient_user_id uuid,from_user_id uuid,to_user_id uuid,recipient_id uuid,sender_id uuid,notification_id uuid);
CREATE TABLE public.feature_purchases(id uuid DEFAULT gen_random_uuid(),user_id uuid,actor_id uuid,recipient_user_id uuid,from_user_id uuid,to_user_id uuid,recipient_id uuid,sender_id uuid,notification_id uuid);
CREATE TABLE public.notifications(id uuid DEFAULT gen_random_uuid(),user_id uuid,actor_id uuid,recipient_user_id uuid,from_user_id uuid,to_user_id uuid,recipient_id uuid,sender_id uuid,notification_id uuid);
CREATE TABLE public.push_outbox(id uuid DEFAULT gen_random_uuid(),user_id uuid,actor_id uuid,recipient_user_id uuid,from_user_id uuid,to_user_id uuid,recipient_id uuid,sender_id uuid,notification_id uuid);
CREATE TABLE public.rate_limits(id uuid DEFAULT gen_random_uuid(),user_id uuid,actor_id uuid,recipient_user_id uuid,from_user_id uuid,to_user_id uuid,recipient_id uuid,sender_id uuid,notification_id uuid);
CREATE TABLE public.signup_errors(id uuid DEFAULT gen_random_uuid(),user_id uuid,actor_id uuid,recipient_user_id uuid,from_user_id uuid,to_user_id uuid,recipient_id uuid,sender_id uuid,notification_id uuid);
CREATE TABLE public.table_waitlist(id uuid DEFAULT gen_random_uuid(),user_id uuid,actor_id uuid,recipient_user_id uuid,from_user_id uuid,to_user_id uuid,recipient_id uuid,sender_id uuid,notification_id uuid);
CREATE TABLE public.theme_asset_unlocks(id uuid DEFAULT gen_random_uuid(),user_id uuid,actor_id uuid,recipient_user_id uuid,from_user_id uuid,to_user_id uuid,recipient_id uuid,sender_id uuid,notification_id uuid);
CREATE TABLE public.user_daily_challenges(id uuid DEFAULT gen_random_uuid(),user_id uuid,actor_id uuid,recipient_user_id uuid,from_user_id uuid,to_user_id uuid,recipient_id uuid,sender_id uuid,notification_id uuid);
CREATE TABLE public.user_notification_preferences(id uuid DEFAULT gen_random_uuid(),user_id uuid,actor_id uuid,recipient_user_id uuid,from_user_id uuid,to_user_id uuid,recipient_id uuid,sender_id uuid,notification_id uuid);
CREATE TABLE public.user_table_studio_preferences(id uuid DEFAULT gen_random_uuid(),user_id uuid,actor_id uuid,recipient_user_id uuid,from_user_id uuid,to_user_id uuid,recipient_id uuid,sender_id uuid,notification_id uuid);
CREATE TABLE public.user_theme_settings(id uuid DEFAULT gen_random_uuid(),user_id uuid,actor_id uuid,recipient_user_id uuid,from_user_id uuid,to_user_id uuid,recipient_id uuid,sender_id uuid,notification_id uuid);
CREATE TABLE public.wallet_credit_idempotency(id uuid DEFAULT gen_random_uuid(),user_id uuid,actor_id uuid,recipient_user_id uuid,from_user_id uuid,to_user_id uuid,recipient_id uuid,sender_id uuid,notification_id uuid);
CREATE TABLE public.wallet_transactions(id uuid DEFAULT gen_random_uuid(),user_id uuid,actor_id uuid,recipient_user_id uuid,from_user_id uuid,to_user_id uuid,recipient_id uuid,sender_id uuid,notification_id uuid);
CREATE OR REPLACE FUNCTION public.cleanup_reserved_certification_account(p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET statement_timeout TO '10min'
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
  IF v_email NOT LIKE 'ca-customization-cert-%@example.invalid'
       AND v_email NOT LIKE 'club-create-cert-%@smarter-poker.invalid' THEN
    RAISE EXCEPTION 'Refusing To Remove Non-Certification Identity %', p_user_id
      USING ERRCODE = '42501';
  END IF;
  IF public.fn_platform_frozen() THEN
    RETURN jsonb_build_object('success', false, 'reason', 'platform_is_frozen');
  END IF;

  PERFORM set_config(
    'app.ledger_maintenance',
    'certification-cleanup:20260926071711:' || p_user_id::text,
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
  -- An invoice delivered to the certification identity (it is a member of
  -- the E2E club, so a club settlement reaches it like any member) is
  -- recorded in accounting_invoice_deliveries, which references the
  -- notification and the recipient profile with NO ACTION, and in
  -- accounting_conversations, which references the recipient profile the
  -- same way. Neither table existed when this order was written, so the
  -- first invoice on 2026-09-26 05:34 UTC made every cleanup fail at the
  -- notifications delete and every post-deploy certificate fail at
  -- provisioning. Remove the delivery record and the conversation mapping
  -- for this identity only; the social conversation itself is audience-
  -- immutable and is left in place.
  DELETE FROM public.accounting_invoice_deliveries
   WHERE recipient_id = p_user_id
      OR notification_id IN (
        SELECT id FROM public.notifications WHERE user_id = p_user_id OR actor_id = p_user_id
      );
  DELETE FROM public.accounting_conversations
   WHERE recipient_id = p_user_id OR sender_id = p_user_id;
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
$function$
;
REVOKE ALL ON FUNCTION public.cleanup_reserved_certification_account(uuid) FROM PUBLIC; GRANT EXECUTE ON FUNCTION public.cleanup_reserved_certification_account(uuid) TO service_role;
