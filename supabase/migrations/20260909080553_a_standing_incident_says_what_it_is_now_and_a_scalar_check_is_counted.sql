DO $mig$
DECLARE
  v_src text;
  v_new text;
  v_n int;
BEGIN
  SET LOCAL lock_timeout = '5s';
  SET LOCAL statement_timeout = '110s';

  /* ------------------------------------------------------------------ */
  /* 1. A STANDING INCIDENT SAYS WHAT IT IS NOW.                         */
  /*                                                                     */
  /* fn_ca_raise_drift_incident folds a repeat finding onto the open      */
  /* incident and bumps occurrences, but neither fold path ever touched   */
  /* suspected_cause or metadata. The row therefore froze at first sight  */
  /* while the condition behind it changed underneath.                    */
  /*                                                                     */
  /* Measured before writing this: incident 7e491ba8 (fn_chip_integrity_  */
  /* report, 87 occurrences) still carried its 2026-09-02 cause -         */
  /* "2 COMPLETED tournaments, ~10.50 uncollected" - which is now zero,   */
  /* while the finding it was actually counting had silently become       */
  /* "122 swallowed ledger writes". Same row, different condition, and    */
  /* nothing on the board said so. Incident bdf4acbb named five           */
  /* tournaments in its metadata; today's five are a different five.      */
  /* An incident that describes a condition that has since been fixed is  */
  /* worse than no incident: it is a check that reads as finding          */
  /* something it is not looking at.                                      */
  /* ------------------------------------------------------------------ */
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_ca_raise_drift_incident';
  IF v_src IS NULL THEN RAISE EXCEPTION 'fn_ca_raise_drift_incident not found'; END IF;

  v_new := v_src;

  -- exact-key fold
  IF position($old$         discrepancy_amount = COALESCE(p_discrepancy, discrepancy_amount),
         actual_amount      = COALESCE(p_actual, actual_amount),
         expected_amount    = COALESCE(p_expected, expected_amount)$old$ IN v_new) = 0 THEN
    RAISE EXCEPTION 'exact-key fold block not found - refusing to patch blind';
  END IF;
  v_new := replace(v_new,
$old$         discrepancy_amount = COALESCE(p_discrepancy, discrepancy_amount),
         actual_amount      = COALESCE(p_actual, actual_amount),
         expected_amount    = COALESCE(p_expected, expected_amount)$old$,
$new$         discrepancy_amount = COALESCE(p_discrepancy, discrepancy_amount),
         actual_amount      = COALESCE(p_actual, actual_amount),
         expected_amount    = COALESCE(p_expected, expected_amount),
         suspected_cause    = COALESCE(p_suspected_cause, suspected_cause),
         metadata           = COALESCE(p_metadata, metadata)$new$);

  -- stable-key fold
  IF position($old$    UPDATE public.ca_drift_incidents
       SET occurrences  = occurrences + 1,
           last_seen_at = now()
     WHERE status <> 'resolved'
       AND source = p_source$old$ IN v_new) = 0 THEN
    RAISE EXCEPTION 'stable-key fold block not found - refusing to patch blind';
  END IF;
  v_new := replace(v_new,
$old$    UPDATE public.ca_drift_incidents
       SET occurrences  = occurrences + 1,
           last_seen_at = now()
     WHERE status <> 'resolved'
       AND source = p_source$old$,
$new$    UPDATE public.ca_drift_incidents
       SET occurrences     = occurrences + 1,
           last_seen_at    = now(),
           suspected_cause = COALESCE(p_suspected_cause, suspected_cause),
           metadata        = COALESCE(p_metadata, metadata)
     WHERE status <> 'resolved'
       AND source = p_source$new$);

  -- the ON CONFLICT DO NOTHING fallback at the end of the insert path
  IF position($old$  IF v_id IS NULL THEN
    UPDATE public.ca_drift_incidents
       SET occurrences = occurrences + 1, last_seen_at = now()
     WHERE dedupe_key = p_dedupe_key AND status <> 'resolved'
     RETURNING id INTO v_id;
    RETURN v_id;
  END IF;$old$ IN v_new) = 0 THEN
    RAISE EXCEPTION 'insert-fallback block not found - refusing to patch blind';
  END IF;
  v_new := replace(v_new,
$old$  IF v_id IS NULL THEN
    UPDATE public.ca_drift_incidents
       SET occurrences = occurrences + 1, last_seen_at = now()
     WHERE dedupe_key = p_dedupe_key AND status <> 'resolved'
     RETURNING id INTO v_id;
    RETURN v_id;
  END IF;$old$,
$new$  IF v_id IS NULL THEN
    UPDATE public.ca_drift_incidents
       SET occurrences     = occurrences + 1,
           last_seen_at    = now(),
           suspected_cause = COALESCE(p_suspected_cause, suspected_cause),
           metadata        = COALESCE(p_metadata, metadata)
     WHERE dedupe_key = p_dedupe_key AND status <> 'resolved'
     RETURNING id INTO v_id;
    RETURN v_id;
  END IF;$new$);

  EXECUTE v_new;

  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_ca_raise_drift_incident';
  SELECT count(*) INTO v_n FROM regexp_matches(v_src, 'suspected_cause\s*=\s*COALESCE\(p_suspected_cause', 'g');
  IF v_n <> 3 THEN
    RAISE EXCEPTION 'expected 3 cause-refresh sites in fn_ca_raise_drift_incident, found %', v_n;
  END IF;

  /* ------------------------------------------------------------------ */
  /* 2. A SCALAR CHECK IS COUNTED, NOT WRAPPED.                          */
  /*                                                                     */
  /* fn_ca_conservation_sweep measures every check as                     */
  /*   select count(*) from (select * from fn() limit 20) t              */
  /* which is correct for a table-returning check and WRONG for a scalar  */
  /* one: `select * from fn_union_house_club_stamp_check()` returns one   */
  /* row holding the value 0, so count(*) is 1 and the sweep files a      */
  /* finding. Same for fn_union_law_integrity_breaches, which returns a   */
  /* jsonb array: `[]` is still one row.                                  */
  /*                                                                     */
  /* Measured before writing this: both functions return empty right now  */
  /* (0 and []), and both of their incidents - 04d1c2f4 (warning) and     */
  /* 6e09b4ae (CRITICAL, 15 occurrences) - were already empty in their    */
  /* own creation metadata on 2026-09-08. Neither has ever once reported  */
  /* a real breach. A critical that is on by construction teaches the     */
  /* board to be ignored, which is the one thing a critical may not do.   */
  /* ------------------------------------------------------------------ */
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_ca_conservation_sweep';
  IF v_src IS NULL THEN RAISE EXCEPTION 'fn_ca_conservation_sweep not found'; END IF;

  v_new := v_src;

  IF position($old$       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_union_house_club_stamp_check() limit 20) t',$old$ IN v_new) = 0 THEN
    RAISE EXCEPTION 'house_club_stamp sweep row not found';
  END IF;
  v_new := replace(v_new,
$old$       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_union_house_club_stamp_check() limit 20) t',$old$,
$new$       'select v.n, case when v.n > 0 then jsonb_build_object(''unstamped_union_tables'', v.n) end from (select public.fn_union_house_club_stamp_check() as n) v',$new$);

  IF position($old$       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_union_law_integrity_breaches() limit 20) t',$old$ IN v_new) = 0 THEN
    RAISE EXCEPTION 'law_integrity sweep row not found';
  END IF;
  v_new := replace(v_new,
$old$       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_union_law_integrity_breaches() limit 20) t',$old$,
$new$       'select coalesce(jsonb_array_length(v.j),0), case when coalesce(jsonb_array_length(v.j),0) > 0 then v.j end from (select public.fn_union_law_integrity_breaches() as j) v',$new$);

  /* The finding count is the one number a count-style check actually has;
     passing NULL for p_actual left the board with no figure at all. */
  IF position($old$          'sweep:' || c.check_name || ':' || CURRENT_DATE::text,
          0, NULL, NULL, 'ledger', c.check_name,$old$ IN v_new) = 0 THEN
    RAISE EXCEPTION 'sweep found-branch raise call not found';
  END IF;
  v_new := replace(v_new,
$old$          'sweep:' || c.check_name || ':' || CURRENT_DATE::text,
          0, NULL, NULL, 'ledger', c.check_name,$old$,
$new$          'sweep:' || c.check_name || ':' || CURRENT_DATE::text,
          0, NULL, v_n::numeric, 'ledger', c.check_name,$new$);

  EXECUTE v_new;

  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_ca_conservation_sweep';
  IF position('unstamped_union_tables' IN v_src) = 0
     OR position('jsonb_array_length(v.j)' IN v_src) = 0
     OR position($chk$          0, NULL, v_n::numeric, 'ledger', c.check_name,$chk$ IN v_src) = 0 THEN
    RAISE EXCEPTION 'fn_ca_conservation_sweep did not take all three edits';
  END IF;
END
$mig$;
