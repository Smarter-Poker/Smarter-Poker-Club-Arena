-- A SATELLITE THAT DELIVERED ITS SEAT OR WAS CASH SETTLED STOPS PAGING THE
-- FINISH REFUSAL.
--
-- Production Alerts board: operational_alert_events id=8, MoneyAlertsGoingUnread.
-- The prior migration in this chain (20260923184855, PR #5145) added CLASS 5
-- for the two non-satellite finish-refusal sources and deliberately left the
-- satellite sources untouched, because a satellite's payout is a seat or
-- ticket awarded, not necessarily a single wallet prize credit - CLASS 1's
-- proof shape does not automatically transfer, and assuming it does without
-- checking would repeat the exact mistake that migration fixed. This is that
-- follow-up, reading the satellite award path on its own terms as promised.
--
-- READ LIVE, not assumed: Tournament.atomic_satellite_finish_refused carries
-- 469 unresolved rows across 39 distinct (tournament_id, winner_id) pairs, and
-- its sibling Tournament.atomic_satellite_finish_outcome_unknown carries 8.
-- Checked two independent proofs, per row, against this alert's own named
-- tournament_id and winner_id:
--
--   (a) tournament_satellite_awards has a row for that exact
--       (tournament_id, user_id) pair - the normal path: a seat or ticket into
--       the target event was actually delivered. 467 of 469 satellite_refused
--       rows and 8 of 8 outcome_unknown rows prove this way.
--
--   (b) a DIFFERENT financial_alerts row for the identical
--       (source, tournament_id, winner_id) triple is already resolved=true.
--       Needed for exactly 2 of the 469: satellite 9fee70de-c692-48fb-
--       a423-98d730ab02bc's place-1 ticket had "no exact target club", so it
--       was terminal-settled as CASH instead of a seat award (resolution on
--       row ba1c42e7, 2026-09-10, via fn_settle_satellite_finish_atomic after
--       a fix, migration 20260910023919) - which correctly never wrote to
--       tournament_satellite_awards, so proof (a) alone would have left this
--       pair's two earlier duplicate alert rows open forever even though the
--       winner was paid.
--
-- Every one of the 477 unresolved rows across both sources is covered by (a)
-- or (b); none were found with neither. This is not "most of the backlog" -
-- it is the whole of these two sources, proven per row, not from elapsed time
-- or the tournament's own status.
--
-- Satellite.seat_origin_unknown, Satellite.seat_outcome_unconfirmed and
-- Satellite.stuck_completing_unawarded (533 rows) are a different failure
-- shape - a satellite that never finished at all, not one whose finish was
-- refused and later resolved - and are deliberately left open here.
--
-- HARDENING (CLAUDE.md 10.11/10.12): extends the same existing resolver on
-- its existing 20-minute cron (ca-resolve-settled-alerts-20m) - no new
-- function, no new cron, no compensating write. This migration restates
-- CLASS 1-5 verbatim from 20260923184855 so it is correct and self-sufficient
-- regardless of merge order relative to PR #5145: CREATE OR REPLACE always
-- rewrites the whole function body, so if this migration lands first it does
-- not regress CLASS 5, and if 20260923184855 lands first this one's identical
-- restatement of CLASS 1-5 is a no-op before it adds CLASS 6.
-- server/src/tournament/ASatelliteThatDeliveredStopsPagingTheRefusal.guard.test.ts
-- pins the exact SQL added. Detection needs nothing new: MoneyAlertsGoingUnread
-- already measures the backlog this closes a further 477 rows of.

DO $$
DECLARE
  v_oid oid := to_regprocedure('public.fn_resolve_settled_financial_alerts(boolean,integer)');
BEGIN
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'fn_resolve_settled_financial_alerts not found - this migration extends an existing function';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.fn_resolve_settled_financial_alerts(p_apply boolean DEFAULT false, p_limit integer DEFAULT 5000)
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
  v_finish    integer := 0;
  v_sat       integer := 0;
  v_paid_ids  uuid[] := '{}';
  v_over_ids  uuid[] := '{}';
  v_settled_ids uuid[] := '{}';
  v_rel_ids   uuid[] := '{}';
  v_finish_ids uuid[] := '{}';
  v_sat_ids   uuid[] := '{}';
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

  -- ── CLASS 5: a tournament's terminal settlement was refused (or its outcome
  -- left ambiguous) by one attempt, but the exact winner this alert named has
  -- since been credited a prize for this exact tournament - the manager's own
  -- retry (finishRetryDelayMs backoff in TournamentManagerEliminations.ts)
  -- landed. Proven the same way CLASS 1 proves it: a wallet_transactions
  -- credit, not the tournament's own later status and not elapsed time. Only
  -- non-satellite finishes; the satellite sources are CLASS 6, below.
  SELECT array_agg(id) INTO v_finish_ids FROM (
    SELECT a.id
      FROM public.financial_alerts a
     WHERE a.resolved IS NOT TRUE
       AND a.source IN ('Tournament.atomic_finish_refused', 'Tournament.atomic_finish_outcome_unknown')
       AND a.context->>'tournament_id' IS NOT NULL
       AND a.context->>'winner_id' IS NOT NULL
       AND EXISTS (
             SELECT 1 FROM public.wallet_transactions w
              WHERE w.related_entity_id = (a.context->>'tournament_id')::uuid
                AND w.user_id           = (a.context->>'winner_id')::uuid
                AND w.type = 'credit' AND w.category = 'prize')
     LIMIT p_limit
  ) s;
  v_finish := COALESCE(array_length(v_finish_ids, 1), 0);

  -- ── CLASS 6: a satellite's terminal settlement was refused (or its outcome
  -- left ambiguous), but the exact (tournament_id, winner_id) this alert named
  -- has since been settled by one of the satellite path's two legitimate
  -- terminal outcomes:
  --   (a) tournament_satellite_awards carries the delivered seat/ticket, or
  --   (b) a different financial_alerts row for the identical
  --       (source, tournament_id, winner_id) is already resolved=true, which
  --       covers the "no exact target club" cash-settlement path that never
  --       writes to tournament_satellite_awards (see migration header).
  -- Deliberately does NOT accept the tournament's own status or elapsed time
  -- as proof, for the same reason CLASS 5 does not: neither is independent of
  -- the manager's own retries.
  SELECT array_agg(id) INTO v_sat_ids FROM (
    SELECT a.id
      FROM public.financial_alerts a
     WHERE a.resolved IS NOT TRUE
       AND a.source IN ('Tournament.atomic_satellite_finish_refused',
                        'Tournament.atomic_satellite_finish_outcome_unknown')
       AND a.context->>'tournament_id' IS NOT NULL
       AND a.context->>'winner_id' IS NOT NULL
       AND (
             EXISTS (
               SELECT 1 FROM public.tournament_satellite_awards sa
                WHERE sa.tournament_id = (a.context->>'tournament_id')::uuid
                  AND sa.user_id       = (a.context->>'winner_id')::uuid)
             OR EXISTS (
               SELECT 1 FROM public.financial_alerts sib
                WHERE sib.resolved = true
                  AND sib.source = a.source
                  AND sib.context->>'tournament_id' = a.context->>'tournament_id'
                  AND sib.context->>'winner_id'      = a.context->>'winner_id'
                  AND sib.id <> a.id)
           )
     LIMIT p_limit
  ) s;
  v_sat := COALESCE(array_length(v_sat_ids, 1), 0);

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

    UPDATE public.financial_alerts a
       SET resolved = true,
           resolved_at = now(),
           context = COALESCE(a.context, '{}'::jsonb) || jsonb_build_object(
             'resolution', 'the named winner has since been credited a prize for this exact tournament; the manager''s own retry that followed this refusal landed',
             'resolved_by_fn', 'fn_resolve_settled_financial_alerts',
             'resolved_on', now(),
             'credited', COALESCE((
               SELECT round(sum(w.amount), 2) FROM public.wallet_transactions w
                WHERE w.related_entity_id = (a.context->>'tournament_id')::uuid
                  AND w.user_id           = (a.context->>'winner_id')::uuid
                  AND w.type = 'credit' AND w.category = 'prize'), 0))
     WHERE a.id = ANY(v_finish_ids);

    UPDATE public.financial_alerts a
       SET resolved = true,
           resolved_at = now(),
           context = COALESCE(a.context, '{}'::jsonb) || jsonb_build_object(
             'resolution', 'the named winner''s satellite outcome for this exact tournament is proven settled: either tournament_satellite_awards carries the delivered seat/ticket, or an identical (source, tournament_id, winner_id) alert is already resolved (e.g. a cash settlement made when no exact target club existed)',
             'resolved_by_fn', 'fn_resolve_settled_financial_alerts',
             'resolved_on', now(),
             'award_proof', EXISTS (
               SELECT 1 FROM public.tournament_satellite_awards sa
                WHERE sa.tournament_id = (a.context->>'tournament_id')::uuid
                  AND sa.user_id       = (a.context->>'winner_id')::uuid))
     WHERE a.id = ANY(v_sat_ids);
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'applied', p_apply,
    'settled_after_alert', v_paid,
    'overpay_absorbed', v_overpaid,
    'post_commit_applied', v_settled,
    'refused_hand_released', v_released,
    'finish_refusal_settled', v_finish,
    'satellite_finish_settled', v_sat,
    'total', v_paid + v_overpaid + v_settled + v_released + v_finish + v_sat,
    'still_unresolved', (SELECT count(*) FROM public.financial_alerts WHERE resolved IS NOT TRUE)
  );
END;
$function$
;

-- Restate the browser-exposure lock every CREATE OR REPLACE of this function
-- has carried since 20260903060000_an_alarm_a_player_can_switch_off_is_not_an_alarm.sql.
-- CREATE OR REPLACE preserves the live ACL, so this is a no-op against
-- production; it exists so the migration file itself is never silent about a
-- SECURITY DEFINER routine's grants (check-definer-authorization).
REVOKE ALL ON FUNCTION public.fn_resolve_settled_financial_alerts(boolean, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_resolve_settled_financial_alerts(boolean, integer) TO service_role;

-- VERIFY: the function still validates, and CLASS 6 is present in a dry run
-- (p_apply => false performs no writes; this is a read-only sanity check, not
-- a probe that needs rollback).
DO $$
DECLARE
  v_result jsonb;
BEGIN
  v_result := public.fn_resolve_settled_financial_alerts(false, 5000);
  IF v_result IS NULL OR NOT (v_result ? 'satellite_finish_settled') THEN
    RAISE EXCEPTION 'fn_resolve_settled_financial_alerts did not take CLASS 6 (satellite_finish_settled missing from result)';
  END IF;
  RAISE NOTICE 'fn_resolve_settled_financial_alerts dry run: %', v_result;
END $$;
