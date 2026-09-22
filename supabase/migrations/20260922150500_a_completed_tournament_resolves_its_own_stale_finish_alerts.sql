-- ============================================================================
-- A COMPLETED TOURNAMENT RESOLVES ITS OWN STALE FINISH ALERTS
-- ============================================================================
-- Production Alerts Fleet, PRIMARY lane. Measured on production 2026-09-22.
--
-- WHAT IS WRONG
-- -------------
-- MoneyAlertsGoingUnread (poker_financial_alerts_stale_critical > 25 for 30m)
-- has been firing continuously since at least 2026-09-15. The dominant driver,
-- measured today: 15,909 unresolved CRITICAL public.financial_alerts rows from
-- the four Tournament.atomic_finish_* / atomic_satellite_finish_* sources
-- (TournamentManagerEliminations.ts), most dated 2026-09-09 through
-- 2026-09-21 - 75% of the entire unresolved-critical population (21,176).
--
-- These alerts fire every time an authoritative tournament finish is refused
-- or its outcome is left unknown, and the elimination manager retries on a
-- schedule (docs/runbooks/horse-fleet-settlement.md), so one genuinely stuck
-- tournament produced hundreds of near-duplicate criticals (measured: single
-- tournament_ids with 200-224 rows each between 2026-09-14 and 2026-09-21).
--
-- RE-MEASURED, NOT ASSUMED (law 10.86 / 10.9 criterion 1)
-- ---------------------------------------------------------
-- Every one of these 15,909 rows names a tournament_id in its context. Joined
-- against the live public.tournaments table today:
--
--     still RUNNING:  0
--     now COMPLETED:  15,909
--     tournament row missing: 0
--
-- Every tournament that ever refused a finish and raised one of these alerts
-- has SINCE finished successfully (the underlying blocker - a pre-cutover
-- accounting-fee provenance gap documented in the same runbook - was cleared
-- by other work; the most recent of these 1,033 distinct tournaments
-- completed at 2026-09-22 14:42 UTC, minutes before this migration was
-- written). The winners were paid through the ordinary finish path, the same
-- path every other tournament uses (law 10.5: no separate treatment). What
-- never happened is anyone telling financial_alerts the condition cleared.
--
-- THE ROOT CAUSE IS THE MISSING MECHANISM ITSELF
-- ------------------------------------------------
-- Nothing re-reads a live tournament's current status and closes the alerts
-- that named it. fn_ca_incident_escalation_tick (20260920183008) can only
-- retire the ca_drift_incidents MIRROR on silence, and by design (law 10.86)
-- that never marks the underlying financial_alerts row resolved, because
-- silence is not evidence of a fix. It is correctly not evidence here either -
-- but a re-read of tournaments.status IS genuine evidence, and nothing does
-- that re-read. This migration adds the missing mechanism, the way section
-- 5's fn_ca_resolve_cleared_incidents already does for polling detectors:
-- close only on a fresh, live re-measurement, never on the passage of time.
--
-- FIX: EVENT-DRIVEN, NOT A SWEEP (law 10.11 / 10.12)
-- -----------------------------------------------------
-- A new AFTER UPDATE OF status trigger on public.tournaments fires exactly
-- when a tournament transitions RUNNING -> COMPLETED, and resolves any open
-- financial_alerts row from the four sources that named it, with the
-- tournament's own completion as its evidence. No new cron, no new sweep, no
-- polling watcher (law 10.12): the fix lives at the one place the ground
-- truth changes. A one-time backfill in this same migration closes the
-- 15,909 rows already stranded from before the trigger existed, using the
-- identical live re-read.
--
-- WHY THIS IS SAFE TO CLOSE (law 10.9 criteria)
-- ------------------------------------------------
-- 1. Read, not assumed: every row closed is matched against tournaments.status
--    at the moment this runs (backfill) or the moment the transition happens
--    (trigger), never against the stale snapshot above.
-- 2. No money moves. This migration writes financial_alerts.resolved only.
--    The prize money was already paid by the ordinary finish path; this
--    corrects the record of an alert, not a ledger.
-- 3. Nothing is taken from anyone; this only closes alerts.
-- 4. Every number here was read live against production before writing this
--    header, and the backfill's WHERE clause re-reads tournaments.status
--    again at apply time rather than trusting this comment.
-- 5. The paragraph: every alert closed by this migration named a tournament
--    that has since reached COMPLETED through the platform's ordinary finish
--    path - the same settlement, the same rake attribution, the same VIP and
--    commission accrual every other tournament gets. Nothing was decided
--    about any player; the migration only tells financial_alerts what
--    tournaments already knows.
--
-- WHAT THIS DOES NOT TOUCH
-- ----------------------------
-- Any alert whose tournament is still RUNNING is left exactly as it is - the
-- WHERE clause excludes it by construction, at apply time. The remaining
-- unresolved critical population (postHandTasks.hand_history_failed,
-- ServerTableEngine.authoritative_hand_semantic_refusal, and others) is a
-- separate incident, not addressed here, and is left open on the fleet board.
--
-- HARDENING
-- ---------
-- * Regression test: tests/a-completed-tournament-resolves-its-own-stale-finish-alerts.law.test.ts
--   builds a fixture tournament RUNNING with an open critical alert naming
--   it, transitions the tournament to COMPLETED, and asserts the alert
--   resolves with 'verified:' evidence citing the live status - and that an
--   alert naming a tournament left RUNNING is untouched.
-- * Invariant: the trigger is unconditional and fires on every future
--   RUNNING -> COMPLETED transition, so this class of alert can never again
--   accumulate a backlog behind a fixed underlying defect.
-- * Detection: unchanged. The existing insert trigger
--   (trg_ca_financial_alert_incident) still mirrors any NEW alert onto the
--   drift board; a genuinely still-stuck tournament keeps alerting exactly
--   as before.
-- * CI gate: the new test runs under the repository's existing Supabase
--   Invariants / vitest run on every PR (section 8, "never push a red test").
--
-- DDL POLICY: one transaction, one PostgREST reload (CLAUDE.md section 2
-- rule 1). Do NOT apply between :50 and :03 UTC (section 2 rule 8).
-- ============================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '180s';

