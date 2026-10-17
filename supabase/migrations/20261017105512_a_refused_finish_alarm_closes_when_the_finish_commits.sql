-- 20261017105512_a_refused_finish_alarm_closes_when_the_finish_commits
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-10-17 10:55:12 UTC.
--
-- A REFUSED FINISH ALARM CLOSES WHEN THE FINISH COMMITS (2026-10-17)
--
-- When the engine's atomic tournament finish is refused, it raises
-- Tournament.atomic_finish_refused or Tournament.atomic_satellite_finish_refused
-- and retries. When a retry commits, nothing closed the alarm. The one closer
-- that existed (fn_ca_tournament_finished_but_not_completed) admits only
-- timeout and deadlock refusals of ordinary tournaments, so every rule refusal
-- and every satellite refusal stayed open until someone closed it by hand:
-- 18,778 rows of the two sources so far. The open one on 2026-10-17 is
-- Satellite 10 (a4445447). Its refusal (diamond_satellite_winner_at_the_table_cap,
-- 01:32:14) was fixed by 20261017033733, and the satellite then COMPLETED at
-- 03:41:13 with satellite settlement receipt v2, its escrow closed at zero,
-- and its winner paid.
--
-- fn_resolve_settled_financial_alerts (cron 354 at :04/:24/:44, cron 227 at
-- :18) gains CLASS 6, which closes a PROVEN refusal only on the evidence that
-- the refused finish later committed:
--   - the named tournament is COMPLETED;
--   - its escrow is terminally closed at zero (prize and bounty) at or after
--     the moment the alarm was raised;
--   - a satellite has its satellite settlement receipt; any other tournament
--     has its terminal receipt (tournament_terminal_settlements).
-- An unproven or unknown outcome, a malformed id, a tournament in any other
-- state, an escrow still holding chips, or an escrow closed before the alarm
-- stays open. The predicate is repeated under the UPDATE. Classes 1-5 are
-- byte-for-byte unchanged.
--
-- Measured 2026-10-17 10:50 UTC: the class-6 preview takes 31 ms (on
-- idx_financial_alerts_source_created and the receipts' primary keys) and
-- would close exactly one alarm, Satellite 10's 0f1ae2ff. Verified on native
-- Postgres: the preimage (8adc7dfe...) and postimage read back byte-identical,
-- and eight fixture cases close exactly the two whose finish committed.
--
-- GUARDS: refuses in the break window; the live body must be the exact
-- preimage or already the postimage; owner, SECURITY DEFINER, search_path and
-- ACL are checked before and after; the readback must be the exact
-- postimage; the service-role-only grant is restated and read back. This
-- migration closes no alarm itself; the next resolver run does.
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_resolve_settled_financial_alerts(boolean,integer)'::regprocedure))) = '24a8270d08af6a1f54a7ed57154ec625'

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

DO $pre$
DECLARE v_reason text;
BEGIN
  v_reason := public.fn_ca_break_window_refuses_migrations(now());
  IF v_reason IS NOT NULL THEN
    RAISE EXCEPTION 'REFUSED_FINISH_ALARM_CLOSER_REFUSED: %', v_reason USING ERRCODE = '55000';
  END IF;
END
$pre$;

DO $component$
DECLARE
  v_oid oid := to_regprocedure('public.fn_resolve_settled_financial_alerts(boolean,integer)');
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
  v_ops       integer := 0;
  v_ops_ids   uuid[] := '{}';
  v_fin       integer := 0;
  v_fin_ids   uuid[] := '{}';
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

  -- CLASS 5: a tournament operational alarm whose condition has ended. A
  -- "table can't start" alarm is over when that table has committed a hand
  -- since the alarm, or is closed; a "tournament dark after rebuild" alarm is
  -- over when any of its tables has committed a hand since the alarm. Either
  -- is over when the tournament reached COMPLETED or CANCELLED. Money is not
  -- this class's evidence: a completed event's payout has its own alarm
  -- (class 1, fn_payout_guarantee_check), which this never touches.
  SELECT COALESCE(array_agg(id), '{}') INTO v_ops_ids FROM (
    SELECT a.id
      FROM public.financial_alerts a, public.tournaments t
     WHERE a.resolved IS NOT TRUE
       AND a.source IN ('Tournament.table_admission_failing',
                        'GameServer.tournament_dark_after_rebuild')
       AND t.id = CASE WHEN (a.context->>'tournament_id') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
                       THEN (a.context->>'tournament_id')::uuid END
       AND (
             t.status IN ('COMPLETED', 'CANCELLED')
          OR (a.source = 'Tournament.table_admission_failing'
              AND EXISTS (
                    SELECT 1 FROM public.tables tb
                     WHERE tb.id = CASE WHEN (a.context->>'table_id') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
                                        THEN (a.context->>'table_id')::uuid END
                       AND tb.tournament_id = t.id
                       AND (lower(tb.status) = 'closed'
                            OR EXISTS (SELECT 1 FROM public.hand_atomic_commits c
                                        WHERE c.table_id = tb.id
                                          AND c.committed_at > a.created_at))))
          OR (a.source = 'GameServer.tournament_dark_after_rebuild'
              AND EXISTS (
                    SELECT 1 FROM public.tables tb
                      JOIN public.hand_atomic_commits c ON c.table_id = tb.id
                     WHERE tb.tournament_id = t.id
                       AND c.committed_at > a.created_at))
           )
     ORDER BY a.created_at, a.id
     LIMIT p_limit
  ) s;
  v_ops := COALESCE(array_length(v_ops_ids, 1), 0);

  IF p_apply THEN
    -- The whole predicate again under UPDATE: a preview is not authority.
    WITH changed AS (
      UPDATE public.financial_alerts a
         SET resolved = true, resolved_at = now(),
             resolution = CASE
               WHEN t.status IN ('COMPLETED', 'CANCELLED')
                 THEN 'verified: tournament ' || t.id::text || ' reached ' || t.status
                   || COALESCE(' at ' || t.ended_at::text, '') || '; the alarm''s condition has ended.'
               WHEN a.source = 'Tournament.table_admission_failing'
                 THEN 'verified: table ' || (a.context->>'table_id')
                   || ' committed a hand or closed after this alarm; the table was admitted.'
               ELSE 'verified: tournament ' || t.id::text
                   || ' committed a hand after this alarm; it is dealing again.'
             END,
             context = COALESCE(a.context, '{}'::jsonb) || jsonb_build_object(
               'resolved_by_fn', 'fn_resolve_settled_financial_alerts',
               'resolved_on', now(),
               'tournament_status_at_resolution', t.status)
        FROM public.tournaments t
       WHERE a.id = ANY(v_ops_ids)
         AND a.resolved IS NOT TRUE
       AND a.source IN ('Tournament.table_admission_failing',
                        'GameServer.tournament_dark_after_rebuild')
       AND t.id = CASE WHEN (a.context->>'tournament_id') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
                       THEN (a.context->>'tournament_id')::uuid END
       AND (
             t.status IN ('COMPLETED', 'CANCELLED')
          OR (a.source = 'Tournament.table_admission_failing'
              AND EXISTS (
                    SELECT 1 FROM public.tables tb
                     WHERE tb.id = CASE WHEN (a.context->>'table_id') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
                                        THEN (a.context->>'table_id')::uuid END
                       AND tb.tournament_id = t.id
                       AND (lower(tb.status) = 'closed'
                            OR EXISTS (SELECT 1 FROM public.hand_atomic_commits c
                                        WHERE c.table_id = tb.id
                                          AND c.committed_at > a.created_at))))
          OR (a.source = 'GameServer.tournament_dark_after_rebuild'
              AND EXISTS (
                    SELECT 1 FROM public.tables tb
                      JOIN public.hand_atomic_commits c ON c.table_id = tb.id
                     WHERE tb.tournament_id = t.id
                       AND c.committed_at > a.created_at))
           )
      RETURNING a.id
    )
    SELECT COALESCE(array_agg(id), '{}') INTO v_ops_ids FROM changed;
    v_ops := COALESCE(array_length(v_ops_ids, 1), 0);
  END IF;

  -- CLASS 6: a proven finish refusal whose tournament has since finished. The
  -- engine retries a refused finish and, once it commits, the tournament is
  -- COMPLETED with its terminal receipt (a satellite: its settlement receipt)
  -- and its escrow closed at zero after the alarm was raised. That receipt is
  -- the end of the condition the alarm described. A refusal whose outcome is
  -- unknown, or a tournament in any other state, stays open.
  SELECT COALESCE(array_agg(id), '{}') INTO v_fin_ids FROM (
    SELECT a.id
      FROM public.financial_alerts a, public.tournaments t, public.tournament_escrow e
     WHERE a.resolved IS NOT TRUE
       AND a.source IN ('Tournament.atomic_finish_refused',
                        'Tournament.atomic_satellite_finish_refused')
       AND lower(COALESCE(a.context->>'proven_refusal', '')) IN ('true', 't', '1')
       AND t.id = CASE WHEN (a.context->>'tournament_id') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
                       THEN (a.context->>'tournament_id')::uuid END
       AND t.status = 'COMPLETED'
       AND e.tournament_id = t.id
       AND e.terminal_closed_at IS NOT NULL
       AND e.terminal_closed_at >= a.created_at
       AND COALESCE(e.prize_balance, 0) = 0
       AND COALESCE(e.bounty_balance, 0) = 0
       AND CASE WHEN a.source = 'Tournament.atomic_satellite_finish_refused'
             THEN EXISTS (SELECT 1 FROM public.tournament_satellite_settlements s
                           WHERE s.tournament_id = t.id AND s.settled_at IS NOT NULL)
             ELSE EXISTS (SELECT 1 FROM public.tournament_terminal_settlements s
                           WHERE s.tournament_id = t.id)
           END
     ORDER BY a.created_at, a.id
     LIMIT p_limit
  ) s;
  v_fin := COALESCE(array_length(v_fin_ids, 1), 0);

  IF p_apply THEN
    WITH changed AS (
      UPDATE public.financial_alerts a
         SET resolved = true, resolved_at = now(),
             resolution = 'verified: tournament ' || t.id::text || ' COMPLETED after this refusal; '
               || CASE WHEN a.source = 'Tournament.atomic_satellite_finish_refused'
                       THEN 'its satellite settlement receipt is written'
                       ELSE 'its terminal receipt is written' END
               || ' and its escrow closed at zero at ' || e.terminal_closed_at::text
               || ', so the refused finish was retried and committed.',
             context = COALESCE(a.context, '{}'::jsonb) || jsonb_build_object(
               'resolved_by_fn', 'fn_resolve_settled_financial_alerts',
               'resolved_on', now())
        FROM public.tournaments t, public.tournament_escrow e
       WHERE a.id = ANY(v_fin_ids)
         AND a.resolved IS NOT TRUE
       AND a.source IN ('Tournament.atomic_finish_refused',
                        'Tournament.atomic_satellite_finish_refused')
       AND lower(COALESCE(a.context->>'proven_refusal', '')) IN ('true', 't', '1')
       AND t.id = CASE WHEN (a.context->>'tournament_id') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
                       THEN (a.context->>'tournament_id')::uuid END
       AND t.status = 'COMPLETED'
       AND e.tournament_id = t.id
       AND e.terminal_closed_at IS NOT NULL
       AND e.terminal_closed_at >= a.created_at
       AND COALESCE(e.prize_balance, 0) = 0
       AND COALESCE(e.bounty_balance, 0) = 0
       AND CASE WHEN a.source = 'Tournament.atomic_satellite_finish_refused'
             THEN EXISTS (SELECT 1 FROM public.tournament_satellite_settlements s
                           WHERE s.tournament_id = t.id AND s.settled_at IS NOT NULL)
             ELSE EXISTS (SELECT 1 FROM public.tournament_terminal_settlements s
                           WHERE s.tournament_id = t.id)
           END
      RETURNING a.id
    )
    SELECT COALESCE(array_agg(id), '{}') INTO v_fin_ids FROM changed;
    v_fin := COALESCE(array_length(v_fin_ids, 1), 0);
  END IF;

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
    'tournament_condition_ended', v_ops,
    'refused_finish_committed', v_fin,
    'total', v_paid + v_overpaid + v_settled + v_released + v_ops + v_fin,
    'still_unresolved', (SELECT count(*) FROM public.financial_alerts WHERE resolved IS NOT TRUE)
  );
