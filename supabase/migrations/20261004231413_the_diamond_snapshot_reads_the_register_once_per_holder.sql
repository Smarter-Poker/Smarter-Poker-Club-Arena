-- ===========================================================================
--  THE DIAMOND SNAPSHOT READS THE REGISTER ONCE PER HOLDER
-- ===========================================================================
--
-- Three critical incidents, all DR0:health_critical from
-- fn_ca_diamond_health_watch, all "Trial balance is incomplete: require one
-- known comparison for each of the five reconciling accounts", status
-- 'unknown' (ca_diamond_incidents 869217, 869298, 874553):
--
--     2026-10-01 16:35:01 UTC   2026-10-01 17:35:08 UTC   2026-10-03 19:35:02 UTC
--
-- No trial balance broke. Each hour the trial balance had NOTHING TO MEASURE
-- FROM, because the hourly snapshot it compares against was never stored.
--
-- WHAT HAPPENED, read on production 2026-10-04 23:10 UTC (cron.job_run_details
-- for job 201 ca-diamond-snapshot-hourly, minute 10; ca_diamond_snapshots):
--
--   2026-10-01 16:10:00  failed  "job startup timeout" (12.04 s). pg_cron could
--                        not open the job's connection; 22 of the 135 jobs
--                        started 16:05-16:15 failed the same way, 262 that day.
--   2026-10-01 17:10:01  failed  after 120.04 s:
--                          ERROR: canceling statement due to statement timeout
--                          CONTEXT: SQL function "fn_ca_is_fixture_account" statement 1
--                          SQL statement "SELECT (SELECT COALESCE(sum(diamonds),0)
--                            FROM public.profiles), ...
--                        the snapshot's own first statement, cancelled at the
--                        postgres role's statement_timeout (2min) inside the
--                        per-row fixture test. Jobs 144 and 263 were cancelled
--                        at 120 s in the same two minutes: the host was
--                        saturated, and this statement was the one that could
--                        not finish.
--   2026-10-03 19:10     no run at all: the database restarted 19:07-19:12
--                        (20261003220245).
--
--   Snapshots exist at 10-01 15:10 (766) and 18:10 (767), and at 10-03 18:10
--   (814) and 20:10 (815). fn_ca_diamond_trial_balance measures from the first
--   snapshot at or after its window start; with none, player_diamonds,
--   fixture_accounts, diamond_house and total return difference NULL, the
--   health report reads 'unknown' and the watch filed critical.
--
--   The hourly DR11:trial_balance_summary rows are NOT missing for those hours
--   (869216 at 16:20, 869220 at 17:20, 874450 at 19:20). They are worse than
--   missing: each says accounts_reported 11, incidents_filed 0, while four of
--   its comparisons were NULL. A "could not tell" recorded as a clean hour.
--
-- THE STATEMENT. EXPLAIN (ANALYZE, BUFFERS) of the snapshot's first statement
-- on production, warm, 2026-10-04 23:12 UTC: 3,474 ms and 917,586 buffer reads.
-- One subquery is 855,590 of them (93%):
--
--     SELECT COALESCE(SUM(...), 0) FROM public.ca_mint_ledger m
--      WHERE m.asset = 'diamonds' AND m.holder_type = 'player'
--        AND public.fn_ca_is_fixture_account(m.holder_id)
--
-- fn_ca_is_fixture_account is SECURITY DEFINER with a SET clause, so it is
-- never inlined: it runs once per ledger ROW, 209,249 times, three index
-- probes each, to keep 23 rows. The register holds 8,404 distinct player
-- holders. The same subquery sits in fn_ca_diamond_trial_balance, which the
-- :20 watch and the :35 health report both run, beside two further passes
-- over the same rows. The snapshot's p50 is 7.8 s and p95 26.2 s over 347
-- runs; under a saturated host that became more than 120 s.
--
-- WHAT CHANGES:
--   1. fn_ca_diamond_snapshot: the player register is netted per holder in
--      ONE pass (a CTE inside the same statement, so still one SQL snapshot
--      with the balances), and the fixture question is put to each holder
--      once. Measured on production, read-only: the two register figures cost
--      443 ms and 84,975 buffer reads this way against 3,269 ms and 856,637
--      for the fixture figure alone.
--   2. fn_ca_diamond_trial_balance: the same, for its three register passes
--      (player, fixture, house). fn_ca_mint_supply('diamonds') is left as the
--      one definition of the register total.
--   3. fn_ca_diamond_trial_balance: with no snapshot at or after the window
--      start it measures from the newest snapshot BEFORE it. The comparisons
--      are stock against stored stock, so that is the same question over a
--      longer span, and the note names the snapshot. fn_ca_diamond_health has
--      passed that snapshot in by hand since 20261003220245; the hourly watch
--      and the staff desk did not, which is why a summary could read clean on
--      four NULLs. No snapshot at all still reads unknown.
--
--   Nothing is scheduled, retried, swept or silenced. No index: the write
--   path of ca_mint_ledger is untouched. No grant, owner or setting moves.
--
-- THE THREE HOURS. There is no door that computes a snapshot for a past hour
-- (the snapshot reads live balances), so none is written. They are not
-- unmeasured: each snapshot stores `unexplained` against the one before it.
-- 767 (10-01 18:10) against 766 (15:10) spans both missing 10-01 hours and
-- reads unexplained 0.00 (basis moved 29,951); 815 (10-03 20:10) against 814
-- (18:10) spans the missing 10-03 hour and reads 0.00 (moved 3,625).
--
-- HOW. Exact substitution through a pg_temp helper (as in 20261003220245):
-- pinned preimages, each anchor exactly once, pinned postimages, owner,
-- security, settings and grants unmoved. Before anything is replaced the new
-- reads are compared with the old ones on the live register in ONE statement,
-- and the migration refuses if any figure differs. fn_ca_diamond_snapshot is
-- on fn_ca_guard_watchlist() and is declared.
-- ===========================================================================
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_ca_diamond_snapshot()'::regprocedure)) = '2419d7a9c757d9a0135b8fec75edd2c8' AND md5(pg_get_functiondef('public.fn_ca_diamond_trial_balance(timestamp with time zone)'::regprocedure)) = '70f9022bd9944863dd7390f03e869c8b')
-- @live-proof: (SELECT position('fn_ca_is_fixture_account(m.holder_id)' IN pg_get_functiondef('public.fn_ca_diamond_snapshot()'::regprocedure)) = 0 AND position('fn_ca_is_fixture_account(m.holder_id)' IN pg_get_functiondef('public.fn_ca_diamond_trial_balance(timestamp with time zone)'::regprocedure)) = 0)

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

