-- 20260922160600_credit_reduction_writers_ask_who_is_calling
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-09-22 16:06:00 UTC.
--
-- CLAUDE.md 10.9: the reasoning goes in this header, not just the SQL.
--
-- ===========================================================================
-- WHAT WAS WRONG
--
-- Schema Integrity Audit, job "No unaccounted DEFINER writer is reachable
-- from a browser", has been red on every run since 2026-09-19 17:25 UTC.
-- Question 1 of fn_definer_exposure_audit() (unauthenticated_writers) reported
-- "live: 3, baselined: 2, new: 2". The two new ones are
--
--   fn_reduce_agent_credit_v1(uuid,uuid,uuid,uuid,uuid,numeric,numeric,
--                             numeric,boolean,bigint,text)
--   fn_retire_agent_credit_reduction_v1(uuid,uuid,uuid)
--
-- Both arrived in union_weekly_accounting_atomic_activation_20260917
-- (recorded 20260917181100), which revoked them from PUBLIC, anon,
-- authenticated and service_role and granted EXECUTE to authenticated only.
-- Both are SECURITY DEFINER, both write (accounting_credit_reduction_*_v1,
-- and the reducer changes an agent's credit line through
-- fn_admin_update_agent), and neither body mentions auth.uid(), auth.role()
-- or auth.jwt().
--
-- They are NOT unbound. Each calls the private helper
-- fn_credit_reduction_lock_v1 (EXECUTE held by postgres alone) before its
-- first write, and the helper raises 42501 credit_reduction_actor_changed
-- unless auth.uid() equals a non-null, non-nil p_expected_actor_id. But the
-- binding lives ONLY in that helper. Every net this estate has for this shape
-- reads the writer's OWN text and cannot see it: the live audit above,
-- scripts/ci/check-definer-authorization.mjs rule 1, and the DDL event
-- trigger trg_autorevoke_privileged_anon, which auto-locked both on
-- 2026-09-17 18:24 as "behavioural: definer + writes + no auth.uid()". And
-- nothing tied the writers to the helper: a later CREATE OR REPLACE of
-- fn_credit_reduction_lock_v1 that lost its actor check would have left both
-- writers open to every signed-in account, with every one of those nets
-- still reporting exactly what it reports today.
--
-- WHY NOT REVOKE, WHY NOT BASELINE
--
-- A signed-in browser caller is real: src/services/CreditReductionOperation.ts
-- calls fn_reduce_agent_credit_v1 (line 440) and
-- fn_retire_agent_credit_reduction_v1 (line 483) for the club manager's
-- credit-reduction flow on AgentDashboardPage. Revoking authenticated breaks
-- it. And reviewedExceptions in scripts/ci/definer-exposure-baseline.json is
-- shrink-only by rule (pinned by tests/live-definer-exposure-audit.test.ts):
-- it is for writers that cannot be pointed at anything, and these can be
-- pointed at any club's agents by the person the caller claims to be.
--
-- WHAT THIS CHANGES
--
-- Each writer now states the binding in its own body, on the line after the
-- helper call:
--
--   IF auth.uid() IS NULL OR auth.uid() IS DISTINCT FROM p_expected_actor_id
--   THEN RAISE EXCEPTION 'credit_reduction_actor_changed' USING ERRCODE='42501'
--
-- the helper's own condition and its own error. Nothing else in either
-- definition changes: the edit is a replace() of one exact fragment on the
-- live definition, refused unless the source md5 is the reviewed one in
-- supabase/accounting/credit-reduction-v1/guard-installed-function-sources.json
-- and unless undoing the replace gives back the old definition byte for
-- byte. Grants, owner, search_path, volatility and OID are asserted
-- unchanged. There is no behaviour change for any caller: every call that
-- reaches the new line has already passed the identical check inside the
-- helper. What changes is that neither writer depends on a private helper
-- keeping that check, and that all three nets can now verify it.
--
-- WHAT WAS MEASURED (2026-09-22, before this migration)
--
--   * ACL of both: {postgres=X/postgres,authenticated=X/postgres}; anon
--     false, PUBLIC false, authenticated true, service_role false.
--   * prosrc md5: reducer 2921345d6b7eda01404fc77e2e130c29, retirer
--     7ef3a5839666732fb2e6f39fd653b8a6 (the accounting contract's values).
--   * The helper call occurs exactly once in each definition.
--   * A self-aborting probe (CLAUDE.md 11.5): with no identity, and signed
--     in as one uuid naming another as the actor, all four calls raised
--     42501 credit_reduction_actor_changed. Nothing was written.
--   * Both rewritten definitions compiled in pg_temp inside a rolled-back
--     block before this file was applied.
--
-- @live-proof: position('IF auth.uid() IS NULL OR auth.uid() IS DISTINCT FROM p_expected_actor_id THEN' in pg_get_functiondef('public.fn_reduce_agent_credit_v1(uuid,uuid,uuid,uuid,uuid,numeric,numeric,numeric,boolean,bigint,text)'::regprocedure)) > 0
-- @live-proof: position('IF auth.uid() IS NULL OR auth.uid() IS DISTINCT FROM p_expected_actor_id THEN' in pg_get_functiondef('public.fn_retire_agent_credit_reduction_v1(uuid,uuid,uuid)'::regprocedure)) > 0
-- ===========================================================================

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

DO $bind$
DECLARE
  v_old constant text :=
    'PERFORM public.fn_credit_reduction_lock_v1(p_expected_actor_id,p_operation_id,p_club_id);';
  v_new constant text := $new$PERFORM public.fn_credit_reduction_lock_v1(p_expected_actor_id,p_operation_id,p_club_id);
 IF auth.uid() IS NULL OR auth.uid() IS DISTINCT FROM p_expected_actor_id THEN
  RAISE EXCEPTION 'credit_reduction_actor_changed' USING ERRCODE='42501';END IF;$new$;
  v_acl constant text := '{postgres=X/postgres,authenticated=X/postgres}';
  t record;
  v_oid oid;
  v_before text;
  v_after text;
  v_shape_before jsonb;
  v_shape_after jsonb;
BEGIN
  FOR t IN
    SELECT *
      FROM (VALUES
        ('public.fn_reduce_agent_credit_v1(uuid,uuid,uuid,uuid,uuid,numeric,numeric,numeric,boolean,bigint,text)',
         '2921345d6b7eda01404fc77e2e130c29'),
        ('public.fn_retire_agent_credit_reduction_v1(uuid,uuid,uuid)',
         '7ef3a5839666732fb2e6f39fd653b8a6')
      ) AS x(sig, src_md5)
  LOOP
    v_oid := to_regprocedure(t.sig);
    IF v_oid IS NULL THEN
      RAISE EXCEPTION 'failed: % does not exist', t.sig;
    END IF;

    -- PREIMAGE: exactly the reviewed source, the reviewed grants, one call site.
    IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = v_oid) IS DISTINCT FROM t.src_md5 THEN
      RAISE EXCEPTION 'failed: % is not the reviewed source; read it again', t.sig;
    END IF;
    SELECT jsonb_build_object(
             'oid', p.oid, 'secdef', p.prosecdef, 'volatile', p.provolatile,
             'parallel', p.proparallel, 'strict', p.proisstrict, 'leakproof', p.proleakproof,
             'config', p.proconfig, 'owner', p.proowner::regrole::text, 'acl', p.proacl::text,
             'args', pg_get_function_arguments(p.oid), 'result', pg_get_function_result(p.oid),
             'cost', p.procost, 'comment', obj_description(p.oid, 'pg_proc'))
      INTO v_shape_before
      FROM pg_proc p WHERE p.oid = v_oid;
    IF v_shape_before->>'acl' IS DISTINCT FROM v_acl OR (v_shape_before->>'secdef')::boolean IS NOT TRUE THEN
      RAISE EXCEPTION 'failed: % is not a SECURITY DEFINER granted to authenticated alone: %', t.sig, v_shape_before;
    END IF;
    v_before := pg_get_functiondef(v_oid);
    IF (length(v_before) - length(replace(v_before, v_old, ''))) / length(v_old) <> 1 THEN
      RAISE EXCEPTION 'failed: % does not call fn_credit_reduction_lock_v1 exactly once', t.sig;
    END IF;
    IF v_before ~ 'auth\.uid\(\)|auth\.role\(\)|auth\.jwt\(\)' THEN
      RAISE EXCEPTION 'failed: % already consults auth; this migration has nothing to do', t.sig;
    END IF;

    -- THE CHANGE: one fragment, on the live definition, nothing retyped.
    EXECUTE replace(v_before, v_old, v_new);

    -- POSTIMAGE: only that fragment moved, and nothing about the function did.
    v_after := pg_get_functiondef(v_oid);
    IF replace(v_after, v_new, v_old) IS DISTINCT FROM v_before THEN
      RAISE EXCEPTION 'failed: % changed by more than the actor binding', t.sig;
    END IF;
    IF (length(v_after) - length(replace(v_after, v_new, ''))) / length(v_new) <> 1 THEN
      RAISE EXCEPTION 'failed: % does not carry the actor binding exactly once', t.sig;
    END IF;
    SELECT jsonb_build_object(
             'oid', p.oid, 'secdef', p.prosecdef, 'volatile', p.provolatile,
             'parallel', p.proparallel, 'strict', p.proisstrict, 'leakproof', p.proleakproof,
             'config', p.proconfig, 'owner', p.proowner::regrole::text, 'acl', p.proacl::text,
             'args', pg_get_function_arguments(p.oid), 'result', pg_get_function_result(p.oid),
             'cost', p.procost, 'comment', obj_description(p.oid, 'pg_proc'))
      INTO v_shape_after
      FROM pg_proc p WHERE p.oid = v_oid;
    IF v_shape_after IS DISTINCT FROM v_shape_before THEN
      RAISE EXCEPTION 'failed: % shape changed: % -> %', t.sig, v_shape_before, v_shape_after;
    END IF;
  END LOOP;