END;
$function$
$post$;
  v_actual text;
BEGIN
  IF current_user <> 'postgres' OR v_oid IS NULL
     OR md5(v_post) <> '24a8270d08af6a1f54a7ed57154ec625' THEN
    RAISE EXCEPTION 'refused finish closer: owner/target/embedded postimage mismatch';
  END IF;
  IF NOT EXISTS (
       SELECT 1 FROM pg_proc p WHERE p.oid = v_oid
          AND pg_get_userbyid(p.proowner) = 'postgres' AND p.prosecdef
          AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
          AND p.proacl::text IS NOT DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}')
     OR (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace
          AND proname = 'fn_resolve_settled_financial_alerts') <> 1 THEN
    RAISE EXCEPTION 'refused finish closer: target authority/overload drift before';
  END IF;
  v_actual := pg_get_functiondef(v_oid);
  IF md5(v_actual) = '24a8270d08af6a1f54a7ed57154ec625' THEN
    RETURN;
  END IF;
  IF md5(v_actual) <> '8adc7dfe51bab6388a174abf2db52e67' THEN
    RAISE EXCEPTION 'refused finish closer: unexpected live body %', md5(v_actual);
  END IF;
  EXECUTE v_post;
  IF pg_get_functiondef(v_oid) IS DISTINCT FROM v_post THEN
    RAISE EXCEPTION 'refused finish closer: exact postimage readback failed';
  END IF;
END
$component$;

-- Already the live grant; restated so a clean rebuild never hands a browser
-- role this writer.
REVOKE ALL ON FUNCTION public.fn_resolve_settled_financial_alerts(boolean, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_resolve_settled_financial_alerts(boolean, integer) TO service_role;

DO $acl$
BEGIN
  IF (SELECT p.proacl::text FROM pg_proc p
       WHERE p.oid = to_regprocedure('public.fn_resolve_settled_financial_alerts(boolean,integer)'))
     IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}'
     OR NOT EXISTS (SELECT 1 FROM pg_proc p
       WHERE p.oid = to_regprocedure('public.fn_resolve_settled_financial_alerts(boolean,integer)')
         AND pg_get_userbyid(p.proowner) = 'postgres' AND p.prosecdef
         AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]) THEN
    RAISE EXCEPTION 'refused finish closer: authority drift after';
  END IF;
END
$acl$;

COMMIT;
