-- 20261002171245_the_stale_money_alerts_close_on_their_evidence.sql
--
-- Version reserved by scripts/reserve-migration-version.sh against this tree,
-- origin/main and every sibling worktree.
--
-- THE STALE MONEY ALERTS CLOSE ON THEIR EVIDENCE (2026-10-02)
--
-- MoneyAlertsGoingUnread was firing with ~536 unresolved financial_alerts.
-- Triaged by source and age, read-only, 2026-10-02 16:50-17:10 UTC. This file
-- resolves exactly the 369 whose condition is proven settled from rows, one
-- class at a time, each with its own evidence in its resolution note. It
-- writes no money row and changes no function; resolving an alert closes the
-- drift incident mirroring it through zz_ca_alert_resolution_reaches_the_incident.
--
--   A  249  postHandTasks.hand_history_failed (126) and
--           ServerTableEngine.authoritative_hand_semantic_refusal (123), all
--           "atomic hand commit refused (lease_proof_expired)", 2026-09-26 ..
--           10-02 05:50 in 20 bursts (engine generation changes). Per alert:
--           no hand_atomic_commits row for the hand id or its table/number,
--           no rake_records row, no chip_ledger leg; every table committed
--           later hands. The hand was rolled back whole: no chip moved.
--           Same proof the 15,000+ earlier rows of these sources closed on.
--   B   82  Tournament.atomic_finish_refused (9) and its drift mirrors (73):
--           every event COMPLETED with its terminal receipt, receipt total =
--           sum of tournament_payouts = prize pool (5,576.50 in all), payout
--           counts equal, prize and bounty escrow 0.00.
--   C   14  postHandTasks.leave_pending_failed: moves_chips false, a read
--           timed out; fn_unaccounted_seat_exits(4 days, 10 minutes) is empty
--           and no open seat on the table carries leave_pending.
--   D    5  ServerTableEngine.authoritative_hand_unreachable (4) + mirror:
--           the same hand is in hand_atomic_commits with its post-commit
--           obligations completed.
--   E    5  RakeSpec.checksum_unavailable: fn_rake_spec_checksum() now
--           returns the engine's compiled checksum on the alert
--           (f9cfc362...), and no RakeSpec.drift since 2026-09-17.
--   F   14  union_accounting_scheduler (7) + 2 mirrors, weekly_club_accounting
--           (4) + 1 mirror: the week 2026-09-21 -> 09-28 these said was
--           incomplete is status complete in union_accounting_runs (union
--           run finished 2026-10-01 23:51, club run 2026-09-29 02:30).
--
-- LEFT OPEN, on purpose (not provable from rows today): 22
-- fn_tournament_money_conservation deltas (including two events that paid
-- 180.00 more than their pool), 43 fn_union_integrity_sweep co-seating
-- signals, 13 fn_union_rake_basis_refresh (the open-week snapshot has not
-- refreshed since 2026-09-28 21:35), 7 FeeReconciler.satellite_conservation,
-- and ~45 older singletons.
--
-- GUARDS: refuses in the break window; every class must match the count read
-- on 2026-10-02 exactly, or nothing is resolved. Post-image: none of the 369
-- is open.
--
-- @live-proof: (SELECT count(*) FROM public.financial_alerts WHERE resolution LIKE '%migration 20261002171245_the_stale_money_alerts_close_on_their_evidence%') >= 369

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '120s';

DO $pre$
DECLARE v_reason text;
BEGIN
  v_reason := public.fn_ca_break_window_refuses_migrations(now());
  IF v_reason IS NOT NULL THEN
    RAISE EXCEPTION 'STALE_ALERTS_REFUSED: %', v_reason USING ERRCODE = '55000';
  END IF;
END
$pre$;

