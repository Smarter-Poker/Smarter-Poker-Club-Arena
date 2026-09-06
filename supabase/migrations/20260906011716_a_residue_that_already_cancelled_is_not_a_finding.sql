-- 20260906011716_a_residue_that_already_cancelled_is_not_a_finding.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY (chip standard Phase 8.1, 2026-09-06 01:2x UTC):
--
-- With every leg keyed (8.1) the replay ran clean - 1,012 accounts, one
-- finding - and then filed four more that each read, in their own words,
-- "0.00 unexplained this interval". A finding whose interval is zero is not a
-- finding, and the cause is in the arithmetic I copied from the BBJ meter:
--
--   the rule was "this interval plus the previous one", which double-counts
--   along a chain. A +100 boundary residue at run N is cancelled by -100 at
--   run N+1 (correctly, no finding), and then reappears at run N+2, where
--   this interval is 0.00 and the previous is -100. The residue is counted
--   twice: once when it cancels and once when it is already gone.
--
-- What the account actually has is a CUMULATIVE residue since its baseline.
-- For a boundary it oscillates around zero; for a leak it grows. So the
-- snapshot now carries that cumulative figure, and a finding needs BOTH a
-- non-zero cumulative AND two consecutive intervals moving it the same way -
-- which is the supply meter's own rule, written on this platform on
-- 2026-09-01: a leak persists, an oscillation flips. A single interval of 100
-- chips or more is always reported whatever its sign, because a jump that
-- size deserves a person's eye even if the next interval takes it back.
--
-- The same flaw is present in fn_bbj_reconcile_all, which this borrowed the
-- pattern from; it is named here for the BBJ lane rather than changed in the
-- same migration, because its two-snapshot window has a different cadence and
-- its own law test.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

ALTER TABLE public.ca_account_snapshots ADD COLUMN IF NOT EXISTS cum_unexplained numeric;
COMMENT ON COLUMN public.ca_account_snapshots.cum_unexplained IS
  'Phase 8.1: the account''s cumulative unexplained residue since its baseline. A boundary oscillates around zero here; a leak grows.';

