-- the_selftest_asks_for_a_retired_watcher_and_scopes_rake_past_the_house_club
--
-- CLAUDE.md 10.9: the reasoning goes in this header, not just the SQL.
--
-- Incident 03348891, financial_alerts:fn_union_law_selftest, 2026-09-21 00:20
-- UTC, CRITICAL: "UNION LAW self-test failed - the law has been clobbered or
-- breached". Nothing was clobbered and nothing was breached. The self-test was
-- measuring against two baselines that no longer describe this platform.
--
-- ===========================================================================
-- 1. THE BREACH: required_cron_missing, active 3
--
-- The list is four names and the test demands all four be active:
--
--   'union-weekly-rakeback-close', 'union-law-selftest',
--   'union-seat-provenance-heal', 'union-integrity-sweep'
--
-- Three are active. The absentee is union-seat-provenance-heal, and its
-- ABSENCE IS THE INTENDED OUTCOME. Migration 20260920070402
-- (three_watchers_whose_defects_were_fixed_stop_running) retired it earlier
-- today under CLAUDE.md 10.12, because its defect had been fixed at the root
-- and the watcher was left behind reading as coverage.
--
-- That migration's reasoning, re-verified today against the live catalog
-- rather than taken from its header:
--
--   trg_table_seats_stamp_club BEFORE INSERT OR UPDATE ON public.table_seats
--     FOR EACH ROW EXECUTE FUNCTION fn_stamp_seat_club()
--
-- No WHEN clause and no UPDATE OF list, so every insert and every update is
-- stamped by the writer the healer used to chase. Measured now:
--
--   table_seats with club_id NULL, joined in the last 7 days .......... 0
--   table_seats joined in the last 24 hours (the denominator) ..... 2,171
--   table_seats with club_id NULL and still seated ..................... 0
--
-- The last figure is the self-test's own seats_without_provenance warning,
-- and it did not fire in the failing run either. The healer is not needed.
--
-- So the correct repair is to stop demanding it. Re-scheduling a retired
-- repair job to satisfy a checker would be a 10.12 violation committed in
-- order to silence a 10.12 success, which is the precise shape of band-aid
-- Dan banned. The other two jobs that migration retired -
-- ca-bbj-repair-unbanked-15m and reconcile-club-table-counts-nightly - are
-- NOT in this list and are not implicated here; they were checked and found
-- correctly absent as well.
--
-- THE SIGNAL ALSO GETS A NAME. The breach reported 'active', 3 - a count,
-- naming nothing. Four names and a number told nobody which of the four was
-- gone, and finding out cost the whole of this investigation. CLAUDE.md 10.86
-- rule 1: a check with something to say should say it. It now reports the
-- missing job names in a 'jobs' array.
--
-- ===========================================================================
-- 2. THE WARNING THAT LOOKED LIKE A P0: distribution_exceeds_rake
--
--   rake_collected 5.00, total_distributed 285,252.43,
--   over_distributed_by 285,247.43
--
-- Read as written, that is a quarter of a million chips paid out against five
-- chips collected. It is not. NO MONEY IS MISSING, and the arithmetic below is
-- the proof rather than an assurance.
--
-- fn_union_distribution_check scopes all three of its sums through the
-- union_clubs join table. union_clubs holds TWO rows - Club JAQK and SHARK
-- CLUB. But clubs.union_id, the column the rest of the union law actually
-- reads, marks THREE clubs as belonging to this union, and the third is the
-- union's own house club:
--
--   Club JAQK    union_id fade0000...  is_union false  in union_clubs YES
--   SHARK CLUB   union_id fade0000...  is_union false  in union_clubs YES
--   Midway Union union_id fade0000...  is_union TRUE   in union_clubs NO
--
-- Midway Union is the house club: clubs.id = unions.id, is_union true. The
-- self-test knows this concept perfectly well - fn_union_house_club_stamp_check
-- and both *_stamp_house_club_fallback_missing breaches exist to police it -
-- but the distribution check never learned it.
--
-- That matters because rake and commission are booked to different clubs BY
-- DESIGN. rake_records.club_id carries the club that owns the TABLE, which on
-- a union floor is the house club. agent_commissions.club_id carries the club
-- the PLAYER belongs to, which is a member club. Measured for the current
-- week (from fn_union_week_start = 2026-09-14 07:00 UTC):
--
--   club            rake booked      commission booked
--   Midway Union      452,060.45                206.64   <- excluded by the map
--   SHARK CLUB              0.00            187,451.43
--   Club JAQK               5.00             98,146.60
--
-- So the old scope compared the member clubs' commissions against the member
-- clubs' rake, while the rake those commissions were computed from sat in the
-- house club it could not see. 5.00 against 285,252.43 is that hole, not a
-- payout.
--
-- Rescoped to clubs.union_id plus the union's own house club row, the same
-- week reads:
--
--   rake collected ............. 452,080.62
--   agent commissions .......... 285,953.50
--   player rakeback ............. 12,747.69
--   total distributed .......... 298,701.19   (66.1% of rake)
--
-- Comfortably inside the rake, which is what this check exists to assert.
--
-- Note the rakeback line. The old scope reported player_rakeback as 0.00 and
-- had done all along, because rakeback_periods are booked to the house club
-- too. A check that silently reads zero for a whole leg of the distribution
-- is worse than one that reads it high: 12,747.69 of real rakeback was
-- invisible to the only guard watching it. Fixing the scope restores it.
--
-- Deep Stack Society (union_id NULL, is_union false, absent from union_clubs)
-- is genuinely OUTSIDE this union and is deliberately not pulled in. It is
-- self-consistent on its own books - 320,207.13 rake against 239,389.86 in
-- commissions, 74.8% - so nothing is hidden by leaving it out.
--
-- The substitution keeps the alias `uc` and joins clubs on its PRIMARY KEY,
-- so the join stays 1:1 and cannot fan out a SUM the way a duplicate
-- union_clubs row could.
--
-- ===========================================================================
-- 3. THE TWO HIERARCHY WARNINGS ARE LEFT EXACTLY AS THEY ARE
--
-- players_without_agent 11 and agents_without_super_agent 1 are WARNINGS.
-- They do not enter `healthy`, which is breaches-only, and they are reporting
-- truthfully: six Club JAQK horses and five SHARK CLUB accounts carry no
-- agent_id, and SHARK CLUB's agent "kingfish" has no parent super_agent.
-- Those are real governance facts for an operator to act on, not defects in
-- the checker, and CLAUDE.md 10.5 forbids making the horses disappear from
-- the count to tidy the number. Nothing here touches them.
--
-- ===========================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- ---------------------------------------------------------------------------
-- 2. fn_union_distribution_check: scope all three legs by clubs.union_id,
--    including the union's own house club row.
-- ---------------------------------------------------------------------------
DO $mig1$
DECLARE
  v_src   text;
  v_new   text;
  v_a_rr  text; v_a_ac text; v_a_rp text;
  v_r_rr  text; v_r_ac text; v_r_rp text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_union_distribution_check';
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'fn_union_distribution_check is absent';
  END IF;

  v_a_rr := $a$
    JOIN union_clubs uc ON uc.club_id = rr.club_id AND uc.union_id = p_union_id
