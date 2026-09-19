-- 20260919152651_a_user_scoped_route_is_checked_as_the_role_it_uses
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-09-19 15:26:51 UTC.
--
-- CLAUDE.md 10.9: the reasoning goes in this header, not just the SQL.
--
-- ===========================================================================
-- WHAT WAS WRONG
--
-- fn_ca_second_writer_check asks, of every World Hub .rpc() call, whether the
-- door exists, whether the register closed it, whether the parameter names
-- resolve, and whether the caller may EXECUTE it. That last question was
-- always asked of one role:
--
--   bool_or(has_function_privilege('service_role', p.oid, 'EXECUTE'))
--
-- Almost every World Hub API route holds the service key, so that was right
-- almost everywhere. Five routes do not. They build a Supabase client from the
-- ANON key and forward the caller's Authorization header, so the RPC runs as
-- `authenticated` and the function reads auth.uid() to know who is asking.
--
-- MEASURED 2026-09-19 over 1,159 files and 332 rpc calls: 41 on a service-role
-- client, 5 on a user-scoped one, 286 whose client this repository cannot see
-- from the call site. The five:
--
--   pages/api/store/diamond-transfer.js:38   send_wallet_diamond_transfer
--   pages/api/club-arena/mint-chips.js:204   fn_mint_chips_from_diamonds
--   pages/api/live/gift.js:517               send_stream_gift
--   pages/api/profile/check-username.js:64   check_username_with_suggestions
--   pages/api/profile/complete-social.js:57  claim_social_profile
--
-- The wrong role is wrong in both directions, and the second one is worse.
--
--   FALSE POSITIVE. send_wallet_diamond_transfer is granted to authenticated
--   and deliberately NOT to service_role: its first statement is auth.uid(),
--   and a service-role caller has none. The audit reported "service_role
--   cannot execute it; the route gets permission denied on every call" for a
--   route that works. It was the only error in the run, and it has kept
--   Schema Integrity Audit red.
--
--   FALSE NEGATIVE. fn_mint_chips_from_diamonds and send_stream_gift are
--   approved money doors called by user-scoped routes. The grant those routes
--   actually need is EXECUTE to authenticated, and nothing has ever asked
--   about it. Both happen to be granted to service_role as well, so the check
--   passed for a reason unrelated to whether the route works. Revoking
--   authenticated would have broken the mint with this audit still green.
--
-- WHAT THIS CHANGES
--
-- The call now carries the role it runs as, and the check asks about THAT
-- role. A call whose role the scanner could not determine is checked as
-- service_role exactly as before, so the 286 unresolved and the 41 explicit
-- service-role calls are unaffected. The finding names the role it asked
-- about, because "permission denied" pointing at the wrong role is how the
-- last ten days were spent.
--
-- The scanner half is scripts/ci/audit-second-writer.mjs (clientRoleOf).
--
-- HOW: pg_temp.ca_patch, the sanctioned apply-time textual edit with an
-- exact-match-count assertion, so a body that has moved on refuses rather
-- than being silently half-patched. Four edits, each asserted to match once.
--
-- @live-proof: (SELECT position('has_function_privilege(v_role, p.oid' in p.prosrc) > 0 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'fn_ca_second_writer_check')
-- @live-proof: (SELECT (public.fn_ca_second_writer_check('[{"file":"probe","line":1,"fn":"send_wallet_diamond_transfer","keys":["p_recipient_id","p_amount","p_message","p_reference_id"],"role":"authenticated"}]'::jsonb)->>'errors')::int = 0)
-- ===========================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE FUNCTION pg_temp.ca_patch(p_fn text, p_from text, p_to text, p_expected integer DEFAULT 1)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_def text; v_n integer; v_procs integer;
BEGIN
  SELECT count(*) INTO v_procs FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = p_fn;
  IF v_procs <> 1 THEN
    RAISE EXCEPTION 'ca_patch: % has % overloads in public (expected exactly 1)', p_fn, v_procs;
  END IF;
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = p_fn;
  v_n := (length(v_def) - length(replace(v_def, p_from, ''))) / length(p_from);
  IF v_n <> p_expected THEN
    RAISE EXCEPTION 'ca_patch: marker in % found % times, expected %: %', p_fn, v_n, p_expected, left(p_from, 120);
  END IF;
  EXECUTE replace(v_def, p_from, p_to);
