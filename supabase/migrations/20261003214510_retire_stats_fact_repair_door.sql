-- 20261003214510_retire_stats_fact_repair_door
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-10-03 21:45:10 UTC.
--
-- CLAUDE.md 10.9: the reasoning goes in this header, not just the SQL.
-- Say what was wrong, what this changes, and what you measured. A
-- migration whose header is its own filename is the next agent's mystery.
-- The accepted-hand transaction now writes a durable outbox claim and the
-- projector writes canonical facts plus an immutable receipt before that
-- claim can be deleted. The older checkpoint scanner is therefore both
-- unnecessary and unsafe: it provides a second writer after settlement and
-- cannot create truthful private facts for protocol-1 history.
--
-- Replace the aggregate-only operational RPC first so it no longer depends
-- on scanner state, then remove the live function and state table. Historical
-- coverage remains explicitly unavailable instead of being reconstructed.

BEGIN;

SET LOCAL lock_timeout = '250ms';
SET LOCAL statement_timeout = '0';

CREATE OR REPLACE FUNCTION public.ca_stats_operational_quality()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
SET statement_timeout TO '5s'
AS $function$
DECLARE
  v_outbox_depth bigint;
  v_oldest timestamptz;
  v_missing_receipts bigint;
  v_failures jsonb;
  v_failure_total bigint;
  v_unresolved_failure_hands bigint;
  v_last_failure timestamptz;
  v_revisions jsonb;
  v_last_revision timestamptz;
  v_last_projected_at timestamptz;
  v_last_projected_hand_number bigint;
  v_last_projection_latency_seconds bigint;
  v_accepted_fact_payloads bigint;
  v_projection_receipts bigint;
BEGIN
  IF current_user NOT IN ('postgres', 'service_role') THEN
    RAISE EXCEPTION 'ca_stats_operational_quality is service only'
      USING ERRCODE = '42501';
  END IF;

  SELECT count(*), min(created_at)
    INTO v_outbox_depth, v_oldest
    FROM public.hand_projection_outbox;

  SELECT count(*)
    INTO v_missing_receipts
    FROM public.hand_projection_outbox o
    JOIN public.hand_atomic_commits c ON c.hand_id = o.hand_id
    LEFT JOIN public.ca_hand_fact_projection_receipts r ON r.hand_id = o.hand_id
   WHERE c.post_commit_payload #> '{accepted_hand_facts,stats_facts}' IS NOT NULL
     AND r.hand_id IS NULL;

  SELECT COALESCE(jsonb_object_agg(failure_code, failures), '{}'::jsonb),
         COALESCE(sum(failures), 0),
         max(last_failed_at)
    INTO v_failures, v_failure_total, v_last_failure
    FROM (
      SELECT failure_code, sum(failure_count)::bigint AS failures,
             max(last_failed_at) AS last_failed_at
        FROM public.ca_stats_projection_failure_receipts
       GROUP BY failure_code
    ) grouped;

  SELECT count(DISTINCT f.hand_id)
    INTO v_unresolved_failure_hands
    FROM public.ca_stats_projection_failure_receipts f
    WHERE EXISTS (
      SELECT 1 FROM public.hand_projection_outbox o WHERE o.hand_id = f.hand_id
    );

  SELECT COALESCE(jsonb_object_agg(kind, revisions), '{}'::jsonb),
         max(last_created_at)
    INTO v_revisions, v_last_revision
    FROM (
      SELECT kind, count(*)::bigint AS revisions, max(created_at) AS last_created_at
        FROM public.ca_hand_fact_revisions
       GROUP BY kind
    ) grouped;

  SELECT count(*)
    INTO v_projection_receipts
    FROM public.ca_hand_fact_projection_receipts;

  -- Every protocol-2 accepted payload is either already receipted or is still
  -- on the bounded outbox working set above. Counting all historical atomic
  -- commits would turn this five-second health door into an unbounded scan.
  v_accepted_fact_payloads := v_projection_receipts + v_missing_receipts;

  SELECT r.projected_at, c.hand_number,
         GREATEST(0, extract(epoch FROM r.projected_at - c.committed_at)::bigint)
    INTO v_last_projected_at, v_last_projected_hand_number,
         v_last_projection_latency_seconds
    FROM public.ca_hand_fact_projection_receipts r
    JOIN public.hand_atomic_commits c ON c.hand_id = r.hand_id
   ORDER BY r.projected_at DESC
   LIMIT 1;

  RETURN jsonb_build_object(
    'contract_version', 2,
    'generated_at', statement_timestamp(),
    'projection_outbox', jsonb_build_object(
      'depth', v_outbox_depth,
      'oldest_created_at', v_oldest,
      'oldest_lag_seconds', CASE WHEN v_oldest IS NULL THEN 0 ELSE
        GREATEST(0, extract(epoch FROM statement_timestamp() - v_oldest)::bigint) END,
      'missing_current_fact_receipts', v_missing_receipts
    ),
    'data_through', jsonb_build_object(
      'last_projected_at', v_last_projected_at,
      'last_projected_hand_number', v_last_projected_hand_number,
      'last_projection_latency_seconds', v_last_projection_latency_seconds,
      'age_seconds', CASE WHEN v_last_projected_at IS NULL THEN NULL ELSE
        GREATEST(0, extract(epoch FROM statement_timestamp() - v_last_projected_at)::bigint) END
    ),
    'fact_projection', jsonb_build_object(
      'accepted_payloads', v_accepted_fact_payloads,
      'projection_receipts', v_projection_receipts,
      'missing_current_fact_receipts', v_missing_receipts,
      'legacy_history', jsonb_build_object(
        'available', false,
        'reason', 'protocol1_private_facts_not_reconstructable'
      )
    ),
    'projection_failures', jsonb_build_object(
      'failure_attempts_total', v_failure_total,
      'hands_still_pending', v_unresolved_failure_hands,
      'by_code', v_failures,
      'last_failed_at', v_last_failure
    ),
    'fact_revisions', jsonb_build_object(
      'by_kind', v_revisions,
      'last_created_at', v_last_revision,
      'failures', jsonb_build_object(
        'available', false,
        'reason', 'no_authoritative_revision_failure_receipt'
      )
    )
  );
END
$function$;

REVOKE ALL ON FUNCTION public.ca_stats_operational_quality()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ca_stats_operational_quality()
  TO service_role;

DROP FUNCTION IF EXISTS public.ca_reconcile_missing_hand_facts(integer);
DROP TABLE IF EXISTS public.ca_hand_fact_reconcile_state;

COMMIT;