-- ---------------------------------------------------------------------------
-- 0. THE NEW READS ARE THE OLD READS, ON THE LIVE REGISTER, IN ONE STATEMENT
-- ---------------------------------------------------------------------------
DO $same$
DECLARE r record;
BEGIN
  WITH reg AS MATERIALIZED (
    SELECT m.holder_type, m.holder_id,
           SUM(CASE WHEN m.action = 'mint' THEN m.amount ELSE -m.amount END) AS net
      FROM public.ca_mint_ledger m
     WHERE m.asset = 'diamonds' AND m.holder_type IN ('player', 'house')
     GROUP BY m.holder_type, m.holder_id)
  SELECT (SELECT COALESCE(SUM(CASE WHEN action = 'mint' THEN amount ELSE -amount END), 0)
            FROM public.ca_mint_ledger WHERE asset = 'diamonds' AND holder_type = 'player') AS old_players,
         (SELECT COALESCE(SUM(CASE WHEN m.action = 'mint' THEN m.amount ELSE -m.amount END), 0)
            FROM public.ca_mint_ledger m
           WHERE m.asset = 'diamonds' AND m.holder_type = 'player' AND public.fn_ca_is_fixture_account(m.holder_id)) AS old_fixtures,
         (SELECT COALESCE(SUM(CASE WHEN action = 'mint' THEN amount ELSE -amount END), 0)
            FROM public.ca_mint_ledger WHERE asset = 'diamonds' AND holder_type = 'house') AS old_house,
         (SELECT COALESCE(SUM(g.net), 0) FROM reg g WHERE g.holder_type = 'player') AS new_players,
         (SELECT COALESCE(SUM(g.net), 0) FROM reg g WHERE g.holder_type = 'player' AND public.fn_ca_is_fixture_account(g.holder_id)) AS new_fixtures,
         (SELECT COALESCE(SUM(g.net), 0) FROM reg g WHERE g.holder_type = 'house') AS new_house
    INTO r;
  IF r.old_players IS DISTINCT FROM r.new_players
     OR r.old_fixtures IS DISTINCT FROM r.new_fixtures
     OR r.old_house IS DISTINCT FROM r.new_house THEN
    RAISE EXCEPTION 'the per-holder register read does not equal the per-row read: players % / %, fixtures % / %, house % / %',
      r.old_players, r.new_players, r.old_fixtures, r.new_fixtures, r.old_house, r.new_house;
  END IF;
  RAISE NOTICE 'register reads agree: players %, fixtures %, house %', r.new_players, r.new_fixtures, r.new_house;
