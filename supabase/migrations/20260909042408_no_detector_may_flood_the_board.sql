-- NO DETECTOR MAY FLOOD THE BOARD (2026-09-09)
-- Companion to one_cause_is_one_incident_not_one_per_hand. That fixed the key
-- that let three engine conditions file 3,330 incidents. This makes the CLASS
-- of failure impossible: the next flood will arrive through a message shape
-- nobody normalised yet, and the board must survive it.
-- Past 25 open incidents for one source, further findings are counted on ONE
-- labelled storm incident instead of filing row 26. Nothing is discarded -
-- every occurrence is still in financial_alerts and in the storm incident's
-- event log, with its own dedupe key recorded. A source with 25 open rows is
-- not 25 findings a human works through one at a time; it is a detector or a
-- condition to fix as a whole, and the storm row says so. The cap is well
-- above any legitimate fan-out here: the widest genuine source across all
-- 5,709 incidents ever filed is 8 open rows.
BEGIN;

DO $do$
DECLARE
  v_def    text;
  v_anchor CONSTANT text := '  INSERT INTO public.ca_drift_incidents (
    classification, severity, layer, source, dedupe_key,';
  v_storm  CONSTANT text := $storm$  /* DETECTOR STORM CAP (2026-09-09). One source cannot own the board.
     Reached only after the exact-key fold and the stable-key fold above have
     both declined to absorb this finding, i.e. it really would be a NEW row. */
  IF (SELECT count(*) FROM public.ca_drift_incidents
       WHERE source = p_source AND status <> 'resolved') >= 25 THEN
    UPDATE public.ca_drift_incidents
       SET occurrences = occurrences + 1, last_seen_at = now()
     WHERE dedupe_key = 'storm:' || p_source AND status <> 'resolved'
     RETURNING id INTO v_id;
    IF v_id IS NULL THEN
      INSERT INTO public.ca_drift_incidents (
        classification, severity, layer, source, dedupe_key,
        discrepancy_amount, suspected_cause, metadata)
      VALUES ('unknown', v_sev, COALESCE(p_layer,'unknown'), p_source,
        'storm:' || p_source, 0,
        'DETECTOR STORM: this source has 25 or more open incidents, so further findings are counted here rather than filed as new rows. Every occurrence is still in financial_alerts and in this incident event log. Fix the detector, or the condition behind it, then resolve this.',
        jsonb_build_object('storm', true, 'capped_from', p_dedupe_key))
      ON CONFLICT (dedupe_key) WHERE status <> 'resolved' DO NOTHING
      RETURNING id INTO v_id;
      IF v_id IS NULL THEN
        UPDATE public.ca_drift_incidents
           SET occurrences = occurrences + 1, last_seen_at = now()
         WHERE dedupe_key = 'storm:' || p_source AND status <> 'resolved'
         RETURNING id INTO v_id;
      END IF;
    END IF;
    IF v_id IS NOT NULL THEN
      INSERT INTO public.ca_incident_events (incident_id, kind, detail)
      VALUES (v_id, 'recurred', jsonb_build_object(
        'source', p_source, 'capped_dedupe_key', p_dedupe_key,
        'discrepancy', p_discrepancy, 'suspected_cause', p_suspected_cause,
        'note', 'counted on the storm incident: this source is over its open-incident cap'));
    END IF;
    RETURN v_id;
  END IF;

$storm$;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_ca_raise_drift_incident';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'fn_ca_raise_drift_incident is missing';
  END IF;
  IF position('DETECTOR STORM CAP' in v_def) > 0 THEN
    RAISE NOTICE 'storm cap already present - nothing to do';
    RETURN;
  END IF;
  IF position(v_anchor in v_def) = 0 THEN
    RAISE EXCEPTION 'the INSERT this cap guards has moved; re-read fn_ca_raise_drift_incident before applying';
  END IF;

  EXECUTE replace(v_def, v_anchor, v_storm || v_anchor);
END $do$;

DO $post$
DECLARE v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_ca_raise_drift_incident';
  IF position('DETECTOR STORM CAP' in v_def) = 0 THEN
    RAISE EXCEPTION 'the replacement did not take: the storm cap is not in the live definition';
  END IF;
  IF position('storm:' in v_def) = 0 THEN
    RAISE EXCEPTION 'a landmark of the storm cap went missing during replacement';
  END IF;
END $post$;

COMMIT;
