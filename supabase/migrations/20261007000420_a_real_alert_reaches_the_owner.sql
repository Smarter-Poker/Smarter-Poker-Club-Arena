-- 20261007000420_a_real_alert_reaches_the_owner.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- A REAL ALERT REACHES THE OWNER (launch audit: "nobody would be told if a
-- table broke"). Full account:
-- docs/changelog/2026-10-07-a-real-alert-reaches-the-owner.md.
--
-- Every Club Arena operational alert lands in public.operational_alert_events
-- (Alertmanager through World Hub, engine alerts and the owner's financial
-- incidents through the source intake). That inbox has one reader, the
-- Production Alerts fleet, and nothing in it has been read since 2026-10-01
-- 20:02 UTC (investigation_touched_at is NULL on every row). Measured
-- 2026-10-06 over 48 hours: 1,574 rows, all unread; 988 of them were the same
-- financial alert recorded under several mirror sources, 429 were recovery
-- notices and 370 were below critical. The one page that reaches a phone,
-- "Production Alerts Has Stopped Reading" (20261003102610), fires once per
-- silence; the silence began on 10-01, so it fired once on 10-03 and never
-- again. Since then a -494,917.55 ledger imbalance, a 407-kill engine storm
-- and tables stalled for 40 minutes reached nobody.
--
-- What changes. Three kinds of alert are the ones a person must hear about:
--   dealing  - a table or tournament stops dealing;
--   restarts - the engine is destroying and rebuilding tables in a loop, or
--              restarted outside the hourly break;
--   money    - a money or ledger integrity failure that already passed
--              fn_ca_incident_notify's critical-only gate, or an unpaid prize.
-- When a new firing row of one of those kinds is recorded, the senior platform
-- recipients in ca_incident_recipients (today: the owner) get an ordinary
-- 'system' notification, which the existing mirror puts on push_outbox and
-- the existing dispatcher sends to their phone. Nothing new is configured: no
-- credential, no service, no job.
--
-- The noise is held back, not paged. Everything else (warnings, recovery
-- notices, mirror copies, self-clearing one-minute flickers such as
-- PokerTablesFrozen, the hourly SLOEngineAvailability after each break) stays
-- in the inbox only. Within a kind, a repeat does not page again until that
-- kind has been quiet for 3 hours (a new episode), except that a kind still
-- firing 12 hours after its last page pages once more so a long outage is not
-- one message. Each page says how many were held since the last one.
-- Replayed against the last 7 days: 283 real firings would have produced 36
-- pages (dealing 12, restarts 15, money 9) - about five a day.
--
-- Event-driven: an AFTER INSERT trigger on the inbox. A repeat delivery of the
-- same alert is an ON CONFLICT update, not an insert, so it never pages. No
-- job is added. No chips move. The trigger can never fail the capture of an
-- alert: it runs inside its own exception block.
--
-- @live-proof: (SELECT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'zz_a_real_alert_reaches_the_owner' AND tgrelid = 'public.operational_alert_events'::regclass AND tgenabled = 'O') AND to_regclass('public.ca_owner_page_state') IS NOT NULL AND (SELECT count(*) FROM public.ca_owner_page_state) = 3)

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $pre$
BEGIN
  IF to_regclass('public.ca_owner_page_state') IS NOT NULL
     OR to_regprocedure('public.fn_ca_owner_page_kind(text,text,text)') IS NOT NULL
     OR to_regprocedure('public.fn_ca_a_real_alert_reaches_the_owner()') IS NOT NULL THEN
    RAISE EXCEPTION 'REAL_ALERT_PREIMAGE_CHANGED';
  END IF;
  -- The page must never be diverted back into the inbox nobody is reading.
  IF public.fn_is_owner_operational_notification('47965354-0e56-43ef-931c-ddaab82af765'::uuid, 'system',
       'Tables Have Stopped Dealing',
       jsonb_build_object('source', 'owner-real-alert', 'kind', 'dealing', 'alert', 'SLOTableHasStalled')) THEN
    RAISE EXCEPTION 'REAL_ALERT_PAGE_WOULD_BE_DIVERTED';
  END IF;