END $same$;

-- ---------------------------------------------------------------------------
-- 1. THE SUBSTITUTION HELPER (temporary; ends with this session)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION pg_temp.ca_audit_subst(p_sig text, p_before text, p_after text,
                                       p_old text[], p_new text[])
RETURNS void LANGUAGE plpgsql AS $h$
DECLARE
  v_def text; v_new text; v_n integer; i integer;
  v_acl text; v_owner text; v_secdef boolean; v_cfg text[];
BEGIN
  v_def := pg_get_functiondef(p_sig::regprocedure);
  IF md5(v_def) <> p_before THEN
    RAISE EXCEPTION '% is not the pinned text (md5 %)', p_sig, md5(v_def);
  END IF;
  IF array_length(p_old, 1) IS DISTINCT FROM array_length(p_new, 1) THEN
    RAISE EXCEPTION '%: anchors and replacements do not pair', p_sig;
  END IF;
  v_new := v_def;
  FOR i IN 1 .. array_length(p_old, 1) LOOP
    v_n := (length(v_new) - length(replace(v_new, p_old[i], ''))) / length(p_old[i]);
    IF v_n <> 1 THEN
      RAISE EXCEPTION '%: anchor % occurs % times, expected exactly 1', p_sig, i, v_n;
    END IF;
    v_new := replace(v_new, p_old[i], p_new[i]);
  END LOOP;
  IF md5(v_new) <> p_after THEN
    RAISE EXCEPTION '%: substituted text is not the derived postimage (md5 %)', p_sig, md5(v_new);
  END IF;

  SELECT p.proacl::text, pg_get_userbyid(p.proowner), p.prosecdef, p.proconfig
    INTO v_acl, v_owner, v_secdef, v_cfg
    FROM pg_proc p WHERE p.oid = p_sig::regprocedure;

  EXECUTE v_new;

  IF md5(pg_get_functiondef(p_sig::regprocedure)) <> p_after THEN
    RAISE EXCEPTION '%: the replaced function does not read back as the postimage', p_sig;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p
                  WHERE p.oid = p_sig::regprocedure
                    AND p.proacl::text IS NOT DISTINCT FROM v_acl
                    AND pg_get_userbyid(p.proowner) = v_owner
                    AND p.prosecdef = v_secdef
                    AND p.proconfig IS NOT DISTINCT FROM v_cfg) THEN
    RAISE EXCEPTION '%: owner, security, settings or grants moved', p_sig;
  END IF;
END $h$;

