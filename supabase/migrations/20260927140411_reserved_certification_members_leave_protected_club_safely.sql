-- A reserved post-deploy account joined Deep Stack Society for real UI
-- verification; its original broad membership cleanup correctly hit the club
-- deletion guard. Qualify one disposable zero-chip membership under row locks
-- and use the guard's existing deliberate-teardown mechanism for that exact
-- DELETE only. Restore the setting immediately. Real players, owned entities,
-- financial history, seats and nonzero/unknown balances remain refused.
-- The original protected-club function/triggers and retained-actor branch stay
-- byte-identical. This installs source only; it deletes no production rows.
-- @live-proof: (SELECT md5(pg_get_functiondef('public.cleanup_reserved_certification_account(uuid)'::regprocedure)) = 'd1bbe4ddac6e7e0721dcc2a06f65c1f4')
BEGIN;
SET LOCAL lock_timeout = '4s';
SET LOCAL statement_timeout = '8s';
DO $patch$
DECLARE
  v_target regprocedure := 'public.cleanup_reserved_certification_account(uuid)'::regprocedure;
  v_guard regprocedure := 'public.fn_deep_stack_society_cannot_be_deleted_by_accident()'::regprocedure;
  v_old text := pg_get_functiondef(v_target);
  v_new text;
  v_catalog jsonb;
  v_triggers jsonb;
