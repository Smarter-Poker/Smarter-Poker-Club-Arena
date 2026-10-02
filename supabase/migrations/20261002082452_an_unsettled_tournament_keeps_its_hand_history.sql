-- 20261002082452_an_unsettled_tournament_keeps_its_hand_history.sql
--
-- AN UNSETTLED TOURNAMENT KEEPS ITS HAND HISTORY (2026-10-02)
--
-- THE DEFECT. Two owed items were left without per-player evidence because a
-- STORAGE job deleted records while the money they describe was still open:
--
--   * Cash, week of 2026-09-14: sp_prune_hand_history deleted the pruned
--     hands' rake_attributions, the per-player earning source of rakeback,
--     before the week's rakeback was paid (103,614.58 of the week's rake lost
--     its per-player record). FIXED by 20260925143224: the pruner no longer
--     deletes rake_attributions at all, accounting_cash_source_immutable
--     refuses to move an accrued attribution, and no function or cron job in
--     production deletes rake_records, rake_attributions,
--     accounting_cash_rake_sources or accounting_payable_earning_sources
--     (read from pg_proc and cron.job on 2026-10-02). The rakeback calculator
--     (fn_calculate_cash_rakeback_periods) reads none of the tables the pruner
--     still deletes (hand_history, hand_atomic_commits, ca_hand_player_idx and
--     the ca_hand_facts / ca_hand_notes / ca_hand_flags cascades). So a cash
--     week's per-player basis survives retention whether the week is settled
--     or not. This migration ASSERTS that, it does not need to change it.
--
--   * Tournament, PKO 3f19bd70 (2026-09-07): its hand history, the only record
--     of who knocked out whom, was pruned at eight days while its 2,310.00
--     bounty pool was still unpaid (bounty_pool_paid 0, alerts 85253851 and
--     fe0e2bab open). The pruner's only tournament settlement test is for
--     Spins (terminal settlement or cancellation receipt); every other
--     tournament's hands prune on age alone, settled or not. STILL OPEN; this
--     migration closes it.
--
-- THE FIX, ONE CANDIDATE CLAUSE. A tournament hand is a prune candidate only
-- when its event's money is settled:
--   - the tournament is COMPLETED or CANCELLED (a running or stuck event keeps
--     its hands);
--   - its bounty pool is fully paid (bounty_pool_paid >= bounty_pool);
--   - its escrow, when it has one, is closed (closed_at IS NOT NULL).
-- Excluding at the candidate set keeps the hand's history, atomic commit and
-- player index together, as the F06 and Spin exclusions already do, and never
-- marks it has_human. Retention resumes on the next run after settlement.
--
-- COST, MEASURED 2026-10-02. 4,734 escrows are open: 214 are RUNNING or
-- REGISTERING and the rest (completed / cancelled 2026-09-04 .. 09-14) already
-- had their hands pruned (12 of the first 300 open escrows have any hand
-- left, in line with the live share). Three terminal events carry an unpaid
-- bounty pool (3f19bd70, a21c0cb6, 3aa67ff3), all hands long gone. Every
-- completed bounty event of the last four days has bounty_pool_paid equal to
-- bounty_pool. Each test is a primary-key lookup (tournaments.id,
-- tournament_escrow.tournament_id).
--
-- DISCIPLINE. Exact-anchor patch of the live body, as 20260928031344 did:
-- pre-image md5 / owner / ACL / proconfig / prosecdef / provolatile asserted
-- against the body read on 2026-10-02; the anchor must occur exactly once;
-- the post-image asserts the clause is present once, the rake_attributions
-- DELETE is absent, and the security attributes are unchanged.
-- @live-proof: (SELECT count(*) FROM pg_proc WHERE proname = 'sp_prune_hand_history' AND prosrc LIKE '%AN UNSETTLED TOURNAMENT KEEPS ITS HANDS%') = 1

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $pre$
DECLARE r record;
BEGIN
  SELECT md5(p.prosrc) AS md5, pg_get_userbyid(p.proowner) AS owner, p.proacl::text AS acl,
         p.proconfig::text AS cfg, p.prosecdef, p.provolatile
    INTO r FROM pg_proc p WHERE p.oid = 'public.sp_prune_hand_history(integer)'::regprocedure;
  IF r.md5 IS DISTINCT FROM '806608447aefdb6ed4e64dbfe9b86d20'
     OR r.owner IS DISTINCT FROM 'postgres'
     OR r.acl IS DISTINCT FROM '{postgres=X/postgres}'
     OR r.cfg IS DISTINCT FROM '{"search_path=public, pg_temp"}'
     OR r.prosecdef IS DISTINCT FROM false
     OR r.provolatile IS DISTINCT FROM 'v' THEN
    RAISE EXCEPTION 'UNSETTLED_TOURNAMENT_RETENTION_PREIMAGE: sp_prune_hand_history is not the body read on 2026-10-02 (md5 %, owner %, acl %, config %, secdef %, volatile %)',
      r.md5, r.owner, r.acl, r.cfg, r.prosecdef, r.provolatile USING ERRCODE = '55000';
  END IF;
  -- The cash half of the law: no pruner deletes a rakeback earning source.
  IF EXISTS (SELECT 1 FROM pg_proc p
              WHERE p.pronamespace IN ('public'::regnamespace, 'smarter_private'::regnamespace)
                AND p.prosrc ~* 'delete\s+from\s+(public\.)?(rake_records|rake_attributions|accounting_cash_rake_sources|accounting_payable_earning_sources)\M')
     OR EXISTS (SELECT 1 FROM cron.job j
              WHERE j.command ~* 'delete\s+from\s+(public\.)?(rake_records|rake_attributions|accounting_cash_rake_sources|accounting_payable_earning_sources)\M') THEN
    RAISE EXCEPTION 'UNSETTLED_TOURNAMENT_RETENTION_PREIMAGE: a function or cron job deletes a rakeback earning source; read it before this migration runs' USING ERRCODE = '55000';
  END IF;
