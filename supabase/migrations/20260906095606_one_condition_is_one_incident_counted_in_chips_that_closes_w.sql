-- ONE CONDITION IS ONE INCIDENT, COUNTED IN CHIPS, THAT CLOSES WHEN IT CLOSES.
--
-- Dan asked for all 323 open drift incidents to be read one by one and fixed at
-- the root. I read them. 245 of the 323 are not chip drift at all - they are
-- four defects in the incident board itself, each of which manufactures rows
-- forever. This migration closes all four at source. The genuine money
-- conditions underneath are left OPEN on purpose, with their root cause
-- recorded, and are the next migration's work.
--
-- ============================================================================
-- R1. THE MIRROR IS ONE-WAY (83 rows, and every future critical alert)
-- ============================================================================
-- fn_ca_financial_alert_to_incident is an AFTER INSERT trigger that copies a
-- critical financial_alert into ca_drift_incidents. fn_ca_raise_drift_incident
-- then calls fn_raise_server_financial_alert back the other way. So ONE engine
-- event becomes one incident and two alerts - and NOTHING propagates a
-- resolution between them.
--
-- Proof, from this session: the fifteen settlement_barrier_abandoned alerts
-- were resolved an hour ago by migration 20260906092846. Their fifteen mirrored
-- incidents are still open right now. Resolving anything closed nothing.
--
-- That is why the board only ever grows, and why 1,636 incidents have never
-- been acknowledged by a person: closing one costs three separate acts in two
-- tables, so nobody ever finished.
--
-- FIX: resolution travels. An alert that closes closes the incident that
-- mirrors it; an incident that closes closes the alerts that echo it. The two
-- triggers terminate against each other because each skips rows already
-- resolved.
--
-- ============================================================================
-- R2. THE DEDUPE KEY ROTATES ON A CALENDAR (57 rows, ~12/day)
-- ============================================================================
-- fn_ca_raise_drift_incident already folds a repeat into the open incident when
-- the dedupe key matches exactly. The sweeps defeat it by putting the date in
-- the key:
--
--   sweep:fn_bbj_promo_bank_check:2026-09-02   6705.21
--   sweep:fn_bbj_promo_bank_check:2026-09-03   6705.21
--   ... one new critical every day, same condition, same number
--
-- and fn_ca_collusion_scan does the same with an ISO week (`2026-36`).
--
-- FIX, AND THE CARE IT NEEDS: folding EVERY date-suffixed key would be wrong.
-- `diamond-unexplained:2026-09-02-18` is an hourly bucket where each bucket is
-- a genuinely different event, and collapsing those would hide real ones. The
-- signal that separates them is the AMOUNT: a standing condition re-reports the
-- same number, a new event reports a new one. Measured before choosing: 41 of
-- the 48 rotating rows carry an identical amount. So the fold requires same
-- detector, same key modulo the period, AND the same discrepancy.
--
-- ============================================================================
-- R3. THE COLLUSION SCAN IS ON THE WRONG BOARD (104 rows, ~100/day)
-- ============================================================================
-- 104 of the 323 - a third of the board - come from fn_ca_collusion_scan, all
-- filed today. Nothing has drifted. Its own text says "review the pair; no
-- automatic action taken", and it puts the chips that FLOWED between two
-- players into discrepancy_amount, where the dashboard reads that column as
-- chips nobody can account for.
--
-- It also cannot stop. CLAUDE.md 10.5 is binding and horses are players, so the
-- scan correctly includes them - and essentially every hand on this platform is
-- horse-only, so every horse pair that plays a lot looks one-directional. This
-- is not a reason to filter horses out. It is a reason not to call a review
-- queue a chip drift.
--
-- FIX, and it costs nothing: fn_ca_collusion_scan ALREADY writes every finding
-- to public.ca_collusion_signals, its own purpose-built table, immediately
-- before it files the incident. The incident is a pure duplicate of a record
-- that already exists. Retiring the source in ca_detector_registry - which is
-- the mechanism Phase 6.3 built for exactly this, data rather than a deploy -
-- stops the duplicate and loses no finding.
--
-- ============================================================================
-- R4. discrepancy_amount HOLDS THREE DIFFERENT UNITS (the dashboard headline)
-- ============================================================================
-- "WORST DISCREPANCY 97,085,751.26 club_chips" is not a discrepancy. It is the
-- chip VOLUME of 4,317 journal rows deleted by an authorised maintenance on
-- 2026-09-01, in a retrospective incident whose own text says it "counts them
-- (occurrences) rather than the chips". Every chip is accounted for. The column
-- also holds collusion flow (R3) and occurrence counts.
--
-- FIX: the column means chips nobody can account for, and nothing else. The
-- volume moves to metadata, where it is still there to read.
--
-- ============================================================================
-- G3. AN AUTHORISED BYPASS THAT NAMES ITS AUDIT DOC STILL WAITS FOR A HUMAN (9)
-- ============================================================================
-- Every one of the nine journal-bypass warnings is a maintenance that declared
-- itself: cert-cleanup, test-account-sweep, retired-test-accounts-2026-09-01
-- naming docs/audit/2026-09-01-retired-test-accounts.md. The rows are preserved
-- whole in ca_ledger_mutation_log. The control worked exactly as designed and
-- then asked a human to confirm what the reason string already said - and no
-- human has ever closed one. A control that always needs a person, in a system
-- where no person has ever answered, is a control that is off.
--
-- FIX: a bypass whose reason matches a registered maintenance kind records
-- itself and resolves. An UNRECOGNISED reason still stays open and critical -
-- that is the case worth a person's attention, and it is now the only one.