END
$pre$;

-- Which alerts are the ones a person must hear about. NULL means inbox only.
CREATE FUNCTION public.fn_ca_owner_page_kind(p_source text, p_alertname text, p_severity text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
 SET search_path TO 'pg_catalog'
AS $function$
  SELECT CASE
    WHEN p_source = 'alertmanager' AND p_alertname IN (
           'SLOTableHasStalled', 'SLOHandsAreNotBeingDealt', 'EngineHandsStopped',
           'EngineLivenessDead', 'EngineDown', 'EngineScrapeDown', 'EngineDiscoveryStalled',
           'EngineFleetThroughputCollapsed', 'MttPlayStopped', 'MttFleetNotDealing',
           'TournamentNeverStarted', 'TournamentFleetUnserved', 'PokerTournamentTableNeverStarted')
      THEN 'dealing'
    WHEN (p_source = 'engine-alerts-backfill' AND p_alertname = 'ClubArenaEngineKillStorm'
          AND p_severity = 'critical')
      OR (p_source = 'alertmanager' AND p_alertname IN ('EngineRestartedOutsideTheBreak',
          'TablesAreReloadingThemselves'))
      THEN 'restarts'
    WHEN (p_source = 'owner-operational-notifications' AND p_severity = 'critical'
          AND (p_alertname LIKE 'financial\_incident:%' OR p_alertname LIKE 'guarantee\_bank\_short:%'))
      OR (p_source = 'alertmanager' AND p_alertname IN ('UndeclaredTriggerOnAMoneyTable',
          'TournamentCompletedUnpaid', 'SpinPrizeUnpaid'))
      THEN 'money'
  END;
$function$;

-- One row per kind: when it last fired, when it last paged, how many were held.
-- No foreign key to anything (production DDL policy rule 7).
CREATE TABLE public.ca_owner_page_state (
  kind text PRIMARY KEY CHECK (kind IN ('dealing', 'restarts', 'money')),
  last_firing_at timestamptz,
  last_paged_at timestamptz,
  held_since_page integer NOT NULL DEFAULT 0,
  pages_sent bigint NOT NULL DEFAULT 0
);
INSERT INTO public.ca_owner_page_state (kind) VALUES ('dealing'), ('restarts'), ('money');
ALTER TABLE public.ca_owner_page_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_owner_page_state FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.ca_owner_page_state TO service_role;

CREATE FUNCTION public.fn_ca_a_real_alert_reaches_the_owner()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  c_new_episode CONSTANT interval := interval '3 hours';
  c_reminder CONSTANT interval := interval '12 hours';
  v_kind text;
  v_state public.ca_owner_page_state%ROWTYPE;
  v_now timestamptz := clock_timestamp();
  v_page boolean;
  v_title text;
  v_summary text;
  v_rec uuid;
BEGIN
  v_kind := public.fn_ca_owner_page_kind(NEW.source, NEW.alertname, NEW.severity);
  IF v_kind IS NULL THEN RETURN NULL; END IF;

  SELECT * INTO v_state FROM public.ca_owner_page_state WHERE kind = v_kind FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;

  v_page := v_state.last_firing_at IS NULL
         OR v_now - v_state.last_firing_at >= c_new_episode
         OR v_state.last_paged_at IS NULL
         OR v_now - v_state.last_paged_at >= c_reminder;

  IF NOT v_page THEN
    UPDATE public.ca_owner_page_state
       SET last_firing_at = v_now, held_since_page = held_since_page + 1
     WHERE kind = v_kind;
    RETURN NULL;
  END IF;

  v_title := CASE v_kind
               WHEN 'dealing' THEN 'Tables Have Stopped Dealing'
               WHEN 'restarts' THEN 'Engine Restart Storm'
               ELSE 'Money Check Failed'
             END;
  v_summary := left(btrim(COALESCE(
      NULLIF(NEW.payload->'alert'->'annotations'->>'summary', ''),
      NULLIF(NEW.payload->'original_event'->>'summary', ''),
      NULLIF(NEW.payload->'original_notification'->>'title', ''),
      NEW.alertname)), 300);

  FOR v_rec IN
    SELECT DISTINCT r.user_id FROM public.ca_incident_recipients r
     WHERE r.scope = 'platform' AND r.active AND r.senior AND r.user_id IS NOT NULL
  LOOP
    PERFORM public.fn_raise_notification(
      v_rec, 'system', v_title,
      v_summary || CASE WHEN v_state.held_since_page > 0
                        THEN format(' %s more of this kind since the last alert.', v_state.held_since_page)
                        ELSE '' END,
      CASE WHEN v_kind = 'money' THEN '/hub/club-arena/financial-incidents' ELSE '/hub/club-arena' END,
      jsonb_build_object('source', 'owner-real-alert', 'kind', v_kind, 'alert', NEW.alertname,
                         'inbox_id', NEW.id, 'held_since_last_page', v_state.held_since_page));
  END LOOP;

  UPDATE public.ca_owner_page_state
     SET last_firing_at = v_now, last_paged_at = v_now, held_since_page = 0,
         pages_sent = pages_sent + 1
   WHERE kind = v_kind;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  -- The capture of the alert itself must never fail because of this page.
  RAISE WARNING 'fn_ca_a_real_alert_reaches_the_owner failed for %: %', NEW.id, SQLERRM;
  RETURN NULL;
END;
$function$;

CREATE TRIGGER zz_a_real_alert_reaches_the_owner
  AFTER INSERT ON public.operational_alert_events
  FOR EACH ROW
  WHEN (NEW.status = 'firing')
  EXECUTE FUNCTION public.fn_ca_a_real_alert_reaches_the_owner();

REVOKE ALL ON FUNCTION public.fn_ca_a_real_alert_reaches_the_owner() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_a_real_alert_reaches_the_owner() TO service_role;
REVOKE ALL ON FUNCTION public.fn_ca_owner_page_kind(text,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_owner_page_kind(text,text,text) TO service_role;

DO $post$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'zz_a_real_alert_reaches_the_owner'
                   AND tgrelid = 'public.operational_alert_events'::regclass AND tgenabled = 'O')
     OR (SELECT count(*) FROM public.ca_owner_page_state) <> 3
     OR public.fn_ca_owner_page_kind('alertmanager', 'SLOTableHasStalled', 'critical') IS DISTINCT FROM 'dealing'
     OR public.fn_ca_owner_page_kind('engine-alerts-backfill', 'ClubArenaEngineKillStorm', 'critical') IS DISTINCT FROM 'restarts'
     OR public.fn_ca_owner_page_kind('owner-operational-notifications', 'financial_incident:-14081.45 chip drift: ledger_imbalance', 'critical') IS DISTINCT FROM 'money'
     OR public.fn_ca_owner_page_kind('alertmanager', 'PokerTablesFrozen', 'critical') IS NOT NULL
     OR public.fn_ca_owner_page_kind('alertmanager', 'SLOEngineAvailability', 'critical') IS NOT NULL
     OR public.fn_ca_owner_page_kind('financial-alerts-backfill', 'postHandTasks.hand_history_failed', 'critical') IS NOT NULL
     OR has_function_privilege('anon', 'public.fn_ca_a_real_alert_reaches_the_owner()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_ca_a_real_alert_reaches_the_owner()', 'EXECUTE') THEN
    RAISE EXCEPTION 'REAL_ALERT_RESULT_CHANGED';
  END IF;
END
$post$;

COMMIT;
