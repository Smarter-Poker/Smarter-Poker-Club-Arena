-- 20260906093024_cashier_rpc_idempotency_and_telemetry_boundary
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-09-06 09:30:24 UTC.
--
-- CLAUDE.md 10.9: the reasoning goes in this header, not just the SQL.
--
-- Two browser-reachable cashier writes were still trusting answers supplied
-- by the browser:
--
-- 1. fn_request_chips accepted a NULL p_op_id. That made the request write
--    non-idempotent even though every current Cashier caller already creates
--    and retains a UUID. A lost response could therefore become two pending
--    requests when an older or hand-written caller retried without a key.
--
-- 2. authenticated held direct INSERT on cashier_operations. RLS proved only
--    that user_id matched auth.uid(); it did not prove the caller belonged to
--    club_id, and it let the browser choose sample_weight. Any signed-in user
--    could attribute arbitrary failures to any club and distort the Cashier
--    SLOs consumed by operators.
--
-- 3. rate_limits itself still inherited full browser table grants and an
--    INSERT WITH CHECK (true) policy. The limiter RPCs were closed earlier,
--    but a browser could still insert rows for any user/action and spend that
--    person's request budget directly. No browser code reads or writes this
--    internal throttle ledger; every legitimate writer is SECURITY DEFINER.
--
-- The request RPC now refuses a missing retry key while keeping its existing
-- four-argument PostgREST signature and every valid-call/replay behavior. The
-- telemetry table becomes server-owned: a narrow SECURITY DEFINER RPC derives
-- user_id from auth.uid(), requires an active staff/agent cashier scope for the
-- club, validates every bounded field and event/operation pairing, derives the
-- sample weight, and limits one actor to 120 accepted events per minute. Direct
-- browser INSERT and sequence access are revoked.
--
-- Rollback: restore fn_request_chips from 20260830010000, drop
-- fn_record_cashier_operation, recreate cashier_operations_insert_own, and
-- restore authenticated INSERT plus sequence USAGE/SELECT. Restoring direct
-- rate_limits access is intentionally not part of rollback: it was an
-- independently exploitable authorization defect.

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_request_chips(
  p_club_id uuid,
  p_amount numeric,
  p_note text DEFAULT NULL,
  p_op_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_me uuid := auth.uid();
  v_agent uuid;
  v_open integer;
  v_prior public.chip_requests%rowtype;
  v_note text := NULLIF(BTRIM(COALESCE(p_note, '')), '');
  v_id uuid;
BEGIN
  IF v_me IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Not Authenticated');
  END IF;
  IF p_op_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'A Retry Key Is Required');
  END IF;
  IF p_club_id IS NULL OR p_amount IS NULL OR p_amount <= 0 OR p_amount > 1e9 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Enter A Valid Request Amount');
  END IF;
  IF p_amount <> ROUND(p_amount, 2) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Chips Move In Hundredths At Most');
  END IF;
  IF v_note IS NOT NULL AND length(v_note) > 500 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Request Note Is Too Long');
  END IF;

  -- One requester/club lock makes both replay and max-three authoritative
  -- under concurrent submissions.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('chip-request:' || p_club_id::text || ':' || v_me::text, 0)
  );

  SELECT *
    INTO v_prior
    FROM public.chip_requests
   WHERE club_id = p_club_id
     AND requester_id = v_me
     AND op_id = p_op_id;
  IF FOUND THEN
    IF v_prior.amount IS DISTINCT FROM p_amount OR v_prior.note IS DISTINCT FROM v_note THEN
      RETURN jsonb_build_object(
        'success', false, 'error', 'That Retry Key Belongs To A Different Request'
      );
    END IF;
    RETURN jsonb_build_object(
      'success', true, 'request_id', v_prior.id, 'replayed', true
    );
  END IF;

  SELECT cm.agent_id
    INTO v_agent
    FROM public.club_members cm
   WHERE cm.club_id = p_club_id
     AND cm.user_id = v_me
     AND COALESCE(cm.status::text, 'active') IN ('active', 'approved')
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success', false, 'error', 'You Are Not An Active Member Of This Club'
    );
  END IF;

  IF v_agent IS NULL THEN
    SELECT owner_id INTO v_agent FROM public.clubs WHERE id = p_club_id;
  END IF;

  SELECT COUNT(*)
    INTO v_open
    FROM public.chip_requests
   WHERE club_id = p_club_id
     AND requester_id = v_me
     AND status = 'pending';
  IF v_open >= 3 THEN
    RETURN jsonb_build_object('success', false, 'error', 'You Already Have 3 Open Requests');
  END IF;

  INSERT INTO public.chip_requests (
    club_id, requester_id, approver_id, amount, note, op_id
  ) VALUES (
    p_club_id, v_me, v_agent, p_amount, v_note, p_op_id
  )
  RETURNING id INTO v_id;

  RETURN jsonb_build_object(
    'success', true, 'request_id', v_id, 'replayed', false
  );
