-- 20260919160144_the_ledger_replay_reads_a_record_it_never_assigned
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-09-19 16:01:44 UTC.
--
-- CLAUDE.md 10.9: the reasoning goes in this header, not just the SQL.
--
-- ===========================================================================
-- WHAT WAS WRONG
--
-- ca-ledger-replay-nightly (cron 40 6 * * *) was `critical` in
-- fn_ca_cron_health(): 1 run, 0 successes. It raised
--
--   ERROR: record "w" is not assigned yet
--   DETAIL: The tuple structure of a not-yet-assigned record is indeterminate.
--   CONTEXT: SQL statement "SELECT COALESCE(sum(w.unkeyable), 0) FROM z..."
--
-- public.fn_ca_ledger_replay declares two bare record variables:
--
--   r record; w record;
--
-- and then uses `w` as a TABLE ALIAS in two statements that run BEFORE the
-- `FOR w IN ...` loop ever assigns it:
--
--   SELECT COALESCE(sum(w.unkeyable), 0) INTO v_unkeyable
--     FROM zz_replay_window w WHERE w.account_type = 'unkeyable';
--
--   CREATE TEMP TABLE zz_replay_touched ... AS
--     SELECT w.* FROM zz_replay_window w WHERE w.account_type <> 'unkeyable' ...
--
-- PL/pgSQL resolves `w.unkeyable` against the DECLARED VARIABLE, not the alias,
-- so the first of those two statements reads a record that has never been
-- assigned and the whole function dies there. The nightly ledger replay has
-- therefore never run, and neither has fn_ca_currency_meter() after it, which
-- the same cron command calls.
--
-- THE ACCOUNTING, so the next reader can check this rather than trust it.
-- prosrc carries exactly ELEVEN `w.` references. Five are the alias uses above
-- (w.unkeyable, w.account_type, w.*, w.account_type, w.net). Six are genuine
-- record uses inside the single FOR loop: w.prev_at three times and
-- w.prev_snapshot three times. 5 + 6 = 11, so the set is complete and nothing
-- is being missed.
--
-- WHAT THIS CHANGES
--
-- The two ALIASES become `zw`. The record variable and its loop are untouched,
-- which is the smallest change that removes the collision and the only one
-- whose every affected site is visible in a single reading. Renaming the
-- variable instead would touch six more sites for no additional correctness.
--
-- THE CLASS, not just the instance. A bare single-letter record variable will
-- shadow any table alias of the same letter, anywhere in the same function,
-- and the failure only shows up if the alias statement runs before the loop.
-- tests/a-record-variable-must-not-shadow-a-table-alias.law.test.ts now fails
-- any migration that writes that collision.
--
-- HOW: pg_temp.ca_patch, the sanctioned apply-time textual edit with an
-- exact-match-count assertion, so a body that has moved on refuses rather than
-- being half-patched. Both markers were confirmed to occur exactly once.
--
-- @live-proof: (SELECT position('FROM zz_replay_window w' in p.prosrc) = 0 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'fn_ca_ledger_replay')
-- @live-proof: (SELECT position('FROM zz_replay_window zw' in p.prosrc) > 0 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'fn_ca_ledger_replay')
-- ===========================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE FUNCTION pg_temp.ca_patch(p_fn text, p_from text, p_to text, p_expected integer DEFAULT 1)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_def text; v_n integer; v_procs integer;
BEGIN
  SELECT count(*) INTO v_procs FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = p_fn;
  IF v_procs <> 1 THEN
    RAISE EXCEPTION 'ca_patch: % has % overloads in public (expected exactly 1)', p_fn, v_procs;
  END IF;
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = p_fn;
  v_n := (length(v_def) - length(replace(v_def, p_from, ''))) / length(p_from);
  IF v_n <> p_expected THEN
    RAISE EXCEPTION 'ca_patch: marker in % found % times, expected %: %', p_fn, v_n, p_expected, left(p_from, 120);
  END IF;
  EXECUTE replace(v_def, p_from, p_to);
END $$;

-- 1. The statement that actually raised.
SELECT pg_temp.ca_patch('fn_ca_ledger_replay',
$p1f$SELECT COALESCE(sum(w.unkeyable), 0) INTO v_unkeyable FROM zz_replay_window w WHERE w.account_type = 'unkeyable';$p1f$,
$p1t$SELECT COALESCE(sum(zw.unkeyable), 0) INTO v_unkeyable FROM zz_replay_window zw WHERE zw.account_type = 'unkeyable';$p1t$);

-- 2. The one that would have raised next.
SELECT pg_temp.ca_patch('fn_ca_ledger_replay',
$p2f$      SELECT w.* FROM zz_replay_window w
       WHERE w.account_type <> 'unkeyable'
       ORDER BY abs(w.net) DESC
$p2f$,
$p2t$      SELECT zw.* FROM zz_replay_window zw
       WHERE zw.account_type <> 'unkeyable'
       ORDER BY abs(zw.net) DESC
$p2t$);

DO $verify$
DECLARE
  v_src text;
  v_w   integer;
BEGIN
  SELECT p.prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_ca_ledger_replay';

  -- No alias `w` anywhere. This is the collision itself, gone.
  IF position('zz_replay_window w' in v_src) > 0 THEN
    RAISE EXCEPTION 'failed: an alias w still shadows the record variable';
  END IF;
  IF position('zz_replay_window zw' in v_src) = 0 THEN
    RAISE EXCEPTION 'failed: the renamed alias is not there, so nothing was patched';
  END IF;

  -- And the record variable is untouched: the loop and its six field reads
  -- must survive, or this removed a collision by removing the wrong half.
  IF position('FOR w IN' in v_src) = 0 THEN
    RAISE EXCEPTION 'failed: the record loop was altered; only the aliases should change';
  END IF;
  v_w := (SELECT count(*) FROM regexp_matches(v_src, '\yw\.', 'g'));
  IF v_w <> 6 THEN
    RAISE EXCEPTION 'failed: expected exactly 6 remaining w. references (the record loop), found %', v_w;
  END IF;
END
$verify$;

COMMIT;
