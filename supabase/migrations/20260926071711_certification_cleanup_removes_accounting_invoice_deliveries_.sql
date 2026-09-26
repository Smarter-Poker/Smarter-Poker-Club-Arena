-- 20260926071711_certification_cleanup_removes_accounting_invoice_deliveries_.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Every post-deploy certificate since 2026-09-26 05:34 UTC has failed at
-- "Provision an isolated production E2E account": production-e2e-account.mjs
-- first removes the previous run's reserved identity through
-- cleanup_reserved_certification_account, and that call now fails with
--
--   23503 update or delete on table "notifications" violates foreign key
--   constraint "accounting_invoice_deliveries_notification_id_fkey"
--
-- (run 36225276836 at 07:03:08 UTC, and every workflow_run receiver since
-- 05:45). The reserved identity is a member of the E2E club a41434bb, so the
-- club's settlement invoice issued at 05:34 was delivered to it like to any
-- member: one row in accounting_invoice_deliveries (notification_id and
-- recipient_id, NO ACTION, created by 20260914113214) and one in
-- accounting_conversations (recipient_id, NO ACTION). The cleanup order,
-- last revised at 20260906022000, predates both tables, so it reaches the
-- notifications delete and stops. Two reserved identities from 05:15 and
-- 05:45 are stuck behind it and every later certificate trips over them.
--
-- This keeps 20260906022000's complete order and archive and removes, for
-- this identity only, its delivery records and its conversation mappings
-- before its notifications. The social conversation is audience-immutable
-- (fn_accounting_conversation_audience_guard refuses its deletion) and is
-- left in place; the mapping row and the delivery record are what reference
-- the profile. Verified in a rolled-back transaction against identity
-- 4d0459e6 (the 05:15 account): deliveries 1, mappings 1, then the cleanup
-- returned success with 2 audit rows archived.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

SET LOCAL lock_timeout = '4s';

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
$function$;

REVOKE ALL ON FUNCTION public.cleanup_reserved_certification_account(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_reserved_certification_account(uuid) TO service_role;

COMMENT ON FUNCTION public.cleanup_reserved_certification_account(uuid) IS
  'Removes only locked ca-customization-cert-* identities after preserving '
  'their complete audit rows in the immutable test-account audit archive.';

COMMIT;