$a$;
  v_a_ac := $a$
    JOIN union_clubs uc ON uc.club_id = ac.club_id AND uc.union_id = p_union_id
$a$;
  v_a_rp := $a$
    JOIN union_clubs uc ON uc.club_id = rp.club_id AND uc.union_id = p_union_id
$a$;

  v_r_rr := $b$
    JOIN clubs uc ON uc.id = rr.club_id AND (uc.union_id = p_union_id OR uc.id = p_union_id)
$b$;
  v_r_ac := $b$
    JOIN clubs uc ON uc.id = ac.club_id AND (uc.union_id = p_union_id OR uc.id = p_union_id)
$b$;
  v_r_rp := $b$
    JOIN clubs uc ON uc.id = rp.club_id AND (uc.union_id = p_union_id OR uc.id = p_union_id)
$b$;

  -- Each anchor must appear EXACTLY once, or the body is not the one this
  -- migration was written against.
  IF (length(v_src) - length(replace(v_src, v_a_rr, ''))) / length(v_a_rr) <> 1 THEN
    RAISE EXCEPTION 'rake_records union_clubs join is not present exactly once';
  END IF;
  IF (length(v_src) - length(replace(v_src, v_a_ac, ''))) / length(v_a_ac) <> 1 THEN
    RAISE EXCEPTION 'agent_commissions union_clubs join is not present exactly once';
  END IF;
  IF (length(v_src) - length(replace(v_src, v_a_rp, ''))) / length(v_a_rp) <> 1 THEN
    RAISE EXCEPTION 'rakeback_periods union_clubs join is not present exactly once';
  END IF;

  v_new := replace(replace(replace(v_src, v_a_rr, v_r_rr), v_a_ac, v_r_ac), v_a_rp, v_r_rp);

  -- Assert the composition before executing it.
  IF v_new = v_src THEN
    RAISE EXCEPTION 'fn_union_distribution_check substitution changed nothing';
  END IF;
  IF position('union_clubs' in v_new) > 0 THEN
    RAISE EXCEPTION 'a union_clubs reference survives the rescope';
  END IF;
  IF (length(v_new) - length(replace(v_new, 'JOIN clubs uc ON uc.id =', ''))) / 24 <> 3 THEN
    RAISE EXCEPTION 'expected exactly three rescoped joins';
  END IF;
  -- The legs themselves must be untouched.
  IF position('SUM(rr.rake_amount)'     in v_new) = 0
  OR position('SUM(ac.amount)'          in v_new) = 0
  OR position('SUM(rp.rakeback_amount)' in v_new) = 0
  OR position('over_distributed_by'     in v_new) = 0
  OR position('fn_union_week_start'     in v_new) = 0 THEN
    RAISE EXCEPTION 'the rescope damaged a distribution leg';
  END IF;

  EXECUTE v_new;
