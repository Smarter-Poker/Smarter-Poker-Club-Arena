-- 20260924012500_a_settled_satellites_own_batch_already_proves_the_seat.sql
--
-- Production Alerts board: operational_alert_events id=8, MoneyAlertsGoingUnread,
-- source financial-alerts-backfill, alertname Satellite.seat_outcome_unconfirmed
-- (5 unresolved rows: a619dd26, 4e84ec39, eb304c2e, d741d403, bade4d66).
--
-- READ LIVE, not assumed: a sibling row of this exact source
-- (id 3ed87bba-4e2e-476d-afd2-f08acd4e80ac) is already resolved=true, with a
-- resolution note naming the 2026-09-09 22-satellite settlement
-- (migration a_finished_satellite_must_be_able_to_settle /
-- a_seat_the_winner_cannot_take_is_paid_as_cash) and stating plainly that
-- this alert's own context ("permission denied", "FOUR TABLE LIMIT", "deadlock
-- detected" - transient failures from the pre-fix code path) does not
-- describe what actually happened: every one of the 22 satellites settled
-- that night, six with a real seat and the rest with the cash-value fallback.
--
-- The 5 rows this migration closes are the exact remainder of that same
-- 22-satellite settlement that nobody individually marked resolved. Verified
-- independently, live, against tournament_satellite_settlement_batches (not
-- against the sibling's resolution note) for each of the 5 named source
-- tournaments:
--   fe8dc50c-8995-4441-b289-43993975f74f  settled_at 2026-09-09 06:14:34 UTC
--   ed78a8ac-d869-469f-a4da-c04b67429064  settled_at 2026-09-09 06:14:35 UTC
--   024d0796-a182-42d9-b3da-482dc55b3ea7  settled_at 2026-09-09 06:14:36 UTC
--   903e9d3c-e1cc-4941-81a2-65031510cd81  settled_at 2026-09-09 06:14:37 UTC
--   54832de2-ec85-43a0-94b9-c108bfb4848c  settled_at 2026-09-09 06:14:28 UTC
-- Cross-checked against the money that actually moved: chip_ledger carries a
-- 'tournament_prize' credit of exactly 20.00 chips (three of these) or 200.00
-- chips (the fourth, bade4d66's 200-chip ticket) into the named winner's
-- player_wallet at that same settled_at timestamp, backed by a
-- tournament_obligations row with amount_paid = amount_owed and settled_at
-- set; the fifth (a619dd26, ticket_value 20) was delivered as a real seat -
-- tournament_players id bb1abd4e-ac08-41c3-b9fd-0a5ebf51d0d8, user
-- 00000000-0000-0000-0000-000000000045, in target tournament d2910755, status
-- eliminated, position 39. No chip moves in this migration: every one of
-- these five was already paid twelve days before this migration exists to
-- record it.
--
-- WHY THE BATCH'S OWN settled_at IS SUFFICIENT PROOF, not a repeat of the
-- per-row checks above: fn_settle_satellite_finish_atomic_before_maintenance_gate
-- only sets tournament_satellite_settlement_batches.settled_at inside the
-- same all-or-nothing block that (a) loops every entitlement in that
-- tournament, delivering each one as a seat or a cash obligation via
-- fn_deliver_satellite_ticket_exact / fn_settle_satellite_cash_entitlement_exact
-- (both RAISE on a delivery that did not settle exactly), and (b) re-checks
-- the whole tournament's postcondition with fn_check_atomic_satellite_finish
-- before the settled_at UPDATE runs. Any failure anywhere in that block is
-- caught by its own EXCEPTION WHEN OTHERS and returns ok:false without ever
-- reaching the settled_at UPDATE. So settled_at IS NOT NULL is not a proxy
-- for "probably fine" - it is the platform's own record that every
-- entitlement in that specific tournament, including the one this alert
-- named, was delivered.
--
-- HARDENING (CLAUDE.md 10.11/10.12): extends the same existing resolver
-- function on its existing 20-minute cron (ca-resolve-settled-alerts-20m) -
-- no new function, no new cron, no compensating write, no money moved. Proof
-- is read fresh from tournament_satellite_settlement_batches per alert every
-- time the resolver runs, not cached or assumed from this migration's own
-- investigation. This migration restates CLASS 1-4 verbatim from the live
-- function (fn_resolve_settled_financial_alerts carried no CLASS 5-7 at the
-- time this was written) so it is correct and self-sufficient regardless of
-- merge order with any sibling PR also extending this resolver: CREATE OR
-- REPLACE always rewrites the whole function body, so whichever of these
-- lands second is a no-op restatement of the other's classes before adding
-- its own.
-- server/src/tournament/ASettledSatellitesOwnBatchAlreadyProvesTheSeat.guard.test.ts
-- pins the exact SQL added. Detection needs nothing new: MoneyAlertsGoingUnread
-- already measures the backlog this closes 5 rows of.
--
-- Probed in a rolled-back transaction (CLAUDE.md 11.5) against production
-- immediately before writing this migration: ran the full CREATE OR REPLACE
-- plus a live p_apply=>true call inside the same aborting DO block, asserting
-- satellite_seat_outcome_settled=5 and that exactly the 5 expected alert ids
-- read resolved=true inside the probe transaction, ending in a deliberate
-- RAISE EXCEPTION so nothing committed:
--   PROBE OK (rolling back...): result={"ok": true, "total": 5, "applied":
--   true, "overpay_absorbed": 0, "still_unresolved": 22133,
--   "post_commit_applied": 0, "settled_after_alert": 0,
--   "refused_hand_released": 0, "satellite_seat_outcome_settled": 5}

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
  v_seat_outcome integer := 0;
  v_paid_ids  uuid[] := '{}';
  v_over_ids  uuid[] := '{}';
  v_settled_ids uuid[] := '{}';
  v_rel_ids   uuid[] := '{}';
  v_seat_ids  uuid[] := '{}';
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

  -- ── CLASS 5: a satellite seat-outcome alert (Satellite.seat_outcome_unconfirmed)
  -- whose named source tournament's own settlement batch has since settled.
  -- See migration header for why settled_at IS NOT NULL is itself the
  -- complete proof for every position in that tournament, matching the
  -- sibling row (3ed87bba) already resolved by hand for the same 2026-09-09
  -- 22-satellite settlement. A different, genuinely still-open source (an
  -- ambiguous winner attribution needing a human, not a delivery failure) is
  -- deliberately left untouched by this exact source-name match.
  SELECT COALESCE(array_agg(a.id), '{}') INTO v_seat_ids FROM (
    SELECT a.id
      FROM public.financial_alerts a
      JOIN public.tournament_satellite_settlement_batches b
        ON b.tournament_id = (a.context->>'tournament_id')::uuid
     WHERE a.resolved IS NOT TRUE
       AND a.source = 'Satellite.seat_outcome_unconfirmed'
       AND a.context->>'tournament_id' IS NOT NULL
       AND b.settled_at IS NOT NULL
     LIMIT p_limit
  ) a;
  v_seat_outcome := COALESCE(array_length(v_seat_ids, 1), 0);

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
           resolution = 'The named satellite tournament''s own settlement batch (tournament_satellite_settlement_batches.settled_at) proves every entitlement in it, including this position, was already delivered (seat or cash) atomically; settled_at is only ever set after the full entitlement loop and its postcondition check succeed with no exception.',
           context = COALESCE(a.context, '{}'::jsonb) || jsonb_build_object(
             'resolution', 'satellite settlement batch already proves delivery for this tournament',
             'resolved_by_fn', 'fn_resolve_settled_financial_alerts',
             'resolved_on', now(),
             'settled_at', (SELECT b.settled_at FROM public.tournament_satellite_settlement_batches b
                             WHERE b.tournament_id = (a.context->>'tournament_id')::uuid),
             'batch_outcomes', (SELECT b.outcomes FROM public.tournament_satellite_settlement_batches b
                                 WHERE b.tournament_id = (a.context->>'tournament_id')::uuid))
     WHERE a.id = ANY(v_seat_ids);
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'applied', p_apply,
    'settled_after_alert', v_paid,
    'overpay_absorbed', v_overpaid,
    'post_commit_applied', v_settled,
    'refused_hand_released', v_released,
    'satellite_seat_outcome_settled', v_seat_outcome,
    'total', v_paid + v_overpaid + v_settled + v_released + v_seat_outcome,
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

-- VERIFY: the function still validates, and CLASS 5 is present in a dry run
-- (p_apply => false performs no writes; this is a read-only sanity check, not
-- a probe that needs rollback).
DO $$
DECLARE
  v_result jsonb;
BEGIN
  v_result := public.fn_resolve_settled_financial_alerts(false, 5000);
  IF v_result IS NULL OR NOT (v_result ? 'satellite_seat_outcome_settled') THEN
    RAISE EXCEPTION 'fn_resolve_settled_financial_alerts did not take CLASS 5 (satellite_seat_outcome_settled missing from result)';
  END IF;
  RAISE NOTICE 'fn_resolve_settled_financial_alerts dry run: %', v_result;
END $$;