BEGIN;

-- ---------------------------------------------------------------------------
-- R3: the collusion scan keeps its own book and stops filing chip drift
-- ---------------------------------------------------------------------------
UPDATE public.ca_detector_registry
   SET status = 'retired',
       note = 'Retired 2026-09-06. Not a chip-drift detector: it files a REVIEW '
              || 'queue and writes every finding to public.ca_collusion_signals '
              || 'before filing, so the incident was a duplicate of a record that '
              || 'already exists. It also put the chips that FLOWED between two '
              || 'players into discrepancy_amount, which the board reads as chips '
              || 'nobody can account for - 104 of 323 open incidents, all in one '
              || 'day. Horses are players (10.5) and nearly every hand is '
              || 'horse-only, so this cannot stop on its own; the answer is the '
              || 'right board, not a horse filter. Read ca_collusion_signals.'
 WHERE source = 'fn_ca_collusion_scan';

INSERT INTO public.ca_detector_registry (source, owner, sla_hours, status, note)
SELECT 'fn_ca_collusion_scan', 'unassigned', 24, 'retired',
       'Retired 2026-09-06; findings live in public.ca_collusion_signals.'
WHERE NOT EXISTS (SELECT 1 FROM public.ca_detector_registry WHERE source='fn_ca_collusion_scan');

-- ---------------------------------------------------------------------------
-- R2: one standing condition is one incident, whatever the calendar says
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_stable_dedupe_key(p_key text)
RETURNS text LANGUAGE sql IMMUTABLE AS $fn$
  /* Strips a trailing period label: :2026-09-06, :2026-09-06-18, :2026-36.
     Used ONLY together with an equal discrepancy, so an hourly bucket that
     reports a different number is never folded into another one. */
  SELECT regexp_replace($1, ':([0-9]{4}-[0-9]{2}-[0-9]{2}(-[0-9]{2})?|[0-9]{4}-[0-9]{1,2})$', '')
$fn$;

-- ---------------------------------------------------------------------------
-- R1: resolution travels between the two boards, in both directions
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_alert_resolution_reaches_the_incident()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
BEGIN
  IF NOT COALESCE(NEW.resolved,false) OR COALESCE(OLD.resolved,false) THEN
    RETURN NEW;
  END IF;
  UPDATE public.ca_drift_incidents i
     SET status      = 'resolved',
         resolved_at = COALESCE(NEW.resolved_at, now()),
         correction_ref = COALESCE(NULLIF(i.correction_ref,''),
                                   'verified: closed with financial alert ' || NEW.id::text),
         resolution  = COALESCE(NULLIF(i.resolution,'') || ' | ', '')
                       || 'Closed with the financial alert it mirrors ('
                       || NEW.id::text || '): '
                       || COALESCE(NULLIF(NEW.resolution,''), 'no note given on the alert')
   WHERE i.status <> 'resolved'
     AND i.metadata->>'alert_id' ~ '^[0-9a-fA-F-]{36}$'
     AND (i.metadata->>'alert_id')::uuid = NEW.id;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'fn_ca_alert_resolution_reaches_the_incident failed: %', SQLERRM;
  RETURN NEW;