-- ---------------------------------------------------------------------------
-- 2. THE SNAPSHOT
-- ---------------------------------------------------------------------------
SELECT pg_temp.ca_audit_subst(
  'public.fn_ca_diamond_snapshot()',
  'd4b4d63f74f302ab55e426f2ffb4556c', '2419d7a9c757d9a0135b8fec75edd2c8',
  ARRAY[$o$  SELECT (SELECT COALESCE(sum(diamonds),0) FROM public.profiles),
         (SELECT COALESCE(sum(balance),0) FROM public.diamond_wallets),
$o$, $o$         (SELECT COALESCE(SUM(CASE WHEN action = 'mint' THEN amount ELSE -amount END), 0)
            FROM public.ca_mint_ledger WHERE asset = 'diamonds' AND holder_type = 'player'),
         (SELECT COALESCE(SUM(CASE WHEN m.action = 'mint' THEN m.amount ELSE -m.amount END), 0)
            FROM public.ca_mint_ledger m
           WHERE m.asset = 'diamonds' AND m.holder_type = 'player' AND public.fn_ca_is_fixture_account(m.holder_id))
$o$],
  ARRAY[$n$  -- THE REGISTER IS READ ONCE, AND THE FIXTURE QUESTION IS ASKED ONCE PER HOLDER
  -- (2026-10-04). This statement used to read the player register twice, and the
  -- second read called fn_ca_is_fixture_account for every ledger ROW: 209,249 calls
  -- and 855,590 of the statement's 917,586 buffer reads (measured 2026-10-04), to
  -- keep 23 rows. On
  -- 2026-10-01 17:10 UTC that read was cancelled at the 120 s statement timeout,
  -- no snapshot was stored, and the trial balance read 'unknown' for two hours.
  -- The register is now netted per holder in one pass (8,404 holders then) and the
  -- fixture question is put to each holder once. Same rows, same sums, same SQL
  -- snapshot as the balances beside it; fn_ca_is_fixture_account is still the
  -- only definition of a fixture.
  WITH reg AS MATERIALIZED (
    SELECT m.holder_id,
           SUM(CASE WHEN m.action = 'mint' THEN m.amount ELSE -m.amount END) AS net
      FROM public.ca_mint_ledger m
     WHERE m.asset = 'diamonds' AND m.holder_type = 'player'
     GROUP BY m.holder_id)
  SELECT (SELECT COALESCE(sum(diamonds),0) FROM public.profiles),
         (SELECT COALESCE(sum(balance),0) FROM public.diamond_wallets),
$n$, $n$         (SELECT COALESCE(SUM(g.net), 0) FROM reg g),
         (SELECT COALESCE(SUM(g.net), 0) FROM reg g WHERE public.fn_ca_is_fixture_account(g.holder_id))
$n$]);

DO $declare$
BEGIN
  IF 'fn_ca_diamond_snapshot' = ANY (public.fn_ca_guard_watchlist()) THEN
    PERFORM public.fn_ca_declare_guard_redefinition('fn_ca_diamond_snapshot',
      'migration 20261004231413_the_diamond_snapshot_reads_the_register_once_per_holder');
  END IF;
END $declare$;

-- ---------------------------------------------------------------------------
-- 3. THE TRIAL BALANCE
-- ---------------------------------------------------------------------------
SELECT pg_temp.ca_audit_subst(
  'public.fn_ca_diamond_trial_balance(timestamp with time zone)',
  'f744e044e7575283be20f73cd1f2f7d5', '70f9022bd9944863dd7390f03e869c8b',
  ARRAY[$o$  SELECT * INTO s0 FROM public.ca_diamond_snapshots WHERE taken_at >= v_since ORDER BY taken_at ASC LIMIT 1;
  w0 := COALESCE(s0.taken_at, v_since);
$o$, $o$  SELECT (SELECT COALESCE(SUM(COALESCE(p.diamonds, 0)), 0)::numeric FROM public.profiles p),
$o$, $o$         (SELECT COALESCE(SUM(CASE WHEN action = 'mint' THEN amount ELSE -amount END), 0)
            FROM public.ca_mint_ledger WHERE asset = 'diamonds' AND holder_type = 'player'),
         (SELECT COALESCE(SUM(CASE WHEN m.action = 'mint' THEN m.amount ELSE -m.amount END), 0)
            FROM public.ca_mint_ledger m WHERE m.asset = 'diamonds' AND m.holder_type = 'player' AND public.fn_ca_is_fixture_account(m.holder_id)),
         (SELECT COALESCE(SUM(CASE WHEN action = 'mint' THEN amount ELSE -amount END), 0)
            FROM public.ca_mint_ledger WHERE asset = 'diamonds' AND holder_type = 'house'),
$o$],
  ARRAY[$n$  SELECT * INTO s0 FROM public.ca_diamond_snapshots WHERE taken_at >= v_since ORDER BY taken_at ASC LIMIT 1;
  -- A MISSED SNAPSHOT IS NOT AN UNKNOWN BALANCE, FOR ANY READER (2026-10-04). When the
  -- hourly snapshot did not land (2026-10-01 16:10 and 17:10, 2026-10-03 19:10) there is
  -- no snapshot inside the window, and every movement comparison below came back NULL.
  -- The comparisons are stock against stored stock, so the newest snapshot BEFORE the
  -- window answers the same question over a longer span, and the note names the snapshot
  -- it measured from. fn_ca_diamond_health has passed that snapshot in by hand since
  -- 2026-10-03; the hourly watch and the staff desk did not. No snapshot at all still
  -- reads unknown.
  IF s0.id IS NULL THEN
    SELECT * INTO s0 FROM public.ca_diamond_snapshots WHERE taken_at < v_since ORDER BY taken_at DESC LIMIT 1;
  END IF;
  w0 := COALESCE(s0.taken_at, v_since);
$n$, $n$  -- THE REGISTER IS READ ONCE, AND THE FIXTURE QUESTION IS ASKED ONCE PER HOLDER
  -- (2026-10-04): see fn_ca_diamond_snapshot. Three passes over the Diamond register,
  -- one of them calling fn_ca_is_fixture_account for every ledger row, are one pass
  -- netted per holder. Same rows, same sums, same SQL snapshot.
  WITH reg AS MATERIALIZED (
    SELECT m.holder_type, m.holder_id,
           SUM(CASE WHEN m.action = 'mint' THEN m.amount ELSE -m.amount END) AS net
      FROM public.ca_mint_ledger m
     WHERE m.asset = 'diamonds' AND m.holder_type IN ('player', 'house')
     GROUP BY m.holder_type, m.holder_id)
  SELECT (SELECT COALESCE(SUM(COALESCE(p.diamonds, 0)), 0)::numeric FROM public.profiles p),
$n$, $n$         (SELECT COALESCE(SUM(g.net), 0) FROM reg g WHERE g.holder_type = 'player'),
         (SELECT COALESCE(SUM(g.net), 0) FROM reg g WHERE g.holder_type = 'player' AND public.fn_ca_is_fixture_account(g.holder_id)),
         (SELECT COALESCE(SUM(g.net), 0) FROM reg g WHERE g.holder_type = 'house'),
$n$]);

