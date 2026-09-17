-- REVIEW CANDIDATE ONLY. Do not execute outside the existing integration/Pipeline lane.
BEGIN;
DO $guard$
DECLARE p pg_proc;
BEGIN
  SELECT * INTO STRICT p FROM pg_proc WHERE oid = to_regprocedure('public.fn_ca_ledger_replay(integer)');
  IF md5(pg_get_functiondef(p.oid)) IS DISTINCT FROM 'bac6f64adcb2a1cb5adb64e5f28a5ec0' OR pg_get_userbyid(p.proowner) IS DISTINCT FROM 'postgres' OR p.proacl::text IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' THEN
    RAISE EXCEPTION 'replay preflight: changed definition/owner/access for fn_ca_ledger_replay(integer)';
  END IF;
  SELECT * INTO STRICT p FROM pg_proc WHERE oid = to_regprocedure('public.fn_ca_currency_meter()');
  IF md5(pg_get_functiondef(p.oid)) IS DISTINCT FROM 'e58e52177046c958f9daacb20a63fade' OR pg_get_userbyid(p.proowner) IS DISTINCT FROM 'postgres' OR p.proacl::text IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' THEN
    RAISE EXCEPTION 'replay preflight: changed definition/owner/access for fn_ca_currency_meter()';
  END IF;