END;
$mig1$;

-- ---------------------------------------------------------------------------
-- 1. fn_union_law_selftest: stop requiring a cron that 20260920070402
--    deliberately retired, and name what is missing instead of counting it.
-- ---------------------------------------------------------------------------
DO $mig2$
DECLARE
  v_src text;
  v_new text;
  v_anchor text;
  v_repl   text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_union_law_selftest';
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'fn_union_law_selftest is absent';
  END IF;

  v_anchor := $a$  SELECT count(*) INTO v_n FROM cron.job
   WHERE jobname IN ('union-weekly-rakeback-close','union-law-selftest',
                     'union-seat-provenance-heal','union-integrity-sweep')
     AND active;
  IF v_n < 4 THEN
    v_breaches := v_breaches || jsonb_build_object('check','required_cron_missing','active',v_n);
  END IF;$a$;

  v_repl := $b$  -- The seat-provenance healer was retired by migration
  -- 20260920070402 under CLAUDE.md 10.12: its defect was fixed at the root
  -- (trg_table_seats_stamp_club now stamps every insert and update, with no
  -- WHEN clause) and the watcher was left behind. Its absence is the intended
  -- outcome, so this list must not ask for it back. Re-scheduling a retired
  -- repair job to satisfy a checker is the band-aid 10.12 forbids.
  --
  -- The missing jobs are NAMED, not counted: 'active', 3 against a list of
  -- four identified nothing (CLAUDE.md 10.86 rule 1).
  SELECT array_agg(j ORDER BY j) INTO v_missing
    FROM unnest(ARRAY['union-weekly-rakeback-close','union-law-selftest',
                      'union-integrity-sweep']) AS j
   WHERE NOT EXISTS (SELECT 1 FROM cron.job cj WHERE cj.jobname = j AND cj.active);
  IF v_missing IS NOT NULL THEN
    v_breaches := v_breaches || jsonb_build_object('check','required_cron_missing','jobs',to_jsonb(v_missing));
  END IF;$b$;

  IF (length(v_src) - length(replace(v_src, v_anchor, ''))) / length(v_anchor) <> 1 THEN
    RAISE EXCEPTION 'the required-cron block is not present exactly once';
  END IF;

  v_new := replace(v_src, v_anchor, v_repl);

  IF v_new = v_src THEN
    RAISE EXCEPTION 'fn_union_law_selftest substitution changed nothing';
  END IF;
  IF position('union-seat-provenance-heal' in v_new) > 0 THEN
    RAISE EXCEPTION 'the retired watcher is still demanded';
  END IF;
  IF position($c$'check','required_cron_missing','jobs'$c$ in v_new) = 0 THEN
    RAISE EXCEPTION 'the rewritten cron breach does not name its jobs';
  END IF;
  -- v_missing is reassigned by every block that reads it, so reusing it here
  -- cannot leak into the oversight-policy or RLS blocks below it.
  IF position('v_missing text[]' in v_new) = 0 THEN
    RAISE EXCEPTION 'v_missing is no longer declared text[]';
  END IF;

  EXECUTE v_new;