-- ---------------------------------------------------------------------------
-- 0. Sanity band. Not a correctness gate - the trigger and the backfill both
--    re-read tournaments.status themselves - only a tripwire against applying
--    this against a completely different-shaped board than the one measured.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_unresolved int;
  v_running    int;
BEGIN
  SELECT count(*),
         count(*) FILTER (WHERE EXISTS (
           SELECT 1 FROM public.tournaments t
            WHERE t.id = (f.context->>'tournament_id')::uuid AND t.status = 'RUNNING'))
    INTO v_unresolved, v_running
    FROM public.financial_alerts f
   WHERE f.severity = 'critical' AND f.resolved = false
     AND f.source IN ('Tournament.atomic_finish_refused','Tournament.atomic_finish_outcome_unknown',
                       'Tournament.atomic_satellite_finish_refused','Tournament.atomic_satellite_finish_outcome_unknown')
     AND f.context ? 'tournament_id'
     AND (f.context->>'tournament_id') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

  IF v_unresolved NOT BETWEEN 5000 AND 60000 THEN
    RAISE EXCEPTION 'ABORT: % unresolved Tournament.atomic_finish_* criticals, expected 5000-60000 (measured 15909 on 2026-09-22). Re-read before applying.', v_unresolved;
  END IF;

  RAISE NOTICE 'Pre-flight: % unresolved Tournament.atomic_finish_* criticals, % still naming a RUNNING tournament (measured 15909 / 0 on 2026-09-22).', v_unresolved, v_running;
END $$;

-- ---------------------------------------------------------------------------
-- 1. The trigger function. Fires once per genuine transition, re-reads
--    nothing but NEW - it IS the fresh state.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_tournament_finish_resolves_stale_alerts()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid;
  v_note  text;
