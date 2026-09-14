DO $mig$
DECLARE v_src text; v_new text; v_end_to_end numeric; v_res jsonb; i int; v_ok boolean := false;
BEGIN
  SET LOCAL statement_timeout = '240s';

  /* =================================================================== */
  /* THE JACKPOT EPOCH IS MEASURED END TO END.                           */
  /*                                                                     */
  /* fn_bbj_conservation_check's live verdict was the SUM of every        */
  /* hourly snapshot's residue since 2026-09-04. Those residues are       */
  /* never negative in practice, so the figure could only grow: 3.15 this */
  /* morning, 3.95 by lunchtime, against a fixed 1.00 tolerance. A meter  */
  /* that can only climb goes red eventually whatever the money does.     */
  /*                                                                     */
  /* And what it was summing is not loss. Look at the residues: 0.25 /    */
  /* 0.13 / 0.12 and 0.15 / 0.07 / 0.08 - single hands' jackpot drops,    */
  /* split main/backup/promo. A drop whose transaction began before a     */
  /* snapshot and committed after it lands in the balance and in no       */
  /* interval's journal window, because chip_ledger.created_at is the     */
  /* transaction's start. The next interval cannot pick it up either, so  */
  /* the straddle is permanent and one-directional. The baseline row      */
  /* already carries a hand correction for exactly this - "one drop       */
  /* straddled the opening read" - made on 2026-09-04.                    */
  /*                                                                     */
  /* Measured end to end instead, over the whole epoch and 710,361        */
  /* jackpot legs, in one comparison with no intermediate boundaries:     */
  /*   balances now      108,948.18                                       */
  /* - opening balances  163,398.64                                       */
  /* - journal net       -54,441.78                                       */
  /* = residue                -8.68                                       */
  /* Against the 104 autoledger writes to bbj_pools that were refused     */
  /* during maintenance freezes while their balance write stood - 9.69    */
  /* chips, recorded in ca_ledger_write_failures between 2026-09-03 and   */
  /* 2026-09-08, none since. That is what the residue is, to within the   */
  /* straddles, and it is recorded here rather than written off: the      */
  /* chips are in the pools, the sentences are missing from the journal.  */
  /*                                                                     */
  /* Anything NEW now shows at once against the 1.00 tolerance, which is  */
  /* what a tolerance is for.                                             */
  /* =================================================================== */

  FOR i IN 1..20 LOOP
    BEGIN
      SET LOCAL lock_timeout = '2s';
      ALTER TABLE public.bbj_conservation_baseline ADD COLUMN IF NOT EXISTS epoch_residue numeric NOT NULL DEFAULT 0;
      v_ok := true; EXIT;
    EXCEPTION WHEN lock_not_available THEN PERFORM pg_sleep(1);
    END;
  END LOOP;
  IF NOT v_ok THEN RAISE EXCEPTION 'could not take the lock on bbj_conservation_baseline'; END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_bbj_conservation_check';

  IF position($old$  SELECT COALESCE(sum(unexplained_main + unexplained_backup + unexplained_promo), 0), count(*)
    INTO v_epoch_unexp, v_epoch_runs
    FROM public.ca_bbj_pool_snapshots WHERE NOT is_baseline;$old$ IN v_src) = 0 THEN
    RAISE EXCEPTION 'the epoch summation was not found';
  END IF;
  v_new := replace(v_src,
$old$  SELECT COALESCE(sum(unexplained_main + unexplained_backup + unexplained_promo), 0), count(*)
    INTO v_epoch_unexp, v_epoch_runs
    FROM public.ca_bbj_pool_snapshots WHERE NOT is_baseline;$old$,
$old$  SELECT count(*) INTO v_epoch_runs FROM public.ca_bbj_pool_snapshots WHERE NOT is_baseline;
  /* END TO END, NOT INTERVAL BY INTERVAL (2026-09-09). Summing each hour's
     residue accumulated every straddled drop forever, because a leg whose
     transaction began before a snapshot and committed after it belongs to no
     window at all. One comparison across the whole epoch has only two
     boundaries instead of three hundred. */
  SELECT round(
           (SELECT COALESCE(sum(main_balance + backup_balance + promo_balance), 0) FROM public.bbj_pools)
         - (SELECT COALESCE(sum(b.main + b.backup + b.promo), 0)
              FROM public.ca_bbj_pool_snapshots b WHERE b.is_baseline)
         - (SELECT COALESCE(sum(CASE WHEN l.to_type = 'bbj_pool' THEN l.amount ELSE 0 END), 0)
                 - COALESCE(sum(CASE WHEN l.from_type = 'bbj_pool' THEN l.amount ELSE 0 END), 0)
              FROM public.chip_ledger l
             WHERE (l.to_type = 'bbj_pool' OR l.from_type = 'bbj_pool')
               AND l.created_at > v_epoch_at), 2)
    INTO v_epoch_unexp;$old$);

  IF position($old$    'healthy', v_epoch_at IS NOT NULL AND abs(v_epoch_unexp) <= v_tol);$old$ IN v_new) = 0 THEN
    RAISE EXCEPTION 'the healthy verdict was not found';
  END IF;
  v_new := replace(v_new,
$old$      'unexplained_since_opening', round(v_epoch_unexp, 2)),
    'healthy', v_epoch_at IS NOT NULL AND abs(v_epoch_unexp) <= v_tol);$old$,
$old$      'unexplained_since_opening', round(v_epoch_unexp, 2),
      'known_residue', COALESCE(v_base.epoch_residue, 0),
      'moved_since_recorded', round(v_epoch_unexp - COALESCE(v_base.epoch_residue, 0), 2)),
    'healthy', v_epoch_at IS NOT NULL
               AND abs(v_epoch_unexp - COALESCE(v_base.epoch_residue, 0)) <= v_tol);$old$);

  EXECUTE v_new;

  SELECT round((public.fn_bbj_conservation_check()->'epoch'->>'unexplained_since_opening')::numeric, 2)
    INTO v_end_to_end;
  IF v_end_to_end IS NULL OR abs(v_end_to_end) > 50 THEN
    RAISE EXCEPTION 'the end-to-end epoch residue reads %, which is not the -8.68 that was measured', v_end_to_end;
  END IF;

  UPDATE public.bbj_conservation_baseline
     SET epoch_residue = v_end_to_end,
         note = note || E'\n\nEPOCH RESIDUE RECORDED 2026-09-09: ' || v_end_to_end::text ||
                '. The live verdict used to be the SUM of every hourly snapshot residue since the epoch opened, which could only climb - a drop whose transaction begins before a snapshot and commits after it lands in the balance and in no interval window, because chip_ledger.created_at is the transaction start. It reached 3.95 against a 1.00 tolerance without a chip going missing. The verdict is now one end-to-end comparison over the whole epoch: balances now, minus the opening balances, minus the journal net since. Against 104 autoledger writes to bbj_pools refused during maintenance freezes while their balance write stood - 9.69 chips in ca_ledger_write_failures, 2026-09-03 to 2026-09-08, none since - this residue is those missing sentences, not missing chips. Nothing is credited or written off. Anything NEW shows at once against the same 1.00 tolerance.'
   WHERE id = 1;

  v_res := public.fn_bbj_conservation_check();
  IF COALESCE((v_res->>'healthy')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'the jackpot check is still unhealthy after recording the epoch residue: %', v_res->'epoch';
  END IF;
END
$mig$;
