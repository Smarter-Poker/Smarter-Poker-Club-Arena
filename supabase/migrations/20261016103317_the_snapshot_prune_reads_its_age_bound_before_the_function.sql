-- 20261016103317_the_snapshot_prune_reads_its_age_bound_before_the_function.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- THE SNAPSHOT PRUNE READS ITS AGE BOUND BEFORE THE FUNCTION (2026-10-16)
--
-- PgCronFailuresElevated fired 14 times between 01:22 and 08:45 UTC on
-- 2026-10-16 (operational_alert_events 255055 onward). Read from
-- cron.job_run_details: every failure in the window is jobid 119,
-- sp_prune_hand_state_snapshots_2m, "canceling statement due to statement
-- timeout" inside the doomed CTE or inside
-- smarter_private.horse_snapshot_disposable. Failures began at 21:49 UTC on
-- 2026-10-15 (1 in that hour, 10 to 16 an hour since). It was not caused by a
-- 20261015* or 20261016* install: the successful runs' mean duration grew
-- steadily with the table, 19 s on 2026-10-14, 30 s by 05:00 and 44 s by
-- 20:00 on 2026-10-15, 55 s on 2026-10-16, and runs fail once they reach the
-- postgres role's 2 min statement_timeout (the in-statement set_config of 30s
-- does not bind the statement that is already running).
--
-- THE CAUSE. 20261012173151 rewrote the doomed CTE so that its only filter is
-- smarter_private.horse_snapshot_disposable(s.id), a SECURITY DEFINER
-- plpgsql function. Its first test refuses any snapshot created or updated in
-- the last eight days, but the planner cannot see inside it, so every run
-- evaluates it once per snapshot: a merge join over all 5.5M certificates and
-- all 2.8M hand_state_snapshots rows (EXPLAIN on production, cost 1.73M). On
-- 2026-10-16 the table holds 2 rows older than seven days and 2.83M younger
-- ones, so every run does 2.8M function calls to delete nothing, and the
-- table grows by about 600k rows a day.
--
-- THE FIX. The doomed CTE states the same age bound itself, on the same clock
-- (statement_timestamp(), which inside the function is the same top-level
-- statement's start), where the planner can use
-- idx_hand_state_snapshots_created_at. created_at and updated_at are NOT NULL,
-- so the bound admits exactly the rows the function's own first test admits:
-- the set of deleted rows is unchanged, only the rows it can never accept are
-- no longer visited. Measured read-only on production with EXPLAIN ANALYZE:
-- 6.6 ms for one round (Index Scan Backward on the created_at index, 2 rows
-- visited) against 40 to 120 s today.
--
-- Pinned-preimage substitution: the live pg_get_functiondef md5 is pinned
-- (54116971...), the one anchor occurs exactly once, the postimage md5 was
-- derived read-only on production with replace() (9796fd7b...), and owner,
-- SECURITY DEFINER, search_path and grants are proven unchanged after the
-- replace.
--
-- Regression: scripts/ci/test-snapshot-prune-reads-its-age-bound.py on native
-- PostgreSQL (the live definition captured 2026-10-16 in
-- scripts/ci/fixtures/snapshot-prune-age-bound/), run by
-- .github/workflows/snapshot-prune-reads-its-age-bound.yml.
--
-- @live-proof: md5(pg_get_functiondef('public.sp_prune_hand_state_snapshots(integer)'::regprocedure)) = '9796fd7b8fba97bf4fe0481740397f9e'

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

CREATE FUNCTION pg_temp.ca_snapshot_prune_subst(p_sig text, p_before text, p_after text,
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

SELECT pg_temp.ca_snapshot_prune_subst(
  'public.sp_prune_hand_state_snapshots(integer)',
  '54116971d0db8245a31761d7f61a0884', '9796fd7b8fba97bf4fe0481740397f9e',
  ARRAY[$so1$       join public.hand_state_snapshots s on s.table_id=c.table_id and s.hand_number=c.hand_number
       where smarter_private.horse_snapshot_disposable(s.id)
$so1$],
  ARRAY[$sn1$       join public.hand_state_snapshots s on s.table_id=c.table_id and s.hand_number=c.hand_number
       -- THE AGE BOUND IS READ BEFORE THE FUNCTION (2026-10-16).
       -- horse_snapshot_disposable refuses every snapshot created or updated
       -- in the last eight days, but as the only filter it ran once per
       -- snapshot row, every two minutes, across the whole table (2.8M rows,
       -- none old enough): 40 to 120 s a run, zero deletes, and the 2 min
       -- role timeout killed a third of the runs (PgCronFailuresElevated).
       -- The same bound, written where the planner can use
       -- idx_hand_state_snapshots_created_at, visits only rows the function
       -- could accept. Same clock (statement_timestamp), same answer.
       where s.created_at < statement_timestamp() - interval '8 days'
         and s.updated_at < statement_timestamp() - interval '8 days'
         and smarter_private.horse_snapshot_disposable(s.id)
$sn1$]
);

COMMIT;
