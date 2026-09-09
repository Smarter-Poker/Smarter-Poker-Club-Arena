DO $mig$
DECLARE v_src text; v_new text;
BEGIN
  SET LOCAL lock_timeout = '4s';
  SET LOCAL statement_timeout = '110s';

  /* ------------------------------------------------------------------- */
  /* THE MARK A READING LEAVES IS WHERE THE READING STARTED.              */
  /*                                                                      */
  /* The one-snapshot rewrite put the balance and the journal in the same  */
  /* statement, and that is right - but it stamped taken_at with           */
  /* clock_timestamp() evaluated per row, INSIDE the statement. The        */
  /* statement's snapshot is taken at its first instant; the stamp landed  */
  /* seconds later, after a thousand balance aggregates had run. The next  */
  /* run then started its window at that later stamp and never counted the */
  /* legs that had committed in between - legs which were, of course,      */
  /* already in the next run's balance.                                    */
  /*                                                                      */
  /* First measurement after the rewrite, two runs 5.1 seconds apart:      */
  /*   felt moved -130.60, journal -30.00, residue -100.60.                */
  /* -100.60 in five seconds is the gap between the snapshot and the stamp,*/
  /* not the felt. The hand-run probe over the same account, reading both  */
  /* numbers in one statement with no stamp at all, was -1.54 over 93s and */
  /* +0.91 over 288s.                                                      */
  /*                                                                      */
  /* So the mark is captured immediately BEFORE the statement, which is    */
  /* within microseconds of the snapshot it will be compared against. What */
  /* remains is only a leg whose transaction began before the mark and     */
  /* committed after the snapshot - sub-second here, and symmetric, which  */
  /* is exactly what the two-interval rule exists to absorb.               */
  /* ------------------------------------------------------------------- */
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_ca_ledger_replay';
  IF v_src IS NULL OR position('one-snapshot-v2' IN v_src) = 0 THEN
    RAISE EXCEPTION 'fn_ca_ledger_replay is not on the one-snapshot basis - refusing to patch';
  END IF;
  v_new := v_src;

  v_new := replace(v_new,
$old$    v_now timestamptz := clock_timestamp();
    v_basis text := 'one-snapshot-v2';$old$,
$old$    v_now timestamptz := clock_timestamp();
    v_read_at timestamptz;
    v_basis text := 'one-snapshot-v2';$old$);

  IF position($old$    FOR v_at IN SELECT DISTINCT prev_at FROM zz_replay_prev WHERE prev_at IS NOT NULL LOOP
      WITH legs AS MATERIALIZED ($old$ IN v_new) = 0 THEN
    RAISE EXCEPTION 'read loop not found';
  END IF;
  v_new := replace(v_new,
$old$    FOR v_at IN SELECT DISTINCT prev_at FROM zz_replay_prev WHERE prev_at IS NOT NULL LOOP
      WITH legs AS MATERIALIZED ($old$,
$old$    FOR v_at IN SELECT DISTINCT prev_at FROM zz_replay_prev WHERE prev_at IS NOT NULL LOOP
      /* captured here, one instant before the statement's snapshot, and used
         for every row: this value is where the next run's window starts */
      v_read_at := clock_timestamp();
      WITH legs AS MATERIALIZED ($old$);

  IF position($old$             public.fn_ca_account_balance(t.account_type, t.entity_id, t.club_id, t.column_name),
             clock_timestamp()$old$ IN v_new) = 0 THEN
    RAISE EXCEPTION 'read statement stamp not found';
  END IF;
  v_new := replace(v_new,
$old$             public.fn_ca_account_balance(t.account_type, t.entity_id, t.club_id, t.column_name),
             clock_timestamp()$old$,
$old$             public.fn_ca_account_balance(t.account_type, t.entity_id, t.club_id, t.column_name),
             v_read_at$old$);

  IF position($old$    SELECT t.account_key, t.account_type, t.entity_id, t.club_id, t.column_name,
           b.bal, clock_timestamp(), true, v_basis,$old$ IN v_new) = 0 THEN
    RAISE EXCEPTION 'baseline insert stamp not found';
  END IF;
  v_new := replace(v_new,
$old$    /* An account nobody has read before is recorded, not judged. */
    INSERT INTO public.ca_account_snapshots$old$,
$old$    /* An account nobody has read before is recorded, not judged. */
    v_read_at := clock_timestamp();
    INSERT INTO public.ca_account_snapshots$old$);
  v_new := replace(v_new,
$old$    SELECT t.account_key, t.account_type, t.entity_id, t.club_id, t.column_name,
           b.bal, clock_timestamp(), true, v_basis,$old$,
$old$    SELECT t.account_key, t.account_type, t.entity_id, t.club_id, t.column_name,
           b.bal, v_read_at, true, v_basis,$old$);

  EXECUTE v_new;

  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_ca_ledger_replay';
  IF position('v_read_at timestamptz;' IN v_src) = 0
     OR position('             v_read_at' IN v_src) = 0
     OR position('           b.bal, v_read_at, true, v_basis,' IN v_src) = 0
     OR position('             clock_timestamp()' IN v_src) <> 0 THEN
    RAISE EXCEPTION 'fn_ca_ledger_replay did not take the read-mark fix';
  END IF;
END
$mig$;
