-- SOURCE ONLY / UNRUN. Stage 1 is a partial protective correction.
-- This DO block changes function source only. It never runs the resolver or
-- updates alerts, hands, balances, history, schedules or guard declarations.
DO $component$
DECLARE
  v_rollback constant boolean := true;
  v_oid oid := to_regprocedure('public.fn_resolve_settled_financial_alerts(boolean,integer)');
  v_pre constant text := $pre$CREATE OR REPLACE FUNCTION public.fn_resolve_settled_financial_alerts(p_apply boolean DEFAULT false, p_limit integer DEFAULT 5000)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_paid      integer := 0;
  v_overpaid  integer := 0;
  v_settled   integer := 0;
  v_released  integer := 0;
  v_paid_ids  uuid[] := '{}';
  v_over_ids  uuid[] := '{}';
  v_settled_ids uuid[] := '{}';
  v_rel_ids   uuid[] := '{}';
BEGIN
  -- ── CLASS 1: the player was accused of being unpaid and has since been paid.
  -- Proven per alert against wallet_transactions, not assumed from elapsed
  -- time. `short` is what the check said they were owed; `got` is what the
  -- prize path actually credited them for that same event.
  SELECT array_agg(id) INTO v_paid_ids FROM (
    SELECT a.id
      FROM public.financial_alerts a
     WHERE a.resolved IS NOT TRUE
       AND a.source = 'fn_payout_guarantee_check'
       AND a.context->>'kind' = 'earner_not_paid'
       AND a.context->>'user_id' IS NOT NULL
       AND a.context->>'tournament_id' IS NOT NULL
       AND COALESCE((
             SELECT sum(w.amount) FROM public.wallet_transactions w
              WHERE w.related_entity_id = (a.context->>'tournament_id')::uuid
                AND w.user_id           = (a.context->>'user_id')::uuid
                AND w.type = 'credit' AND w.category = 'prize'
           ), 0) >= COALESCE((a.context->>'short')::numeric, 0) - 0.01
     LIMIT p_limit
  ) s;
  v_paid := COALESCE(array_length(v_paid_ids, 1), 0);

  -- ── CLASS 2: every issue on the alert is an overpay, which 10.6 rule 3 says
  -- is absorbed and never clawed back. There is no action left to take, so
  -- "unresolved" is a false state. An alert carrying ANY other issue kind is
  -- deliberately left open.
  SELECT array_agg(id) INTO v_over_ids FROM (
    SELECT a.id
      FROM public.financial_alerts a
     WHERE a.resolved IS NOT TRUE
       AND a.source = 'fn_tournament_payout_reconcile'
       AND jsonb_typeof(a.context->'issues') = 'array'
       AND jsonb_array_length(a.context->'issues') > 0
       AND NOT EXISTS (
             SELECT 1 FROM jsonb_array_elements(a.context->'issues') i
              WHERE i->>'issue' IS DISTINCT FROM 'overpaid')
     LIMIT p_limit
  ) s;
  v_overpaid := COALESCE(array_length(v_over_ids, 1), 0);

  -- CLASS 3: the post-commit envelope this alert was raised about has since
  -- been applied. hand_atomic_commits.post_commit_completed_at is the durable
  -- proof; the alert is the memory of a moment when it was not yet set.
  SELECT COALESCE(array_agg(id), '{}') INTO v_settled_ids FROM (
    SELECT a.id
      FROM public.financial_alerts a
      JOIN public.hand_atomic_commits c ON c.hand_id = (a.context->>'hand_id')::uuid
     WHERE a.resolved IS NOT TRUE
       AND a.source = 'ServerTableEngine.post_commit_obligations_pending'
       AND a.context->>'hand_id' IS NOT NULL
       AND c.post_commit_completed_at IS NOT NULL
     LIMIT p_limit
  ) s;
  v_settled := COALESCE(array_length(v_settled_ids, 1), 0);

  -- CLASS 4: a refused hand was released whole. Either the commit row for that
  -- exact hand now exists (the retry landed), or the table has since committed
  -- a LATER hand, which the per-table hand-order barrier only permits once the
  -- refused one is no longer in the way. Both are proof the money is settled;
  -- neither is elapsed time.
  SELECT COALESCE(array_agg(id), '{}') INTO v_rel_ids FROM (
    SELECT a.id
      FROM public.financial_alerts a
     WHERE a.resolved IS NOT TRUE
       AND a.source IN ('postHandTasks.hand_history_failed',
                        'ServerTableEngine.authoritative_hand_semantic_refusal')
       AND a.context->>'table_id' IS NOT NULL
       AND a.context->>'hand_number' IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM public.hand_atomic_commits c
          WHERE c.table_id = (a.context->>'table_id')::uuid
            AND c.hand_number >= (a.context->>'hand_number')::bigint)
     LIMIT p_limit
  ) s;
  v_released := COALESCE(array_length(v_rel_ids, 1), 0);

  IF p_apply THEN
    UPDATE public.financial_alerts a
       SET resolved = true, resolved_at = now(),
           context = COALESCE(a.context, '{}'::jsonb) || jsonb_build_object(
             'resolution', 'the post-commit envelope for this hand has been applied; post_commit_completed_at is set',
             'resolved_by_fn', 'fn_resolve_settled_financial_alerts',
             'resolved_on', now())
     WHERE a.id = ANY(v_settled_ids);

    UPDATE public.financial_alerts a
       SET resolved = true, resolved_at = now(),
           context = COALESCE(a.context, '{}'::jsonb) || jsonb_build_object(
             'resolution', 'the refused hand was released whole: this table has committed that hand or a later one, and an atomic refusal leaves nothing partial behind',
             'resolved_by_fn', 'fn_resolve_settled_financial_alerts',
             'resolved_on', now())
     WHERE a.id = ANY(v_rel_ids);
  END IF;

  IF p_apply THEN
    UPDATE public.financial_alerts a
       SET resolved = true,
           resolved_at = now(),
           context = COALESCE(a.context, '{}'::jsonb) || jsonb_build_object(
             'resolution', 'settled after the alert was raised; the prize path credited this player for this event',
             'resolved_by_fn', 'fn_resolve_settled_financial_alerts',
             'resolved_on', now(),
             'credited', COALESCE((
               SELECT round(sum(w.amount), 2) FROM public.wallet_transactions w
                WHERE w.related_entity_id = (a.context->>'tournament_id')::uuid
                  AND w.user_id           = (a.context->>'user_id')::uuid
                  AND w.type = 'credit' AND w.category = 'prize'), 0))
     WHERE a.id = ANY(v_paid_ids);

    UPDATE public.financial_alerts a
       SET resolved = true,
           resolved_at = now(),
           context = COALESCE(a.context, '{}'::jsonb) || jsonb_build_object(
             'resolution', 'overpay only; absorbed by the house per CLAUDE.md 10.6 rule 3, never clawed back',
             'resolved_by_fn', 'fn_resolve_settled_financial_alerts',
             'resolved_on', now())
     WHERE a.id = ANY(v_over_ids);
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'applied', p_apply,
    'settled_after_alert', v_paid,
    'overpay_absorbed', v_overpaid,
    'post_commit_applied', v_settled,
    'refused_hand_released', v_released,
    'total', v_paid + v_overpaid + v_settled + v_released,
    'still_unresolved', (SELECT count(*) FROM public.financial_alerts WHERE resolved IS NOT TRUE)
  );
