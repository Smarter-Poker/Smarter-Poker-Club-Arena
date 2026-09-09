DO $mig$
DECLARE v_src text; v_new text;
BEGIN
  SET LOCAL lock_timeout = '4s';
  SET LOCAL statement_timeout = '110s';

  /* =================================================================== */
  /* EVERY ACCOUNT READ IN ONE RUN CARRIES ONE MARK.                     */
  /*                                                                     */
  /* The reader scans the journal once per DISTINCT previous mark, which  */
  /* is one scan on an ordinary night. The rebaseline path was stamping   */
  /* each account with its own clock reading, so a single rebaselining    */
  /* run left 1,004 distinct marks behind and the next run tried to scan  */
  /* the journal 1,004 times. It did not finish.                          */
  /*                                                                     */
  /* One mark per run is also the truer statement: these readings were    */
  /* all taken from the same snapshot, so they all happened at the same   */
  /* instant as far as the money is concerned.                            */
  /*                                                                     */
  /* The function also carries its own statement_timeout now. The nightly */
  /* cron set 600s around the call, so a hand-run - or any other caller - */
  /* got whatever the session happened to have, which is how this run was */
  /* cancelled at 110s halfway through a rebaseline.                      */
  /* =================================================================== */
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_ca_ledger_replay';
  IF v_src IS NULL THEN RAISE EXCEPTION 'fn_ca_ledger_replay not found'; END IF;
  v_new := v_src;

  IF position($old$ SET search_path TO 'public'$old$ IN v_new) = 0 THEN
    RAISE EXCEPTION 'search_path clause not found';
  END IF;
  v_new := replace(v_new,
$old$ SET search_path TO 'public'$old$,
$old$ SET search_path TO 'public'
 SET statement_timeout TO '540s'$old$);

  IF position($old$    v_basis text := 'one-snapshot-v2';$old$ IN v_new) = 0 THEN
    RAISE EXCEPTION 'basis line not found';
  END IF;
  v_new := replace(v_new,
$old$    v_basis text := 'one-snapshot-v2';$old$,
$old$    /* v3 (2026-09-09): the mini bad-beat jackpot's missing bbj_pool ->
       table_stack legs were posted as corrections dated today, so every
       account rebaselines once and the repair is not read as the damage. */
    v_basis text := 'one-snapshot-v3';$old$);

  IF position($old$    FOR r IN
      SELECT t.*, p.prev_balance, p.prev_at, p.prev_unexplained, p.prev_cum, p.prev_basis,
             d.expected, d.now_bal, d.read_at$old$ IN v_new) = 0 THEN
    RAISE EXCEPTION 'judging loop header not found';
  END IF;
  v_new := replace(v_new,
$old$    FOR r IN
      SELECT t.*, p.prev_balance, p.prev_at, p.prev_unexplained, p.prev_cum, p.prev_basis,
             d.expected, d.now_bal, d.read_at$old$,
$old$    /* one mark for the whole run: these readings share a snapshot, so they
       share an instant, and the next run then needs one journal scan */
    v_read_at := clock_timestamp();
    FOR r IN
      SELECT t.*, p.prev_balance, p.prev_at, p.prev_unexplained, p.prev_cum, p.prev_basis,
             d.expected, d.now_bal, d.read_at$old$);

  v_new := replace(v_new,
$old$                r.now_bal, r.read_at, true, NULL, 0, v_basis,$old$,
$old$                r.now_bal, v_read_at, true, NULL, 0, v_basis,$old$);
  v_new := replace(v_new,
$old$              r.now_bal, r.read_at, false, v_this, v_cum, v_basis,$old$,
$old$              r.now_bal, v_read_at, false, v_this, v_cum, v_basis,$old$);

  EXECUTE v_new;

  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_ca_ledger_replay';
  IF position('one-snapshot-v3' IN v_src) = 0
     OR position($chk$SET statement_timeout TO '540s'$chk$ IN v_src) = 0
     OR position('r.now_bal, r.read_at' IN v_src) <> 0 THEN
    RAISE EXCEPTION 'fn_ca_ledger_replay did not take the one-mark rewrite';
  END IF;
END
$mig$;
