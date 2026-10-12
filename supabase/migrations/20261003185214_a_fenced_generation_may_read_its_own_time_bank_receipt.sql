-- 20261003185214_a_fenced_generation_may_read_its_own_time_bank_receipt.sql
--
-- Version reserved by scripts/reserve-migration-version.sh against origin/main
-- and every remote branch. One transaction, two functions, one marker. It
-- schedules nothing, writes no row and moves no chip.
--
-- ===========================================================================
-- WHAT WAS WRONG (2026-10-03)
--
-- The 16:35Z Postgres restart lost the answer to time-bank debit 6b1de5d5
-- (spin 20a7de08, table 9aa37b13). Its receipt committed at 16:34:18
-- (time_bank_consume_receipts). The table's manager lost its lease at
-- 16:34:42. Engine 6a08c4713 re-asks a lost debit by id, but it sends the
-- re-ask with the dead manager's data-actor headers. This hook fenced every
-- re-ask (TOURNAMENT_MANAGER_FENCED at each retry in the Postgres log), so:
--   * timeBankAccountingUnconfirmed never clears;
--   * the stopped time-bank custody can never be written;
--   * the manager's stop fails "retained time-bank custody" once a minute
--     (quarantined, three players seated, no hand since 16:33);
--   * the census reports stopped_bank_custody_stuck, which holds the restart
--     certificate shut (breaksSinceRestartCertified 3 at 18:55Z), so the
--     engine release that fixes the re-ask (#6003, process-root re-ask)
--     cannot be activated. The fix cannot ship past the bug it fixes. This is
--     the same deadlock 20260926131014 resolved for the custody write itself.
--
-- WHAT THIS CHANGES
--
--   1. smarter_private.fn_smarter_data_api_pre_request: at the point it would
--      fence, it admits one more shape, a POST to rpc/fn_consume_time_bank,
--      under its own marker 'fenced-manager-time-bank-receipt'. It is never
--      admitted as a manager. Every other method, path and row is fenced as
--      before.
--   2. public.fn_consume_time_bank: under that marker it answers ONLY from the
--      receipt the request id already committed (the replay branch that runs
--      first, unchanged), and otherwise raises the same
--      TOURNAMENT_MANAGER_FENCED. A fenced generation can read its own answer
--      and can never debit.
--
-- A committed debit is confirmed, the engine clears the flag, writes the
-- stopped custody through the existing refusing process write, the stop
-- completes and the tournament is re-admitted. The certificate opens only by
-- its own unchanged rules.
--
-- Same signatures, owners, ACLs, SECURITY DEFINER, volatility and
-- search_paths. Restoring the stated passage of each body reproduces its
-- pre-image digest (asserted below).
--
-- Pinned by tests/a-fenced-generation-may-read-its-own-time-bank-receipt.law.test.ts.

-- @live-proof: (SELECT bool_and(CASE p.oid WHEN 'smarter_private.fn_smarter_data_api_pre_request()'::regprocedure THEN md5(p.prosrc)='0c47f87ec4ecfdd5de66308604e92b27' ELSE md5(p.prosrc)='b67aabf0a73b754a87f5684de3d68b51' END) FROM pg_proc p WHERE p.oid IN ('smarter_private.fn_smarter_data_api_pre_request()'::regprocedure,'public.fn_consume_time_bank(uuid,integer,uuid)'::regprocedure))

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '15s';

DO $fenced_receipt_preimage$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('smarter_private.fn_smarter_data_api_pre_request()'))
       IS DISTINCT FROM '0e6038e3ddf79a4e82f401c41f2a55da'
     OR (SELECT md5(pg_get_functiondef(oid)) FROM pg_proc WHERE oid = to_regprocedure('smarter_private.fn_smarter_data_api_pre_request()'))
       IS DISTINCT FROM '4014592d136fe1dcd1ba5c88492d5c92'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.fn_consume_time_bank(uuid,integer,uuid)'))
       IS DISTINCT FROM '6adbdcd86c910c09e56b4f10193d2e55'
     OR (SELECT md5(pg_get_functiondef(oid)) FROM pg_proc WHERE oid = to_regprocedure('public.fn_consume_time_bank(uuid,integer,uuid)'))
       IS DISTINCT FROM 'e8e37336d62cf26b98d310472e0a5f94'
     OR (SELECT count(*) FROM pg_proc WHERE proname = 'fn_consume_time_bank') <> 1 THEN
    RAISE EXCEPTION 'FENCED_RECEIPT_PREIMAGE_DRIFT: a body is not the one inspected';
  END IF;
