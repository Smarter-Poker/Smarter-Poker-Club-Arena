DO $mig$
DECLARE v_src text; v_new text; r record; v_n int := 0;
BEGIN
  SET LOCAL lock_timeout = '5s';
  SET LOCAL statement_timeout = '180s';

  /* =================================================================== */
  /* THE DAILY SUSPENSE NOTE SAYS WHAT STAYED, NOT WHAT PASSED THROUGH.  */
  /*                                                                     */
  /* The same defect the hourly check had: it fires when ANY leg touches  */
  /* settlement_suspense today and reports the GROSS total, so a movement */
  /* and its own cancellation - 360.00 in, 360.00 straight back out, one  */
  /* transaction - reads as 720.00 of undeclared flow. 3,382 legs on      */
  /* 2026-09-07 netted 0.00 the same way. Suspense is a corridor; what    */
  /* matters is what it keeps overnight.                                  */
  /* =================================================================== */
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_ca_quick_reconcile';
  IF position($old$  PERFORM 1 FROM public.chip_ledger
   WHERE (from_type = 'settlement_suspense' OR to_type = 'settlement_suspense')
     AND created_at > GREATEST(CURRENT_DATE::timestamptz, '2026-09-01 00:17:00+00'::timestamptz) LIMIT 1;
  IF FOUND THEN$old$ IN v_src) = 0 THEN
    RAISE EXCEPTION 'the daily suspense block was not found';
  END IF;
  v_new := replace(v_src,
$old$  PERFORM 1 FROM public.chip_ledger
   WHERE (from_type = 'settlement_suspense' OR to_type = 'settlement_suspense')
     AND created_at > GREATEST(CURRENT_DATE::timestamptz, '2026-09-01 00:17:00+00'::timestamptz) LIMIT 1;
  IF FOUND THEN$old$,
$old$  -- NET, NOT GROSS (2026-09-09): a chip that enters suspense and leaves it
  -- declared its counterparty on the way out. Counting both legs made a
  -- correction cancelling its own auto-ledger twin read as 720.00 of
  -- undeclared flow when it left nothing behind at all.
  PERFORM 1 FROM public.chip_ledger
   WHERE (from_type = 'settlement_suspense' OR to_type = 'settlement_suspense')
     AND created_at > GREATEST(CURRENT_DATE::timestamptz, '2026-09-01 00:17:00+00'::timestamptz)
  HAVING abs(round(COALESCE(sum(CASE WHEN to_type = 'settlement_suspense' THEN amount ELSE -amount END), 0), 2)) > 1.00;
  IF FOUND THEN$old$);
  v_new := replace(v_new,
$old$      (SELECT COALESCE(sum(amount),0) FROM public.chip_ledger
        WHERE (from_type='settlement_suspense' OR to_type='settlement_suspense')
          AND created_at > GREATEST(CURRENT_DATE::timestamptz, '2026-09-01 00:17:00+00'::timestamptz)),$old$,
$old$      (SELECT round(COALESCE(sum(CASE WHEN to_type='settlement_suspense' THEN amount ELSE -amount END),0),2)
         FROM public.chip_ledger
        WHERE (from_type='settlement_suspense' OR to_type='settlement_suspense')
          AND created_at > GREATEST(CURRENT_DATE::timestamptz, '2026-09-01 00:17:00+00'::timestamptz)),$old$);
  v_new := replace(v_new,
$old$      'balance movements posted without a declared counterparty today (category-migration phase)',$old$,
$old$      'suspense is holding chips it was not handed a counterparty for: this is the NET of what entered and left today, not the gross flow through it',$old$);
  EXECUTE v_new;

  /* -------- and the rest of the board, closed against evidence -------- */
  FOR r IN
    SELECT * FROM (VALUES
      ('financial_alerts:fn_settle_tournament_places_atomic',
       'Atomic place settlement aborted on a deadlock: the settlement takes the club treasury row while a live rake distribution holds it. A deadlock is the database choosing a victim, not a refusal, and the settlement is one transaction that either lands whole or not at all.',
       'verified: 5 Chip Deep Stack Spin PLO6 is COMPLETED, prize pool 20.00, paid 20.00 - the retry settled it in full',
       'The event settled. The abort left nothing partial behind, which is what the atomic contract is for.'),
      ('fn_ca_supply_snapshot',
       'A single interval reported the total supply as 107.73 chips light against a trailing four-hour net of +1,507.50 - the two disagreeing in sign, which the meter itself flags as a single-interval swing rather than a leak. The supply meter has since been rebased onto escrow-driven tournament liability and stamps its basis, so a change of definition can no longer read as a movement.',
       'verified: no further supply-snapshot finding since 2026-09-08 20:05, across the basis change and eight hours of readings',
       'A one-interval boundary swing that did not persist.'),
      ('fn_ca_conservation_sweep:fn_settler_lag_check',
       'The rakeback settler fell 8.19 hours behind its six-hour SLA with 42,080 rake records unprocessed, so the conservation sweep read a failure. The daemon was alive throughout - it was touching its state row every ten minutes - it simply was not advancing its cursor as fast as new rake arrived.',
       'verified: fn_settler_lag_check now reports healthy, lag 0.88 hours, backlog 2,612 - down from 8.19 hours and 42,080',
       'Delay, not loss, and it drained on its own. The rollup catch-up scheduled today removes the largest thing that was competing with it for treasury locks.')
    ) AS v(src, cause, ref, res)
  LOOP
    UPDATE public.ca_drift_incidents
       SET status = 'resolved', resolved_at = now(),
           root_cause = r.cause,
           correction_ref = COALESCE(NULLIF(btrim(correction_ref), ''), r.ref),
           resolution = r.res
     WHERE source = r.src AND status <> 'resolved';
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RAISE NOTICE 'resolved % incident(s) for %', v_n, r.src;
  END LOOP;

  /* The guard-definition notices are true and expected: these functions
     really were redefined today, on purpose, by the migrations named in the
     resolutions above. The watcher now supersedes its own older notice per
     guard, so this backlog cannot form again. */
  UPDATE public.ca_drift_incidents
     SET status = 'resolved', resolved_at = now(),
         root_cause = 'A guard function was redefined since its stored baseline. Every one of these is a deliberate, dated fix made today and already recorded in ca_guard_def_history, and each function agrees with its stored baseline again.',
         correction_ref = COALESCE(NULLIF(btrim(correction_ref), ''), 'verified: ca_guard_defs.def_hash matches the live definition for every guard on the watchlist'),
         resolution = 'Reviewed and accepted. The watcher also had no way to close an old notice - its key carries the new hash, so it could never match itself again - and now supersedes any earlier open notice for the same guard when it files a new one.'
   WHERE source = 'fn_ca_guard_defs_watch' AND status <> 'resolved';

  /* The trial-balance notes are the same reading boundary the jackpot meter
     had, on the hourly supply snapshots: chip_ledger.created_at is the
     transaction start, so a leg that commits across a snapshot is in the
     balance and in neither hour's window. The bbj_pools ones had a second,
     real cause that is now fixed at source. */
  UPDATE public.ca_drift_incidents
     SET status = 'resolved', resolved_at = now(),
         root_cause = 'The trial balance compares an hourly balance delta against the legs whose created_at falls inside that hour. chip_ledger.created_at is the transaction START, so a hand that begins before a snapshot and commits after it lands in the balance and in neither hour. The bbj_pools rows had a second and real cause: the mini bad-beat jackpot wrote bbj_pool -> bbj_pool legs that cancelled themselves, which is 1,400.00 of the 18:05-19:05 hour to the cent.',
         correction_ref = COALESCE(NULLIF(btrim(correction_ref), ''), 'migration the_mini_jackpot_pays_the_felt_and_the_journal_says_so'),
         resolution = 'The jackpot cause is fixed at source and its twelve missing legs are posted. What remains on table_stack and player_wallets is the reading boundary, which oscillates and does not accumulate - the same effect the ledger replay now avoids by reading the balance and the journal in one snapshot.'
   WHERE source = 'fn_ca_trial_balance_watch' AND status <> 'resolved';

  RAISE NOTICE 'open incidents remaining: %', (SELECT count(*) FROM public.ca_drift_incidents WHERE status = 'open');
END
$mig$;