BEGIN
  v_note := 'verified: tournament ' || NEW.id::text
    || ' transitioned RUNNING -> COMPLETED at ' || to_char(now(), 'YYYY-MM-DD HH24:MI:SS UTC')
    || '. The atomic-finish refusal that raised this alert has been superseded '
    || 'by a successful finish through the ordinary settlement path; nothing '
    || 'was paid or adjusted by this closure, it only records that the '
    || 'tournament finished.';

  UPDATE public.financial_alerts f
     SET resolved    = true,
         resolved_at = now(),
         resolved_by = v_actor,
         resolution  = COALESCE(NULLIF(f.resolution,'') || ' | ', '') || v_note
   WHERE NOT COALESCE(f.resolved,false)
     AND f.source IN ('Tournament.atomic_finish_refused','Tournament.atomic_finish_outcome_unknown',
                       'Tournament.atomic_satellite_finish_refused','Tournament.atomic_satellite_finish_outcome_unknown')
     AND f.context ? 'tournament_id'
     AND (f.context->>'tournament_id') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
     AND (f.context->>'tournament_id')::uuid = NEW.id;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Never let a housekeeping closure block the finish that triggered it.
  RAISE WARNING 'fn_ca_tournament_finish_resolves_stale_alerts failed for tournament %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.fn_ca_tournament_finish_resolves_stale_alerts() IS
  'Closes open Tournament.atomic_finish_* / atomic_satellite_finish_* financial_alerts rows '
  'naming a tournament the instant that tournament reaches COMPLETED. Added 2026-09-22 after '
  '15,909 such alerts sat open for up to 13 days behind tournaments that had already finished - '
  'see migration 20260922150500. Never touches a row naming a tournament that is not COMPLETED.';

DROP TRIGGER IF EXISTS trg_tournament_finish_resolves_stale_alerts ON public.tournaments;
CREATE TRIGGER trg_tournament_finish_resolves_stale_alerts
  AFTER UPDATE OF status ON public.tournaments
  FOR EACH ROW
  WHEN (NEW.status = 'COMPLETED' AND OLD.status = 'RUNNING')
  EXECUTE FUNCTION public.fn_ca_tournament_finish_resolves_stale_alerts();

-- ---------------------------------------------------------------------------
-- 2. One-time backfill for rows stranded before the trigger existed. Re-reads
--    tournaments.status live; only ever touches a row whose tournament is
--    COMPLETED right now, regardless of what section 0 measured.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_closed int;
BEGIN
  UPDATE public.financial_alerts f
     SET resolved    = true,
         resolved_at = now(),
         resolved_by = '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid,
         resolution  = COALESCE(NULLIF(f.resolution,'') || ' | ', '')
           || 'verified: tournament ' || (f.context->>'tournament_id')
           || ' is COMPLETED (re-read at migration apply time, 20260922150500). '
           || 'The atomic-finish refusal that raised this alert has been superseded '
           || 'by a successful finish through the ordinary settlement path; nothing '
           || 'was paid or adjusted by this closure, it only records that the '
           || 'tournament finished. Backfill for alerts raised before '
           || 'trg_tournament_finish_resolves_stale_alerts existed.'
   WHERE NOT COALESCE(f.resolved,false)
     AND f.source IN ('Tournament.atomic_finish_refused','Tournament.atomic_finish_outcome_unknown',
                       'Tournament.atomic_satellite_finish_refused','Tournament.atomic_satellite_finish_outcome_unknown')
     AND f.context ? 'tournament_id'
     AND (f.context->>'tournament_id') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
     AND EXISTS (
           SELECT 1 FROM public.tournaments t
            WHERE t.id = (f.context->>'tournament_id')::uuid AND t.status = 'COMPLETED');
  GET DIAGNOSTICS v_closed = ROW_COUNT;
  RAISE NOTICE 'Backfill closed % Tournament.atomic_finish_* alert(s) against tournaments read as COMPLETED at apply time.', v_closed;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Post-check. No alert from these four sources may remain unresolved while
--    naming a tournament that is, right now, COMPLETED - if one does, the
--    backfill's own WHERE clause and this check disagree, and something is
--    wrong with either.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_left int;
BEGIN
  SELECT count(*) INTO v_left
    FROM public.financial_alerts f
   WHERE NOT COALESCE(f.resolved,false)
     AND f.source IN ('Tournament.atomic_finish_refused','Tournament.atomic_finish_outcome_unknown',
                       'Tournament.atomic_satellite_finish_refused','Tournament.atomic_satellite_finish_outcome_unknown')
     AND f.context ? 'tournament_id'
     AND (f.context->>'tournament_id') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
     AND EXISTS (
           SELECT 1 FROM public.tournaments t
            WHERE t.id = (f.context->>'tournament_id')::uuid AND t.status = 'COMPLETED');
  IF v_left <> 0 THEN
    RAISE EXCEPTION 'ABORT: % alert(s) still unresolved against a COMPLETED tournament after backfill - the UPDATE and this check disagree.', v_left;
  END IF;
  RAISE NOTICE 'Post-check OK: 0 unresolved Tournament.atomic_finish_* alerts remain against a COMPLETED tournament.';
END $$;

COMMIT;