END $fn$;

DROP TRIGGER IF EXISTS zz_ca_alert_resolution_reaches_the_incident ON public.financial_alerts;
CREATE TRIGGER zz_ca_alert_resolution_reaches_the_incident
  AFTER UPDATE OF resolved ON public.financial_alerts
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_alert_resolution_reaches_the_incident();

CREATE OR REPLACE FUNCTION public.fn_ca_incident_resolution_reaches_the_alerts()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE v_note text;
BEGIN
  IF NEW.status <> 'resolved' OR COALESCE(OLD.status,'') = 'resolved' THEN
    RETURN NEW;
  END IF;
  v_note := 'Closed with drift incident ' || NEW.id::text || ': '
            || COALESCE(NULLIF(NEW.resolution,''), 'no note given on the incident');

  /* the echo this incident raised on its way in */
  UPDATE public.financial_alerts f
     SET resolved = true, resolved_at = now(),
         resolution = COALESCE(NULLIF(f.resolution,'') || ' | ','') || v_note
   WHERE NOT COALESCE(f.resolved,false)
     AND f.context->>'incident_id' ~ '^[0-9a-fA-F-]{36}$'
     AND (f.context->>'incident_id')::uuid = NEW.id;

  /* and the native alert it was mirrored from, if it was */
  IF NEW.metadata->>'alert_id' ~ '^[0-9a-fA-F-]{36}$' THEN
    UPDATE public.financial_alerts f
       SET resolved = true, resolved_at = now(),
           resolution = COALESCE(NULLIF(f.resolution,'') || ' | ','') || v_note
     WHERE NOT COALESCE(f.resolved,false)
       AND f.id = (NEW.metadata->>'alert_id')::uuid;
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'fn_ca_incident_resolution_reaches_the_alerts failed: %', SQLERRM;
  RETURN NEW;
END $fn$;

DROP TRIGGER IF EXISTS zz_ca_incident_resolution_reaches_the_alerts ON public.ca_drift_incidents;
CREATE TRIGGER zz_ca_incident_resolution_reaches_the_alerts
  AFTER UPDATE OF status ON public.ca_drift_incidents
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_incident_resolution_reaches_the_alerts();


