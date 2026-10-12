-- Reserved post-deploy Create Club verification left five immutable ledger
-- rows after its owned club retired. The protected membership gate refused
-- that historical actor before the existing Auth-soft-retirement branch.
-- Remove only the performed_by refusal; retain from/to custody and rake
-- refusals, exact namespace/profile checks, protected club guard and triggers.
-- Qualify every held/locked/credit balance and agent link under ordered locks.
-- Ledger bytes, retirement predicate, Auth credentials and production rows are
-- untouched by this installation. The supported Auth API owns retirement.
-- @live-proof: (SELECT md5(pg_get_functiondef('public.cleanup_reserved_certification_account(uuid)'::regprocedure)) = '07419c2062fbff02d3ee7d3c24cd8ea9')
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
  IF md5(v_old) IS DISTINCT FROM 'f99b95d79a0e9bf05715ed5279e705ac' THEN
    RAISE EXCEPTION 'CERTIFICATION_PROTECTED_LEDGER_PREIMAGE_CHANGED' USING ERRCODE='55000';
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
  v_new := replace(v_old, $old$BEGIN
  SELECT email INTO v_email$old$, $new$BEGIN
  -- Join and cleanup share the membership lane before taking identity rows.
  PERFORM public.fn_club_membership_lock(p_user_id);
  SELECT email INTO v_email$new$);
  v_new := replace(v_new, $old$      PERFORM 1 FROM public.club_members WHERE user_id = p_user_id FOR UPDATE;
      PERFORM 1 FROM public.wallets WHERE user_id = p_user_id FOR UPDATE;$old$, $new$      PERFORM 1 FROM public.wallets WHERE user_id = p_user_id ORDER BY id FOR UPDATE;
      PERFORM 1 FROM public.club_members WHERE user_id = p_user_id ORDER BY club_id FOR UPDATE;$new$);
  v_new := replace(v_new, $old$                      AND (chip_balance IS DISTINCT FROM 0 OR promo_balance IS DISTINCT FROM 0
                        OR NOT ($old$, $new$                      AND (chip_balance IS DISTINCT FROM 0 OR promo_balance IS DISTINCT FROM 0
                        OR held_chips IS DISTINCT FROM 0 OR locked_chips IS DISTINCT FROM 0
                        OR credit_used IS DISTINCT FROM 0 OR credit_limit IS DISTINCT FROM 0
                        OR agent_id IS NOT NULL OR parent_agent_id IS NOT NULL
                        OR NOT ($new$);
  v_new := replace(v_new, $old$         OR EXISTS (SELECT 1 FROM public.chip_ledger WHERE performed_by = p_user_id)
$old$, $new$         -- Historical actors reach the immutable-ledger Auth retirement branch below.
$new$);
  IF md5(v_new) IS DISTINCT FROM '07419c2062fbff02d3ee7d3c24cd8ea9' THEN
    RAISE EXCEPTION 'CERTIFICATION_PROTECTED_LEDGER_POSTIMAGE_CHANGED' USING ERRCODE='55000';
  END IF;
  EXECUTE v_new;
  IF md5(pg_get_functiondef(v_target)) IS DISTINCT FROM '07419c2062fbff02d3ee7d3c24cd8ea9'
     OR md5(pg_get_functiondef(v_guard)) IS DISTINCT FROM '213a7fa40330c703cb23dc001a99d31e'
     OR (SELECT jsonb_agg(jsonb_build_object('oid',oid,'owner',proowner,'acl',proacl,'config',proconfig) ORDER BY oid)
           FROM pg_proc WHERE oid IN(v_target,v_guard)) IS DISTINCT FROM v_catalog
     OR (SELECT jsonb_agg(to_jsonb(t) ORDER BY oid) FROM pg_trigger t WHERE tgfoid=v_guard) IS DISTINCT FROM v_triggers THEN
    RAISE EXCEPTION 'CERTIFICATION_PROTECTED_LEDGER_READBACK_CHANGED' USING ERRCODE='55000';
  END IF;
END $patch$;
COMMIT;
