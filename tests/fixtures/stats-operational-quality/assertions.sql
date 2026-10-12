\set ON_ERROR_STOP on

DO $assert_privileges$
BEGIN
  IF to_regprocedure('public.ca_reconcile_missing_hand_facts(integer)') IS NOT NULL
     OR to_regclass('public.ca_hand_fact_reconcile_state') IS NOT NULL THEN
    RAISE EXCEPTION 'Stats repair door still exists';
  END IF;
  IF has_function_privilege('authenticated', 'public.ca_stats_operational_quality()', 'EXECUTE')
     OR has_function_privilege(
       'authenticated',
       'public.ca_record_stats_projection_failure(uuid,bigint,text)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'browser role retained Stats operations access';
  END IF;
  IF has_table_privilege(
    'authenticated', 'public.ca_stats_projection_failure_receipts', 'SELECT'
  ) THEN
    RAISE EXCEPTION 'browser role retained Stats failure receipt access';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.ca_stats_operational_quality()', 'EXECUTE')
     OR NOT has_function_privilege(
       'service_role',
       'public.ca_record_stats_projection_failure(uuid,bigint,text)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'service role lacks Stats operations access';
  END IF;
END
$assert_privileges$;

INSERT INTO public.hand_atomic_commits(hand_id, hand_number, post_commit_payload) VALUES
  ('10000000-0000-0000-0000-000000000001', 1000001,
   '{"accepted_hand_facts":{"stats_facts":{"version":2,"facts":[],"transfers":[]}}}'),
  ('10000000-0000-0000-0000-000000000002', 1000002, '{}'),
  ('10000000-0000-0000-0000-000000000003', 1000003,
   '{"accepted_hand_facts":{"stats_facts":{"version":2,"facts":[],"transfers":[]}}}');

INSERT INTO public.hand_projection_outbox(hand_id, table_id, hand_number, created_at) VALUES
  ('10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001',
   1000001, statement_timestamp() - interval '2 minutes'),
  ('10000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000002',
   1000002, statement_timestamp() - interval '1 minute');

INSERT INTO public.ca_hand_fact_projection_receipts(
  hand_id, source_hash, fact_count, transfer_count, projected_at
) VALUES (
  '10000000-0000-0000-0000-000000000003', repeat('a',64), 1, 0,
  statement_timestamp()
);

INSERT INTO public.ca_hand_fact_revisions(id, kind, created_at) VALUES
  ('30000000-0000-0000-0000-000000000001', 'correction', statement_timestamp()),
  ('30000000-0000-0000-0000-000000000002', 'refund', statement_timestamp());

SELECT public.ca_record_stats_projection_failure(
  '10000000-0000-0000-0000-000000000001', 1000001, 'source_hash_conflict'
);
SELECT public.ca_record_stats_projection_failure(
  '10000000-0000-0000-0000-000000000001', 1000001, 'source_hash_conflict'
);
SELECT public.ca_record_stats_projection_failure(
  '10000000-0000-0000-0000-000000000002', 1000002, 'projection_rpc_failure'
);

DO $assert_invalid_receipt$
BEGIN
  BEGIN
    PERFORM public.ca_record_stats_projection_failure(
      '10000000-0000-0000-0000-000000000001', 1000001, 'raw secret error text'
    );
    RAISE EXCEPTION 'invalid failure category was accepted';
  EXCEPTION WHEN SQLSTATE '22023' THEN
    NULL;
  END;
END
$assert_invalid_receipt$;

DO $assert_quality$
DECLARE
  q jsonb := public.ca_stats_operational_quality();
BEGIN
  IF q->>'contract_version' <> '2'
     OR (q#>>'{projection_outbox,depth}')::bigint <> 2
     OR (q#>>'{projection_outbox,missing_current_fact_receipts}')::bigint <> 1
     OR (q#>>'{projection_outbox,oldest_lag_seconds}')::bigint < 110
     OR (q#>>'{data_through,last_projected_hand_number}')::bigint <> 1000003
     OR (q#>>'{data_through,age_seconds}')::bigint > 5
     OR (q#>>'{fact_projection,accepted_payloads}')::bigint <> 2
     OR (q#>>'{fact_projection,projection_receipts}')::bigint <> 1
     OR (q#>>'{fact_projection,missing_current_fact_receipts}')::bigint <> 1
     OR (q#>>'{fact_projection,legacy_history,available}')::boolean IS DISTINCT FROM false
     OR q#>>'{fact_projection,legacy_history,reason}' <> 'protocol1_private_facts_not_reconstructable'
     OR (q#>>'{projection_failures,failure_attempts_total}')::bigint <> 3
     OR (q#>>'{projection_failures,hands_still_pending}')::bigint <> 2
     OR (q#>>'{projection_failures,by_code,source_hash_conflict}')::bigint <> 2
     OR (q#>>'{projection_failures,by_code,projection_rpc_failure}')::bigint <> 1
     OR (q#>>'{fact_revisions,by_kind,correction}')::bigint <> 1
     OR (q#>>'{fact_revisions,by_kind,refund}')::bigint <> 1
     OR (q#>>'{fact_revisions,failures,available}')::boolean IS DISTINCT FROM false
  THEN
    RAISE EXCEPTION 'unexpected Stats operational quality payload: %', q;
  END IF;
  IF q::text LIKE '%10000000-0000-0000-0000-000000000001%'
     OR q ? 'hand_id' OR q ? 'club_id' OR q ? 'player_id' OR q ? 'table_id' THEN
    RAISE EXCEPTION 'Stats operational quality payload leaked private identity: %', q;
  END IF;
END
$assert_quality$;

SELECT 'stats operational quality fixture: PASS' AS result;
