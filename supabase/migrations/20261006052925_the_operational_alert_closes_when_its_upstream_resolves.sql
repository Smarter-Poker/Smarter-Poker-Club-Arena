-- 20261006052925_the_operational_alert_closes_when_its_upstream_resolves
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-10-06 05:29:25 UTC.
--
-- THE OPERATIONAL ALERT CLOSES WHEN ITS UPSTREAM RESOLVES (2026-10-06)
--
-- public.operational_alert_events has no closure path. investigation_touched_at
-- is NULL on all 209,580 rows: no row has ever been transitioned, by anything.
-- Meanwhile the mirror mints a NEW row for every snapshot of an upstream record,
-- so when a financial alert or a drift incident RESOLVES upstream, its recovery
-- lands as another OPEN row and its firing predecessor is never closed. Read
-- 2026-10-06 02:55-05:00 UTC: 91,999 of 116,777 open rows (78.8 pct) carry
-- status='resolved' - the alert already recovered - and the backlog has risen
-- forty-one consecutive times because nothing can ever leave it.
--
-- This supplies the missing transition, at the owning layer, in the upstream
-- resolution's own transaction. It adds no watcher, cron, reconciler or polling
-- loop (CLAUDE.md 10.85, AGENT-HARDENING-STANDARD.md): the existing AFTER
-- INSERT OR UPDATE trigger a00_operational_source_intake already fires on the
-- resolving UPDATE, and the close happens there.
--
-- WHAT CLOSES, AND ON WHAT EVIDENCE. Only a row whose LIVE upstream record is
-- resolved right now - public.financial_alerts.resolved IS TRUE, or
-- public.ca_drift_incidents.resolved_at IS NOT NULL - read in the same
-- statement, never the snapshot in the row's own payload. Measured at
-- 2026-10-06 05:0xZ: 89,643 of 89,674 open financial-mirror rows and 14,307 of
-- 14,334 open drift-mirror rows qualify, 103,950 in all; the 31 + 27 = 58 whose
-- upstream is genuinely still unresolved STAY OPEN, which is the point.
-- 7,903 of the financial rows are status='firing' and close together with the
-- recovery of the same upstream record: that is linking rows by identity and
-- closing them on removed cause, not bulk-marking a label.
--
-- WHAT IT IS NOT. 'historical' is not 'verified_fixed'. This records that the
-- alert's condition ended upstream, NOT that any root cause was investigated or
-- repaired; verified_fixed stays reserved for a lane that verified a fix live at
-- an exact commit. Closure is evidence-bearing and reversible: every row keeps
-- its original identity, payload, status and timestamps, and gains
-- investigation.closed_from holding the exact status it came from, so the
-- ROLLBACK below is precise rather than approximate.
--
-- A RECURRENCE IS NOT HIDDEN. A later episode of the same upstream record
-- arrives as a NEW row (record_strict keys -updates rows as <id>:<md5(row)>, so
-- a changed row is a new event_key) and is open at 'new'. Closing today cannot
-- absorb tomorrow's firing, which is the defect filed 2026-10-03T02:07:51Z
-- against closing as historical without a fixing commit.
--
-- SCOPE. financial and drift only. The engine kind is deliberately excluded:
-- engine_alerts admits status 'info' as well as firing/resolved and has no
-- single authoritative resolved column, and its 668 open resolved rows need
-- their own evidence. Named here so a later reader does not mistake the
-- omission for an oversight.
--
-- NO MONEY MOVES. No chip, ledger, wallet, treasury, payout or membership row is
-- read for mutation or written. The only table written is
-- public.operational_alert_events. public.financial_alerts and
-- public.ca_drift_incidents are READ ONLY here, to prove resolution.
--
-- @live-proof: (SELECT count(*) FROM public.operational_alert_events WHERE investigation_status = 'historical' AND investigation->>'closed_by' = '20261006052925_the_operational_alert_closes_when_its_upstream_resolves') > 0
--
-- ROLLBACK: restores every row this migration closed to the exact status it
-- ROLLBACK: came from, drops the supporting index and restores the trigger
-- ROLLBACK: function to its pre-migration definition. Run as one transaction:
-- ROLLBACK:
-- ROLLBACK: BEGIN;
-- ROLLBACK:   UPDATE public.operational_alert_events
-- ROLLBACK:      SET investigation_status = investigation->>'closed_from',
-- ROLLBACK:          investigation_touched_at = NULL,
-- ROLLBACK:          investigation = investigation - 'closed_by' - 'closed_from'
-- ROLLBACK:            - 'closed_at' - 'upstream_kind' - 'upstream_table'
-- ROLLBACK:            - 'upstream_id' - 'upstream_resolved_at'
-- ROLLBACK:    WHERE investigation_status = 'historical'
-- ROLLBACK:      AND investigation->>'closed_by' = '20261006052925_the_operational_alert_closes_when_its_upstream_resolves'
-- ROLLBACK:      AND investigation->>'closed_from' IN ('new','investigating');
-- ROLLBACK:   DROP INDEX IF EXISTS public.operational_alert_events_open_upstream_key_idx;
-- ROLLBACK:   DROP FUNCTION IF EXISTS public.fn_close_operational_alerts_for_upstream(text, text);
-- ROLLBACK:   -- and re-apply the previous definition from
-- ROLLBACK:   -- 20261001161127_operational_alert_redelivery_addresses_an_unaddressed_row.sql
-- ROLLBACK:   -- for public.fn_capture_operational_source_event().
-- ROLLBACK: COMMIT;

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '600s';