END
$pre$;

DO $patch$
DECLARE v_def text; v_new text; v_old text; v_repl text; n int;
BEGIN
  v_def := pg_get_functiondef('public.sp_prune_hand_history(integer)'::regprocedure);
  v_old := E'            WHERE c.hand_id=hh.id AND c.state=''pending'')\n';
  v_repl := v_old
         || E'         -- AN UNSETTLED TOURNAMENT KEEPS ITS HANDS (2026-10-02). A tournament\n'
         || E'         -- hand is evidence until its event''s money is settled: the event is\n'
         || E'         -- COMPLETED or CANCELLED, its bounty pool is fully paid, and its\n'
         || E'         -- escrow, when it has one, is closed. PKO 3f19bd70 lost the only record\n'
         || E'         -- of who knocked out whom while 2,310.00 of its bounty pool was unpaid.\n'
         || E'         -- Cash rake records are never deleted here (20260925143224), so a cash\n'
         || E'         -- week keeps its per-player rakeback basis settled or not.\n'
         || E'         -- Migration 20261002082452.\n'
         || E'         AND (hh.tournament_id IS NULL OR NOT EXISTS (\n'
         || E'           SELECT 1 FROM public.tournaments ut\n'
         || E'            WHERE ut.id=hh.tournament_id\n'
         || E'              AND (upper(COALESCE(ut.status::text,'''')) NOT IN (''COMPLETED'',''CANCELLED'',''CANCELED'')\n'
         || E'                   OR COALESCE(ut.bounty_pool,0)>COALESCE(ut.bounty_pool_paid,0)\n'
         || E'                   OR EXISTS (SELECT 1 FROM public.tournament_escrow ue\n'
         || E'                               WHERE ue.tournament_id=ut.id AND ue.closed_at IS NULL))))\n';
  n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF n <> 1 THEN
    RAISE EXCEPTION 'UNSETTLED_TOURNAMENT_RETENTION_ANCHOR_FOUND_%_TIMES', n USING ERRCODE = '55000';
  END IF;
  v_new := replace(v_def, v_old, v_repl);
  EXECUTE v_new;
END
$patch$;

-- Grants unchanged by CREATE OR REPLACE; stated explicitly (service_role gets
-- nothing it did not have: the live ACL is postgres only).
REVOKE ALL ON FUNCTION public.sp_prune_hand_history(integer) FROM PUBLIC, anon, authenticated, service_role;

DO $post$
DECLARE r record; v_src text;
BEGIN
  SELECT p.prosrc, pg_get_userbyid(p.proowner) AS owner, p.proacl::text AS acl,
         p.proconfig::text AS cfg, p.prosecdef, p.provolatile
    INTO r FROM pg_proc p WHERE p.oid = 'public.sp_prune_hand_history(integer)'::regprocedure;
  v_src := r.prosrc;
  IF (length(v_src) - length(replace(v_src, 'AN UNSETTLED TOURNAMENT KEEPS ITS HANDS', ''))) / length('AN UNSETTLED TOURNAMENT KEEPS ITS HANDS') <> 1
     OR position('COALESCE(ut.bounty_pool,0)>COALESCE(ut.bounty_pool_paid,0)' in v_src) = 0
     OR position('WHERE ue.tournament_id=ut.id AND ue.closed_at IS NULL' in v_src) = 0
     OR position('hand_submission_retention_disposal' in v_src) = 0
     OR position('f06_movement_boundary_retained' in v_src) = 0
     OR position('hand_history_retention_policy' in v_src) = 0
     OR position('horse_retention_days' in v_src) = 0 THEN
    RAISE EXCEPTION 'UNSETTLED_TOURNAMENT_RETENTION_UNPROVEN: the guard is not in the live body exactly once, or an earlier guard was lost' USING ERRCODE = '55000';
  END IF;
  IF v_src ~* '(^|\n)\s*delete\s+from\s+public\.rake_attributions' THEN
    RAISE EXCEPTION 'UNSETTLED_TOURNAMENT_RETENTION_UNPROVEN: the pruner deletes rake_attributions again' USING ERRCODE = '55000';
  END IF;
  IF r.owner IS DISTINCT FROM 'postgres' OR r.acl IS DISTINCT FROM '{postgres=X/postgres}'
     OR r.cfg IS DISTINCT FROM '{"search_path=public, pg_temp"}'
     OR r.prosecdef IS DISTINCT FROM false OR r.provolatile IS DISTINCT FROM 'v' THEN
    RAISE EXCEPTION 'UNSETTLED_TOURNAMENT_RETENTION_UNPROVEN: owner %, acl %, config %, secdef %, volatile % changed',
      r.owner, r.acl, r.cfg, r.prosecdef, r.provolatile USING ERRCODE = '55000';
  END IF;
END
$post$;

COMMIT;
