-- 20261010022852_cashier_contract_pins_need_service_role_execute.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- The cashier release contract (scripts/verification-harness/
-- cashier-release-contract.sql, the post-deploy canary) pins every RPC a
-- browser calls from a cashier surface by signature, body hash, SECURITY
-- DEFINER, search_path and ACL. Its ACL rule is one line for every pinned
-- client door: authenticated AND service_role may EXECUTE, anon may not. The
-- launch audit of 2026-10-09 (findings S-02 and S-12) read every cashier door
-- on production and found exactly two that the browser calls and the contract
-- could not pin, because production grants EXECUTE on them to authenticated
-- and postgres only, never to service_role:
--
--   public.fn_cashout_operation_receipt_v2(uuid,uuid,text,uuid,numeric,uuid,text)
--     the cashout v2 receipt reader (CashoutService), live
--     body md5 c9af51f246a9be79c7b79c49b760e9a9, proconfig
--     search_path=public, lock_timeout=3s, statement_timeout=30s
--   public.send_wallet_diamond_transfer(uuid,integer,text,text)
--     the Diamond Wallet transfer (DiamondWalletTransfer), live body md5
--     8d5b95d8ad2a74c1ba85339168349606, proconfig search_path=public, pg_temp
--
-- Every other pinned door already carries the service_role grant (the service
-- key is what the verification harness, the post-deploy canary and the
-- accounting runners call these doors with; a door the service key cannot
-- open cannot be exercised by the harness). This file grants only that, so
-- both doors can join the contract with their production hashes and the
-- "not pinnable" carve-out in the contract can be deleted. Nothing about
-- either function's body, owner, security, search_path or browser ACL
-- changes: authenticated keeps EXECUTE, anon and PUBLIC still have none, and
-- the post-apply block below refuses the apply if any of that is not so.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).
--
-- @live-proof: (SELECT has_function_privilege('service_role', 'public.fn_cashout_operation_receipt_v2(uuid,uuid,text,uuid,numeric,uuid,text)', 'EXECUTE') AND has_function_privilege('authenticated', 'public.fn_cashout_operation_receipt_v2(uuid,uuid,text,uuid,numeric,uuid,text)', 'EXECUTE') AND NOT has_function_privilege('anon', 'public.fn_cashout_operation_receipt_v2(uuid,uuid,text,uuid,numeric,uuid,text)', 'EXECUTE'))
-- @live-proof: (SELECT has_function_privilege('service_role', 'public.send_wallet_diamond_transfer(uuid,integer,text,text)', 'EXECUTE') AND has_function_privilege('authenticated', 'public.send_wallet_diamond_transfer(uuid,integer,text,text)', 'EXECUTE') AND NOT has_function_privilege('anon', 'public.send_wallet_diamond_transfer(uuid,integer,text,text)', 'EXECUTE'))

BEGIN;

-- Two grants on existing functions; nothing here waits behind a hot table.
SET LOCAL lock_timeout = '5s';

GRANT EXECUTE ON FUNCTION public.fn_cashout_operation_receipt_v2(uuid,uuid,text,uuid,numeric,uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.send_wallet_diamond_transfer(uuid,integer,text,text) TO service_role;

-- ---------------------------------------------------------------------------
-- POST-APPLY: both doors now satisfy the contract ACL rule exactly, and the
-- browser ACL is what it was. Any miss aborts the whole transaction.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_doors text[] := ARRAY[
    'public.fn_cashout_operation_receipt_v2(uuid,uuid,text,uuid,numeric,uuid,text)',
    'public.send_wallet_diamond_transfer(uuid,integer,text,text)'
  ];
  v_signature text;
  v_oid oid;
BEGIN
  FOREACH v_signature IN ARRAY v_doors LOOP
    v_oid := to_regprocedure(v_signature);
    IF v_oid IS NULL THEN
      RAISE EXCEPTION 'POST-APPLY: % is missing', v_signature;
    END IF;
    IF NOT has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'POST-APPLY: authenticated cannot execute %', v_signature;
    END IF;
    IF NOT has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'POST-APPLY: service_role cannot execute %', v_signature;
    END IF;
    IF has_function_privilege('anon', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'POST-APPLY: anon can execute %', v_signature;
    END IF;
    IF EXISTS (
      SELECT 1
        FROM pg_proc p
        CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
       WHERE p.oid = v_oid
         AND acl.privilege_type = 'EXECUTE'
         AND acl.grantee = 0
    ) THEN
      RAISE EXCEPTION 'POST-APPLY: PUBLIC can execute %', v_signature;
    END IF;
  END LOOP;
END
$$;

COMMIT;