END;
$function$
$pre$;
  v_post constant text := $post$CREATE OR REPLACE FUNCTION public.fn_resolve_settled_financial_alerts(p_apply boolean DEFAULT false, p_limit integer DEFAULT 5000)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_paid      integer := 0;
  v_overpaid  integer := 0;
  v_settled   integer := 0;
  v_released  integer := 0;
  v_paid_ids  uuid[] := '{}';
  v_over_ids  uuid[] := '{}';
  v_settled_ids uuid[] := '{}';
  v_rel_ids   uuid[] := '{}';
BEGIN
  -- ── CLASS 1: the player was accused of being unpaid and has since been paid.
  -- Proven per alert against wallet_transactions, not assumed from elapsed
  -- time. `short` is what the check said they were owed; `got` is what the
  -- prize path actually credited them for that same event.
  SELECT array_agg(id) INTO v_paid_ids FROM (
    SELECT a.id
      FROM public.financial_alerts a
     WHERE a.resolved IS NOT TRUE
       AND a.source = 'fn_payout_guarantee_check'
       AND a.context->>'kind' = 'earner_not_paid'
       AND a.context->>'user_id' IS NOT NULL
       AND a.context->>'tournament_id' IS NOT NULL
       AND COALESCE((
             SELECT sum(w.amount) FROM public.wallet_transactions w
              WHERE w.related_entity_id = (a.context->>'tournament_id')::uuid
                AND w.user_id           = (a.context->>'user_id')::uuid
                AND w.type = 'credit' AND w.category = 'prize'
           ), 0) >= COALESCE((a.context->>'short')::numeric, 0) - 0.01
     LIMIT p_limit
  ) s;
  v_paid := COALESCE(array_length(v_paid_ids, 1), 0);

  -- ── CLASS 2: every issue on the alert is an overpay, which 10.6 rule 3 says
  -- is absorbed and never clawed back. There is no action left to take, so
  -- "unresolved" is a false state. An alert carrying ANY other issue kind is
  -- deliberately left open.
  SELECT array_agg(id) INTO v_over_ids FROM (
    SELECT a.id
      FROM public.financial_alerts a
     WHERE a.resolved IS NOT TRUE
       AND a.source = 'fn_tournament_payout_reconcile'
       AND jsonb_typeof(a.context->'issues') = 'array'
       AND jsonb_array_length(a.context->'issues') > 0
       AND NOT EXISTS (
             SELECT 1 FROM jsonb_array_elements(a.context->'issues') i
              WHERE i->>'issue' IS DISTINCT FROM 'overpaid')
     LIMIT p_limit
  ) s;
  v_overpaid := COALESCE(array_length(v_over_ids, 1), 0);

  -- CLASS 3: the post-commit envelope this alert was raised about has since
  -- been applied. hand_atomic_commits.post_commit_completed_at is the durable
  -- proof; the alert is the memory of a moment when it was not yet set.
  SELECT COALESCE(array_agg(id), '{}') INTO v_settled_ids FROM (
    SELECT a.id
      FROM public.financial_alerts a
      JOIN public.hand_atomic_commits c ON c.hand_id = (a.context->>'hand_id')::uuid
     WHERE a.resolved IS NOT TRUE
       AND a.source = 'ServerTableEngine.post_commit_obligations_pending'
       AND a.context->>'hand_id' IS NOT NULL
       AND c.post_commit_completed_at IS NOT NULL
     LIMIT p_limit
  ) s;
  v_settled := COALESCE(array_length(v_settled_ids, 1), 0);

  -- CLASS 4 / STAGE 1 (PARTIAL): only an exact original accepted hand with
  -- completed required obligations can resolve here. A later hand, client
  -- claim, text-only rollback or missing identity remains actionable. A true
  -- rollback needs no same-hand commit; this stage does not certify rollbacks.
  SELECT COALESCE(array_agg(id), '{}') INTO v_rel_ids FROM (
    SELECT a.id
      FROM public.financial_alerts a
      JOIN public.hand_atomic_commits c ON
        c.hand_id = CASE WHEN (a.context->'hand_request_identity_v1'->>'hand_id') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
          THEN (a.context->'hand_request_identity_v1'->>'hand_id')::uuid END
     WHERE a.resolved IS NOT TRUE
       AND a.source IN ('postHandTasks.hand_history_failed',
                        'ServerTableEngine.authoritative_hand_semantic_refusal')
       AND jsonb_typeof(a.context) = 'object'
       AND a.context->>'channel' = 'server_rpc'
       AND jsonb_typeof(a.context->'hand_request_identity_v1') = 'object'
       AND a.context->'hand_request_identity_v1'->'version' = '1'::jsonb
       AND a.context->'hand_request_identity_v1'->'post_commit_required' = 'true'::jsonb
       AND jsonb_typeof(a.context->'hand_request_identity_v1'->'table_id') = 'string'
       AND jsonb_typeof(a.context->'hand_request_identity_v1'->'hand_id') = 'string'
       AND jsonb_typeof(a.context->'hand_request_identity_v1'->'hand_number') = 'number'
       AND lower(a.context->>'table_id') = lower(a.context->'hand_request_identity_v1'->>'table_id')
       AND a.context->'hand_number' = a.context->'hand_request_identity_v1'->'hand_number'
       AND c.hand_id = CASE
         WHEN (a.context->'hand_request_identity_v1'->>'hand_id') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
         THEN (a.context->'hand_request_identity_v1'->>'hand_id')::uuid END
       AND c.table_id = CASE
         WHEN (a.context->'hand_request_identity_v1'->>'table_id') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
         THEN (a.context->'hand_request_identity_v1'->>'table_id')::uuid END
       AND c.hand_number = CASE
         WHEN (a.context->'hand_request_identity_v1'->>'hand_number') ~ '^[1-9][0-9]{6,15}$'
         THEN CASE WHEN (a.context->'hand_request_identity_v1'->>'hand_number')::bigint <= 9007199254740991
           THEN (a.context->'hand_request_identity_v1'->>'hand_number')::bigint END END
       AND c.payload_hash ~ '^[0-9a-f]{64}$'
       AND c.post_commit_request_hash ~ '^[0-9a-f]{64}$'
       AND c.post_commit_payload_hash ~ '^[0-9a-f]{64}$'
       AND jsonb_typeof(c.post_commit_payload) = 'object'
       AND c.post_commit_completed_at IS NOT NULL
       AND jsonb_typeof(c.post_commit_result) = 'object'
       AND c.post_commit_result->'ok' = 'true'::jsonb
       AND c.post_commit_result->>'hand_id' = c.hand_id::text
       AND c.post_commit_result->'hand_number' = to_jsonb(c.hand_number)
     ORDER BY a.created_at, a.id
     LIMIT p_limit
  ) s;
  v_released := COALESCE(array_length(v_rel_ids, 1), 0);

  IF p_apply THEN
    UPDATE public.financial_alerts a
       SET resolved = true, resolved_at = now(),
           context = COALESCE(a.context, '{}'::jsonb) || jsonb_build_object(
             'resolution', 'the post-commit envelope for this hand has been applied; post_commit_completed_at is set',
             'resolved_by_fn', 'fn_resolve_settled_financial_alerts',
             'resolved_on', now())
     WHERE a.id = ANY(v_settled_ids);

    -- Repeat the complete guard under UPDATE: preview membership alone is not
    -- authority after a concurrent original-alert identity or status change.
    WITH changed AS (
      UPDATE public.financial_alerts a
         SET resolved = true, resolved_at = now(),
             resolution = 'Exact original hand ' || c.hand_id::text || ' at table ' || c.table_id::text || ' (#' || c.hand_number::text || ') was accepted; its required post-commit obligations completed at ' || c.post_commit_completed_at::text || '. This receipt does not diagnose the original failure cause.',
             context = COALESCE(a.context, '{}'::jsonb) || jsonb_build_object(
               'resolution', 'Exact original hand ' || c.hand_id::text || ' at table ' || c.table_id::text || ' (#' || c.hand_number::text || ') was accepted; its required post-commit obligations completed at ' || c.post_commit_completed_at::text || '. This receipt does not diagnose the original failure cause.',
               'resolved_by_fn', 'fn_resolve_settled_financial_alerts',
               'resolved_on', now(),
               'hand_outcome_resolution_v1', jsonb_build_object(
                 'version', 1, 'kind', 'exact_original_post_commit_complete',
                 'financial_alert_id', a.id,
                 'hand_id', c.hand_id, 'table_id', c.table_id,
                 'hand_number', c.hand_number, 'post_commit_required', true,
                 'commit_hash', c.payload_hash, 'committed_at', c.committed_at,
                 'post_commit_request_hash', c.post_commit_request_hash,
                 'post_commit_payload_hash', c.post_commit_payload_hash,
                 'post_commit_completed_at', c.post_commit_completed_at,
                 'completion_ok', true))
        FROM public.hand_atomic_commits c
       WHERE a.id = ANY(v_rel_ids)
         AND a.resolved IS NOT TRUE
       AND a.source IN ('postHandTasks.hand_history_failed',
                        'ServerTableEngine.authoritative_hand_semantic_refusal')
       AND jsonb_typeof(a.context) = 'object'
       AND a.context->>'channel' = 'server_rpc'
       AND jsonb_typeof(a.context->'hand_request_identity_v1') = 'object'
       AND a.context->'hand_request_identity_v1'->'version' = '1'::jsonb
       AND a.context->'hand_request_identity_v1'->'post_commit_required' = 'true'::jsonb
       AND jsonb_typeof(a.context->'hand_request_identity_v1'->'table_id') = 'string'
       AND jsonb_typeof(a.context->'hand_request_identity_v1'->'hand_id') = 'string'
       AND jsonb_typeof(a.context->'hand_request_identity_v1'->'hand_number') = 'number'
       AND lower(a.context->>'table_id') = lower(a.context->'hand_request_identity_v1'->>'table_id')
       AND a.context->'hand_number' = a.context->'hand_request_identity_v1'->'hand_number'
       AND c.hand_id = CASE
         WHEN (a.context->'hand_request_identity_v1'->>'hand_id') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
         THEN (a.context->'hand_request_identity_v1'->>'hand_id')::uuid END
       AND c.table_id = CASE
         WHEN (a.context->'hand_request_identity_v1'->>'table_id') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
         THEN (a.context->'hand_request_identity_v1'->>'table_id')::uuid END
       AND c.hand_number = CASE
         WHEN (a.context->'hand_request_identity_v1'->>'hand_number') ~ '^[1-9][0-9]{6,15}$'
         THEN CASE WHEN (a.context->'hand_request_identity_v1'->>'hand_number')::bigint <= 9007199254740991
           THEN (a.context->'hand_request_identity_v1'->>'hand_number')::bigint END END
       AND c.payload_hash ~ '^[0-9a-f]{64}$'
       AND c.post_commit_request_hash ~ '^[0-9a-f]{64}$'
       AND c.post_commit_payload_hash ~ '^[0-9a-f]{64}$'
       AND jsonb_typeof(c.post_commit_payload) = 'object'
       AND c.post_commit_completed_at IS NOT NULL
       AND jsonb_typeof(c.post_commit_result) = 'object'
       AND c.post_commit_result->'ok' = 'true'::jsonb
       AND c.post_commit_result->>'hand_id' = c.hand_id::text
       AND c.post_commit_result->'hand_number' = to_jsonb(c.hand_number)
      RETURNING a.id
    )
    SELECT COALESCE(array_agg(id), '{}') INTO v_rel_ids FROM changed;
    v_released := COALESCE(array_length(v_rel_ids, 1), 0);
  END IF;

  IF p_apply THEN
    UPDATE public.financial_alerts a
       SET resolved = true,
           resolved_at = now(),
           context = COALESCE(a.context, '{}'::jsonb) || jsonb_build_object(
             'resolution', 'settled after the alert was raised; the prize path credited this player for this event',
             'resolved_by_fn', 'fn_resolve_settled_financial_alerts',
             'resolved_on', now(),
             'credited', COALESCE((
               SELECT round(sum(w.amount), 2) FROM public.wallet_transactions w
                WHERE w.related_entity_id = (a.context->>'tournament_id')::uuid
                  AND w.user_id           = (a.context->>'user_id')::uuid
                  AND w.type = 'credit' AND w.category = 'prize'), 0))
     WHERE a.id = ANY(v_paid_ids);

    UPDATE public.financial_alerts a
       SET resolved = true,
           resolved_at = now(),
           context = COALESCE(a.context, '{}'::jsonb) || jsonb_build_object(
             'resolution', 'overpay only; absorbed by the house per CLAUDE.md 10.6 rule 3, never clawed back',
             'resolved_by_fn', 'fn_resolve_settled_financial_alerts',
             'resolved_on', now())
     WHERE a.id = ANY(v_over_ids);
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'applied', p_apply,
    'settled_after_alert', v_paid,
    'overpay_absorbed', v_overpaid,
    'post_commit_applied', v_settled,
    'refused_hand_released', v_released,
    'total', v_paid + v_overpaid + v_settled + v_released,
    'still_unresolved', (SELECT count(*) FROM public.financial_alerts WHERE resolved IS NOT TRUE)
  );