END $guard$;
CREATE OR REPLACE FUNCTION public.fn_ca_ledger_replay(p_limit integer DEFAULT 5000)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '540s'
AS $function$
  DECLARE
    v_now timestamptz := clock_timestamp();
    v_read_at timestamptz;
    /* v4 (2026-09-10): THE JOURNAL WINDOW IS A SNAPSHOT, NOT A CLOCK. A leg
       whose transaction straddled the previous reading (created_at before the
       reading, committed after it) fell through the created_at window for
       ever and read as drift (-100 / +100 on 2026-09-10). Every reading now
       records the snapshot it read under; the next reading counts a leg iff it
       was not visible in that snapshot. Every account rebaselines once. */
    v_basis text := 'one-snapshot-v4';
    r record; v_replay_window record;
    v_checked int := 0; v_baselines int := 0; v_rebased int := 0;
    v_bad int := 0; v_unkeyable bigint := 0;
    v_this numeric; v_two numeric; v_cum numeric;
    v_worst numeric := 0; v_worst_key text; v_sample jsonb := '[]'::jsonb;
  BEGIN
    IF NOT (current_user IN ('postgres', 'supabase_admin') OR COALESCE(auth.role(), '') = 'service_role') THEN
      RAISE EXCEPTION 'fn_ca_ledger_replay is service only' USING ERRCODE = '42501';
    END IF;

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
             s.basis_version AS prev_basis, s.read_snapshot AS prev_snapshot
        FROM zz_replay_touched t
        LEFT JOIN LATERAL (
          SELECT x.balance, x.taken_at, x.unexplained, x.cum_unexplained, x.basis_version, x.read_snapshot
            FROM public.ca_account_snapshots x
           WHERE x.account_key = t.account_key ORDER BY x.taken_at DESC LIMIT 1
        ) s ON true;

    /* THE BALANCE, THE JOURNAL AND THE SNAPSHOT ARE READ IN ONE STATEMENT.
       read_snapshot is pg_current_snapshot() evaluated by that statement, so
       it is exactly the visibility horizon the balances were read under, and
       it becomes the next run's window. */
    CREATE TEMP TABLE zz_replay_read (
      account_key text, prev_at timestamptz, prev_snapshot text, expected numeric,
      now_bal numeric, read_at timestamptz, read_snapshot text
    ) ON COMMIT DROP;

    FOR v_replay_window IN SELECT DISTINCT prev_at, prev_snapshot FROM zz_replay_prev WHERE prev_at IS NOT NULL AND prev_snapshot IS NOT NULL LOOP
      v_read_at := clock_timestamp();
      WITH legs AS MATERIALIZED (
        SELECT a.account_key, a.net
          FROM public.fn_ca_leg_accounts_since_snapshot(v_replay_window.prev_at, v_replay_window.prev_snapshot::pg_snapshot) a
         WHERE a.account_key IS NOT NULL
      )
      INSERT INTO zz_replay_read (account_key, prev_at, prev_snapshot, expected, now_bal, read_at, read_snapshot)
      SELECT t.account_key, v_replay_window.prev_at, v_replay_window.prev_snapshot, COALESCE(l.net, 0),
             public.fn_ca_account_balance(t.account_type, t.entity_id, t.club_id, t.column_name),
             v_read_at, pg_current_snapshot()::text
        FROM zz_replay_touched t
        JOIN zz_replay_prev p ON p.account_key = t.account_key AND p.prev_at = v_replay_window.prev_at
                             AND p.prev_snapshot = v_replay_window.prev_snapshot
        LEFT JOIN legs l ON l.account_key = t.account_key;
    END LOOP;

    /* An account nobody has read before, or one whose last reading holds no
       snapshot (every reading before v4), is recorded, not judged. */
    v_read_at := clock_timestamp();
    INSERT INTO public.ca_account_snapshots
      (account_key, account_type, entity_id, club_id, column_name, balance, taken_at, is_baseline, basis_version, note, read_snapshot, cum_unexplained)
    SELECT t.account_key, t.account_type, t.entity_id, t.club_id, t.column_name,
           b.bal, v_read_at, true, v_basis,
           CASE WHEN p.prev_at IS NULL THEN 'baseline: first reading of this account, not judged'
                ELSE format('rebaselined onto %s: the previous reading (%s) windowed the journal by created_at, and a leg that straddled that reading is the reader''s to miss, not the account''s',
                            v_basis, COALESCE(p.prev_basis, 'the unversioned reader')) END,
           pg_current_snapshot()::text,
           0
      FROM zz_replay_touched t
      JOIN zz_replay_prev p ON p.account_key = t.account_key AND (p.prev_at IS NULL OR p.prev_snapshot IS NULL)
      CROSS JOIN LATERAL (
        SELECT public.fn_ca_account_balance(t.account_type, t.entity_id, t.club_id, t.column_name) AS bal
      ) b
     WHERE b.bal IS NOT NULL;
    GET DIAGNOSTICS v_baselines = ROW_COUNT;

    v_read_at := clock_timestamp();
    FOR r IN
      SELECT t.*, p.prev_balance, p.prev_at, p.prev_unexplained, p.prev_cum, p.prev_basis,
             d.expected, d.now_bal, d.read_at, d.read_snapshot
        FROM zz_replay_touched t
        JOIN zz_replay_prev p ON p.account_key = t.account_key
        JOIN zz_replay_read d ON d.account_key = t.account_key AND d.prev_at = p.prev_at
    LOOP
      IF r.now_bal IS NULL THEN CONTINUE; END IF;

      /* A CHANGE OF BASIS IS NOT DRIFT. */
      IF COALESCE(r.prev_basis, '') <> v_basis THEN
        INSERT INTO public.ca_account_snapshots
          (account_key, account_type, entity_id, club_id, column_name, balance, taken_at,
           is_baseline, unexplained, cum_unexplained, basis_version, note, read_snapshot)
        VALUES (r.account_key, r.account_type, r.entity_id, r.club_id, r.column_name,
                r.now_bal, v_read_at, true, NULL, 0, v_basis,
                format('rebaselined onto %s: the previous reading (%s) windowed the journal by created_at, and a leg that straddled that reading is the reader''s to miss, not the account''s',
                       v_basis, COALESCE(r.prev_basis, 'the unversioned reader')),
                r.read_snapshot);
        v_rebased := v_rebased + 1;
        CONTINUE;
      END IF;

      v_checked := v_checked + 1;
      v_this := round((r.now_bal - r.prev_balance) - r.expected, 2);
      v_cum := round(v_this + COALESCE(r.prev_cum, 0), 2);
      v_two := CASE
                 WHEN abs(v_this) >= 100 THEN v_this
                 WHEN v_this <> 0 AND COALESCE(r.prev_unexplained, 0) <> 0
                      AND sign(v_this) = sign(r.prev_unexplained) THEN v_cum
                 ELSE 0
               END;

      INSERT INTO public.ca_account_snapshots
        (account_key, account_type, entity_id, club_id, column_name, balance, taken_at,
         is_baseline, unexplained, cum_unexplained, basis_version, note, read_snapshot)
      VALUES (r.account_key, r.account_type, r.entity_id, r.club_id, r.column_name,
              r.now_bal, v_read_at, false, v_this, v_cum, v_basis,
              format('moved %s, journal %s, unexplained %s this interval (cumulative %s, judged %s) since %s',
                     round(r.now_bal - r.prev_balance, 2), r.expected, v_this, v_cum, v_two, r.prev_at),
              r.read_snapshot);

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
          format('%s moved %s between %s and now while the journal accounts for %s: %s unexplained this interval, %s over the last two. The journal window is the previous reading''s snapshot, so a leg is counted exactly when it committed after that reading.',
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
DO $guard$
DECLARE p pg_proc;
BEGIN
  SELECT * INTO STRICT p FROM pg_proc WHERE oid = to_regprocedure('public.fn_ca_ledger_replay(integer)');
  IF md5(pg_get_functiondef(p.oid)) IS DISTINCT FROM '0ebc35f25915af00e69a809038550b83' OR pg_get_userbyid(p.proowner) IS DISTINCT FROM 'postgres' OR p.proacl::text IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' THEN
    RAISE EXCEPTION 'replay postflight: changed definition/owner/access for fn_ca_ledger_replay(integer)';
  END IF;
  SELECT * INTO STRICT p FROM pg_proc WHERE oid = to_regprocedure('public.fn_ca_currency_meter()');
  IF md5(pg_get_functiondef(p.oid)) IS DISTINCT FROM 'e58e52177046c958f9daacb20a63fade' OR pg_get_userbyid(p.proowner) IS DISTINCT FROM 'postgres' OR p.proacl::text IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' THEN
    RAISE EXCEPTION 'replay postflight: changed definition/owner/access for fn_ca_currency_meter()';
  END IF;
END $guard$;
COMMIT;