END $$;

-- 1. The role the call runs as.
SELECT pg_temp.ca_patch('fn_ca_second_writer_check',
$p1f$  v_sr         boolean;
$p1f$,
$p1t$  v_sr         boolean;
  v_role       text;
$p1t$);

-- 2. Read it once per call, fail closed. A call with no role, or a role this
--    check does not recognise, is service_role, which is what every call was
--    before this migration.
SELECT pg_temp.ca_patch('fn_ca_second_writer_check',
$p2f$    IF v_keys IS NULL THEN v_unchecked := v_unchecked + 1; ELSE v_checked := v_checked + 1; END IF;
$p2f$,
$p2t$    IF v_keys IS NULL THEN v_unchecked := v_unchecked + 1; ELSE v_checked := v_checked + 1; END IF;

    /* WHICH ROLE THE ROUTE CALLS AS. A World Hub route that forwards the
       caller's token runs as authenticated and the door reads auth.uid();
       one holding the service key runs as service_role. Asking the wrong one
       reported a working money route as permission denied and never once
       asked whether the mint route's own grant was still there. Unknown is
       service_role, which is what every call was before. */
    v_role := c->>'role';
    IF v_role IS NULL OR v_role NOT IN ('service_role', 'authenticated') THEN
      v_role := 'service_role';
    END IF;
$p2t$);

-- 3. Ask about that role.
SELECT pg_temp.ca_patch('fn_ca_second_writer_check',
$p3f$bool_or(has_function_privilege('service_role', p.oid, 'EXECUTE')),$p3f$,
$p3t$bool_or(has_function_privilege(v_role, p.oid, 'EXECUTE')),$p3t$);

-- 4. And say which role it asked about.
SELECT pg_temp.ca_patch('fn_ca_second_writer_check',
$p4f$        'kind', 'not_executable_by_service_role', 'severity', v_sev, 'money', v_money,
        'detail', 'service_role cannot execute it; the route gets "permission denied" on every call');$p4f$,
$p4t$        'kind', 'not_executable_by_' || v_role, 'severity', v_sev, 'money', v_money,
        'detail', v_role || ' cannot execute it; the route gets "permission denied" on every call');$p4t$);

-- The check is the arbiter of its own change: the real call, both ways.
DO $verify$
DECLARE
  v_payload CONSTANT jsonb := '[{"file":"pages/api/store/diamond-transfer.js","line":38,"fn":"send_wallet_diamond_transfer","keys":["p_recipient_id","p_amount","p_message","p_reference_id"]}]'::jsonb;
  v_as_user jsonb;
  v_default jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'public' AND p.proname = 'fn_ca_second_writer_check'
                    AND position('has_function_privilege(v_role, p.oid' in p.prosrc) > 0) THEN
    RAISE EXCEPTION 'failed: the privilege question is still hard coded to one role';
  END IF;

  v_as_user := public.fn_ca_second_writer_check(
    jsonb_set(v_payload, '{0,role}', '"authenticated"'::jsonb));
  IF (v_as_user->>'errors')::int <> 0 THEN
    RAISE EXCEPTION 'failed: the user-scoped diamond transfer call still reports % error(s): %',
      v_as_user->>'errors', v_as_user->'findings';
  END IF;

  -- And the default has NOT been loosened: the same call with no role is still
  -- checked as service_role, and service_role still cannot execute that door.
  v_default := public.fn_ca_second_writer_check(v_payload);
  IF (v_default->>'errors')::int <> 1
     OR (v_default->'findings'->0->>'kind') <> 'not_executable_by_service_role' THEN
    RAISE EXCEPTION 'failed: a call with no declared role must still be checked as service_role, got %',
      v_default;
  END IF;

  RAISE NOTICE 'second writer: user-scoped calls are checked as authenticated; unknown stays service_role';
END
$verify$;

COMMIT;