END;
$function$
$post$;
  v_actual text;
  v_target text;
  v_dep jsonb;
  v_rel jsonb;
  v_schema jsonb;
  v_observed jsonb;
  v_pass integer;
BEGIN
  PERFORM set_config('lock_timeout','5s',true);
  PERFORM set_config('search_path','public, pg_temp',true);
  PERFORM pg_advisory_xact_lock(hashtextextended('class4-hand-outcome-evidence:source:v1',0));
  IF current_user <> 'postgres'
     OR md5(v_pre) <> '0874e7e5fa2a2b3b68bc8d3cdc7de8ab'
     OR md5(v_post) <> 'edd4397b2daeadade433cd01a26a1c70'
     OR v_oid IS NULL THEN
    RAISE EXCEPTION 'class4 evidence: owner/embedded preimage/postimage/target mismatch';
  END IF;
  v_actual := pg_get_functiondef(v_oid);
  IF v_actual IS DISTINCT FROM v_pre AND v_actual IS DISTINCT FROM v_post THEN
    RAISE EXCEPTION 'class4 evidence: unexpected target body';
  END IF;
  v_target := CASE WHEN v_rollback THEN v_pre ELSE v_post END;
  FOR v_pass IN 1..2 LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p WHERE p.oid=v_oid
        AND pg_get_userbyid(p.proowner)='postgres' AND p.prosecdef
        AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
        AND p.proacl::text IS NOT DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}'
    ) OR (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace
          AND proname='fn_resolve_settled_financial_alerts') <> 1 THEN
      RAISE EXCEPTION 'class4 evidence: target authority/overload drift';
    END IF;
    FOR v_dep IN SELECT value FROM jsonb_array_elements($dependencies$[{"signature":"fn_ca_commit_hand_settlement_exact_before_obligations(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid)","owner":"postgres","prosecdef":true,"acl":"{postgres=X/postgres}","proconfig":["search_path=public, pg_temp"],"prosrc_md5":"21eee4aac1840bd768592caff4b2c492","definition_md5":"c555fb7b83c889312995bc0038c1b275"},{"signature":"fn_raise_financial_alert(text,text,text,jsonb)","owner":"postgres","prosecdef":true,"acl":"{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}","proconfig":["search_path=public"],"prosrc_md5":"7328d6be0e93399b9b9477b2cae36be5","definition_md5":"2c11cbdc3efbc3676b1d0b48c17d7b85"},{"signature":"fn_raise_server_financial_alert(text,text,text,jsonb,text,text)","owner":"postgres","prosecdef":true,"acl":"{postgres=X/postgres,service_role=X/postgres}","proconfig":["search_path=public"],"prosrc_md5":"13c75f3339f7f21f7dd1345447befab6","definition_md5":"264d32bcba8f6430ea68b7ca9738fbc8"},{"signature":"fn_ca_process_hand_post_commit_obligations(uuid)","owner":"postgres","prosecdef":true,"acl":"{postgres=X/postgres,service_role=X/postgres}","proconfig":["search_path=public, extensions, pg_temp"],"prosrc_md5":"9672653f9e15a45072de3b60ce5b0b2f","definition_md5":"8d18dde12765610895b25e297a1f403f"},{"signature":"fn_ca_alert_resolution_reaches_the_incident()","owner":"postgres","prosecdef":true,"acl":"{postgres=X/postgres,service_role=X/postgres}","proconfig":["search_path=public"],"prosrc_md5":"40ab72a641e2ea070426866e36f626be","definition_md5":"dbe622139f98faf98bca7bc30db0155c"},{"signature":"fn_ca_financial_alert_to_incident()","owner":"postgres","prosecdef":true,"acl":"{postgres=X/postgres,service_role=X/postgres}","proconfig":["search_path=public"],"prosrc_md5":"0a4d20fe06d675a9150e9edc9e1acb1c","definition_md5":"00a43ae03ab12cec9505e2bfed71d937"},{"signature":"fn_ca_guard_watchlist()","owner":"postgres","prosecdef":false,"acl":"{postgres=X/postgres,service_role=X/postgres}","proconfig":["search_path=public"],"definition_md5":"92ee208d0887728444bda396d0b4d442"},{"signature":"fn_ca_commit_hand_settlement_before_lease_generation(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb)","owner":"postgres","prosecdef":true,"acl":"{postgres=X/postgres}","proconfig":["search_path=public, pg_temp"],"prosrc_md5":"1c9a29b3e27345cdaf1704663acd4b25","definition_md5":"7d47c01ec2c1b38f3cf9faeeb686514b"},{"signature":"fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)","owner":"postgres","prosecdef":true,"acl":"{postgres=X/postgres,service_role=X/postgres}","proconfig":["search_path=public, extensions, pg_temp"],"prosrc_md5":"47e924f08a43c440d2711e6e38378371","definition_md5":"8c0acda3b19e958ecd5bbbc07c845afe"}]$dependencies$::jsonb)
    LOOP
      IF NOT EXISTS (
        SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure(v_dep->>'signature')
          AND pg_get_userbyid(p.proowner)=v_dep->>'owner'
          AND p.prosecdef=(v_dep->>'prosecdef')::boolean
          AND to_jsonb(p.proconfig) IS NOT DISTINCT FROM v_dep->'proconfig'
          AND p.proacl::text IS NOT DISTINCT FROM v_dep->>'acl'
          AND md5(pg_get_functiondef(p.oid))=v_dep->>'definition_md5'
      ) THEN
        RAISE EXCEPTION 'class4 evidence: dependency body/authority drift %',v_dep->>'signature';
      END IF;
    END LOOP;
    IF 'fn_resolve_settled_financial_alerts'=ANY(public.fn_ca_guard_watchlist())
       OR EXISTS(SELECT 1 FROM public.ca_guard_defs
                 WHERE proname='fn_resolve_settled_financial_alerts') THEN
      RAISE EXCEPTION 'class4 evidence: explicit unwatchlisted target mode changed';
    END IF;
    FOR v_rel IN SELECT value FROM jsonb_array_elements($relations$[{"nspname":"public","relname":"financial_alerts","relkind":"r","owner":"postgres","acl":"{postgres=arwdDxtm/postgres,anon=rxt/postgres,authenticated=rxt/postgres,service_role=arwdDxtm/postgres}","relrowsecurity":true,"relforcerowsecurity":false,"policies":[{"cmd":"ALL","qual":"true","roles":["service_role"],"tablename":"financial_alerts","permissive":"PERMISSIVE","policyname":"financial_alerts_service_only","schemaname":"public","with_check":"true"}],"triggers":[{"name":"trg_ca_financial_alert_incident","function":"fn_ca_financial_alert_to_incident()","definition":"CREATE TRIGGER trg_ca_financial_alert_incident AFTER INSERT ON public.financial_alerts FOR EACH ROW EXECUTE FUNCTION fn_ca_financial_alert_to_incident()","enabled":"O"},{"name":"zz_ca_alert_resolution_reaches_the_incident","function":"fn_ca_alert_resolution_reaches_the_incident()","definition":"CREATE TRIGGER zz_ca_alert_resolution_reaches_the_incident AFTER UPDATE OF resolved ON public.financial_alerts FOR EACH ROW EXECUTE FUNCTION fn_ca_alert_resolution_reaches_the_incident()","enabled":"O"}]},{"nspname":"public","relname":"hand_atomic_commits","relkind":"r","owner":"postgres","acl":"{postgres=arwdDxtm/postgres,service_role=r/postgres}","relrowsecurity":true,"relforcerowsecurity":false,"policies":null,"triggers":[{"name":"zzzz_f06_accepted_hand","function":"smarter_private.f06_accept_hand()","definition":"CREATE TRIGGER zzzz_f06_accepted_hand AFTER INSERT OR UPDATE OF post_commit_completed_at ON public.hand_atomic_commits FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_accept_hand()","enabled":"O"}]}]$relations$::jsonb)
    LOOP
      IF NOT EXISTS (
        SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
         WHERE n.nspname=v_rel->>'nspname' AND c.relname=v_rel->>'relname'
           AND c.relkind::text=v_rel->>'relkind'
           AND pg_get_userbyid(c.relowner)=v_rel->>'owner'
           AND c.relacl::text IS NOT DISTINCT FROM v_rel->>'acl'
           AND c.relrowsecurity=(v_rel->>'relrowsecurity')::boolean
           AND c.relforcerowsecurity=(v_rel->>'relforcerowsecurity')::boolean
      ) THEN
        RAISE EXCEPTION 'class4 evidence: relation authority drift %',v_rel->>'relname';
      END IF;
      SELECT jsonb_agg(to_jsonb(p) ORDER BY p.policyname) INTO v_observed
        FROM pg_policies p WHERE p.schemaname=v_rel->>'nspname' AND p.tablename=v_rel->>'relname';
      IF v_observed IS DISTINCT FROM NULLIF(v_rel->'policies','null'::jsonb) THEN
        RAISE EXCEPTION 'class4 evidence: relation policy drift %',v_rel->>'relname';
      END IF;
      SELECT jsonb_agg(jsonb_build_object(
          'name',t.tgname,'definition',pg_get_triggerdef(t.oid),'enabled',t.tgenabled::text,
          'function',t.tgfoid::regprocedure::text) ORDER BY t.tgname)
        INTO v_observed FROM pg_trigger t
       WHERE t.tgrelid=to_regclass(format('%I.%I',v_rel->>'nspname',v_rel->>'relname'))
         AND NOT t.tgisinternal;
      IF v_observed IS DISTINCT FROM NULLIF(v_rel->'triggers','null'::jsonb) THEN
        RAISE EXCEPTION 'class4 evidence: relation trigger drift %',v_rel->>'relname';
      END IF;
    END LOOP;
    FOR v_schema IN SELECT value FROM jsonb_array_elements($schema$[{"relname":"financial_alerts","columns":[{"name":"id","type":"uuid","default":"gen_random_uuid()","not_null":true},{"name":"severity","type":"text","default":null,"not_null":true},{"name":"source","type":"text","default":null,"not_null":true},{"name":"message","type":"text","default":null,"not_null":true},{"name":"context","type":"jsonb","default":"'{}'::jsonb","not_null":false},{"name":"resolved","type":"boolean","default":"false","not_null":true},{"name":"resolved_at","type":"timestamp with time zone","default":null,"not_null":false},{"name":"created_at","type":"timestamp with time zone","default":"now()","not_null":true},{"name":"resolved_by","type":"uuid","default":null,"not_null":false},{"name":"resolution","type":"text","default":null,"not_null":false}],"constraints":[{"name":"financial_alerts_pkey","type":"p","definition":"PRIMARY KEY (id)"},{"name":"financial_alerts_resolved_by_fkey","type":"f","definition":"FOREIGN KEY (resolved_by) REFERENCES auth.users(id)"},{"name":"financial_alerts_severity_check","type":"c","definition":"CHECK ((severity = ANY (ARRAY['critical'::text, 'warning'::text, 'info'::text])))"}],"indexes":[{"name":"financial_alerts_incident_id_idx","definition":"CREATE INDEX financial_alerts_incident_id_idx ON public.financial_alerts USING btree (((context ->> 'incident_id'::text))) WHERE (context ? 'incident_id'::text)"},{"name":"financial_alerts_incident_uuid_idx","definition":"CREATE INDEX financial_alerts_incident_uuid_idx ON public.financial_alerts USING btree ((((context ->> 'incident_id'::text))::uuid)) WHERE ((context ->> 'incident_id'::text) ~ '^[0-9a-fA-F-]{36}$'::text)"},{"name":"financial_alerts_pkey","definition":"CREATE UNIQUE INDEX financial_alerts_pkey ON public.financial_alerts USING btree (id)"},{"name":"financial_alerts_unresolved_source_idx","definition":"CREATE INDEX financial_alerts_unresolved_source_idx ON public.financial_alerts USING btree (source) WHERE (NOT resolved)"},{"name":"idx_financial_alerts_reported_by_created","definition":"CREATE INDEX idx_financial_alerts_reported_by_created ON public.financial_alerts USING btree (((context ->> 'reported_by'::text)), created_at DESC)"},{"name":"idx_financial_alerts_resolved","definition":"CREATE INDEX idx_financial_alerts_resolved ON public.financial_alerts USING btree (resolved) WHERE (resolved = false)"},{"name":"idx_financial_alerts_resolved_by","definition":"CREATE INDEX idx_financial_alerts_resolved_by ON public.financial_alerts USING btree (resolved_by)"},{"name":"idx_financial_alerts_severity","definition":"CREATE INDEX idx_financial_alerts_severity ON public.financial_alerts USING btree (severity)"},{"name":"idx_financial_alerts_source_created","definition":"CREATE INDEX idx_financial_alerts_source_created ON public.financial_alerts USING btree (source, created_at DESC)"}]},{"relname":"hand_atomic_commits","columns":[{"name":"table_id","type":"uuid","default":null,"not_null":true},{"name":"hand_number","type":"bigint","default":null,"not_null":true},{"name":"hand_id","type":"uuid","default":null,"not_null":true},{"name":"payload_hash","type":"text","default":null,"not_null":true},{"name":"stack_result","type":"jsonb","default":null,"not_null":true},{"name":"committed_at","type":"timestamp with time zone","default":"clock_timestamp()","not_null":true},{"name":"post_commit_payload","type":"jsonb","default":null,"not_null":false},{"name":"post_commit_request_hash","type":"text","default":null,"not_null":false},{"name":"post_commit_payload_hash","type":"text","default":null,"not_null":false},{"name":"post_commit_completed_at","type":"timestamp with time zone","default":null,"not_null":false},{"name":"post_commit_result","type":"jsonb","default":null,"not_null":false}],"constraints":[{"name":"hand_atomic_commits_hand_id_key","type":"u","definition":"UNIQUE (hand_id)"},{"name":"hand_atomic_commits_hand_number_check","type":"c","definition":"CHECK ((hand_number >= 1000000))"},{"name":"hand_atomic_commits_hand_number_key","type":"u","definition":"UNIQUE (hand_number)"},{"name":"hand_atomic_commits_payload_hash_check","type":"c","definition":"CHECK ((payload_hash ~ '^[0-9a-f]{64}$'::text))"},{"name":"hand_atomic_commits_pkey","type":"p","definition":"PRIMARY KEY (table_id, hand_number)"}],"indexes":[{"name":"hand_atomic_commits_hand_id_key","definition":"CREATE UNIQUE INDEX hand_atomic_commits_hand_id_key ON public.hand_atomic_commits USING btree (hand_id)"},{"name":"hand_atomic_commits_hand_number_key","definition":"CREATE UNIQUE INDEX hand_atomic_commits_hand_number_key ON public.hand_atomic_commits USING btree (hand_number)"},{"name":"hand_atomic_commits_pkey","definition":"CREATE UNIQUE INDEX hand_atomic_commits_pkey ON public.hand_atomic_commits USING btree (table_id, hand_number)"},{"name":"idx_hand_atomic_commits_post_commit_pending","definition":"CREATE INDEX idx_hand_atomic_commits_post_commit_pending ON public.hand_atomic_commits USING btree (table_id, hand_number) WHERE ((post_commit_payload IS NOT NULL) AND (post_commit_completed_at IS NULL))"}]}]$schema$::jsonb)
    LOOP
      SELECT jsonb_agg(jsonb_build_object(
          'name',a.attname,'type',format_type(a.atttypid,a.atttypmod),
          'not_null',a.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum)
        INTO v_observed FROM pg_attribute a LEFT JOIN pg_attrdef d
          ON d.adrelid=a.attrelid AND d.adnum=a.attnum
       WHERE a.attrelid=to_regclass(format('public.%I',v_schema->>'relname'))
         AND a.attnum>0 AND NOT a.attisdropped;
      IF v_observed IS DISTINCT FROM v_schema->'columns' THEN
        RAISE EXCEPTION 'class4 evidence: consumed schema/default drift %',v_schema->>'relname';
      END IF;
      SELECT jsonb_agg(jsonb_build_object(
          'name',x.conname,'type',x.contype,'definition',pg_get_constraintdef(x.oid)) ORDER BY x.conname)
        INTO v_observed FROM pg_constraint x
       WHERE x.conrelid=to_regclass(format('public.%I',v_schema->>'relname'));
      IF v_observed IS DISTINCT FROM v_schema->'constraints' THEN
        RAISE EXCEPTION 'class4 evidence: identity/constraint drift %',v_schema->>'relname';
      END IF;
      SELECT jsonb_agg(jsonb_build_object('name',i.indexname,'definition',i.indexdef) ORDER BY i.indexname)
        INTO v_observed FROM pg_indexes i
       WHERE i.schemaname='public' AND i.tablename=v_schema->>'relname';
      IF v_observed IS DISTINCT FROM v_schema->'indexes'
         OR EXISTS(SELECT 1 FROM pg_index x WHERE x.indrelid=to_regclass(format('public.%I',v_schema->>'relname'))
                   AND (NOT x.indisvalid OR NOT x.indisready)) THEN
        RAISE EXCEPTION 'class4 evidence: index drift %',v_schema->>'relname';
      END IF;
    END LOOP;
    IF v_pass=1 THEN
      IF v_actual IS DISTINCT FROM v_target THEN EXECUTE v_target; END IF;
    ELSIF pg_get_functiondef(v_oid) IS DISTINCT FROM v_target THEN
      RAISE EXCEPTION 'class4 evidence: exact target readback failed';
    END IF;
  END LOOP;
END
$component$;