CREATE OR REPLACE FUNCTION public.fn_ca_ledger_replay(p_limit integer DEFAULT 5000)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_now timestamptz := clock_timestamp();
  r record; v_at timestamptz;
  v_checked int := 0; v_baselines int := 0; v_bad int := 0; v_unkeyable bigint := 0;
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
  /* Two runs in one transaction (the probe, and the assertion below) must not
     collide on the scratch names. */
  DROP TABLE IF EXISTS zz_replay_window;
  DROP TABLE IF EXISTS zz_replay_touched;
  DROP TABLE IF EXISTS zz_replay_prev;
  DROP TABLE IF EXISTS zz_replay_net;

  /* One read of the window for both answers: what moved, and what could not
     be keyed. The journal is the biggest table on the platform; it is scanned
     once here and once per distinct previous reading below, and nowhere else. */
  CREATE TEMP TABLE zz_replay_window ON COMMIT DROP AS
    SELECT a.* FROM public.fn_ca_leg_accounts(v_now - interval '26 hours', v_now) a;

  SELECT COALESCE(sum(w.unkeyable), 0) INTO v_unkeyable FROM zz_replay_window w WHERE w.account_type = 'unkeyable';

  CREATE TEMP TABLE zz_replay_touched ON COMMIT DROP AS
    SELECT w.* FROM zz_replay_window w
     WHERE w.account_type <> 'unkeyable'
     ORDER BY abs(w.net) DESC
     LIMIT GREATEST(COALESCE(p_limit, 5000), 1);

  CREATE TEMP TABLE zz_replay_prev ON COMMIT DROP AS
    SELECT t.account_key, s.balance AS prev_balance, s.taken_at AS prev_at, s.unexplained AS prev_unexplained, s.cum_unexplained AS prev_cum
      FROM zz_replay_touched t
      LEFT JOIN LATERAL (
        SELECT x.balance, x.taken_at, x.unexplained, x.cum_unexplained FROM public.ca_account_snapshots x
         WHERE x.account_key = t.account_key ORDER BY x.taken_at DESC LIMIT 1
      ) s ON true;

  CREATE TEMP TABLE zz_replay_net (account_key text, prev_at timestamptz, net numeric) ON COMMIT DROP;
  FOR v_at IN SELECT DISTINCT prev_at FROM zz_replay_prev WHERE prev_at IS NOT NULL LOOP
    INSERT INTO zz_replay_net (account_key, prev_at, net)
    SELECT a.account_key, v_at, a.net FROM public.fn_ca_leg_accounts(v_at, v_now) a WHERE a.account_key IS NOT NULL;
  END LOOP;

  FOR r IN
    SELECT t.*, p.prev_balance, p.prev_at, p.prev_unexplained, p.prev_cum,
           COALESCE((SELECT n.net FROM zz_replay_net n WHERE n.account_key = t.account_key AND n.prev_at = p.prev_at), 0) AS expected,
           public.fn_ca_account_balance(t.account_type, t.entity_id, t.club_id, t.column_name) AS now_bal
      FROM zz_replay_touched t JOIN zz_replay_prev p ON p.account_key = t.account_key
  LOOP
    IF r.now_bal IS NULL THEN CONTINUE; END IF;

    IF r.prev_at IS NULL THEN
      INSERT INTO public.ca_account_snapshots (account_key, account_type, entity_id, club_id, column_name, balance, taken_at, is_baseline, note)
      VALUES (r.account_key, r.account_type, r.entity_id, r.club_id, r.column_name, r.now_bal, v_now, true,
              'baseline: first reading of this account, not judged');
      v_baselines := v_baselines + 1;
      CONTINUE;
    END IF;

    v_checked := v_checked + 1;
    v_this := round((r.now_bal - r.prev_balance) - r.expected, 2);

    /* TWO INTERVALS, ONE FINDING. A leg that commits between the balance read
       and the window's end lands in one interval and reverses in the next, so
       a single interval's residue is noise and the two-interval sum is the
       finding - the same rule the BBJ meter uses, and for the same reason.
       Measured while building this: two passes microseconds apart reported
       three player wallets as 3.00 unexplained; every one was a buy-in that
       committed between the two reads, and every one cancelled next pass. */
    /* A RESIDUE THAT ALREADY CANCELLED IS NOT A FINDING (2026-09-06). Summing
       this interval with the previous one double-counts along the chain: a
       +100 at run N cancelled by -100 at run N+1 reappears as -100 at run N+2,
       where this interval is 0.00. Four such findings were filed at the Phase
       8 gate, every one reading "0.00 unexplained this interval". What is
       carried instead is the CUMULATIVE residue since the account's baseline,
       which oscillates around zero for a boundary and grows for a leak, and
       a finding needs BOTH a non-zero cumulative AND two consecutive
       intervals moving it the same way - the supply meter's own rule, that a
       leak persists while an oscillation flips. A single interval of 100 or
       more is always shown, whatever its sign. */
    v_cum := round(v_this + COALESCE(r.prev_cum, 0), 2);
    v_two := CASE
               WHEN abs(v_this) >= 100 THEN v_this
               WHEN v_this <> 0 AND COALESCE(r.prev_unexplained, 0) <> 0
                    AND sign(v_this) = sign(r.prev_unexplained) THEN v_cum
               ELSE 0
             END;

    INSERT INTO public.ca_account_snapshots (account_key, account_type, entity_id, club_id, column_name, balance, taken_at, is_baseline, unexplained, cum_unexplained, note)
    VALUES (r.account_key, r.account_type, r.entity_id, r.club_id, r.column_name, r.now_bal, v_now, false, v_this, v_cum,
            format('moved %s, journal %s, unexplained %s this interval (cumulative %s, judged %s) since %s', round(r.now_bal - r.prev_balance, 2), r.expected,
                   v_this, v_cum, v_two, r.prev_at));

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
        format('%s moved %s between %s and now while the journal accounts for %s: %s unexplained this interval, %s over the last two. The journal names every chip that entered or left an account; this one disagrees with its own balance.',
               r.column_name, round(r.now_bal - r.prev_balance, 2), r.prev_at, r.expected, v_this, v_cum),
        false,
        jsonb_build_object('account_key', r.account_key, 'column', r.column_name,
                           'moved', round(r.now_bal - r.prev_balance, 2), 'journal', r.expected,
                           'unexplained', v_this, 'cumulative', v_cum, 'judged', v_two, 'previous_at', r.prev_at));
    END IF;
  END LOOP;

  PERFORM public.fn_ca_kill_switch_trip('fn_ca_ledger_replay', v_worst,
    format('one account disagrees with the journal by %s (%s)', round(COALESCE(v_worst, 0), 2), COALESCE(v_worst_key, 'n/a')));

  RETURN jsonb_build_object('checked', v_checked, 'baselines', v_baselines, 'disagree', v_bad,
                            'worst', round(COALESCE(v_worst, 0), 2), 'worst_account', v_worst_key,
                            'unkeyable_legs', v_unkeyable, 'sample', v_sample, 'at', v_now);
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_ledger_replay(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_ledger_replay(integer) TO service_role;

UPDATE public.ca_drift_incidents
   SET status = 'resolved', resolved_at = now(),
       correction_ref = 'migration 20260906011716_a_residue_that_already_cancelled_is_not_a_finding',
       root_cause = 'the replay judged this interval plus the previous one, which counts a boundary residue twice along the chain: once when the next interval cancels it and again when it is already gone. Every one of these findings says "0.00 unexplained this interval" in its own text',
       resolution = 'the snapshot carries the cumulative residue since the account''s baseline, and a finding needs a non-zero cumulative and two consecutive intervals moving it the same way'
 WHERE source = 'fn_ca_ledger_replay' AND status IN ('open','acknowledged','reconciling');

DO $$
DECLARE v_src text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'fn_ca_ledger_replay';
  IF v_src NOT LIKE '%A RESIDUE THAT ALREADY CANCELLED IS NOT A FINDING%' THEN
    RAISE EXCEPTION 'the replay still sums two intervals blind';
  END IF;
  IF v_src NOT LIKE '%sign(v_this) = sign(r.prev_unexplained)%' THEN
    RAISE EXCEPTION 'the replay does not require the residue to persist in sign';
  END IF;
  IF (SELECT count(*) FROM public.ca_drift_incidents WHERE source = 'fn_ca_ledger_replay' AND status = 'open') <> 0 THEN
    RAISE EXCEPTION 'a replay finding is still open';
  END IF;
END $$;

COMMIT;
