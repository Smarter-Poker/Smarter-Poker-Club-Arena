-- Reserved certification identities that performed immutable ledger entries
-- must remain as actors. The previous cleanup tried to delete auth.users and
-- correctly failed chip_ledger_performed_by_fkey, blocking every new browser
-- certificate. Retain the actor, profile, welcome diamonds and all history.
-- The owning caller uses Auth admin should_soft_delete, then verifies this
-- narrowly scoped terminal state. No Auth internals or financial rows change
-- here. Existing disposable, non-ledger cleanup remains byte-identical.
-- @live-proof: (to_regprocedure('public.fn_ca_certification_identity_retired(uuid)') IS NOT NULL AND to_regprocedure('public.fn_ca_stale_certification_accounts(timestamp with time zone)') IS NOT NULL AND position('auth_soft_delete_required' in pg_get_functiondef('public.cleanup_reserved_certification_account(uuid)'::regprocedure)) > 0)
BEGIN;
SET LOCAL lock_timeout = '4s';
SET LOCAL statement_timeout = '30s';

DO $preflight$
BEGIN
  IF md5(pg_get_functiondef('public.cleanup_reserved_certification_account(uuid)'::regprocedure))
       <> 'f525ae6f43f60a993524f9e43ecfba71' THEN
    RAISE EXCEPTION 'CERTIFICATION_CLEANUP_PREIMAGE_CHANGED' USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid='public.cleanup_reserved_certification_account(uuid)'::regprocedure
       AND proowner='postgres'::regrole
       AND proacl=ARRAY['postgres=X/postgres','service_role=X/postgres']::aclitem[])
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.chip_ledger'::regclass
       AND conname='chip_ledger_performed_by_fkey' AND contype='f'
       AND confrelid='auth.users'::regclass AND confdeltype='a') THEN
    RAISE EXCEPTION 'CERTIFICATION_ACTOR_AUTHORITY_OR_FK_CHANGED' USING ERRCODE = '55000';
  END IF;
  IF to_regprocedure('public.fn_ca_certification_identity_retired(uuid)') IS NOT NULL
     OR to_regprocedure('public.fn_ca_stale_certification_accounts(timestamp with time zone)') IS NOT NULL THEN
    RAISE EXCEPTION 'CERTIFICATION_RETIREMENT_ALREADY_PRESENT' USING ERRCODE = '55000';
  END IF;
END
$preflight$;

-- A read-only completion predicate, also used by bounded stale inventory.
-- A spoofed profile email never authorizes soft-deleting an active Auth user.
CREATE FUNCTION public.fn_ca_certification_identity_retired(p_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' SET statement_timeout = '8s'
AS $function$
 SELECT EXISTS (
   SELECT 1 FROM auth.users u JOIN public.profiles p ON p.id = u.id
   WHERE u.id = p_user_id AND u.deleted_at IS NOT NULL
     AND COALESCE(u.encrypted_password, '') = ''
     AND (p.email LIKE 'ca-customization-cert-postdeploy-%@example.invalid'
       OR p.email LIKE 'club-create-cert-%@smarter-poker.invalid')
     AND p.role = 'user' AND NOT COALESCE(p.is_admin, false)
     AND NOT COALESCE(p.is_horse, false)
     AND EXISTS (SELECT 1 FROM public.chip_ledger l WHERE l.performed_by = u.id)
     AND NOT EXISTS (SELECT 1 FROM auth.sessions s WHERE s.user_id = u.id)
     AND NOT EXISTS (SELECT 1 FROM auth.refresh_tokens t WHERE t.user_id = u.id::text)
     AND NOT EXISTS (SELECT 1 FROM public.clubs c WHERE c.owner_id = u.id)
     AND NOT EXISTS (SELECT 1 FROM public.unions c WHERE c.owner_id = u.id)
     AND NOT EXISTS (SELECT 1 FROM public.agents a WHERE a.user_id = u.id)
     AND NOT EXISTS (SELECT 1 FROM public.club_members m WHERE m.user_id = u.id)
     AND NOT EXISTS (SELECT 1 FROM public.table_seats s WHERE s.user_id = u.id)
     AND NOT EXISTS (SELECT 1 FROM public.tournament_players t WHERE t.user_id = u.id)
     AND NOT EXISTS (SELECT 1 FROM public.wallets w WHERE w.user_id = u.id
                      AND (COALESCE(w.balance, 0) <> 0 OR COALESCE(w.locked_balance, 0) <> 0))
 )
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_certification_identity_retired(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_certification_identity_retired(uuid) TO service_role;

DO $patch$
DECLARE
 v_old text := pg_get_functiondef('public.cleanup_reserved_certification_account(uuid)'::regprocedure);
 v_new text;
 v_anchor text := $anchor$  IF v_email NOT LIKE 'ca-customization-cert-%@example.invalid'$anchor$;
 v_branch text := $branch$  -- Preserve immutable ledger actors. The Auth API owns credential/session
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
$branch$;
BEGIN
 IF (length(v_old) - length(replace(v_old, v_anchor, ''))) / length(v_anchor) <> 1 THEN
   RAISE EXCEPTION 'CERTIFICATION_CLEANUP_ANCHOR_CHANGED' USING ERRCODE = '55000';
 END IF;
 v_new := replace(v_old, v_anchor, v_branch || v_anchor);
 EXECUTE v_new;
END
$patch$;

-- The existing pre-job recovery remains bounded at 20 plus one refusal row.
-- A retained profile is excluded only when actual Auth/session and custody
-- readback agrees; interrupted/partial outcomes remain visible to its owner.
CREATE FUNCTION public.fn_ca_stale_certification_accounts(p_before timestamptz)
RETURNS TABLE(id uuid, email text, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' SET statement_timeout = '8s'
AS $function$
 SELECT p.id, p.email::text, p.created_at
 FROM public.profiles p
 WHERE p.email LIKE 'ca-customization-cert-postdeploy-%@example.invalid'
   AND p.created_at <= LEAST(p_before, now() - interval '40 minutes')
   AND NOT public.fn_ca_certification_identity_retired(p.id)
 ORDER BY p.created_at, p.id LIMIT 21
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_stale_certification_accounts(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_stale_certification_accounts(timestamptz) TO service_role;
COMMIT;