BEGIN
  IF md5(v_old) IS DISTINCT FROM 'f29271b8f640a2d2a1f04e6f020e150c' THEN
    RAISE EXCEPTION 'CERTIFICATION_PROTECTED_CLEANUP_PREIMAGE_CHANGED' USING ERRCODE='55000';
  END IF;
  IF md5(pg_get_functiondef(v_guard)) IS DISTINCT FROM '213a7fa40330c703cb23dc001a99d31e'
     OR NOT EXISTS (SELECT FROM pg_trigger WHERE tgname='trg_deep_stack_members_are_protected'
          AND tgrelid='public.club_members'::regclass AND tgfoid=v_guard AND tgenabled='O' AND tgtype=11)
     OR NOT EXISTS (SELECT FROM pg_trigger WHERE tgname='trg_deep_stack_agents_are_protected'
          AND tgrelid='public.agents'::regclass AND tgfoid=v_guard AND tgenabled='O' AND tgtype=11) THEN
    RAISE EXCEPTION 'CERTIFICATION_PROTECTED_CLUB_GUARD_CHANGED' USING ERRCODE='55000';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_proc WHERE oid=v_target AND proowner='postgres'::regrole AND prosecdef)
     OR has_function_privilege('anon',v_target,'EXECUTE')
     OR has_function_privilege('authenticated',v_target,'EXECUTE')
     OR NOT has_function_privilege('service_role',v_target,'EXECUTE') THEN
    RAISE EXCEPTION 'CERTIFICATION_PROTECTED_CLEANUP_AUTHORITY_CHANGED' USING ERRCODE='55000';
  END IF;
  SELECT jsonb_agg(jsonb_build_object('oid',oid,'owner',proowner,'acl',proacl,'config',proconfig) ORDER BY oid)
    INTO v_catalog FROM pg_proc WHERE oid IN(v_target,v_guard);
  SELECT jsonb_agg(to_jsonb(t) ORDER BY oid) INTO v_triggers FROM pg_trigger t WHERE tgfoid=v_guard;
  v_new := replace(v_old, $anchor$  -- Preserve immutable ledger actors. The Auth API owns credential/session$anchor$, $block$  -- The reserved post-deploy account may join the protected standalone club
  -- to verify its real member UI. Keep the club guard intact: qualify and
  -- remove only that identity's zero-chip membership, restoring the original
  -- deliberate-teardown setting before any other cleanup statement executes.
  IF EXISTS (SELECT 1 FROM public.club_members WHERE user_id = p_user_id
               AND club_id = '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid) THEN
    DECLARE
      v_previous_teardown text;
      v_deleted integer;
    BEGIN
      IF public.fn_platform_frozen() THEN
        RETURN jsonb_build_object('success', false, 'reason', 'platform_is_frozen');
      END IF;
      IF v_email IS NULL OR v_email NOT LIKE 'ca-customization-cert-postdeploy-%@example.invalid'
         OR EXISTS (SELECT 1 FROM auth.users WHERE id = p_user_id AND deleted_at IS NOT NULL) THEN
        RAISE EXCEPTION 'CERTIFICATION_PROTECTED_MEMBERSHIP_IDENTITY_REFUSED' USING ERRCODE = '42501';
      END IF;
      PERFORM 1 FROM public.profiles p WHERE p.id = p_user_id
        AND p.email = v_email AND p.role = 'user'
        AND NOT COALESCE(p.is_admin, false) AND NOT COALESCE(p.is_horse, false)
        FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'CERTIFICATION_PROTECTED_MEMBERSHIP_PROFILE_REFUSED' USING ERRCODE = '42501';
      END IF;
      PERFORM 1 FROM public.club_members WHERE user_id = p_user_id FOR UPDATE;
      PERFORM 1 FROM public.wallets WHERE user_id = p_user_id FOR UPDATE;
      IF EXISTS (SELECT 1 FROM public.clubs WHERE owner_id = p_user_id)
         OR EXISTS (SELECT 1 FROM public.unions WHERE owner_id = p_user_id)
         OR EXISTS (SELECT 1 FROM public.agents WHERE user_id = p_user_id)
         OR EXISTS (SELECT 1 FROM public.table_seats WHERE user_id = p_user_id)
         OR EXISTS (SELECT 1 FROM public.tournament_players WHERE user_id = p_user_id)
         OR EXISTS (SELECT 1 FROM public.wallets WHERE user_id = p_user_id
                      AND (balance IS DISTINCT FROM 0 OR locked_balance IS DISTINCT FROM 0))
         OR EXISTS (SELECT 1 FROM public.club_members WHERE user_id = p_user_id
                      AND (chip_balance IS DISTINCT FROM 0 OR promo_balance IS DISTINCT FROM 0
                        OR NOT (
                          (club_id = 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid AND role = 'admin')
                          OR (club_id = '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid AND role IN ('admin','member'))
                        ) IS TRUE))
         OR EXISTS (SELECT 1 FROM public.chip_ledger WHERE performed_by = p_user_id)
         OR EXISTS (SELECT 1 FROM public.chip_ledger WHERE from_entity_id = p_user_id)
         OR EXISTS (SELECT 1 FROM public.chip_ledger WHERE to_entity_id = p_user_id)
         OR EXISTS (SELECT 1 FROM public.accounting_cash_rake_sources WHERE player_id = p_user_id) THEN
        RAISE EXCEPTION 'CERTIFICATION_PROTECTED_MEMBERSHIP_HAS_AUTHORITY_OR_CUSTODY' USING ERRCODE = '55000';
      END IF;
      v_previous_teardown := current_setting('app.deep_stack_teardown', true);
      BEGIN
        PERFORM set_config('app.deep_stack_teardown', 'on', true);
        DELETE FROM public.club_members WHERE user_id = p_user_id
          AND club_id = '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid
          AND role IN ('admin','member') AND chip_balance = 0 AND promo_balance = 0;
        GET DIAGNOSTICS v_deleted = ROW_COUNT;
        PERFORM set_config('app.deep_stack_teardown', COALESCE(v_previous_teardown, ''), true);
        IF v_deleted <> 1 THEN
          RAISE EXCEPTION 'CERTIFICATION_PROTECTED_MEMBERSHIP_CARDINALITY_CHANGED' USING ERRCODE = '55000';
        END IF;
      EXCEPTION WHEN OTHERS THEN
        PERFORM set_config('app.deep_stack_teardown', COALESCE(v_previous_teardown, ''), true);
        RAISE;
      END;
    END;
  END IF;
  -- Preserve immutable ledger actors. The Auth API owns credential/session$block$);
  IF md5(v_new) IS DISTINCT FROM 'd1bbe4ddac6e7e0721dcc2a06f65c1f4' THEN
    RAISE EXCEPTION 'CERTIFICATION_PROTECTED_CLEANUP_d1bbe4ddac6e7e0721dcc2a06f65c1f4_CHANGED' USING ERRCODE='55000';
  END IF;
  EXECUTE v_new;
  IF md5(pg_get_functiondef(v_target)) IS DISTINCT FROM 'd1bbe4ddac6e7e0721dcc2a06f65c1f4'
     OR md5(pg_get_functiondef(v_guard)) IS DISTINCT FROM '213a7fa40330c703cb23dc001a99d31e'
     OR (SELECT jsonb_agg(jsonb_build_object('oid',oid,'owner',proowner,'acl',proacl,'config',proconfig) ORDER BY oid)
           FROM pg_proc WHERE oid IN(v_target,v_guard)) IS DISTINCT FROM v_catalog
     OR (SELECT jsonb_agg(to_jsonb(t) ORDER BY oid) FROM pg_trigger t WHERE tgfoid=v_guard) IS DISTINCT FROM v_triggers THEN
    RAISE EXCEPTION 'CERTIFICATION_PROTECTED_CLEANUP_READBACK_CHANGED' USING ERRCODE='55000';
  END IF;
END $patch$;
COMMIT;