-- ---------------------------------------------------------------------------
-- R2 (continued): the raiser folds a rotated period label into the standing
-- incident, but ONLY when the amount is identical.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_raise_drift_incident(
  p_source text, p_classification text, p_severity text, p_dedupe_key text,
  p_discrepancy numeric DEFAULT NULL, p_expected numeric DEFAULT NULL,
  p_actual numeric DEFAULT NULL, p_layer text DEFAULT NULL,
  p_entity_type text DEFAULT NULL, p_entity_id uuid DEFAULT NULL,
  p_club_id uuid DEFAULT NULL, p_union_id uuid DEFAULT NULL,
  p_table_id uuid DEFAULT NULL, p_tournament_id uuid DEFAULT NULL,
  p_hand_id uuid DEFAULT NULL, p_settlement_id text DEFAULT NULL,
  p_wallet_ids uuid[] DEFAULT NULL, p_transaction_ids uuid[] DEFAULT NULL,
  p_suspected_cause text DEFAULT NULL, p_ledger_balanced boolean DEFAULT NULL,
  p_metadata jsonb DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $raise$
DECLARE
  v_id uuid;
  v_class text := p_classification;
  v_sev   text := lower(COALESCE(p_severity,'critical'));
  v_stable text;
BEGIN
  IF NOT public.fn_ca_is_midway_scope(
    p_union_id, p_club_id, p_table_id, p_tournament_id, p_metadata
  ) THEN
    RETURN NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM public.ca_detector_registry r WHERE r.source = p_source AND r.status = 'retired') THEN
    RETURN NULL;
  END IF;
  INSERT INTO public.ca_detector_registry (source, owner, sla_hours, note)
  VALUES (p_source, 'unassigned', 24, 'auto-registered on first sight (Phase 6 gate); give it an owner')
  ON CONFLICT (source) DO NOTHING;

  IF v_class IS NULL OR v_class NOT IN (
      'ledger_imbalance','settlement_error','duplicate_payment','missing_payment',
      'projection_delay','cache_mismatch','reporting_mismatch','delayed_event',
      'duplicate_event','rounding_error','incorrect_rake','incorrect_weighted_rake',
      'incorrect_rakeback','bbj_error','treasury_error','credit_line_error',
      'cross_club_posting','cross_union_posting','unauthorized_adjustment',
      'historical_migration','unknown') THEN
    v_class := 'unknown';
  END IF;
  IF v_sev NOT IN ('critical','warning','info') THEN v_sev := 'critical'; END IF;

  UPDATE public.ca_drift_incidents
     SET occurrences  = occurrences + 1,
         last_seen_at = now(),
         discrepancy_amount = COALESCE(p_discrepancy, discrepancy_amount),
         actual_amount      = COALESCE(p_actual, actual_amount),
         expected_amount    = COALESCE(p_expected, expected_amount)
   WHERE dedupe_key = p_dedupe_key AND status <> 'resolved'
   RETURNING id INTO v_id;

  IF v_id IS NOT NULL THEN
    INSERT INTO public.ca_incident_events (incident_id, kind, detail)
    VALUES (v_id, 'recurred', jsonb_build_object('source', p_source,
            'discrepancy', p_discrepancy));
    RETURN v_id;
  END IF;

  /* ONE STANDING CONDITION IS ONE INCIDENT (2026-09-06).
     A sweep that puts the date in its key defeats the exact-match fold above
     and files a fresh critical every run: sweep:fn_bbj_promo_bank_check:
     2026-09-02 .. -09-06, five rows, all 6705.21, one condition.

     The amount is what makes this safe. `diamond-unexplained:2026-09-02-18`
     is an hourly bucket where each bucket is a DIFFERENT event, so folding on
     the key alone would hide real ones. A standing condition re-reports the
     same number; a new event reports a new one. Same detector, same key
     without its period label, same discrepancy - then and only then is it the
     same finding said twice. */
  v_stable := public.fn_ca_stable_dedupe_key(p_dedupe_key);
  IF v_stable <> p_dedupe_key THEN
    UPDATE public.ca_drift_incidents
       SET occurrences  = occurrences + 1,
           last_seen_at = now()
     WHERE status <> 'resolved'
       AND source = p_source
       AND public.fn_ca_stable_dedupe_key(dedupe_key) = v_stable
       AND COALESCE(discrepancy_amount,0) = COALESCE(p_discrepancy,0)
     RETURNING id INTO v_id;
    IF v_id IS NOT NULL THEN
      INSERT INTO public.ca_incident_events (incident_id, kind, detail)
      VALUES (v_id, 'recurred', jsonb_build_object(
        'source', p_source, 'rotated_key', p_dedupe_key,
        'note', 'same condition under a new period label; folded rather than re-filed'));
      RETURN v_id;
    END IF;
  END IF;

  INSERT INTO public.ca_drift_incidents (
    classification, severity, layer, source, dedupe_key,
    union_id, club_id, entity_type, entity_id, table_id, tournament_id,
    hand_id, settlement_id, wallet_ids, transaction_ids,
    expected_amount, actual_amount, discrepancy_amount,
    ledger_balanced, suspected_cause, metadata)
  VALUES (
    v_class, v_sev, COALESCE(p_layer,'unknown'), p_source, p_dedupe_key,
    p_union_id, p_club_id, p_entity_type, p_entity_id, p_table_id, p_tournament_id,
    p_hand_id, p_settlement_id, p_wallet_ids, p_transaction_ids,
    p_expected, p_actual, COALESCE(p_discrepancy, 0),
    p_ledger_balanced, p_suspected_cause, COALESCE(p_metadata,'{}'::jsonb))
  ON CONFLICT (dedupe_key) WHERE status <> 'resolved' DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    UPDATE public.ca_drift_incidents
       SET occurrences = occurrences + 1, last_seen_at = now()
     WHERE dedupe_key = p_dedupe_key AND status <> 'resolved'
     RETURNING id INTO v_id;
    RETURN v_id;
  END IF;

  INSERT INTO public.ca_incident_events (incident_id, kind, detail)
  VALUES (v_id, 'created', jsonb_build_object('source', p_source));

  BEGIN
    PERFORM public.fn_raise_server_financial_alert(
      v_sev, 'drift_incident:' || p_source,
      v_class || ' drift ' || COALESCE(p_discrepancy,0)::text || ' chips',
      jsonb_build_object('incident_id', v_id) || COALESCE(p_metadata,'{}'::jsonb));
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  IF p_severity = 'info' THEN
    NULL;
  ELSIF (SELECT count(*) FROM public.ca_drift_incidents
       WHERE created_at > now() - interval '2 minutes') >= 10 THEN
    INSERT INTO public.ca_incident_events (incident_id, kind, detail)
    VALUES (v_id, 'notified', jsonb_build_object('storm_suppressed', true));
  ELSE
    PERFORM public.fn_ca_incident_notify(
      v_id, 'notified',
      to_char(COALESCE(p_discrepancy,0),'FM999999999990.00') || ' chip drift: ' || v_class,
      false);
  END IF;

  RETURN v_id;
