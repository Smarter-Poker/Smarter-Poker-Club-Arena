DO $mig$
DECLARE v_src text; v_new text;
BEGIN
  SET LOCAL lock_timeout = '4s';
  SET LOCAL statement_timeout = '110s';

  /* =================================================================== */
  /* A DELETED ROW IS NOT A WRITE - IN THE NIGHTLY READER TOO.           */
  /*                                                                     */
  /* public.wallets was frozen on 2026-08-21 and retired. Two functions   */
  /* watch it. fn_ca_quick_reconcile was taught on 2026-09-02 (migration  */
  /* 20260902041433, "the frozen pool check counts what left") that a     */
  /* pre-freeze row can LEAVE - public.wallets cascades from profiles and */
  /* auth.users, and certification accounts are torn down routinely - so  */
  /* it sums only pre-freeze rows and adds recorded departures back.      */
  /* reconcile_ledger_nightly never learned it, and still reads a bare    */
  /* SUM(balance) over the whole table.                                    */
  /*                                                                     */
  /* Measured before writing this:                                        */
  /*   pre-freeze rows            732,581,294.03                          */
  /* + recorded departures                    0.30                        */
  /* = baseline                   732,581,294.33   exactly                 */
  /* The 0.30 is one reconstructed row in ca_frozen_pool_deletions,        */
  /* a cascaded account teardown from before the recording trigger        */
  /* existed. fn_ca_quick_reconcile has read this pool clean every five   */
  /* minutes since 2026-09-02; reconcile_ledger_nightly has filed a       */
  /* critical every six hours over the same period, and an hourly         */
  /* escalator has re-filed it on top. Same pool, same instant, two       */
  /* answers - and the one that pages was the one nobody fixed.           */
  /* =================================================================== */
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='reconcile_ledger_nightly';
  IF v_src IS NULL THEN RAISE EXCEPTION 'reconcile_ledger_nightly not found'; END IF;
  v_new := v_src;

  IF position($old$  v_now     NUMERIC;$old$ IN v_new) = 0 THEN
    RAISE EXCEPTION 'nightly DECLARE block not found';
  END IF;
  v_new := replace(v_new,
$old$  v_now     NUMERIC;$old$,
$old$  v_now     NUMERIC;
  v_left    NUMERIC;$old$);

  IF position($old$  SELECT COALESCE(SUM(balance), 0) INTO v_now FROM public.wallets;$old$ IN v_new) = 0 THEN
    RAISE EXCEPTION 'nightly frozen-pool read not found';
  END IF;
  v_new := replace(v_new,
$old$  SELECT COALESCE(SUM(balance), 0) INTO v_now FROM public.wallets;$old$,
$old$  -- The frozen pool is the PRE-FREEZE rows. Post-freeze rows belong to
  -- certification accounts whose harness chips cycle through the no-club
  -- fallback and are deleted by the certification cleanup; they are not the
  -- stranded pool. And a pre-freeze row can LEAVE, because public.wallets
  -- cascades from profiles and auth.users - a deleted row is not a write, so
  -- recorded departures are added back before comparing. An attributable
  -- teardown nets to zero; an unrecorded change still pages. This is the same
  -- arithmetic fn_ca_quick_reconcile has used since 2026-09-02.
  SELECT COALESCE(SUM(balance), 0) INTO v_now FROM public.wallets
   WHERE created_at < '2026-08-22';
  SELECT COALESCE(SUM(deleted_balance), 0) INTO v_left
    FROM public.ca_frozen_pool_deletions WHERE pool = 'public.wallets';
  v_now := v_now + COALESCE(v_left, 0);$old$);

  EXECUTE v_new;

  /* =================================================================== */
  /* ONE CONDITION IS ONE INCIDENT, WHOEVER NOTICES IT.                  */
  /*                                                                     */
  /* Every warn/critical row written to ledger_reconcile_log already      */
  /* files an incident through the trigger fn_ca_reconcile_log_to_incident*/
  /* under the key lrl:<entity_type>:<entity_id|->:<ref>. The hourly      */
  /* escalator then read the same row and filed a SECOND incident under a */
  /* key of its own invention, reconcile:<entity_type>:global. The frozen */
  /* pool therefore carried two parallel incident lifelines for one       */
  /* number - b107c8c6 and 6c33b0d4, resolved together on 2026-09-08 and  */
  /* both reopened the same afternoon, then 545f6217 and b561b788. The    */
  /* escalator now speaks the trigger's key and the trigger's source, so  */
  /* it folds onto the incident that already exists instead of opening a  */
  /* twin beside it.                                                      */
  /* =================================================================== */
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_ca_escalate_reconcile_criticals';
  IF v_src IS NULL THEN RAISE EXCEPTION 'fn_ca_escalate_reconcile_criticals not found'; END IF;
  v_new := v_src;

  IF position($old$      'ledger_reconcile_log:' || r.entity_type,$old$ IN v_new) = 0
     OR position($old$      'reconcile:' || r.entity_type || ':' || COALESCE(r.entity_id::text, 'global'),$old$ IN v_new) = 0 THEN
    RAISE EXCEPTION 'escalator source/key lines not found';
  END IF;
  v_new := replace(v_new,
$old$      'ledger_reconcile_log:' || r.entity_type,$old$,
$old$      -- the same source the trigger files under, so one detector owns it
      'ledger_reconcile_log:' || COALESCE(r.metadata->>'source', r.entity_type),$old$);
  v_new := replace(v_new,
$old$      'reconcile:' || r.entity_type || ':' || COALESCE(r.entity_id::text, 'global'),$old$,
$old$      -- the same key fn_ca_reconcile_log_to_incident builds, so this folds
      -- onto the incident that already exists rather than twinning it
      'lrl:' || r.entity_type || ':' || COALESCE(r.entity_id::text, '-') || ':' ||
        COALESCE(r.metadata->>'exit_id', r.metadata->>'hand_history_id',
                 r.metadata->>'hand_id', r.metadata->>'escrow_id', ''),$old$);

  EXECUTE v_new;

  /* post-apply */
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='reconcile_ledger_nightly';
  IF position('ca_frozen_pool_deletions' IN v_src) = 0
     OR position($chk$WHERE created_at < '2026-08-22'$chk$ IN v_src) = 0 THEN
    RAISE EXCEPTION 'reconcile_ledger_nightly did not take the frozen-pool fix';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_ca_escalate_reconcile_criticals';
  IF position($chk$'lrl:' || r.entity_type$chk$ IN v_src) = 0
     OR position($chk$'reconcile:' || r.entity_type$chk$ IN v_src) <> 0 THEN
    RAISE EXCEPTION 'fn_ca_escalate_reconcile_criticals did not take the key fix';
  END IF;
END
$mig$;