END
$fenced_receipt_preimage$;

CREATE OR REPLACE FUNCTION smarter_private.fn_smarter_data_api_pre_request()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $fenced_receipt_hook$
DECLARE
  v_headers jsonb;
  v_claims jsonb;
  v_actor text;
  v_protocol text;
  v_request_role text;
  v_method text;
  v_path text;
  v_tournament_id uuid;
  v_lease_generation uuid;
  /* Must remain identical to TOURNAMENT_LEASE_STALE_SECONDS and the claim RPC
     default. The catalog assertion below pins this audited takeover window. */
  v_stale_seconds constant integer := 30;
BEGIN
  BEGIN
    v_headers := COALESCE(
      NULLIF(current_setting('request.headers', true), '')::jsonb,
      '{}'::jsonb
    );
    v_claims := COALESCE(
      NULLIF(current_setting('request.jwt.claims', true), '')::jsonb,
      '{}'::jsonb
    );
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'DATA_ACTOR_INVALID: malformed PostgREST request context'
      USING ERRCODE = '22023';
  END;

  v_actor := lower(btrim(COALESCE(v_headers ->> 'x-smarter-data-actor', '')));
  v_protocol := btrim(COALESCE(v_headers ->> 'x-smarter-data-protocol', ''));
  /* This function is SECURITY DEFINER, so current_user is its owner, not the
     impersonated API role. The transaction-scoped, PostgREST-verified JWT
     claims are the request identity inside this privileged function. */
  v_request_role := btrim(COALESCE(auth.role(), ''));
  IF v_actor <> ''
     AND v_request_role <> btrim(COALESCE(v_claims ->> 'role', '')) THEN
    RAISE EXCEPTION 'DATA_ACTOR_INVALID: verified JWT role disagrees with request claims'
      USING ERRCODE = '22023';
  END IF;
  v_method := upper(btrim(COALESCE(current_setting('request.method', true), '')));
  v_path := lower(btrim(COALESCE(current_setting('request.path', true), ''), '/'));

  /* This route cannot exist while smarter_private stays outside db-schemas.
     Keep the refusal as fail-closed defence if that deployment boundary is
     ever misconfigured. */
  IF v_path = 'rpc/fn_smarter_data_api_pre_request' THEN
    RAISE EXCEPTION 'DATA_ACTOR_FORBIDDEN: request hook is not an RPC'
      USING ERRCODE = '42501';
  END IF;

  /* Stage A strict mode is intentionally OFF.  Unmarked old engines and
     ordinary browser clients remain compatible until a later activation
     migration.  Recording the local marker lets downstream Stage-B guards
     distinguish this path without guessing from table names or payloads. */
  IF v_actor = '' THEN
    PERFORM set_config('app.smarter_data_actor', 'legacy-unmarked', true);
    PERFORM set_config('app.smarter_tournament_id', '', true);
    PERFORM set_config('app.smarter_tournament_lease_generation', '', true);
    RETURN;
  END IF;

  IF v_request_role <> 'service_role' THEN
    RAISE EXCEPTION 'DATA_ACTOR_FORBIDDEN: marked server actor requires service_role'
      USING ERRCODE = '42501';
  END IF;

  IF v_actor = 'service' THEN
    IF v_protocol <> '1'
       OR length(btrim(COALESCE(v_headers ->> 'x-smarter-tournament-id', ''))) > 0
       OR length(
            btrim(
              COALESCE(v_headers ->> 'x-smarter-tournament-lease-generation', '')
            )
          ) > 0 THEN
      RAISE EXCEPTION 'DATA_ACTOR_INVALID: service authority headers are inconsistent'
        USING ERRCODE = '22023';
    END IF;
    PERFORM set_config('app.smarter_data_actor', 'service', true);
    PERFORM set_config('app.smarter_tournament_id', '', true);
    PERFORM set_config('app.smarter_tournament_lease_generation', '', true);
    RETURN;
  END IF;

  IF v_actor <> 'tournament-manager' OR v_protocol <> '2' THEN
    RAISE EXCEPTION 'DATA_ACTOR_INVALID: unknown actor or protocol'
      USING ERRCODE = '22023';
  END IF;

  BEGIN
    v_tournament_id := (v_headers ->> 'x-smarter-tournament-id')::uuid;
    v_lease_generation :=
      (v_headers ->> 'x-smarter-tournament-lease-generation')::uuid;
  EXCEPTION WHEN invalid_text_representation OR null_value_not_allowed THEN
    RAISE EXCEPTION 'DATA_ACTOR_INVALID: manager authority requires two UUIDs'
      USING ERRCODE = '22023';
  END;
  IF v_tournament_id IS NULL OR v_lease_generation IS NULL THEN
    RAISE EXCEPTION 'DATA_ACTOR_INVALID: manager authority requires two UUIDs'
      USING ERRCODE = '22023';
  END IF;

  /* PostgREST executes this hook inside the same transaction as the requested
     statement.  Read-only GET/HEAD requests need exact validation only.
     Every possible mutation method takes a shared row lock first; a lease
     takeover/update therefore waits until this manager transaction commits. */
  IF v_method IN ('GET', 'HEAD', 'OPTIONS')
     OR current_setting('transaction_read_only') = 'on' THEN
    PERFORM 1
      FROM public.engine_tournament_leases l
     WHERE l.tournament_id = v_tournament_id
       AND l.protocol_version = 2
       AND l.lease_generation = v_lease_generation
       AND NOT smarter_private.f06_generation_aborted(l.tournament_id,v_lease_generation)
       AND l.heartbeat_at >=
           clock_timestamp() - make_interval(secs => v_stale_seconds);
  ELSE
    PERFORM 1
      FROM public.engine_tournament_leases l
     WHERE l.tournament_id = v_tournament_id
       AND l.protocol_version = 2
       AND l.lease_generation = v_lease_generation
       AND NOT smarter_private.f06_generation_aborted(l.tournament_id,v_lease_generation)
       AND l.heartbeat_at >=
           clock_timestamp() - make_interval(secs => v_stale_seconds)
     /* A BUSY MANAGER KEEPS ITS LEASE (2026-09-10): FOR KEY SHARE, not
        FOR SHARE. The heartbeat renews heartbeat_at with FOR NO KEY
        UPDATE ... SKIP LOCKED; FOR SHARE made every in-flight manager
        request read as busy and expired the manager after 20 seconds.
        A takeover still waits: claim_tournament_lease_v2 takes FOR
        UPDATE, which FOR KEY SHARE does conflict with. */
     FOR KEY SHARE;
  END IF;

  IF NOT FOUND THEN
    /* A FENCED MANAGER'S STOPPED CUSTODY GOES THROUGH THE PROCESS WRITE
       (2026-09-26, migration 20260926131014). Exactly one request shape
       passes this point: a POST to engine_presence_parked. It is admitted
       under its own marker, never as a manager, and
       smarter_private.fn_fenced_manager_stopped_custody_park() (BEFORE
       INSERT on that table) either routes a stopped-custody row through
       public.fn_park_stopped_time_bank_custody - the same refusing write the
       engine calls at the process root since #5323 - and suppresses the raw
       upsert, or raises this same TOURNAMENT_MANAGER_FENCED. Every other
       method, path and row is fenced exactly as before. */
    IF v_method = 'POST' AND v_path = 'engine_presence_parked' THEN
      PERFORM set_config('app.smarter_data_actor', 'fenced-manager-stopped-custody', true);
      PERFORM set_config('app.smarter_tournament_id', v_tournament_id::text, true);
      PERFORM set_config(
        'app.smarter_tournament_lease_generation',
        v_lease_generation::text,
        true
      );
      RETURN;
    END IF;
    /* A FENCED GENERATION MAY READ ITS OWN TIME BANK RECEIPT (2026-10-03,
       migration 20261003185214). One more shape passes: a POST to
       rpc/fn_consume_time_bank, admitted under its own marker, never as a
       manager. fn_consume_time_bank answers it ONLY from the receipt that
       request id already committed, and otherwise raises this same
       TOURNAMENT_MANAGER_FENCED: a fenced generation never debits. */
    IF v_method = 'POST' AND v_path = 'rpc/fn_consume_time_bank' THEN
      PERFORM set_config('app.smarter_data_actor', 'fenced-manager-time-bank-receipt', true);
      PERFORM set_config('app.smarter_tournament_id', v_tournament_id::text, true);
      PERFORM set_config(
        'app.smarter_tournament_lease_generation',
        v_lease_generation::text,
        true
      );
      RETURN;
    END IF;
    RAISE EXCEPTION
      'TOURNAMENT_MANAGER_FENCED: lease generation is no longer current'
      USING ERRCODE = '42501';
  END IF;

  PERFORM set_config('app.smarter_data_actor', 'tournament-manager', true);
  PERFORM set_config('app.smarter_tournament_id', v_tournament_id::text, true);
  PERFORM set_config(
    'app.smarter_tournament_lease_generation',
    v_lease_generation::text,
    true
  );