END;
$mig2$;

-- ---------------------------------------------------------------------------
-- 3. Post-conditions. Every other guard must survive, and the self-test must
--    actually come back healthy - this migration is not worth committing if
--    the incident it was written for is still open afterwards.
-- ---------------------------------------------------------------------------
DO $mig3$
DECLARE
  v_src  text;
  v_chk  text;
  v_res  jsonb;
  v_dist jsonb;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_union_law_selftest';

  -- Every breach and warning this self-test carried before today must still
  -- be carried. A rescope that quietly drops a guard is the failure this
  -- migration is repairing, one level up.
  FOREACH v_chk IN ARRAY ARRAY[
    'atomic_distribute_rake_law_missing',
    'tournament_buyin_rake_not_club_scoped',
    'fn_resolve_bbj_pool_law_missing',
    'record_rake_delegation_missing',
    'table_stamp_house_club_fallback_missing',
    'tournament_stamp_house_club_fallback_missing',
    'house_club_games_unstamped',
    'money_path_not_club_scoped',
    'chip_supply_monitor_blind_to_club_wallets',
    'required_trigger_missing',
    'required_cron_missing',
    'oversight_policy_missing',
    'club_table_rls_disabled',
    'club_view_not_security_invoker',
    'live_games_in_member_club_lobby',
    'private_rows_union_stamped',
    'seats_without_provenance'
  ] LOOP
    IF position(v_chk in v_src) = 0 THEN
      RAISE EXCEPTION 'guard % did not survive', v_chk;
    END IF;
  END LOOP;

  IF position('fn_union_law_extra_breaches'    in v_src) = 0
  OR position('fn_union_law_integrity_breaches' in v_src) = 0
  OR position('fn_union_hierarchy_warnings'     in v_src) = 0
  OR position('fn_union_money_path_check'       in v_src) = 0 THEN
    RAISE EXCEPTION 'a delegated breach source did not survive';
  END IF;

  -- The three jobs still demanded must genuinely be active right now.
  IF (SELECT count(*) FROM cron.job
       WHERE jobname IN ('union-weekly-rakeback-close','union-law-selftest',
                         'union-integrity-sweep') AND active) <> 3 THEN
    RAISE EXCEPTION 'one of the three still-required crons is not active';
  END IF;

  -- The rescoped distribution check must now balance, and must see the
  -- rakeback leg the old scope read as zero.
  v_dist := public.fn_union_distribution_check();
  IF NOT (v_dist->>'healthy')::boolean THEN
    RAISE EXCEPTION 'distribution still over rake after rescope: %', v_dist::text;
  END IF;
  IF (v_dist->>'rake_collected')::numeric <= 1000 THEN
    RAISE EXCEPTION 'rescope did not reach the house club rake: %', v_dist::text;
  END IF;

  -- And the incident's own subject.
  v_res := public.fn_union_law_selftest();
  IF NOT (v_res->>'healthy')::boolean THEN
    RAISE EXCEPTION 'self-test still unhealthy: %', (v_res->'breaches')::text;
  END IF;

  RAISE NOTICE 'union law self-test healthy; distribution %', v_dist::text;
END;
$mig3$;

COMMIT;
