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
  v_ledger_count integer;
  v_ledger_archived_count integer;
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
  -- Preserve immutable ledger actors. The Auth API owns credential/session
  -- retirement; this transaction only removes the existing zero-chip E2E
  -- staff membership after locked custody and exact-identity checks.
  IF EXISTS (SELECT 1 FROM public.chip_ledger WHERE performed_by = p_user_id) THEN
    IF public.fn_ca_certification_identity_retired(p_user_id) THEN
      RETURN jsonb_build_object('success', true, 'disposition', 'retained_ledger_actor',
                               'user_id', p_user_id);
    END IF;
    IF public.fn_platform_frozen() THEN
      RETURN jsonb_build_object('success', false, 'reason', 'platform_is_frozen');
    END IF;
    IF v_email IS NULL OR NOT (
      v_email LIKE 'ca-customization-cert-postdeploy-%@example.invalid'
      OR v_email LIKE 'club-create-cert-%@smarter-poker.invalid'
    ) OR EXISTS (SELECT 1 FROM auth.users WHERE id = p_user_id AND deleted_at IS NOT NULL) THEN
      RAISE EXCEPTION 'CERTIFICATION_RETIREMENT_IDENTITY_REFUSED' USING ERRCODE = '42501';
    END IF;
    PERFORM 1 FROM public.profiles p WHERE p.id = p_user_id
      AND p.email = v_email AND p.role = 'user'
      AND NOT COALESCE(p.is_admin, false) AND NOT COALESCE(p.is_horse, false)
      FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'CERTIFICATION_RETIREMENT_PROFILE_REFUSED' USING ERRCODE = '42501';
    END IF;
    PERFORM 1 FROM public.club_members WHERE user_id = p_user_id FOR UPDATE;
    IF EXISTS (SELECT 1 FROM public.clubs WHERE owner_id = p_user_id)
       OR EXISTS (SELECT 1 FROM public.unions WHERE owner_id = p_user_id)
       OR EXISTS (SELECT 1 FROM public.agents WHERE user_id = p_user_id)
       OR EXISTS (SELECT 1 FROM public.table_seats WHERE user_id = p_user_id)
       OR EXISTS (SELECT 1 FROM public.tournament_players WHERE user_id = p_user_id)
       OR EXISTS (SELECT 1 FROM public.wallets WHERE user_id = p_user_id
                    AND (COALESCE(balance, 0) <> 0 OR COALESCE(locked_balance, 0) <> 0))
       OR EXISTS (SELECT 1 FROM public.club_members WHERE user_id = p_user_id
                    AND (club_id IS DISTINCT FROM 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid
                      OR role IS DISTINCT FROM 'admin' OR COALESCE(chip_balance, 0) <> 0
                      OR COALESCE(promo_balance, 0) <> 0)) THEN
      RAISE EXCEPTION 'CERTIFICATION_RETIREMENT_HAS_AUTHORITY_OR_CUSTODY' USING ERRCODE = '55000';
    END IF;
    DELETE FROM public.club_members WHERE user_id = p_user_id
      AND club_id = 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid
      AND role = 'admin' AND COALESCE(chip_balance, 0) = 0 AND COALESCE(promo_balance, 0) = 0;
    RETURN jsonb_build_object('success', false, 'reason', 'auth_soft_delete_required',
                             'user_id', p_user_id, 'email', v_email);
  END IF;
  -- Refuse every financial row except the exact Create Club opening
  -- grant contract or one of the two pre-contract certification-only opening
  -- variants. Namespace admission alone is not enough: an unrelated mint or
  -- adjustment must keep its live actor and block account deletion.
  IF EXISTS (
    SELECT 1
      FROM public.chip_ledger l
     WHERE l.performed_by = p_user_id
       AND (
         l.hand_id IS NOT NULL
         OR l.table_id IS NOT NULL
         OR l.tournament_id IS NOT NULL
         OR l.status IS DISTINCT FROM 'posted'
         OR NOT (
           (
             l.category = 'mint'
             AND l.amount = 100000
             AND l.from_type IN ('issuance_reserve', 'system_mint')
             AND l.from_entity_id IS NULL
             AND l.to_type = 'club_treasury'
             AND l.to_entity_id = l.club_id
             AND l.idempotency_key IS NOT NULL
             AND l.idempotency_key ~
                   ('^club-opening-grant:' || l.club_id::text || '(:[0-9]+)?$')
           )
           OR (
             l.category = 'adjustment'
             AND l.amount = 100000
             AND l.idempotency_key IS NULL
             AND l.from_entity_id IS NULL
             AND (
               (
                 l.from_type = 'settlement_suspense'
                 AND l.to_type = 'club_treasury'
                 AND l.to_entity_id = l.club_id
               )
               OR (
                 l.from_type = 'table_stack'
                 AND l.to_type = 'player_wallet'
                 AND l.to_entity_id = p_user_id
               )
             )
           )
         )
         OR EXISTS (
           SELECT 1
             FROM public.accounting_tournament_fee_recognitions r
            WHERE r.bank_journal_id = l.id
         )
       )
  ) THEN
    RAISE EXCEPTION 'Reserved Certification Identity % Has Non-Club-Creation Ledger Evidence',
      p_user_id USING ERRCODE = '55000';
  END IF;

  SELECT count(*) INTO v_ledger_count
    FROM public.chip_ledger WHERE performed_by = p_user_id;

  INSERT INTO public.ca_test_account_ledger_actor_archive
    (ledger_id, actor_id, actor_email, ledger_row)
  SELECT l.id, p_user_id, v_email, to_jsonb(l)
    FROM public.chip_ledger l
   WHERE l.performed_by = p_user_id
  ON CONFLICT (ledger_id) DO NOTHING;

  SELECT count(*) INTO v_ledger_archived_count
    FROM public.ca_test_account_ledger_actor_archive x
    JOIN public.chip_ledger l ON l.id = x.ledger_id
   WHERE x.actor_id = p_user_id
     AND x.actor_email = v_email
     AND x.ledger_row = to_jsonb(l)
     AND l.performed_by = p_user_id;
  IF v_ledger_archived_count <> v_ledger_count THEN
    RAISE EXCEPTION
      'Reserved Certification Ledger Actor Archive Copied % Of % Rows For %',
      v_ledger_archived_count, v_ledger_count, p_user_id;
  END IF;

  PERFORM set_config(
    'app.ledger_maintenance',
    'certification-cleanup:20260927034716:' || p_user_id::text,
    true
  );

  UPDATE public.chip_ledger
     SET performed_by = NULL
   WHERE performed_by = p_user_id;
  IF EXISTS (SELECT 1 FROM public.chip_ledger WHERE performed_by = p_user_id) THEN
    RAISE EXCEPTION 'Reserved Certification Ledger Actor % Was Not Detached', p_user_id;
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
CREATE OR REPLACE FUNCTION public.lock_club_cashier_hierarchy_mutation()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_old_club uuid := case when tg_op in ('UPDATE','DELETE') then old.club_id else null end;
  v_new_club uuid := case when tg_op in ('INSERT','UPDATE') then new.club_id else null end;
begin
  if v_old_club is not null and (v_new_club is null or v_old_club::text <= v_new_club::text) then
    perform pg_advisory_xact_lock(hashtextextended('cashier-hierarchy:'||v_old_club::text,0));
  end if;
  if v_new_club is not null and v_new_club is distinct from v_old_club then
    perform pg_advisory_xact_lock(hashtextextended('cashier-hierarchy:'||v_new_club::text,0));
  end if;
  if v_old_club is not null and v_new_club is not null and v_old_club::text > v_new_club::text then
    perform pg_advisory_xact_lock(hashtextextended('cashier-hierarchy:'||v_old_club::text,0));
  end if;
  return case when tg_op='DELETE' then old else new end;
end
$function$
;
CREATE TRIGGER lock_cashier_hierarchy_insert_delete BEFORE INSERT OR DELETE ON public.club_members FOR EACH ROW EXECUTE FUNCTION lock_club_cashier_hierarchy_mutation();
CREATE TRIGGER lock_cashier_hierarchy_update BEFORE UPDATE OF club_id, agent_id, role, status ON public.club_members FOR EACH ROW EXECUTE FUNCTION lock_club_cashier_hierarchy_mutation();
