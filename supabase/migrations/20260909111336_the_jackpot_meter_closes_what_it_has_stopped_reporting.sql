DO $mig$
DECLARE v_src text; v_new text;
BEGIN
  ------------------------------------------------------------------
  -- The jackpot meter records that it finished.
  ------------------------------------------------------------------
  SELECT pg_get_functiondef(p.oid) INTO v_src FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_bbj_reconcile_all';
  IF v_src IS NULL THEN RAISE EXCEPTION 'fn_bbj_reconcile_all is gone'; END IF;
  IF position($chk$ca_detector_runs$chk$ IN v_src) <> 0 THEN
    RAISE EXCEPTION 'the jackpot meter already records its runs';
  END IF;
  IF position($chk$  RETURN jsonb_build_object('pools', v_out, 'alerts', v_alerts, 'opened', v_opened);$chk$ IN v_src) = 0 THEN
    RAISE EXCEPTION 'the jackpot meter return moved; re-read it before editing';
  END IF;

  v_new := replace(v_src,
$old$  RETURN jsonb_build_object('pools', v_out, 'alerts', v_alerts, 'opened', v_opened);$old$,
$new$  /* THIS METER RAISES UNDER A FRESH KEY EVERY HOUR, so an incident it has
     stopped reporting can never fold into a later one and can never close on
     its own: left alone it accumulates one open row per pool per hour
     forever. Recording the run lets fn_ca_resolve_cleared_incidents close
     what two consecutive readings have declined to raise. */
  INSERT INTO public.ca_detector_runs (detector, detail)
  VALUES ('fn_bbj_reconcile', jsonb_build_object('alerts', v_alerts, 'opened', v_opened));

  RETURN jsonb_build_object('pools', v_out, 'alerts', v_alerts, 'opened', v_opened);$new$);
  IF v_new = v_src THEN RAISE EXCEPTION 'the jackpot meter did not learn to record its runs'; END IF;
  EXECUTE v_new;

  ------------------------------------------------------------------
  -- The resolver watches it too.
  ------------------------------------------------------------------
  SELECT pg_get_functiondef(p.oid) INTO v_src FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_ca_resolve_cleared_incidents';
  IF position($chk$fn_bbj_reconcile$chk$ IN v_src) <> 0 THEN
    RAISE EXCEPTION 'the resolver already watches the jackpot meter';
  END IF;
  IF position($chk$ARRAY['fn_ca_conservation_sweep','fn_ca_ratchet_watch']$chk$ IN v_src) = 0 THEN
    RAISE EXCEPTION 'the resolver roster moved; re-read it before editing';
  END IF;

  v_new := replace(v_src,
$old$  FOR d IN SELECT unnest(ARRAY['fn_ca_conservation_sweep','fn_ca_ratchet_watch']) AS detector$old$,
$new$  /* WHAT MAY BE ON THIS LIST. Only a detector whose raise condition looks
     at the whole standing state, so that not raising a finding means the
     finding is gone. fn_ca_quick_reconcile is deliberately absent: it looks
     at a ten minute window, so its silence means the window moved on, not
     that anything was fixed, and auto-closing its criticals would bury real
     unanswered money. */
  FOR d IN SELECT unnest(ARRAY['fn_ca_conservation_sweep','fn_ca_ratchet_watch','fn_bbj_reconcile']) AS detector$new$);
  IF v_new = v_src THEN RAISE EXCEPTION 'the resolver roster was not extended'; END IF;
  EXECUTE v_new;

  IF (SELECT position($chk$fn_bbj_reconcile$chk$ IN pg_get_functiondef(p.oid))
        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='public' AND p.proname='fn_ca_resolve_cleared_incidents') = 0 THEN
    RAISE EXCEPTION 'the resolver did not take the jackpot meter';
  END IF;
END
$mig$;;
