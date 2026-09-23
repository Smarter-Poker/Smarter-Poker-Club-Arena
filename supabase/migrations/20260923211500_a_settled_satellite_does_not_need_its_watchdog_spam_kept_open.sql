-- 20260923211500_a_settled_satellite_does_not_need_its_watchdog_spam_kept_open.sql
--
-- Production Alerts board: operational_alert_events id=8, MoneyAlertsGoingUnread.
-- This closes Satellite.stuck_completing_unawarded, the source PR #5146
-- (20260923195015) deliberately left open as "a different failure shape - a
-- satellite that never finished at all". It IS a different shape from CLASS 6
-- (a refused finish that later succeeded): here the discovery-watchdog fired
-- while a satellite sat COMPLETING with zero survivors, and the message it
-- wrote is explicit that nobody had been paid yet -
--   "Its pool was collected and nobody has been paid... the engine would
--    fall back to the LAST ELIMINATED player, which in a normal finish is
--    second place."
--
-- READ LIVE, not assumed: all 533 unresolved rows for this source (verified
-- by SELECT ... GROUP BY tournament_id summing to exactly 533) name only 9
-- distinct tournament_id values, every occurrence dated 2026-09-08 03:54:01
-- through 2026-09-08 14:53:20 - the discovery-watchdog re-fired on the same
-- 9 stuck satellites roughly once a minute for eleven hours before its own
-- cause was fixed, producing up to 106 duplicate alert rows for one incident
-- (a6a1b360-821c-4201-b378-1591e3df3892 alone: 106 rows, all identical
-- prize_pool 28.5 / alive_count 0 / satellite_target_id null).
--
-- All 9 named tournaments were in fact settled on 2026-09-09: a sibling
-- financial_alerts row of this exact source (id fe00d1ee-8b13-4a7d-a2bc-
-- 68aa56abebec, tournament a6a1b360) already carries
-- resolved=true/resolved_at 2026-09-09T06:38:07Z with a resolution note
-- naming a batch of 22 satellites settled via migration
-- a_finished_satellite_must_be_able_to_settle: "all 22 satellites are
-- COMPLETED with escrow 0.00 and 1,919.00 paid to their winners... and the
-- rest were paid the cash value", and explicitly correcting this alert's own
-- context fields ("it reported alive_count 0 and satellite_target_id null,
-- and both were wrong"). Verified independently, live, against the current
-- state of all 9 tournaments named by the unresolved rows (not against that
-- older resolution note): every one reads
--   tournaments.status = 'COMPLETED'
--   tournament_escrow.closed_at IS NOT NULL (2026-09-09 06:12-06:14 UTC)
--   tournament_escrow.prize_balance = 0.00
--   tournament_escrow.prize_out > 0 (28.50 or 285.00 - 95% of gross_in;
--     0 tournament_satellite_awards rows for any of the 9, consistent with
--     the resolution note's "paid the cash value" branch rather than a real
--     seat delivery)
-- i.e. the pool was fully disbursed and the escrow closed at zero, which is
-- the platform's own proof that "nobody has been paid" is no longer true for
-- these 9 tournaments. The true, un-duplicated defect this alert reported
-- was fixed twelve days ago; what remains is spam left behind because the
-- 2026-09-09 settlement resolved the underlying tournaments, not each
-- duplicate alert row the watchdog had already written about them.
--
-- Every one of the 533 unresolved rows is covered by this same proof (one
-- of 9 tournament_ids, all closed-at-zero-with-payout); none were found
-- naming a tournament in any other state. No new discovery-watchdog spam
-- exists for this source: the newest row of any status for
-- Satellite.stuck_completing_unawarded predates 2026-09-09, so the watchdog
-- itself is not currently reproducing this duplication (the 2026-09-09
-- resolution's own migration is the fix for the underlying stuck state; this
-- migration only closes the bookkeeping the fix left behind).
--
-- HARDENING (CLAUDE.md 10.11/10.12): extends the same existing resolver
-- function on its existing 20-minute cron (ca-resolve-settled-alerts-20m) -
-- no new function, no new cron, no compensating write, no money moved (the
-- money was already settled on 2026-09-09; this only marks the alert rows
-- that already-settled money produced as resolved). Proof is read fresh from
-- tournament_escrow per alert every time the resolver runs, not cached or
-- assumed from this migration's own investigation, so it stays correct if
-- escrow state ever changes. This migration restates CLASS 1-6 verbatim from
-- 20260923195015 (PR #5146) so it is correct and self-sufficient regardless
-- of merge order: CREATE OR REPLACE always rewrites the whole function body,
-- so whichever of this migration and #5146 lands second is a no-op
-- restatement of the other's classes before adding its own.
-- server/src/tournament/ASettledSatelliteDoesNotNeedItsWatchdogSpamKeptOpen.guard.test.ts
-- pins the exact SQL added. Detection needs nothing new: MoneyAlertsGoingUnread
-- already measures the backlog this closes 533 rows of.

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
  v_stuck     integer := 0;
  v_paid_ids  uuid[] := '{}';
  v_over_ids  uuid[] := '{}';
  v_settled_ids uuid[] := '{}';
  v_rel_ids   uuid[] := '{}';
  v_finish_ids uuid[] := '{}';
  v_sat_ids   uuid[] := '{}';
  v_stuck_ids uuid[] := '{}';
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

  -- ── CLASS 7: a satellite reported stuck COMPLETING "with no survivor and no
  -- seats or payouts awarded" (Satellite.stuck_completing_unawarded), but its
  -- named tournament's own escrow now proves the pool was fully disbursed and
  -- closed at zero - the exact fact the alert's message says has not
  -- happened. Proof is read fresh from tournament_escrow every run, not from
  -- the tournament's status alone (a status can be wrong; a closed, zeroed
  -- escrow with money actually paid out cannot): closed_at set, prize_balance
  -- exactly zero, and prize_out or refund_prize strictly positive (some money
  -- actually moved out, not merely a balance that was already zero for
  -- another reason). See migration header for the specific 9-tournament,
  -- 533-row duplicate-watchdog-spam episode this closes.
  SELECT array_agg(id) INTO v_stuck_ids FROM (
    SELECT a.id
      FROM public.financial_alerts a
      JOIN public.tournament_escrow e ON e.tournament_id = (a.context->>'tournament_id')::uuid
     WHERE a.resolved IS NOT TRUE
       AND a.source = 'Satellite.stuck_completing_unawarded'
       AND a.context->>'tournament_id' IS NOT NULL
       AND e.closed_at IS NOT NULL
       AND e.prize_balance = 0
       AND (COALESCE(e.prize_out, 0) + COALESCE(e.refund_prize, 0)) > 0
     LIMIT p_limit
  ) s;
  v_stuck := COALESCE(array_length(v_stuck_ids, 1), 0);

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

    UPDATE public.financial_alerts a
       SET resolved = true,
           resolved_at = now(),
           context = COALESCE(a.context, '{}'::jsonb) || jsonb_build_object(
             'resolution', 'this tournament''s escrow is closed with a zero prize_balance and a non-zero prize_out/refund_prize: the pool this alert said nobody had been paid from has since been fully disbursed',
             'resolved_by_fn', 'fn_resolve_settled_financial_alerts',
             'resolved_on', now(),
             'escrow_proof', (
               SELECT jsonb_build_object(
                 'closed_at', e.closed_at, 'prize_balance', e.prize_balance,
                 'prize_out', e.prize_out, 'refund_prize', e.refund_prize)
                 FROM public.tournament_escrow e
                WHERE e.tournament_id = (a.context->>'tournament_id')::uuid))
     WHERE a.id = ANY(v_stuck_ids);
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
    'stuck_completing_settled', v_stuck,
    'total', v_paid + v_overpaid + v_settled + v_released + v_finish + v_sat + v_stuck,
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

-- VERIFY: the function still validates, and CLASS 7 is present in a dry run
-- (p_apply => false performs no writes; this is a read-only sanity check, not
-- a probe that needs rollback).
DO $$
DECLARE
  v_result jsonb;
BEGIN
  v_result := public.fn_resolve_settled_financial_alerts(false, 5000);
  IF v_result IS NULL OR NOT (v_result ? 'stuck_completing_settled') THEN
    RAISE EXCEPTION 'fn_resolve_settled_financial_alerts did not take CLASS 7 (stuck_completing_settled missing from result)';
  END IF;
  RAISE NOTICE 'fn_resolve_settled_financial_alerts dry run: %', v_result;
END $$;
