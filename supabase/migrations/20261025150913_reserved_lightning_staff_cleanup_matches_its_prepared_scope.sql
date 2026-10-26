-- The reserved Lightning operator fixture joins the union's owning house club
-- as zero-balance admin. Its cleanup must recognize the exact scope prepared
-- by prepareProductionE2ELightningMembership. Preserve all real memberships,
-- custody, protected-club triggers, actor history and supported Auth retirement.
-- No rows are changed by this migration. Ordinary players never reach this door.
-- @live-proof: (SELECT md5(pg_get_functiondef('public.cleanup_reserved_certification_account(uuid)'::regprocedure)) = '793d42fa3e4ac6f53f45fa9afd4d455e')
BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '8s';
DO $patch$
DECLARE
  v_target regprocedure := 'public.cleanup_reserved_certification_account(uuid)'::regprocedure;
  v_old text := pg_get_functiondef(v_target);
  v_new text;
  v_meta jsonb;
BEGIN
  IF md5(v_old) IS DISTINCT FROM '07419c2062fbff02d3ee7d3c24cd8ea9' THEN
    RAISE EXCEPTION 'LIGHTNING_CERTIFICATION_CLEANUP_PREIMAGE_CHANGED';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_proc WHERE oid=v_target AND proowner='postgres'::regrole AND prosecdef)
     OR has_function_privilege('anon',v_target,'EXECUTE')
     OR has_function_privilege('authenticated',v_target,'EXECUTE')
     OR NOT has_function_privilege('service_role',v_target,'EXECUTE') THEN
    RAISE EXCEPTION 'LIGHTNING_CERTIFICATION_CLEANUP_AUTHORITY_CHANGED';
  END IF;
  SELECT jsonb_build_object('owner',proowner,'acl',proacl,'config',proconfig) INTO v_meta
    FROM pg_proc WHERE oid=v_target;
  v_new := v_old;
  v_new := replace(v_new, $old$                          OR (club_id = '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid AND role IN ('admin','member'))$old$, $new$                          OR (club_id = '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid AND role IN ('admin','member'))
                          OR (club_id = 'fade0000-0000-0000-0000-000000000001'::uuid AND role = 'admin')$new$);
  v_new := replace(v_new, $old$club_id IS DISTINCT FROM 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid$old$, $new$(club_id IS NULL OR club_id NOT IN ('a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid, 'fade0000-0000-0000-0000-000000000001'::uuid))$new$);
  v_new := replace(v_new, $old$      AND club_id = 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid
      AND role = 'admin'$old$, $new$      AND club_id IN ('a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid, 'fade0000-0000-0000-0000-000000000001'::uuid)
      AND role = 'admin'$new$);
  v_new := replace(v_new, $old$OR COALESCE(promo_balance, 0) <> 0)) THEN$old$, $new$OR COALESCE(promo_balance, 0) <> 0
                      OR held_chips IS DISTINCT FROM 0 OR locked_chips IS DISTINCT FROM 0
                      OR credit_used IS DISTINCT FROM 0 OR credit_limit IS DISTINCT FROM 0
                      OR agent_id IS NOT NULL OR parent_agent_id IS NOT NULL)) THEN$new$);
  IF md5(v_new) IS DISTINCT FROM '793d42fa3e4ac6f53f45fa9afd4d455e' THEN
    RAISE EXCEPTION 'LIGHTNING_CERTIFICATION_CLEANUP_POSTIMAGE_CHANGED';
  END IF;
  EXECUTE v_new;
  IF md5(pg_get_functiondef(v_target)) IS DISTINCT FROM '793d42fa3e4ac6f53f45fa9afd4d455e'
     OR (SELECT jsonb_build_object('owner',proowner,'acl',proacl,'config',proconfig)
           FROM pg_proc WHERE oid=v_target) IS DISTINCT FROM v_meta THEN
    RAISE EXCEPTION 'LIGHTNING_CERTIFICATION_CLEANUP_READBACK_CHANGED';
  END IF;
END $patch$;
COMMIT;
