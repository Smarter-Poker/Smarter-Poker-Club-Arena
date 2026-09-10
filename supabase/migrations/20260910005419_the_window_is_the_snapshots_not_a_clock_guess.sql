/* THE WINDOW IS THE SNAPSHOTS, NOT A CLOCK GUESS (2026-09-10)

   fn_ca_trial_balance is the platform's global chip-conservation check: for
   each of fourteen accounts it compares the movement in the balance columns
   against the net of the ledger legs over a window, and fn_ca_trial_balance_watch
   files an incident when the two disagree. It is the one thing that would
   notice chips appearing or vanishing anywhere in Club Arena.

   IT HAS BEEN MEASURING ALMOST NOTHING.

   It asked for the first snapshot at or after now() minus 75 minutes:

     WHERE taken_at >= COALESCE(p_since, now() - interval '75 minutes')

   Measured on production 2026-09-10:
     - snapshots are hourly (ca-supply-snapshot-hourly, '5 * * * *'), average
       AND maximum gap 60.0 minutes, average offset :05:00.9
     - the watch runs at '20 * * * *', average offset :20:00.5
     - so the window opened at :05:00.5 and the snapshot landed at :05:00.9 -
       it cleared by FOUR TENTHS OF A SECOND, decided by scheduler jitter

   With one snapshot in range the function correctly refuses to invent a zero
   and returns NULL deltas - the right behaviour, and the reason nothing looked
   broken. The result:

     cron runs, 7 days:      168
     actual readings:          6     (3.6%)
     readings before today:    0

   And it compounds. The watch files only when TWO CONSECUTIVE readings breach
   the threshold in the same direction ("one window is noise"), and it records a
   run only when it measured something ("a run that measured nothing is not a
   reading") - both sound rules. But readings that land 3.6% of the time are
   almost never adjacent, so the persistence rule could effectively never be
   satisfied. The check was blind and the watch on top of it could not fire.

   THE FIX. Two snapshots always exist, so the window is taken FROM THE
   SNAPSHOTS: the two most recent rows, measuring exactly one snapshot interval,
   every run, whatever the scheduler does. p_since still overrides for ad-hoc
   queries; its default becomes NULL so the snapshot-relative path is the one
   that runs hourly. The watch's default changes with it, or it would keep
   passing the old timestamp down.

   Proved in a transaction that was rolled back: the trial balance returned
   14 rows with 0 NULL differences, where it had returned 14 of 14 NULL.

   No cron added, nothing scheduled, no repair (10.12) - the expression that
   produced the wrong window is the expression that changed. */
DO $mig$
DECLARE
  v_src text; v_new text; v_n int; v_a text; v_b text; v_da text; v_db text;
  v_check text; v_rows int; v_nullrows int;