END;
$fenced_receipt_hook$;

CREATE OR REPLACE FUNCTION public.fn_consume_time_bank(p_user_id uuid, p_seconds integer, p_request_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $fenced_receipt_consume$
DECLARE
  v_is_vip      boolean;
  v_is_lifetime boolean;
  v_month       text := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM');
  v_used        int;
  v_from_vip    int := 0;
  v_remaining   int;
  v_uses_needed int;
  v_uses_taken  int := 0;
  v_expiring_taken int := 0;
  v_row         record;
  v_take        int;
  v_receipt     jsonb;
  v_result      jsonb;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'fn_consume_time_bank is engine-only';
  END IF;
  IF p_seconds IS NULL OR p_seconds <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'p_seconds must be positive');
  END IF;

  -- A REPLAY NEVER TOUCHES A BALANCE (2026-09-28). Checked before the
  -- advisory lock, before anything is read: an already-receipted request_id
  -- is answered from its own receipt, full stop.
  IF p_request_id IS NOT NULL THEN
    SELECT result INTO v_receipt
      FROM public.time_bank_consume_receipts
     WHERE request_id = p_request_id;
    IF FOUND THEN
      RETURN v_receipt || jsonb_build_object('idempotent_replay', true);
    END IF;
  END IF;

  -- A FENCED GENERATION ONLY READS ITS RECEIPT (2026-10-03). The request hook
  -- admits a fenced manager's re-ask of a lost debit under its own marker so
  -- the answer above can reach it; it never debits. No receipt: fenced.
  IF current_setting('app.smarter_data_actor', true) = 'fenced-manager-time-bank-receipt' THEN
    RAISE EXCEPTION 'TOURNAMENT_MANAGER_FENCED: lease generation is no longer current'
      USING ERRCODE = '42501';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('time_bank:' || p_user_id::text, 0));

  -- Re-check under the lock: a concurrent call with the same request_id for
  -- the same user (the retry this migration exists to make safe) serializes
  -- on the lock above and, once the first commits, is answered here instead
  -- of deducting a second time.
  IF p_request_id IS NOT NULL THEN
    SELECT result INTO v_receipt
      FROM public.time_bank_consume_receipts
     WHERE request_id = p_request_id;
    IF FOUND THEN
      RETURN v_receipt || jsonb_build_object('idempotent_replay', true);
    END IF;
  END IF;

  SELECT
    COALESCE(p.is_vip, false)
      AND (p.vip_tier = 'lifetime' OR p.vip_expires_at IS NULL OR p.vip_expires_at > now()),
    COALESCE(p.is_vip, false) AND p.vip_tier = 'lifetime'
    INTO v_is_vip, v_is_lifetime
    FROM public.profiles p
   WHERE p.id = p_user_id;

  IF v_is_vip IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'unknown user');
  END IF;

  IF v_is_lifetime THEN
    INSERT INTO public.vip_feature_usage_monthly
      (user_id, feature, month, usage_count, updated_at)
    VALUES
      (p_user_id, 'time_bank_seconds', v_month, p_seconds, now())
    ON CONFLICT (user_id, feature, month) DO UPDATE
       SET usage_count = public.vip_feature_usage_monthly.usage_count + EXCLUDED.usage_count,
           updated_at = now();

    v_result := jsonb_build_object(
      'success', true,
      'source', 'lifetime_vip',
      'unlimited', true,
      'consumed_vip_seconds', p_seconds,
      'consumed_purchased_uses', 0,
      'shortfall_seconds', 0
    );
    IF p_request_id IS NOT NULL THEN
      INSERT INTO public.time_bank_consume_receipts (request_id, user_id, seconds, result)
      VALUES (p_request_id, p_user_id, p_seconds, v_result)
      ON CONFLICT (request_id) DO NOTHING;
    END IF;
    RETURN v_result;
  END IF;

  v_remaining := p_seconds;

  -- AN EXPIRING CREDIT IS SPENT BEFORE AN ALLOWANCE THAT RENEWS. A daily
  -- bonus credit lives seven days; the VIP allowance comes back on the
  -- first. One use is twenty seconds; soonest to expire first.
  v_uses_needed := CEIL(v_remaining / 20.0)::int;
  FOR v_row IN
    SELECT id, uses_remaining
      FROM public.feature_purchases
     WHERE user_id = p_user_id
       AND feature = 'time_bank_seconds'
       AND COALESCE(uses_remaining, 0) > 0
       AND expires_at IS NOT NULL
       AND expires_at > now()
     ORDER BY expires_at ASC, created_at ASC
     FOR UPDATE
  LOOP
    EXIT WHEN v_uses_needed <= 0;
    v_take := LEAST(v_row.uses_remaining, v_uses_needed);
    UPDATE public.feature_purchases
       SET uses_remaining = uses_remaining - v_take
     WHERE id = v_row.id;
    v_uses_taken := v_uses_taken + v_take;
    v_expiring_taken := v_expiring_taken + v_take;
    v_uses_needed := v_uses_needed - v_take;
  END LOOP;
  v_remaining := GREATEST(0, v_remaining - v_expiring_taken * 20);

  IF v_remaining > 0 AND v_is_vip THEN
    SELECT COALESCE(SUM(usage_count), 0)::int INTO v_used
      FROM public.vip_feature_usage_monthly
     WHERE user_id = p_user_id
       AND feature = 'time_bank_seconds'
       AND month = v_month;

    v_from_vip := LEAST(v_remaining, GREATEST(0, 120 - v_used));
    IF v_from_vip > 0 THEN
      INSERT INTO public.vip_feature_usage_monthly
        (user_id, feature, month, usage_count, updated_at)
      VALUES
        (p_user_id, 'time_bank_seconds', v_month, v_from_vip, now())
      ON CONFLICT (user_id, feature, month) DO UPDATE
         SET usage_count = public.vip_feature_usage_monthly.usage_count + EXCLUDED.usage_count,
             updated_at = now();
      v_remaining := v_remaining - v_from_vip;
    END IF;
  END IF;

  IF v_remaining > 0 THEN
    v_uses_needed := CEIL(v_remaining / 20.0)::int;
    FOR v_row IN
      SELECT id, uses_remaining
        FROM public.feature_purchases
       WHERE user_id = p_user_id
         AND feature = 'time_bank_seconds'
         AND COALESCE(uses_remaining, 0) > 0
         AND (expires_at IS NULL OR expires_at > now())
       ORDER BY created_at
       FOR UPDATE
    LOOP
      EXIT WHEN v_uses_needed <= 0;
      v_take := LEAST(v_row.uses_remaining, v_uses_needed);
      UPDATE public.feature_purchases
         SET uses_remaining = uses_remaining - v_take
       WHERE id = v_row.id;
      v_uses_taken := v_uses_taken + v_take;
      v_uses_needed := v_uses_needed - v_take;
    END LOOP;
    v_remaining := GREATEST(0, v_remaining - (v_uses_taken - v_expiring_taken) * 20);
  END IF;

  v_result := jsonb_build_object(
    'success', true,
    'consumed_vip_seconds', v_from_vip,
    'consumed_purchased_uses', v_uses_taken,
    'consumed_expiring_uses', v_expiring_taken,
    'shortfall_seconds', v_remaining
  );
  IF p_request_id IS NOT NULL THEN
    INSERT INTO public.time_bank_consume_receipts (request_id, user_id, seconds, result)
    VALUES (p_request_id, p_user_id, p_seconds, v_result)
    ON CONFLICT (request_id) DO NOTHING;
  END IF;
  RETURN v_result;
