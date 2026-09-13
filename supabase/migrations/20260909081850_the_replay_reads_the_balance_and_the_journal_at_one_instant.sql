DO $mig$
DECLARE v_n int;
BEGIN
  SET LOCAL lock_timeout = '4s';
  SET LOCAL statement_timeout = '110s';

  /* ------------------------------------------------------------------- */
  /* THE FELT DID NOT LOSE 4,379 CHIPS. THE READER LOST THEM.             */
  /*                                                                      */
  /* fn_ca_ledger_replay tripped the kill switch on                        */
  /*   table_stack:00000000-0000-0000-0000-0000000fe17e:table_seats.stack  */
  /* with "4379.10 unexplained this interval, 6504.34 over the last two".  */
  /*                                                                      */
  /* It captured v_now, then scanned 26 hours of chip_ledger, built three  */
  /* temp tables, re-scanned the journal once per distinct previous        */
  /* reading, and only THEN read the balance. The journal window ended at  */
  /* v_now; the balance was read at whatever instant the loop's portal     */
  /* opened, many seconds later. Every chip that moved in between landed   */
  /* in the balance and not in the window. For a club treasury that is a   */
  /* rounding error. For the felt - 371 seats, 108,390 rake legs and       */
  /* 233,376 jackpot legs a day, and a pot that leaves the seats before it */
  /* reaches the winner - it is thousands.                                 */
  /*                                                                      */
  /* Measured before writing this, reading the balance and the journal in  */
  /* ONE statement so they share one MVCC snapshot:                        */
  /*   08:01:15 -> 08:02:48  (93s):  felt -1600.72, journal -1599.18,      */
  /*                                 residue -1.54                         */
  /*   08:01:15 -> 08:06:04 (288s):  felt -2612.23, journal -2613.14,      */
  /*                                 residue +0.91                         */
  /* Sub-two-chip, and it changes sign. The felt conserves. Independently: */
  /* 7,306 cash hands in the hour before this migration, awarded + rake +  */
  /* jackpot - pot = 0.00 on every single one, 0 creating and 0            */
  /* destroying. There was never 4,379 chips of drift to find.             */
  /*                                                                      */
  /* So the window no longer ends at a timestamp. It ends at the snapshot  */
  /* the balance is read in: p_until is 'infinity' and the statement's own */
  /* visibility decides what counts. A leg that has not committed is in    */
  /* neither number; a leg that has committed is in both.                  */
  /* ------------------------------------------------------------------- */

  CREATE OR REPLACE FUNCTION public.fn_ca_ledger_replay(p_limit integer DEFAULT 5000)
   RETURNS jsonb
   LANGUAGE plpgsql
   SECURITY DEFINER
   SET search_path TO 'public'
  AS $function$
  DECLARE
    v_now timestamptz := clock_timestamp();
    v_basis text := 'one-snapshot-v2';
    r record; v_at timestamptz;
    v_checked int := 0; v_baselines int := 0; v_rebased int := 0;
    v_bad int := 0; v_unkeyable bigint := 0;
    v_this numeric; v_two numeric; v_cum numeric;
    v_worst numeric := 0; v_worst_key text; v_sample jsonb := '[]'::jsonb;
  BEGIN
    IF NOT (current_user IN ('postgres', 'supabase_admin') OR COALESCE(auth.role(), '') = 'service_role') THEN
      RAISE EXCEPTION 'fn_ca_ledger_replay is service only' USING ERRCODE = '42501';
    END IF;

    /* ONE SCAN PER INSTANT, NOT ONE PER ACCOUNT. Every account read in a run
       shares this run's end instant, and in the ordinary case they share the
       previous run's instant too, so the journal is read once per distinct
       previous reading (one, most nights) rather than once per wallet. The
       first shape of this function called the reader inside the loop: 200
       accounts meant 200 scans of a day of journal, and it did not finish. */
    DROP TABLE IF EXISTS zz_replay_window;
    DROP TABLE IF EXISTS zz_replay_touched;
    DROP TABLE IF EXISTS zz_replay_prev;
    DROP TABLE IF EXISTS zz_replay_net;
    DROP TABLE IF EXISTS zz_replay_read;

    CREATE TEMP TABLE zz_replay_window ON COMMIT DROP AS
      SELECT a.* FROM public.fn_ca_leg_accounts(v_now - interval '26 hours', v_now) a;

    SELECT COALESCE(sum(w.unkeyable), 0) INTO v_unkeyable FROM zz_replay_window w WHERE w.account_type = 'unkeyable';

    CREATE TEMP TABLE zz_replay_touched ON COMMIT DROP AS
      SELECT w.* FROM zz_replay_window w
       WHERE w.account_type <> 'unkeyable'
       ORDER BY abs(w.net) DESC
       LIMIT GREATEST(COALESCE(p_limit, 5000), 1);

    CREATE TEMP TABLE zz_replay_prev ON COMMIT DROP AS
      SELECT t.account_key, s.balance AS prev_balance, s.taken_at AS prev_at,
             s.unexplained AS prev_unexplained, s.cum_unexplained AS prev_cum,
             s.basis_version AS prev_basis
        FROM zz_replay_touched t
        LEFT JOIN LATERAL (
          SELECT x.balance, x.taken_at, x.unexplained, x.cum_unexplained, x.basis_version
            FROM public.ca_account_snapshots x
           WHERE x.account_key = t.account_key ORDER BY x.taken_at DESC LIMIT 1
        ) s ON true;

    /* THE BALANCE AND THE JOURNAL ARE READ IN THE SAME STATEMENT, so they see
       the same committed rows. p_until is 'infinity': the upper bound of the
       window is this statement's snapshot, not a clock reading taken before a
       26-hour scan. read_at is stamped here and becomes the next run's window
       start, so both ends of every future interval are the same kind of
       instant. */
    CREATE TEMP TABLE zz_replay_read (
      account_key text, prev_at timestamptz, expected numeric,
      now_bal numeric, read_at timestamptz
    ) ON COMMIT DROP;

    FOR v_at IN SELECT DISTINCT prev_at FROM zz_replay_prev WHERE prev_at IS NOT NULL LOOP
      WITH legs AS MATERIALIZED (
        SELECT a.account_key, a.net
          FROM public.fn_ca_leg_accounts(v_at, 'infinity'::timestamptz) a
         WHERE a.account_key IS NOT NULL
      )
      INSERT INTO zz_replay_read (account_key, prev_at, expected, now_bal, read_at)
      SELECT t.account_key, v_at, COALESCE(l.net, 0),
             public.fn_ca_account_balance(t.account_type, t.entity_id, t.club_id, t.column_name),
             clock_timestamp()
        FROM zz_replay_touched t
        JOIN zz_replay_prev p ON p.account_key = t.account_key AND p.prev_at = v_at
        LEFT JOIN legs l ON l.account_key = t.account_key;
    END LOOP;

    /* An account nobody has read before is recorded, not judged. */
    INSERT INTO public.ca_account_snapshots
      (account_key, account_type, entity_id, club_id, column_name, balance, taken_at, is_baseline, basis_version, note)
    SELECT t.account_key, t.account_type, t.entity_id, t.club_id, t.column_name,
           b.bal, clock_timestamp(), true, v_basis,
           'baseline: first reading of this account, not judged'
      FROM zz_replay_touched t
      JOIN zz_replay_prev p ON p.account_key = t.account_key AND p.prev_at IS NULL
      CROSS JOIN LATERAL (
        SELECT public.fn_ca_account_balance(t.account_type, t.entity_id, t.club_id, t.column_name) AS bal
      ) b
     WHERE b.bal IS NOT NULL;
    GET DIAGNOSTICS v_baselines = ROW_COUNT;

    FOR r IN
      SELECT t.*, p.prev_balance, p.prev_at, p.prev_unexplained, p.prev_cum, p.prev_basis,
             d.expected, d.now_bal, d.read_at
        FROM zz_replay_touched t
        JOIN zz_replay_prev p ON p.account_key = t.account_key
        JOIN zz_replay_read d ON d.account_key = t.account_key AND d.prev_at = p.prev_at
    LOOP
      IF r.now_bal IS NULL THEN CONTINUE; END IF;

      /* A CHANGE OF BASIS IS NOT DRIFT. The previous reading paired a balance
         with a journal window that ended somewhere else in time. Comparing it
         against a reading taken on the new basis measures the change of
         reader, not the movement of money, so the first reading of each
         account under the new basis is a baseline. The supply meter learned
         this the same way, the same morning. */
      IF COALESCE(r.prev_basis, '') <> v_basis THEN
        INSERT INTO public.ca_account_snapshots
          (account_key, account_type, entity_id, club_id, column_name, balance, taken_at,
           is_baseline, unexplained, cum_unexplained, basis_version, note)
        VALUES (r.account_key, r.account_type, r.entity_id, r.club_id, r.column_name,
                r.now_bal, r.read_at, true, NULL, 0, v_basis,
                format('rebaselined onto %s: the previous reading (%s) ended its journal window at a different instant from its balance read, and that difference belongs to the reader, not to the account',
                       v_basis, COALESCE(r.prev_basis, 'the unversioned reader')));
        v_rebased := v_rebased + 1;
        CONTINUE;
      END IF;

      v_checked := v_checked + 1;
      v_this := round((r.now_bal - r.prev_balance) - r.expected, 2);

      /* TWO INTERVALS, ONE FINDING. A leg that commits on the boundary lands
         in one interval and reverses in the next, so a single interval's
         residue is noise and the two-interval sum is the finding - the same
         rule the BBJ meter uses, and for the same reason. */
      /* A RESIDUE THAT ALREADY CANCELLED IS NOT A FINDING (2026-09-06). What
         is carried is the CUMULATIVE residue since the account's baseline,
         which oscillates around zero for a boundary and grows for a leak; a
         finding needs BOTH a non-zero cumulative AND two consecutive
         intervals moving it the same way. A single interval of 100 or more is
         always shown, whatever its sign. */
      v_cum := round(v_this + COALESCE(r.prev_cum, 0), 2);
      v_two := CASE
                 WHEN abs(v_this) >= 100 THEN v_this
                 WHEN v_this <> 0 AND COALESCE(r.prev_unexplained, 0) <> 0
                      AND sign(v_this) = sign(r.prev_unexplained) THEN v_cum
                 ELSE 0
               END;

      INSERT INTO public.ca_account_snapshots
        (account_key, account_type, entity_id, club_id, column_name, balance, taken_at,
         is_baseline, unexplained, cum_unexplained, basis_version, note)
      VALUES (r.account_key, r.account_type, r.entity_id, r.club_id, r.column_name,
              r.now_bal, r.read_at, false, v_this, v_cum, v_basis,
              format('moved %s, journal %s, unexplained %s this interval (cumulative %s, judged %s) since %s',
                     round(r.now_bal - r.prev_balance, 2), r.expected, v_this, v_cum, v_two, r.prev_at));

      IF abs(v_two) > 0.005 THEN
        v_bad := v_bad + 1;
        IF abs(v_two) > abs(v_worst) THEN v_worst := v_two; v_worst_key := r.account_key; END IF;
        IF v_bad <= 20 THEN
          v_sample := v_sample || jsonb_build_object('account', r.account_key, 'moved', round(r.now_bal - r.prev_balance, 2),
                                                     'journal', r.expected, 'unexplained', v_this, 'cumulative', v_cum,
                                                     'since', r.prev_at);
        END IF;
        PERFORM public.fn_ca_raise_drift_incident(
          'fn_ca_ledger_replay', 'ledger_imbalance',
          CASE WHEN abs(v_two) >= 100 THEN 'critical' ELSE 'warning' END,
          'ledger-replay:' || r.account_key || ':' || to_char(v_now, 'YYYY-MM-DD'),
          v_two, r.expected, round(r.now_bal - r.prev_balance, 2),
          'ledger', r.account_type, r.entity_id, r.club_id, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
          format('%s moved %s between %s and now while the journal accounts for %s: %s unexplained this interval, %s over the last two. The balance and the journal were read in one snapshot, so a leg is in both numbers or in neither.',
                 r.column_name, round(r.now_bal - r.prev_balance, 2), r.prev_at, r.expected, v_this, v_cum),
          false,
          jsonb_build_object('account_key', r.account_key, 'column', r.column_name,
                             'moved', round(r.now_bal - r.prev_balance, 2), 'journal', r.expected,
                             'unexplained', v_this, 'cumulative', v_cum, 'judged', v_two,
                             'previous_at', r.prev_at, 'basis_version', v_basis));
      END IF;
    END LOOP;

    PERFORM public.fn_ca_kill_switch_trip('fn_ca_ledger_replay', v_worst,
      format('one account disagrees with the journal by %s (%s)', round(COALESCE(v_worst, 0), 2), COALESCE(v_worst_key, 'n/a')));

    RETURN jsonb_build_object('checked', v_checked, 'baselines', v_baselines, 'rebaselined', v_rebased,
                              'disagree', v_bad, 'worst', round(COALESCE(v_worst, 0), 2), 'worst_account', v_worst_key,
                              'unkeyable_legs', v_unkeyable, 'basis_version', v_basis,
                              'sample', v_sample, 'at', v_now);
  END;
  $function$;

  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_ca_ledger_replay'
     AND pg_get_functiondef(p.oid) LIKE '%one-snapshot-v2%'
     AND pg_get_functiondef(p.oid) LIKE '%infinity%';
  IF v_n <> 1 THEN RAISE EXCEPTION 'fn_ca_ledger_replay did not take the one-snapshot rewrite'; END IF;
END
$mig$;