DO $pre$
DECLARE v_reason text;
BEGIN
  v_reason := public.fn_ca_break_window_refuses_migrations(now());
  IF v_reason IS NOT NULL THEN
    RAISE EXCEPTION 'ALERT_CLOSURE_REFUSED: %', v_reason USING ERRCODE = '55000';
  END IF;
END
$pre$;

-- The supporting index. The -updates rows for one upstream record are keyed
-- <id>:<md5(row)>, so the closure matches them by prefix; without
-- text_pattern_ops that prefix match cannot use an index and the trigger path
-- would seq-scan 209,580 rows on every upstream resolution.
CREATE INDEX IF NOT EXISTS operational_alert_events_open_upstream_key_idx
  ON public.operational_alert_events (source, event_key text_pattern_ops)
  WHERE investigation_status IN ('new','investigating');

-- One implementation serves both callers - the trigger (one upstream id) and
-- this migration's backfill (p_source_id NULL = every resolved upstream of the
-- kind) - so the identity predicate cannot drift between them.
CREATE OR REPLACE FUNCTION public.fn_close_operational_alerts_for_upstream(
  p_kind text, p_source_id text DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SET search_path TO 'pg_catalog', 'public'
AS $fn$
DECLARE v_prefix text; v_table text; v_marker text; v_n integer;
BEGIN
  v_marker := '20261006052925_the_operational_alert_closes_when_its_upstream_resolves';
  IF p_kind = 'financial' THEN
    v_prefix := 'financial-alerts'; v_table := 'public.financial_alerts';
  ELSIF p_kind = 'drift' THEN
    v_prefix := 'drift-incidents'; v_table := 'public.ca_drift_incidents';
  ELSE
    RAISE EXCEPTION 'unsupported operational closure kind %', p_kind;
  END IF;
  IF p_source_id IS NOT NULL
     AND p_source_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'operational closure identity is invalid';
  END IF;

  WITH upstream AS (
    SELECT a.id AS uid, a.resolved_at
      FROM public.financial_alerts a
     WHERE p_kind = 'financial'
       AND a.resolved IS TRUE
       AND (p_source_id IS NULL OR a.id = p_source_id::uuid)
    UNION ALL
    SELECT d.id AS uid, d.resolved_at
      FROM public.ca_drift_incidents d
     WHERE p_kind = 'drift'
       AND d.resolved_at IS NOT NULL
       AND (p_source_id IS NULL OR d.id = p_source_id::uuid)
  ), closed AS (
    UPDATE public.operational_alert_events e
       SET investigation_status = 'historical',
           investigation_touched_at = clock_timestamp(),
           investigation = e.investigation || jsonb_build_object(
             'closed_by', v_marker,
             'closed_from', e.investigation_status,
             'closed_at', clock_timestamp(),
             'upstream_kind', p_kind,
             'upstream_table', v_table,
             'upstream_id', u.uid::text,
             'upstream_resolved_at', u.resolved_at)
      FROM upstream u
     WHERE e.investigation_status IN ('new','investigating')
       AND ( (e.source = v_prefix || '-backfill' AND e.event_key = u.uid::text)
          OR (e.source = v_prefix || '-updates'  AND e.event_key LIKE u.uid::text || ':%') )
    RETURNING 1)
  SELECT count(*) INTO v_n FROM closed;
  RETURN v_n;
END
$fn$;

COMMENT ON FUNCTION public.fn_close_operational_alerts_for_upstream(text, text) IS
  'Closes open operational_alert_events rows as historical when their LIVE upstream record is resolved. Read-only on the upstream tables. Evidence-bearing: records closed_from so the close is exactly reversible. Not a claim of root-cause repair - verified_fixed is reserved for a lane that verified a fix live.';

-- The structural half: the close now happens in the resolving UPDATE's own
-- transaction, through the trigger that already fires on it. A closure failure
-- must never abort the upstream money/incident result, so it warns exactly as
-- operational_source_intake.preserve does and never swallows cancellation.
CREATE OR REPLACE FUNCTION public.fn_capture_operational_source_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog'
SET "TimeZone" TO 'UTC'
AS $function$
DECLARE k text; v_resolved_now boolean; v_resolved_before boolean;
BEGIN
  IF TG_TABLE_SCHEMA<>'public' OR TG_TABLE_NAME NOT IN ('engine_alerts','financial_alerts','ca_drift_incidents')
    OR TG_OP NOT IN ('INSERT','UPDATE') OR TG_WHEN<>'AFTER' OR TG_LEVEL<>'ROW'
    THEN RAISE EXCEPTION 'invalid operational source trigger binding'; END IF;
  k:=CASE TG_TABLE_NAME WHEN 'engine_alerts' THEN 'engine' WHEN 'financial_alerts' THEN 'financial' ELSE 'drift' END;
  IF TG_OP='UPDATE' AND to_jsonb(NEW)=to_jsonb(OLD) THEN RETURN NEW; END IF;
  IF k='engine' THEN
    IF TG_OP='UPDATE' THEN PERFORM operational_source_intake.record_strict(k,to_jsonb(OLD),'update_old'); END IF;
    PERFORM operational_source_intake.record_strict(k,to_jsonb(NEW),CASE WHEN TG_OP='INSERT' THEN 'insert' ELSE 'update_new' END);
  ELSE
    IF TG_OP='UPDATE' THEN PERFORM operational_source_intake.preserve(k,to_jsonb(OLD),'update_old'); END IF;
    PERFORM operational_source_intake.preserve(k,to_jsonb(NEW),CASE WHEN TG_OP='INSERT' THEN 'insert' ELSE 'update_new' END);
    -- The alert's condition has just ended upstream: close its open rows,
    -- including the recovery snapshot preserved immediately above, so a
    -- recovery stops adding to a backlog it is the end of.
    IF TG_OP='UPDATE' THEN
      v_resolved_now := CASE k WHEN 'financial' THEN (to_jsonb(NEW)->>'resolved')='true'
                                              ELSE (to_jsonb(NEW)->>'resolved_at') IS NOT NULL END;
      v_resolved_before := CASE k WHEN 'financial' THEN (to_jsonb(OLD)->>'resolved')='true'
                                                 ELSE (to_jsonb(OLD)->>'resolved_at') IS NOT NULL END;
      IF v_resolved_now AND NOT v_resolved_before THEN
        BEGIN
          PERFORM public.fn_close_operational_alerts_for_upstream(k, (to_jsonb(NEW)->>'id'));
        EXCEPTION WHEN OTHERS THEN
          RAISE WARNING 'operational alert closure failed kind=% id=% SQLSTATE=%: %',
            k, to_jsonb(NEW)->>'id', SQLSTATE, left(SQLERRM,1000);
        END;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

-- The backfill, through the same function, and then the property that matters:
-- not a frozen count, but that NOTHING resolved upstream is left open.
DO $backfill$
DECLARE v_fin integer; v_drift integer; v_left integer; v_bad integer;
BEGIN
  v_fin   := public.fn_close_operational_alerts_for_upstream('financial');
  v_drift := public.fn_close_operational_alerts_for_upstream('drift');
  RAISE NOTICE 'closed financial=% drift=%', v_fin, v_drift;

  SELECT count(*) INTO v_left
    FROM public.operational_alert_events e
   WHERE e.investigation_status IN ('new','investigating')
     AND ( EXISTS (SELECT 1 FROM public.financial_alerts a
                    WHERE a.resolved IS TRUE
                      AND ( (e.source='financial-alerts-backfill' AND e.event_key=a.id::text)
                         OR (e.source='financial-alerts-updates'  AND e.event_key LIKE a.id::text||':%') ))
        OR EXISTS (SELECT 1 FROM public.ca_drift_incidents d
                    WHERE d.resolved_at IS NOT NULL
                      AND ( (e.source='drift-incidents-backfill' AND e.event_key=d.id::text)
                         OR (e.source='drift-incidents-updates'  AND e.event_key LIKE d.id::text||':%') )) );
  IF v_left <> 0 THEN
    RAISE EXCEPTION 'closure incomplete: % rows whose upstream is resolved are still open', v_left;
  END IF;

  -- And the inverse property: nothing was closed whose upstream is NOT resolved.
  SELECT count(*) INTO v_bad
    FROM public.operational_alert_events e
   WHERE e.investigation_status = 'historical'
     AND e.investigation->>'closed_by' = '20261006052925_the_operational_alert_closes_when_its_upstream_resolves'
     AND NOT EXISTS (SELECT 1 FROM public.financial_alerts a
                      WHERE a.id::text = e.investigation->>'upstream_id' AND a.resolved IS TRUE)
     AND NOT EXISTS (SELECT 1 FROM public.ca_drift_incidents d
                      WHERE d.id::text = e.investigation->>'upstream_id' AND d.resolved_at IS NOT NULL);
  IF v_bad <> 0 THEN
    RAISE EXCEPTION 'closure unsound: % rows closed without a resolved upstream', v_bad;
  END IF;

  -- Every closed row must be reversible and must name its evidence.
  SELECT count(*) INTO v_bad
    FROM public.operational_alert_events e
   WHERE e.investigation_status = 'historical'
     AND e.investigation->>'closed_by' = '20261006052925_the_operational_alert_closes_when_its_upstream_resolves'
     AND ( e.investigation->>'closed_from' NOT IN ('new','investigating')
        OR e.investigation->>'upstream_id' IS NULL
        OR e.investigation_touched_at IS NULL );
  IF v_bad <> 0 THEN
    RAISE EXCEPTION 'closure not reversible: % rows lack closed_from, upstream_id or a touch time', v_bad;
  END IF;
END
$backfill$;

COMMIT;