END $bind$;

-- BOTH DIRECTIONS, before anything commits.
DO $verify$
DECLARE
  r record;
  v_state text;
  v_msg text;
  v_someone uuid := gen_random_uuid();
  v_other uuid := gen_random_uuid();
  v_audit jsonb := public.fn_definer_exposure_audit();
BEGIN
  FOR r IN
    SELECT unnest(ARRAY[
      'public.fn_reduce_agent_credit_v1(uuid,uuid,uuid,uuid,uuid,numeric,numeric,numeric,boolean,bigint,text)',
      'public.fn_retire_agent_credit_reduction_v1(uuid,uuid,uuid)']) AS sig
  LOOP
    -- Nobody without an account, and nobody through PUBLIC.
    IF has_function_privilege('anon', r.sig, 'EXECUTE')
       OR has_function_privilege('public', r.sig, 'EXECUTE') THEN
      RAISE EXCEPTION 'failed: a caller with no account can execute %', r.sig;
    END IF;
    -- The signed-in manager's path still runs.
    IF NOT has_function_privilege('authenticated', r.sig, 'EXECUTE') THEN
      RAISE EXCEPTION 'failed: authenticated lost EXECUTE on %', r.sig;
    END IF;
    -- Unchanged: no server path ever held it, and none is added here.
    IF has_function_privilege('service_role', r.sig, 'EXECUTE') THEN
      RAISE EXCEPTION 'failed: service_role gained EXECUTE on %', r.sig;
    END IF;
  END LOOP;

  -- The auditor that went red now clears both on their own text.
  IF EXISTS (SELECT 1
               FROM jsonb_array_elements(v_audit->'unauthenticated_writers') e
              WHERE e->>'function' IN ('fn_reduce_agent_credit_v1',
                                       'fn_retire_agent_credit_reduction_v1')) THEN
    RAISE EXCEPTION 'failed: fn_definer_exposure_audit still lists a credit-reduction writer: %',
      v_audit->'unauthenticated_writers';
  END IF;

  -- And a caller who is not the named actor is still refused, 42501, before
  -- any write. Each call is its own subtransaction; a refusal rolls it back.
  PERFORM set_config('request.jwt.claims', '', true);
  BEGIN
    PERFORM public.fn_retire_agent_credit_reduction_v1(v_other, gen_random_uuid(), gen_random_uuid());
    RAISE EXCEPTION 'failed: the retirer accepted a caller with no identity';
  EXCEPTION WHEN insufficient_privilege THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    IF v_msg IS DISTINCT FROM 'credit_reduction_actor_changed' THEN
      RAISE EXCEPTION 'failed: the retirer refused a caller with no identity for the wrong reason: % %', v_state, v_msg;
    END IF;
  END;
  BEGIN
    PERFORM public.fn_reduce_agent_credit_v1(v_other, gen_random_uuid(), gen_random_uuid(),
      gen_random_uuid(), gen_random_uuid(), 1.00, 10.00, 0.00, false, 0, NULL);
    RAISE EXCEPTION 'failed: the reducer accepted a caller with no identity';
  EXCEPTION WHEN insufficient_privilege THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    IF v_msg IS DISTINCT FROM 'credit_reduction_actor_changed' THEN
      RAISE EXCEPTION 'failed: the reducer refused a caller with no identity for the wrong reason: % %', v_state, v_msg;
    END IF;
  END;

  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_someone, 'role', 'authenticated')::text, true);
  IF auth.uid() IS DISTINCT FROM v_someone THEN
    RAISE EXCEPTION 'failed: could not stand in for a signed-in caller';
  END IF;
  BEGIN
    PERFORM public.fn_retire_agent_credit_reduction_v1(v_other, gen_random_uuid(), gen_random_uuid());
    RAISE EXCEPTION 'failed: the retirer accepted a caller naming somebody else';
  EXCEPTION WHEN insufficient_privilege THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    IF v_msg IS DISTINCT FROM 'credit_reduction_actor_changed' THEN
      RAISE EXCEPTION 'failed: the retirer refused another actor for the wrong reason: % %', v_state, v_msg;
    END IF;
  END;
  BEGIN
    PERFORM public.fn_reduce_agent_credit_v1(v_other, gen_random_uuid(), gen_random_uuid(),
      gen_random_uuid(), gen_random_uuid(), 1.00, 10.00, 0.00, false, 0, NULL);
    RAISE EXCEPTION 'failed: the reducer accepted a caller naming somebody else';
  EXCEPTION WHEN insufficient_privilege THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    IF v_msg IS DISTINCT FROM 'credit_reduction_actor_changed' THEN
      RAISE EXCEPTION 'failed: the reducer refused another actor for the wrong reason: % %', v_state, v_msg;
    END IF;
  END;
  PERFORM set_config('request.jwt.claims', '', true);
END $verify$;

COMMIT;