DO $declare$
BEGIN
  IF 'fn_ca_diamond_trial_balance' = ANY (public.fn_ca_guard_watchlist()) THEN
    PERFORM public.fn_ca_declare_guard_redefinition('fn_ca_diamond_trial_balance',
      'migration 20261004231413_the_diamond_snapshot_reads_the_register_once_per_holder');
  END IF;
END $declare$;

-- ---------------------------------------------------------------------------
-- 4. WHAT MUST NOW BE TRUE
-- ---------------------------------------------------------------------------
DO $after$
DECLARE v_snap text; v_tb text;
BEGIN
  v_snap := pg_get_functiondef('public.fn_ca_diamond_snapshot()'::regprocedure);
  v_tb   := pg_get_functiondef('public.fn_ca_diamond_trial_balance(timestamp with time zone)'::regprocedure);
  IF position('fn_ca_is_fixture_account(m.holder_id)' IN v_snap) > 0
     OR position('fn_ca_is_fixture_account(m.holder_id)' IN v_tb) > 0 THEN
    RAISE EXCEPTION 'a Diamond book still asks the fixture question once per ledger row';
  END IF;
  IF position('fn_ca_is_fixture_account(g.holder_id)' IN v_snap) = 0
     OR position('fn_ca_is_fixture_account(g.holder_id)' IN v_tb) = 0 THEN
    RAISE EXCEPTION 'a Diamond book no longer measures fixtures with fn_ca_is_fixture_account';
  END IF;
  IF position('WHERE taken_at < v_since ORDER BY taken_at DESC LIMIT 1' IN v_tb) = 0 THEN
    RAISE EXCEPTION 'the trial balance does not reach back to the newest earlier snapshot';
  END IF;
  IF has_function_privilege('anon', 'public.fn_ca_diamond_snapshot()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_ca_diamond_snapshot()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.fn_ca_diamond_trial_balance(timestamp with time zone)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_ca_diamond_trial_balance(timestamp with time zone)', 'EXECUTE') THEN
    RAISE EXCEPTION 'a browser role can execute a Diamond book';
  END IF;
END $after$;

-- pg_temp.ca_audit_subst is a temporary object and ends with this session.

COMMIT;