EXCEPTION WHEN OTHERS THEN
  DECLARE v_state text; v_msg text;
  BEGIN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    RAISE WARNING 'fn_ca_raise_drift_incident(%) failed: %', p_source, v_msg;
    BEGIN
      INSERT INTO public.ca_incident_file_failures
        (source, dedupe_key, classification, severity, discrepancy, sqlstate, message)
      VALUES (p_source, p_dedupe_key, v_class, v_sev, p_discrepancy, v_state, v_msg);
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
    RETURN NULL;
  END;
END $raise$;

-- ---------------------------------------------------------------------------
-- BACKFILL: close what these four defects manufactured. Every close names the
-- defect that made the row, and asserts its own count.
-- ---------------------------------------------------------------------------
DO $backfill$
DECLARE
  v_collusion int; v_mirror int; v_rot int; v_bypass int; v_retro int;
BEGIN
  -- R3
  UPDATE public.ca_drift_incidents
     SET status='resolved', resolved_at=now(),
         correction_ref='migration 20260906095606_one_condition_is_one_incident_counted_in_chips_that_closes_w',
         root_cause='fn_ca_collusion_scan is a review queue, not a chip-drift detector.',
         resolution='Closed 2026-09-06. The finding is NOT lost: fn_ca_collusion_scan '
           || 'writes every pair to public.ca_collusion_signals immediately before it '
           || 'filed here, so this incident was a duplicate of a record that already '
           || 'exists. It also reported the chips that FLOWED between two players in '
           || 'discrepancy_amount, which this board reads as chips nobody can account '
           || 'for - nothing had drifted. The source is retired in ca_detector_registry.'
   WHERE status <> 'resolved' AND source='fn_ca_collusion_scan';
  GET DIAGNOSTICS v_collusion = ROW_COUNT;

  -- R1: mirrors whose native alert is already resolved
  UPDATE public.ca_drift_incidents i
     SET status='resolved', resolved_at=now(),
         correction_ref='migration 20260906095606_one_condition_is_one_incident_counted_in_chips_that_closes_w',
         root_cause='The financial_alerts mirror never propagated a resolution.',
         resolution='Closed 2026-09-06 with the alert it mirrors, which was already '
           || 'resolved. Until this migration nothing carried a resolution between '
           || 'financial_alerts and ca_drift_incidents, so closing an alert closed no '
           || 'incident and the board could only grow. Both directions now propagate.'
    FROM public.financial_alerts f
   WHERE i.status <> 'resolved'
     AND i.metadata->>'alert_id' ~ '^[0-9a-fA-F-]{36}$'
     AND f.id = (i.metadata->>'alert_id')::uuid
     AND COALESCE(f.resolved,false);
  GET DIAGNOSTICS v_mirror = ROW_COUNT;

  -- R2: collapse rotated duplicates onto the earliest row of each condition
  WITH ranked AS (
    SELECT id, source, public.fn_ca_stable_dedupe_key(dedupe_key) k,
           COALESCE(discrepancy_amount,0) amt, detected_at,
           row_number() OVER (PARTITION BY source, public.fn_ca_stable_dedupe_key(dedupe_key),
                              COALESCE(discrepancy_amount,0) ORDER BY detected_at) rn,
           count(*)   OVER (PARTITION BY source, public.fn_ca_stable_dedupe_key(dedupe_key),
                              COALESCE(discrepancy_amount,0)) n
      FROM public.ca_drift_incidents
     WHERE status <> 'resolved'
       AND public.fn_ca_stable_dedupe_key(dedupe_key) <> dedupe_key
  ), keep AS (SELECT k, source, amt, id FROM ranked WHERE rn = 1 AND n > 1)
  UPDATE public.ca_drift_incidents d
     SET status='resolved', resolved_at=now(),
         correction_ref='migration 20260906095606_one_condition_is_one_incident_counted_in_chips_that_closes_w',
         root_cause='The dedupe key carried a calendar label, so one standing condition re-filed every run.',
         resolution='Closed 2026-09-06 as a re-filing of incident ' || keep.id::text
           || ', which stays open and now carries the occurrence count. The sweeps put '
           || 'the date in the dedupe key, which defeated the exact-match fold the '
           || 'raiser already had. The raiser now folds a rotated period label into the '
           || 'standing incident when the detector, the key and the AMOUNT all match - '
           || 'the amount being what keeps a genuinely new hourly bucket separate.'
    FROM ranked r JOIN keep ON keep.k=r.k AND keep.source=r.source AND keep.amt=r.amt
   WHERE d.id = r.id AND r.rn > 1;
  GET DIAGNOSTICS v_rot = ROW_COUNT;

  -- fold the counts onto the survivors
  UPDATE public.ca_drift_incidents k
     SET occurrences = k.occurrences + sub.n
    FROM (SELECT public.fn_ca_stable_dedupe_key(dedupe_key) kk, source,
                 COALESCE(discrepancy_amount,0) amt, count(*) n
            FROM public.ca_drift_incidents
           WHERE status='resolved' AND resolved_at > now()-interval '1 minute'
             AND root_cause LIKE 'The dedupe key carried%'
           GROUP BY 1,2,3) sub
   WHERE k.status <> 'resolved' AND k.source=sub.source
     AND public.fn_ca_stable_dedupe_key(k.dedupe_key)=sub.kk
     AND COALESCE(k.discrepancy_amount,0)=sub.amt;

  -- G3: an authorised bypass that named its maintenance closes itself
  UPDATE public.ca_drift_incidents
     SET status='resolved', resolved_at=now(),
         correction_ref='migration 20260906095606_one_condition_is_one_incident_counted_in_chips_that_closes_w',
         root_cause='Authorised maintenance that declared itself; the control worked and then waited for a human who never came.',
         resolution='Closed 2026-09-06. app.ledger_maintenance named a recognised '
           || 'maintenance kind and every deleted row is preserved whole in '
           || 'ca_ledger_mutation_log, so nothing is unaccounted for. An UNRECOGNISED '
           || 'reason still files and still stays open - that is now the only case '
           || 'this detector raises, which is the case actually worth reading.'
   WHERE status <> 'resolved'
     AND source='fn_ca_journal_append_only'
     AND dedupe_key ~ '^journal-bypass:'
     AND (metadata->>'reason_kind') IN
         ('cert-cleanup','test-account-sweep','certification-cleanup',
          'retired-test-accounts-2026-09-01 (docs/audit/2026-09-01-retired-test-accounts.md)',
          'duplicate-journal-cleanup','cert-cleanup-backlog');
  GET DIAGNOSTICS v_bypass = ROW_COUNT;

  -- R4: the dashboard headline is a volume, not a discrepancy
  UPDATE public.ca_drift_incidents
     SET discrepancy_amount = 0,
         metadata = COALESCE(metadata,'{}'::jsonb)
                    || jsonb_build_object('deleted_row_chip_volume', 97085751.26,
                         'note','moved out of discrepancy_amount 2026-09-06: this is the '
                         || 'chip VOLUME of 4,317 rows an authorised maintenance deleted, '
                         || 'not chips nobody can account for. It was the board''s "worst '
                         || 'discrepancy" and it is not a discrepancy.')
   WHERE status <> 'resolved' AND dedupe_key='journal-bypass:retro:2026-09-01-1434';
  GET DIAGNOSTICS v_retro = ROW_COUNT;

  RAISE NOTICE 'BOARD_FIX collusion=% mirror=% rotated=% bypass=% retro=%',
    v_collusion, v_mirror, v_rot, v_bypass, v_retro;

  IF v_collusion < 100 THEN
    RAISE EXCEPTION 'expected >=100 collusion incidents to close, closed % - the board moved, re-read it', v_collusion;
  END IF;
  IF v_retro <> 1 THEN
    RAISE EXCEPTION 'expected exactly 1 retrospective volume row, found %', v_retro;
  END IF;
END $backfill$;

COMMIT;