END
$function$;

REVOKE ALL ON FUNCTION public.fn_request_chips(uuid, numeric, text, uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_request_chips(uuid, numeric, text, uuid)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_record_cashier_operation(
  p_club_id uuid,
  p_event text,
  p_operation text,
  p_duration_ms integer DEFAULT NULL,
  p_item_count integer DEFAULT NULL,
  p_page_number integer DEFAULT NULL,
  p_success_count integer DEFAULT NULL,
  p_failure_count integer DEFAULT NULL,
  p_reason_code text DEFAULT NULL
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_user_id uuid := auth.uid();
  v_scope text;
  v_is_failure boolean;
  v_recent_count integer;
BEGIN
  IF v_user_id IS NULL OR p_club_id IS NULL THEN
    RETURN false;
  END IF;

  -- The Cashier operational feed describes staff/agent workflows. A plain
  -- player or a user with no active membership cannot write a club's signal.
  v_scope := public.fn_club_cashier_scope(p_club_id, v_user_id);
  IF COALESCE(v_scope, 'none') NOT IN ('all', 'downline') THEN
    RETURN false;
  END IF;

  IF p_event IS NULL OR p_operation IS NULL OR p_event NOT IN (
    'roster_page_succeeded', 'roster_page_failed',
    'batch_succeeded', 'batch_partial', 'batch_failed'
  ) OR p_operation NOT IN ('roster', 'send', 'ticket') THEN
    RETURN false;
  END IF;
  IF (p_event LIKE 'roster_page_%' AND p_operation <> 'roster')
     OR (p_event LIKE 'batch_%' AND p_operation NOT IN ('send', 'ticket')) THEN
    RETURN false;
  END IF;

  IF (p_duration_ms IS NOT NULL AND (p_duration_ms < 0 OR p_duration_ms > 300000))
     OR (p_item_count IS NOT NULL AND (p_item_count < 0 OR p_item_count > 1000000))
     OR (p_page_number IS NOT NULL AND (p_page_number < 0 OR p_page_number > 100000))
     OR (p_success_count IS NOT NULL AND (p_success_count < 0 OR p_success_count > 1000000))
     OR (p_failure_count IS NOT NULL AND (p_failure_count < 0 OR p_failure_count > 1000000))
     OR (p_reason_code IS NOT NULL AND p_reason_code !~ '^[a-z0-9:_-]{1,64}$') THEN
    RETURN false;
  END IF;

  -- Bound storage abuse and SLO poisoning by a compromised authenticated
  -- client. The actor is server-derived and the lock closes concurrent races.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('cashier-operation:' || v_user_id::text, 0)
  );
  SELECT COUNT(*)
    INTO v_recent_count
    FROM public.rate_limits
   WHERE user_id = v_user_id
     AND action = 'cashier_operation'
     AND created_at > now() - interval '1 minute';
  IF v_recent_count >= 120 THEN
    RETURN false;
  END IF;
  INSERT INTO public.rate_limits (user_id, action)
  VALUES (v_user_id, 'cashier_operation');

  v_is_failure := p_event IN ('roster_page_failed', 'batch_partial', 'batch_failed');

  INSERT INTO public.cashier_operations (
    user_id,
    club_id,
    event,
    operation,
    duration_ms,
    item_count,
    page_number,
    success_count,
    failure_count,
    reason_code,
    sample_weight
  ) VALUES (
    v_user_id,
    p_club_id,
    p_event,
    p_operation,
    p_duration_ms,
    p_item_count,
    p_page_number,
    p_success_count,
    p_failure_count,
    p_reason_code,
    CASE WHEN v_is_failure THEN 1 ELSE 10 END
  );

  RETURN true;
END
$function$;

COMMENT ON FUNCTION public.fn_record_cashier_operation(
  uuid, text, text, integer, integer, integer, integer, integer, text
) IS
  'Records one bounded Cashier SLO event for auth.uid() after validating active club cashier scope. The browser cannot choose user_id or sample_weight.';

COMMENT ON TABLE public.cashier_operations IS
  'Server-owned Cashier roster/batch SLO events. Contains no amounts, recipients, notes, or free-form error messages; browsers write only through fn_record_cashier_operation.';

-- rate_limits is an internal SECURITY DEFINER implementation table. Keeping a
-- browser policy here lets any client manufacture another user's limiter rows.
DROP POLICY IF EXISTS "Service can insert rate limit entries" ON public.rate_limits;
REVOKE ALL ON public.rate_limits FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.rate_limits TO service_role;

DROP POLICY IF EXISTS cashier_operations_insert_own ON public.cashier_operations;
REVOKE ALL ON public.cashier_operations FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.cashier_operations_id_seq FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.cashier_operations TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.cashier_operations_id_seq TO service_role;

REVOKE ALL ON FUNCTION public.fn_record_cashier_operation(
  uuid, text, text, integer, integer, integer, integer, integer, text
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_record_cashier_operation(
  uuid, text, text, integer, integer, integer, integer, integer, text
) TO authenticated, service_role;

DO $verify$
DECLARE
  v_request_source text;
  v_telemetry_source text;
  v_telemetry_oid oid := to_regprocedure(
    'public.fn_record_cashier_operation(uuid,text,text,integer,integer,integer,integer,integer,text)'
  );
BEGIN
  SELECT lower(prosrc)
    INTO v_request_source
    FROM pg_proc
   WHERE oid = to_regprocedure('public.fn_request_chips(uuid,numeric,text,uuid)');
  IF v_request_source IS NULL OR v_request_source NOT LIKE '%if p_op_id is null then%' THEN
    RAISE EXCEPTION 'POST-APPLY: fn_request_chips does not require p_op_id';
  END IF;

  IF v_telemetry_oid IS NULL THEN
    RAISE EXCEPTION 'POST-APPLY: fn_record_cashier_operation is missing';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_telemetry_oid)
     OR NOT COALESCE((
       SELECT proconfig @> ARRAY['search_path=public, pg_temp']
         FROM pg_proc
        WHERE oid = v_telemetry_oid
     ), false) THEN
    RAISE EXCEPTION 'POST-APPLY: cashier telemetry RPC lost its definer/search_path boundary';
  END IF;
  SELECT lower(prosrc) INTO v_telemetry_source FROM pg_proc WHERE oid = v_telemetry_oid;
  IF v_telemetry_source NOT LIKE '%auth.uid()%'
     OR v_telemetry_source NOT LIKE '%fn_club_cashier_scope%'
     OR v_telemetry_source NOT LIKE '%cashier_operation%' THEN
    RAISE EXCEPTION 'POST-APPLY: cashier telemetry RPC lost identity, scope, or rate limiting';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename = 'cashier_operations'
       AND cmd = 'INSERT'
  ) OR has_table_privilege('authenticated', 'public.cashier_operations', 'INSERT') THEN
    RAISE EXCEPTION 'POST-APPLY: authenticated can still insert cashier_operations directly';
  END IF;
  IF has_sequence_privilege(
    'authenticated', 'public.cashier_operations_id_seq', 'USAGE'
  ) THEN
    RAISE EXCEPTION 'POST-APPLY: authenticated still has cashier_operations sequence access';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename = 'rate_limits'
       AND cmd IN ('INSERT', 'UPDATE', 'DELETE')
  ) OR has_table_privilege('anon', 'public.rate_limits', 'SELECT')
     OR has_table_privilege('anon', 'public.rate_limits', 'INSERT')
     OR has_table_privilege('anon', 'public.rate_limits', 'UPDATE')
     OR has_table_privilege('anon', 'public.rate_limits', 'DELETE')
     OR has_table_privilege('authenticated', 'public.rate_limits', 'SELECT')
     OR has_table_privilege('authenticated', 'public.rate_limits', 'INSERT')
     OR has_table_privilege('authenticated', 'public.rate_limits', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.rate_limits', 'DELETE') THEN
    RAISE EXCEPTION 'POST-APPLY: a browser can still access the internal rate limiter';
  END IF;

  IF has_function_privilege('anon', v_telemetry_oid, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', v_telemetry_oid, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_telemetry_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'POST-APPLY: cashier telemetry RPC ACL drift';
  END IF;
END
$verify$;

COMMIT;
