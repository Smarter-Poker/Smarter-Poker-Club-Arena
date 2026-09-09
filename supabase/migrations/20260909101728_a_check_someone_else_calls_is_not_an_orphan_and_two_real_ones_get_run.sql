DO $mig$
DECLARE v_src text; v_new text; v_n int;
BEGIN
  SET LOCAL lock_timeout = '4s';
  SET LOCAL statement_timeout = '110s';

  /* =================================================================== */
  /* A CHECK SOMEONE ELSE CALLS IS NOT AN ORPHAN.                        */
  /*                                                                     */
  /* fn_ca_orphaned_checks named 29 functions that "nothing ever runs".   */
  /* It looked for each name in cron.job, in fn_ca_conservation_sweep's   */
  /* body, and in an exemption table - and nowhere else. So it counted:   */
  /*                                                                     */
  /*  - fn_union_settlement_conservation_assert, which the weekly cascade */
  /*    calls between rounds 3 and 4 with the three rounds' results;      */
  /*  - fn_ca_escrow_vs_counter_check, fn_cash_leave_check,               */
  /*    fn_plinko_table_audit, fn_wheel_segments_audit and the integrity  */
  /*    helpers, every one of them called by another function;            */
  /*  - and thirteen case-management RPCs - open a case, assign it,       */
  /*    decide it, sanction, retract an item - which are not checks at    */
  /*    all. They match on the word "integrity" in their names.           */
  /*                                                                     */
  /* Two tests fix it, and both are about what a check IS. A function     */
  /* another function calls is run, whether or not a cron entry names it. */
  /* A function that takes an actor, an op id and a request id is a       */
  /* write-side door with an audit trail, not a reader looking for drift. */
  /*                                                                     */
  /* What survives both tests is the real answer, and it is small: two    */
  /* genuine checks that nothing ran, and six readers and probes that are */
  /* exempted below with the reason each one is not a sweep's business.   */
  /* =================================================================== */
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_ca_orphaned_checks';
  IF position($old$    SELECT p.proname::text AS pn,
           pg_get_function_identity_arguments(p.oid) AS ar$old$ IN v_src) = 0 THEN
    RAISE EXCEPTION 'orphan candidate block not found';
  END IF;
  v_new := replace(v_src,
$old$    SELECT p.proname::text AS pn,
           pg_get_function_identity_arguments(p.oid) AS ar$old$,
$old$    SELECT p.oid AS oid, p.proname::text AS pn,
           pg_get_function_identity_arguments(p.oid) AS ar$old$);

  IF position($old$       AND p.proname NOT LIKE '%selftest%'
  )$old$ IN v_new) = 0 THEN
    RAISE EXCEPTION 'orphan candidate filter tail not found';
  END IF;
  v_new := replace(v_new,
$old$       AND p.proname NOT LIKE '%selftest%'
  )$old$,
$old$       AND p.proname NOT LIKE '%selftest%'
       /* A DOOR IS NOT A CHECK. A function taking an actor, an op id, a
          case id or a request id is a write-side RPC with an audit trail -
          open a case, assign it, decide it, sanction. It matches on the
          word "integrity" in its name and on nothing else. */
       AND pg_get_function_identity_arguments(p.oid) !~ '(p_actor|p_op_id|p_case_id|p_request_id)'
  )$old$);

  IF position($old$   WHERE NOT EXISTS (SELECT 1 FROM cron.job j WHERE j.command LIKE '%' || c.pn || '%')$old$ IN v_new) = 0 THEN
    RAISE EXCEPTION 'orphan cron test not found';
  END IF;
  v_new := replace(v_new,
$old$   WHERE NOT EXISTS (SELECT 1 FROM cron.job j WHERE j.command LIKE '%' || c.pn || '%')$old$,
$old$   WHERE NOT EXISTS (SELECT 1 FROM cron.job j WHERE j.command LIKE '%' || c.pn || '%')
     /* A CHECK ANOTHER FUNCTION CALLS IS RUN. The weekly cascade calls
        fn_union_settlement_conservation_assert between its rounds; nothing
        in cron names it, and it is not orphaned. */
     AND NOT EXISTS (SELECT 1 FROM pg_proc q JOIN pg_namespace qn ON qn.oid = q.pronamespace
                      WHERE qn.nspname = 'public' AND q.oid <> c.oid
                        AND q.prosrc LIKE '%' || c.pn || '%')$old$);
  EXECUTE v_new;

  /* -- the two that really were unrun, both currently returning nothing -- */
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_ca_conservation_sweep';
  IF position($old$      ('fn_ca_payout_rows_without_money',$old$ IN v_src) = 0 THEN
    RAISE EXCEPTION 'sweep anchor not found';
  END IF;
  v_new := replace(v_src,
$old$      ('fn_ca_payout_rows_without_money',$old$,
$old$      ('fn_rake_spec_self_check',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_rake_spec_self_check() limit 20) t',
       'warning'),
      ('fn_spin_ladder_drift_check',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_spin_ladder_drift_check(7) limit 20) t',
       'warning'),
      ('fn_ca_payout_rows_without_money',$old$);
  EXECUTE v_new;

  /* -- and the readers and probes that are nobody's sweep to run -- */
  INSERT INTO public.ca_check_sweep_exemptions (proname, reason) VALUES
    ('fn_ca_integrity_flags',
     'A paged reader for the integrity review screen: it takes p_as_of, p_limit and p_cursor and answers what an operator asked to see. There is no verdict here for a sweep to act on.'),
    ('fn_ca_integrity_hands',
     'A paged reader for the integrity review screen, scoped to a player or a pair. Nothing to schedule: it answers a question an operator asked.'),
    ('fn_ca_integrity_pairs',
     'A paged reader for the integrity review screen. Nothing to schedule: it answers a question an operator asked.'),
    ('fn_ca_integrity_timing',
     'A paged reader for the integrity review screen. Nothing to schedule: it answers a question an operator asked.'),
    ('fn_ca_second_writer_check',
     'Takes the calls to audit as a jsonb argument - it checks a caller-supplied list against the money-door register, which is what the CI gate hands it. It has no standing question of its own to run on a schedule.'),
    ('fn_training_cache_run_drift_audit',
     'Audits one training run, named by p_run_date. The training pipeline calls it for the run it just finished; a sweep has no run to name.')
  ON CONFLICT (proname) DO NOTHING;

  SELECT count(*) INTO v_n FROM public.fn_ca_orphaned_checks();
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'still % orphaned check(s): %', v_n,
      (SELECT string_agg(proname, ', ') FROM public.fn_ca_orphaned_checks());
  END IF;
END
$mig$;
