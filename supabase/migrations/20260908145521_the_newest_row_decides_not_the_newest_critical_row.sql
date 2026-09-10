DO $mig$
DECLARE
  v_src text; v_new text; v_hits int;
  v_anchor text :=
    '    SELECT DISTINCT ON (l.entity_type, l.entity_id)' || E'\n' ||
    '           l.entity_type, l.entity_id, l.drift, l.ledger_balance,' || E'\n' ||
    '           l.stored_balance, l.run_date, l.metadata' || E'\n' ||
    '      FROM public.ledger_reconcile_log l' || E'\n' ||
    '     WHERE l.severity = ''critical''' || E'\n' ||
    '       AND l.created_at >= now() - p_lookback' || E'\n' ||
    '     ORDER BY l.entity_type, l.entity_id, l.created_at DESC';
  v_replace text :=
    '    /* THE NEWEST ROW DECIDES, NOT THE NEWEST CRITICAL ROW (2026-09-08).' || E'\n' ||
    '       The severity filter used to sit in this WHERE, so DISTINCT ON picked' || E'\n' ||
    '       the newest CRITICAL row per entity rather than the newest row - and' || E'\n' ||
    '       an entity whose latest reading is ok kept re-escalating its last' || E'\n' ||
    '       critical for the whole lookback. Deep Stack Society read ok at' || E'\n' ||
    '       13:01:35 and was escalated again at 13:52 from a 2026-09-07 row.' || E'\n' ||
    '       Every fix in this repo was being undone on the board for 36 hours. */' || E'\n' ||
    '    SELECT * FROM (' || E'\n' ||
    '      SELECT DISTINCT ON (l.entity_type, l.entity_id)' || E'\n' ||
    '             l.entity_type, l.entity_id, l.drift, l.ledger_balance,' || E'\n' ||
    '             l.stored_balance, l.run_date, l.metadata, l.severity' || E'\n' ||
    '        FROM public.ledger_reconcile_log l' || E'\n' ||
    '       WHERE l.created_at >= now() - p_lookback' || E'\n' ||
    '       ORDER BY l.entity_type, l.entity_id, l.created_at DESC' || E'\n' ||
    '    ) newest WHERE newest.severity = ''critical''';
BEGIN
  IF NOT (current_user IN ('postgres', 'service_role')) THEN
    RAISE EXCEPTION 'operator-only';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_ca_escalate_reconcile_criticals';
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'fn_ca_escalate_reconcile_criticals not found';
  END IF;

  IF position('THE NEWEST ROW DECIDES' in v_src) > 0 THEN
    RAISE NOTICE 'escalator already reads the newest row; skipping';
  ELSE
    v_hits := (length(v_src) - length(replace(v_src, v_anchor, ''))) / length(v_anchor);
    IF v_hits <> 1 THEN
      RAISE EXCEPTION
        'the escalator query does not appear exactly once (found %) - it has changed and this edit must be re-read against it', v_hits;
    END IF;
    v_new := replace(v_src, v_anchor, v_replace);
    IF v_new = v_src THEN
      RAISE EXCEPTION 'substitution produced no change';
    END IF;
    EXECUTE v_new;
  END IF;
END $mig$;