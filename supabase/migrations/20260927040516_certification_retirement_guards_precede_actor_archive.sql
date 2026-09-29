-- Keep the already-qualified retained-actor decision ahead of later cleanup.
-- The combined installed function archived/detached a reserved actor before
-- checking the platform freeze and custody. A frozen request returned false
-- after that UPDATE committed; an eligible opening-grant actor bypassed the
-- retained-identity branch entirely. Move that exact existing branch first.
-- No ledger, archive, identity, balance, constraint or trigger is changed here.
-- Non-ledger disposable cleanup and all archive safeguards remain in place.
-- @live-proof: (SELECT md5(pg_get_functiondef('public.cleanup_reserved_certification_account(uuid)'::regprocedure)) = 'f29271b8f640a2d2a1f04e6f020e150c')
BEGIN;
SET LOCAL lock_timeout = '4s';
SET LOCAL statement_timeout = '8s';

DO $patch$
DECLARE
  v_target regprocedure := 'public.cleanup_reserved_certification_account(uuid)'::regprocedure;
  v_old text := pg_get_functiondef(v_target);
  v_new text;
  v_block text;
  v_start integer;
  v_end integer;
  v_catalog record;
BEGIN
  IF md5(v_old) IS DISTINCT FROM '398b42f6d1e594370a1264db7f64c6b7' THEN
    RAISE EXCEPTION 'CERTIFICATION_RETIREMENT_ORDER_PREIMAGE_CHANGED: %', md5(v_old)
      USING ERRCODE = '55000';
  END IF;
  SELECT oid, proowner, proacl, proconfig INTO STRICT v_catalog
    FROM pg_proc WHERE oid = v_target;
  IF NOT EXISTS (SELECT FROM pg_proc WHERE oid = v_target
                  AND proowner = 'postgres'::regrole AND prosecdef)
     OR has_function_privilege('anon', v_target, 'EXECUTE')
     OR has_function_privilege('authenticated', v_target, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_target, 'EXECUTE') THEN
    RAISE EXCEPTION 'CERTIFICATION_RETIREMENT_ORDER_AUTHORITY_CHANGED'
      USING ERRCODE = '55000';
  END IF;
  v_start := strpos(v_old,
    '  -- Preserve immutable ledger actors. The Auth API owns credential/session');
  v_end := strpos(v_old,
    $$  IF v_email NOT LIKE 'ca-customization-cert-%@example.invalid'$$);
  v_block := substring(v_old FROM v_start FOR v_end - v_start);
  IF md5(v_block) IS DISTINCT FROM '3dd91ddd6028c8396688a4c9eb306810' THEN
    RAISE EXCEPTION 'CERTIFICATION_RETIREMENT_ORDER_GUARD_BLOCK_CHANGED'
      USING ERRCODE = '55000';
  END IF;
  v_new := replace(v_old, v_block, '');
  v_new := replace(v_new,
    '  -- Refuse every financial row except the exact Create Club opening',
    v_block || '  -- Refuse every financial row except the exact Create Club opening');
  IF md5(v_new) IS DISTINCT FROM 'f29271b8f640a2d2a1f04e6f020e150c' THEN
    RAISE EXCEPTION 'CERTIFICATION_RETIREMENT_ORDER_RESULT_CHANGED'
      USING ERRCODE = '55000';
  END IF;
  EXECUTE v_new;
  IF NOT EXISTS (SELECT FROM pg_proc WHERE oid = v_catalog.oid
                  AND proowner = v_catalog.proowner
                  AND proacl IS NOT DISTINCT FROM v_catalog.proacl
                  AND proconfig IS NOT DISTINCT FROM v_catalog.proconfig)
     OR md5(pg_get_functiondef(v_target)) <> 'f29271b8f640a2d2a1f04e6f020e150c' THEN
    RAISE EXCEPTION 'CERTIFICATION_RETIREMENT_ORDER_READBACK_CHANGED'
      USING ERRCODE = '55000';
  END IF;
END
$patch$;
COMMIT;