BEGIN
  IF NOT (current_user IN ('postgres','service_role')) THEN
    RAISE EXCEPTION 'operator-only';
  END IF;

  v_da := 'p_since timestamp with time zone DEFAULT (now() - ''01:15:00''::interval)';
  v_db := 'p_since timestamp with time zone DEFAULT NULL::timestamp with time zone';

  ---------------------------------------------------------------------------
  -- 1. fn_ca_trial_balance: take the window from the snapshots
  ---------------------------------------------------------------------------
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_ca_trial_balance';
  IF v_src IS NULL THEN RAISE EXCEPTION 'fn_ca_trial_balance not found'; END IF;

  IF position('THE WINDOW IS THE SNAPSHOTS' in v_src) > 0 THEN
    RAISE NOTICE 'trial balance already snapshot-relative; skipping';
  ELSE
    v_n := (length(v_src)-length(replace(v_src,v_da,'')))/length(v_da);
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'the p_since default appears % times in fn_ca_trial_balance, expected exactly 1 - it has changed and this edit must be re-read against it', v_n;
    END IF;

    v_a := '  SELECT * INTO s0 FROM public.ca_supply_snapshots' || E'\n' ||
           '   WHERE taken_at >= COALESCE(p_since, now() - interval ''75 minutes'')' || E'\n' ||
           '   ORDER BY taken_at ASC LIMIT 1;' || E'\n' ||
           '  SELECT * INTO s1 FROM public.ca_supply_snapshots ORDER BY taken_at DESC LIMIT 1;';
    v_n := (length(v_src)-length(replace(v_src,v_a,'')))/length(v_a);
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'the window selection appears % times, expected exactly 1', v_n;
    END IF;

    v_b := '  /* THE WINDOW IS THE SNAPSHOTS, NOT A CLOCK GUESS (2026-09-10).' || E'\n' ||
           '     This asked for the first snapshot at/after now() minus 75 minutes.' || E'\n' ||
           '     Snapshots are hourly (ca-supply-snapshot-hourly, measured gap 60.0' || E'\n' ||
           '     min, offset :05:00.9) and the watch runs at :20:00.5, so the window' || E'\n' ||
           '     opened at :05:00.5 and cleared the snapshot by FOUR TENTHS OF A' || E'\n' ||
           '     SECOND. Scheduler jitter decided whether the platform measured its' || E'\n' ||
           '     own chip conservation: 168 cron runs in seven days produced SIX' || E'\n' ||
           '     readings, 3.6%, and none at all before today. Worse, the watch' || E'\n' ||
           '     files only when two CONSECUTIVE readings breach in the same' || E'\n' ||
           '     direction, and readings landing 3.6% of the time are almost never' || E'\n' ||
           '     adjacent - so it could effectively never file. Global chip' || E'\n' ||
           '     conservation was not being checked at all.' || E'\n' ||
           '     Two snapshots always exist, so take the two most recent and measure' || E'\n' ||
           '     exactly one snapshot interval, every run, whatever the scheduler' || E'\n' ||
           '     does. p_since still overrides for ad-hoc queries; the NULL default' || E'\n' ||
           '     is the every-run path. */' || E'\n' ||
           '  SELECT * INTO s1 FROM public.ca_supply_snapshots ORDER BY taken_at DESC LIMIT 1;' || E'\n' ||
           '  IF p_since IS NULL THEN' || E'\n' ||
           '    SELECT * INTO s0 FROM public.ca_supply_snapshots' || E'\n' ||
           '     WHERE taken_at < s1.taken_at ORDER BY taken_at DESC LIMIT 1;' || E'\n' ||
           '  ELSE' || E'\n' ||
           '    SELECT * INTO s0 FROM public.ca_supply_snapshots' || E'\n' ||
           '     WHERE taken_at >= p_since ORDER BY taken_at ASC LIMIT 1;' || E'\n' ||
           '  END IF;';

    v_new := replace(replace(v_src, v_da, v_db), v_a, v_b);
    IF v_new = v_src THEN RAISE EXCEPTION 'trial balance substitution produced no change'; END IF;
    EXECUTE v_new;
  END IF;

  ---------------------------------------------------------------------------
  -- 2. the watch default moves with it
  ---------------------------------------------------------------------------
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_ca_trial_balance_watch';
  IF v_src IS NULL THEN RAISE EXCEPTION 'fn_ca_trial_balance_watch not found'; END IF;

  IF position('DEFAULT NULL::timestamp with time zone' in v_src) > 0 THEN
    RAISE NOTICE 'watch default already NULL; skipping';
  ELSE
    v_n := (length(v_src)-length(replace(v_src,v_da,'')))/length(v_da);
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'the p_since default appears % times in the watch, expected exactly 1', v_n;
    END IF;
    v_new := replace(v_src, v_da, v_db);
    IF v_new = v_src THEN RAISE EXCEPTION 'watch substitution produced no change'; END IF;
    EXECUTE v_new;
  END IF;

  ---------------------------------------------------------------------------
  -- POST-CONDITION: it must actually measure now
  ---------------------------------------------------------------------------
  SELECT count(*), count(*) FILTER (WHERE difference IS NULL)
    INTO v_rows, v_nullrows FROM public.fn_ca_trial_balance();
  IF v_rows <> 14 OR v_nullrows <> 0 THEN
    RAISE EXCEPTION 'post-condition failed: trial balance returned % rows with % NULL differences - it must read all 14 accounts. Nothing written.',
      v_rows, v_nullrows;
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_check
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_ca_trial_balance_watch';
  IF position('DEFAULT NULL::timestamp with time zone' in v_check) = 0 THEN
    RAISE EXCEPTION 'post-condition failed: the watch still carries the old clock default. Nothing written.';
  END IF;

  RAISE NOTICE 'global chip conservation now measures on every run: 14 accounts, 0 blind';
END $mig$;