END;
$fenced_receipt_consume$;

DO $fenced_receipt_postimage$
DECLARE pre_body text; ctb_body text;
BEGIN
  SELECT p.prosrc INTO pre_body FROM pg_proc p
   WHERE p.oid = 'smarter_private.fn_smarter_data_api_pre_request()'::regprocedure
     AND md5(p.prosrc) = '0c47f87ec4ecfdd5de66308604e92b27'
     AND md5(pg_get_functiondef(p.oid)) = '6027b488b1c77d03642b3d384f275d6a'
     AND pg_get_userbyid(p.proowner) = 'postgres'
     AND p.proacl::text = '{postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}';
  SELECT p.prosrc INTO ctb_body FROM pg_proc p
   WHERE p.oid = 'public.fn_consume_time_bank(uuid,integer,uuid)'::regprocedure
     AND md5(p.prosrc) = 'b67aabf0a73b754a87f5684de3d68b51'
     AND md5(pg_get_functiondef(p.oid)) = 'f7b9218b8ee0413fd042f9c8491d5b07'
     AND pg_get_userbyid(p.proowner) = 'postgres'
     AND p.proacl::text = '{postgres=X/postgres,service_role=X/postgres}';
  IF pre_body IS NULL OR ctb_body IS NULL THEN
    RAISE EXCEPTION 'FENCED_RECEIPT_POSTIMAGE_DRIFT: a function is not the body, owner or ACL stated';
  END IF;
  -- Only the stated passages changed.
  IF md5(replace(pre_body,
       $r$      RETURN;
    END IF;
    /* A FENCED GENERATION MAY READ ITS OWN TIME BANK RECEIPT (2026-10-03,
       migration 20261003185214). One more shape passes: a POST to
       rpc/fn_consume_time_bank, admitted under its own marker, never as a
       manager. fn_consume_time_bank answers it ONLY from the receipt that
       request id already committed, and otherwise raises this same
       TOURNAMENT_MANAGER_FENCED: a fenced generation never debits. */
    IF v_method = 'POST' AND v_path = 'rpc/fn_consume_time_bank' THEN
      PERFORM set_config('app.smarter_data_actor', 'fenced-manager-time-bank-receipt', true);
      PERFORM set_config('app.smarter_tournament_id', v_tournament_id::text, true);
      PERFORM set_config(
        'app.smarter_tournament_lease_generation',
        v_lease_generation::text,
        true
      );
      RETURN;
    END IF;
    RAISE EXCEPTION
      'TOURNAMENT_MANAGER_FENCED: lease generation is no longer current'$r$, $r$      RETURN;
    END IF;
    RAISE EXCEPTION
      'TOURNAMENT_MANAGER_FENCED: lease generation is no longer current'$r$)) <> '0e6038e3ddf79a4e82f401c41f2a55da'
     OR md5(replace(ctb_body,
       $r$    IF FOUND THEN
      RETURN v_receipt || jsonb_build_object('idempotent_replay', true);
    END IF;
  END IF;

  -- A FENCED GENERATION ONLY READS ITS RECEIPT (2026-10-03). The request hook
  -- admits a fenced manager's re-ask of a lost debit under its own marker so
  -- the answer above can reach it; it never debits. No receipt: fenced.
  IF current_setting('app.smarter_data_actor', true) = 'fenced-manager-time-bank-receipt' THEN
    RAISE EXCEPTION 'TOURNAMENT_MANAGER_FENCED: lease generation is no longer current'
      USING ERRCODE = '42501';
  END IF;

  PERFORM pg_advisory_xact_lock($r$, $r$    IF FOUND THEN
      RETURN v_receipt || jsonb_build_object('idempotent_replay', true);
    END IF;
  END IF;

  PERFORM pg_advisory_xact_lock($r$)) <> '6adbdcd86c910c09e56b4f10193d2e55' THEN
    RAISE EXCEPTION 'FENCED_RECEIPT_POSTIMAGE_DRIFT: more than the stated passages changed';
  END IF;
END
$fenced_receipt_postimage$;

COMMIT;