CREATE TEMP TABLE _stale_alerts ON COMMIT DROP AS
WITH open_alerts AS (
  SELECT a.*
    FROM public.financial_alerts a
   WHERE a.resolved IS NOT TRUE
     AND a.created_at < '2026-10-02 17:00:00+00'::timestamptz
),
a_refused AS (
  SELECT a.id, 'A'::text AS cls,
         'verified: atomic hand commit refused (lease_proof_expired) rolled hand ' || (a.context->'hand_request_identity_v1'->>'hand_id')
         || ' (table ' || (a.context->>'table_id') || ' #' || (a.context->>'hand_number')
         || ') back whole - no hand_atomic_commits row for the hand or its number, no rake_records row and no chip_ledger leg, so no chip moved '
         || 'and no history is owed; the table committed later hands, so its stacks were carried by the database. '
         || 'migration 20261002171245_the_stale_money_alerts_close_on_their_evidence' AS note
    FROM open_alerts a
   WHERE a.source IN ('postHandTasks.hand_history_failed', 'ServerTableEngine.authoritative_hand_semantic_refusal')
     AND a.context->>'error' = 'atomic hand commit refused (lease_proof_expired)'
     AND (a.context->'hand_request_identity_v1'->>'hand_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     AND (a.context->>'table_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     AND (a.context->>'hand_number') ~ '^[0-9]{1,15}$'
     AND NOT EXISTS (SELECT 1 FROM public.hand_atomic_commits c
                      WHERE c.hand_id = (a.context->'hand_request_identity_v1'->>'hand_id')::uuid)
     AND NOT EXISTS (SELECT 1 FROM public.hand_atomic_commits c
                      WHERE c.table_id = (a.context->>'table_id')::uuid
                        AND c.hand_number = (a.context->>'hand_number')::bigint)
     AND NOT EXISTS (SELECT 1 FROM public.rake_records r
                      WHERE r.hand_id = (a.context->'hand_request_identity_v1'->>'hand_id')::uuid)
     AND NOT EXISTS (SELECT 1 FROM public.chip_ledger l
                      WHERE l.created_at BETWEEN a.created_at - interval '1 hour' AND a.created_at + interval '1 hour'
                        AND l.hand_id = (a.context->'hand_request_identity_v1'->>'hand_id')::uuid)
     AND EXISTS (SELECT 1 FROM public.hand_atomic_commits c
                  WHERE c.table_id = (a.context->>'table_id')::uuid
                    AND c.hand_number > (a.context->>'hand_number')::bigint)
),
b_finish AS (
  SELECT a.id, 'B'::text,
         'verified: tournament ' || t.id::text || ' was refused finishing and then finished by its terminal authority: COMPLETED, '
         || 'terminal receipt of ' || s.cash_payout_total::text || ' in ' || s.cash_payout_count::text || ' payout(s), equal to the '
         || 'tournament_payouts rows and to the prize pool, prize and bounty escrow 0.00. Nothing is owed and nobody was paid twice. '
         || 'migration 20261002171245_the_stale_money_alerts_close_on_their_evidence'
    FROM open_alerts a
    JOIN public.tournaments t
      ON t.id = (COALESCE(a.context->>'tournament_id', a.context->'metadata'->>'tournament_id'))::uuid
    JOIN public.tournament_terminal_settlements s ON s.tournament_id = t.id
    LEFT JOIN public.tournament_escrow e ON e.tournament_id = t.id
   WHERE a.source IN ('Tournament.atomic_finish_refused', 'drift_incident:financial_alerts:Tournament.atomic_finish_refused')
     AND t.status = 'COMPLETED'
     AND s.cash_payout_total >= t.prize_pool - 0.01
     AND s.cash_payout_total = (SELECT COALESCE(sum(p.amount), 0) FROM public.tournament_payouts p WHERE p.tournament_id = t.id)
     AND s.cash_payout_count = (SELECT count(*) FROM public.tournament_payouts p WHERE p.tournament_id = t.id)
     AND COALESCE(e.prize_balance, 0) = 0 AND COALESCE(e.bounty_balance, 0) = 0
),
c_leave AS (
  SELECT a.id, 'C'::text,
         'verified: the leave_pending step failed on a read (' || COALESCE(a.context->>'error', 'no error text')
         || ') with moves_chips false; fn_unaccounted_seat_exits(4 days, 10 minutes) returns 0 rows and no open seat on table '
         || (a.context->>'table_id') || ' carries leave_pending, so every deferred departure was taken at a later boundary. '
         || 'migration 20261002171245_the_stale_money_alerts_close_on_their_evidence'
    FROM open_alerts a
   WHERE a.source = 'postHandTasks.leave_pending_failed'
     AND a.context->'moves_chips' = 'false'::jsonb
     AND (a.context->>'table_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     AND NOT EXISTS (SELECT 1 FROM public.fn_unaccounted_seat_exits(interval '4 days', interval '10 minutes'))
     AND NOT EXISTS (SELECT 1 FROM public.table_seats s
                      WHERE s.table_id = (a.context->>'table_id')::uuid
                        AND s.left_at IS NULL AND COALESCE(s.leave_pending, false))
),
d_unreachable AS (
  SELECT a.id, 'D'::text,
         'verified: the engine generation that could not reach the database for table ' || (a.context->>'table_id') || ' hand #'
         || (a.context->>'hand_number') || ' was replaced and the same hand was committed (hand_atomic_commits '
         || c.hand_id::text || ') with its post-commit obligations completed at ' || c.post_commit_completed_at::text
         || '. migration 20261002171245_the_stale_money_alerts_close_on_their_evidence'
    FROM open_alerts a
    JOIN public.hand_atomic_commits c
      ON c.table_id = (a.context->>'table_id')::uuid
     AND c.hand_number = (a.context->>'hand_number')::bigint
   WHERE a.source IN ('ServerTableEngine.authoritative_hand_unreachable',
                      'drift_incident:financial_alerts:ServerTableEngine.authoritative_hand_unreachable')
     AND c.post_commit_completed_at IS NOT NULL
),
e_rakespec AS (
  SELECT a.id, 'E'::text,
         'verified: a transient read failure of fn_rake_spec_checksum(); it now returns ' || public.fn_rake_spec_checksum()
         || ', equal to the engine''s compiled checksum on the alert, and no RakeSpec.drift alert since 2026-09-29. '
         || 'migration 20261002171245_the_stale_money_alerts_close_on_their_evidence'
    FROM open_alerts a
   WHERE a.source = 'RakeSpec.checksum_unavailable'
     AND a.context->>'compiledChecksum' = public.fn_rake_spec_checksum()
     AND NOT EXISTS (SELECT 1 FROM public.financial_alerts d
                      WHERE d.source = 'RakeSpec.drift' AND d.created_at > '2026-09-29'::timestamptz)
),
f_weekly AS (
  SELECT a.id, 'F'::text,
         'verified: the weekly accounting run for period 2026-09-21 to 2026-09-28 that this alert reported incomplete has since '
         || 'completed (union_accounting_runs status complete, finished ' || r.finished_at::text || ', attempt '
         || r.attempts::text || '). migration 20261002171245_the_stale_money_alerts_close_on_their_evidence'
    FROM open_alerts a
    JOIN public.union_accounting_runs r
      ON r.period_start = '2026-09-21 07:00:00+00'::timestamptz
     AND r.status = 'complete'
     AND (   (a.source IN ('union_accounting_scheduler', 'drift_incident:financial_alerts:union_accounting_scheduler')
              AND r.union_id::text = COALESCE(a.context->>'union_id', a.context->>'scope_id'))
          OR (a.source IN ('weekly_club_accounting', 'drift_incident:financial_alerts:weekly_club_accounting')
              AND r.union_id IS NULL
              AND r.result->'round2'->>'scope_id' = a.context->>'club_id'))
   WHERE a.source IN ('union_accounting_scheduler', 'drift_incident:financial_alerts:union_accounting_scheduler',
                      'weekly_club_accounting', 'drift_incident:financial_alerts:weekly_club_accounting')
     AND a.created_at BETWEEN '2026-09-28'::timestamptz AND '2026-10-02'::timestamptz
     AND COALESCE(a.context->>'period_start', '2026-09-21T07:00:00+00:00') = '2026-09-21T07:00:00+00:00'
)
SELECT * FROM a_refused
UNION ALL SELECT * FROM b_finish
UNION ALL SELECT * FROM c_leave
UNION ALL SELECT * FROM d_unreachable
UNION ALL SELECT * FROM e_rakespec
UNION ALL SELECT * FROM f_weekly;

DO $resolve$
DECLARE
  v_bad text;
  v_n integer;
BEGIN
  SELECT string_agg(x.cls || ' read ' || x.n || ' expected ' || x.want, ', ') INTO v_bad
    FROM (SELECT w.cls, w.want, COALESCE((SELECT count(*) FROM _stale_alerts s WHERE s.cls = w.cls), 0) AS n
            FROM (VALUES ('A', 249), ('B', 82), ('C', 14), ('D', 5), ('E', 5), ('F', 14)) AS w(cls, want)) x
   WHERE x.n <> x.want;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'STALE_ALERTS_PREIMAGE: %', v_bad USING ERRCODE = '55000';
  END IF;
  IF (SELECT count(DISTINCT id) FROM _stale_alerts) <> 369 THEN
    RAISE EXCEPTION 'STALE_ALERTS_PREIMAGE: an alert matched two classes' USING ERRCODE = '55000';
  END IF;

  UPDATE public.financial_alerts fa
     SET resolved = true,
         resolved_at = now(),
         resolution = s.note
    FROM _stale_alerts s
   WHERE fa.id = s.id
     AND fa.resolved IS NOT TRUE;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 369 THEN
    RAISE EXCEPTION 'STALE_ALERTS_RESOLVE: resolved % alerts, expected 369', v_n USING ERRCODE = '55000';
  END IF;
END
$resolve$;

DO $post$
BEGIN
  IF EXISTS (SELECT 1 FROM public.financial_alerts fa JOIN _stale_alerts s ON s.id = fa.id WHERE fa.resolved IS NOT TRUE) THEN
    RAISE EXCEPTION 'STALE_ALERTS_POSTIMAGE: an alert of the 369 is still open' USING ERRCODE = '55000';
  END IF;
END
$post$;

COMMIT;
