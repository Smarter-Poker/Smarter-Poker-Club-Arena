-- Refuse signed JWTs whose user session has been revoked or expired.
-- Preserve the existing atomic transfer, receipt replay, and ACL contracts.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $guard$
DECLARE
  v_body text;
  v_definition text;
BEGIN
  SELECT prosrc, pg_get_functiondef(oid) INTO STRICT v_body, v_definition
    FROM pg_proc WHERE oid = 'public.send_wallet_diamond_transfer(uuid,integer,text,text)'::regprocedure;
  IF md5(v_body) <> '17fbc7ff2a9176d3cca3f94d91721292' THEN
    RAISE EXCEPTION 'wallet_transfer_source_changed_review_required';
  END IF;
  IF to_regprocedure('public.fn_caller_session_is_live()') IS NULL THEN
    RAISE EXCEPTION 'live_session_guard_required';
  END IF;
  EXECUTE replace(v_definition, 'IF v_sender IS NULL THEN',
    'IF v_sender IS NULL OR NOT public.fn_caller_session_is_live() THEN');
  IF NOT EXISTS (SELECT 1 FROM pg_proc
    WHERE oid = 'public.send_wallet_diamond_transfer(uuid,integer,text,text)'::regprocedure
    AND prosrc LIKE '%IF v_sender IS NULL OR NOT public.fn_caller_session_is_live() THEN%')
  OR has_function_privilege('anon', 'public.send_wallet_diamond_transfer(uuid,integer,text,text)', 'EXECUTE')
  OR has_function_privilege('service_role', 'public.send_wallet_diamond_transfer(uuid,integer,text,text)', 'EXECUTE')
  OR NOT has_function_privilege('authenticated', 'public.send_wallet_diamond_transfer(uuid,integer,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'wallet_transfer_guard_or_acl_contract_failed';
  END IF;
END;
$guard$;
COMMIT;
