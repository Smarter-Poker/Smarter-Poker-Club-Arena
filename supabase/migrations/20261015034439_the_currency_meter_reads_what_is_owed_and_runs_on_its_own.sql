-- 20261015034439_the_currency_meter_reads_what_is_owed_and_runs_on_its_own
--
-- Reserved by scripts/new-migration.mjs on 2026-10-15 03:44:39 UTC.
--
-- THE CURRENCY METER READS WHAT IS OWED, AND RUNS ON ITS OWN (2026-10-15)
--
-- ca-ledger-replay-nightly (jobid 286, 06:40 UTC) failed on 2026-10-14 at its
-- 600 s statement_timeout:
--
--   ERROR: canceling statement due to statement timeout
--   CONTEXT: SQL function "fn_ca_launch_accounting_cutoff" during startup
--            SQL function "fn_ca_launch_accounting_accepts" statement 1
--            SQL statement "WITH u AS (SELECT club_id, user_id, sum(amount)
--            AS owed FROM public.agent_commissions_unsettled GROUP BY ..."
--
-- The job runs fn_ca_ledger_replay(5000) and then fn_ca_currency_meter() as
-- one command, so one transaction (it sets REPEATABLE READ for the replay):
-- the meter's timeout rolled that night's replay back with it.
--
-- WHY THE AGGREGATE WAS SLOW, READ FROM PRODUCTION:
--   * agent_commissions holds 22.3 M rows (16 GB). 21.2 M of them have
--     settled_at IS NULL (agent_commissions_open_idx reltuples), because a
--     settlement records the period it covered and never stamps the rows
--     (20260908033445). Only 6,184,371 of them are actually owed (the
--     rollup's rows_behind, and this migration's read below, agree).
--   * 20261012181905 (scoped club launch reset) put
--     fn_ca_launch_accounting_accepts(ac.club_id, ac.created_at) into the
--     agent_commissions_unsettled view. Both it and the cutoff it calls are
--     SECURITY DEFINER SQL functions with a SET search_path, which Postgres
--     never inlines, so EXPLAIN shows "Index Only Scan using
--     agent_commissions_open_idx ... Filter: fn_ca_launch_accounting_accepts(
--     club_id, created_at)" over all 21 M rows: two definer calls and a
--     lookup per row. No club has a launch boundary today
--     (ca_launch_accounting_boundaries is empty), so every call answers true.
--   * pg_stat_statements: the meter's successful calls averaged 82 s (max
--     124 s) before the view change; the first full night after it, it did
--     not finish in 600 s.
--
-- THE FIX, AT THE LINE THAT READ IT: the meter's commission statement no
-- longer aggregates the view. It asks the same question per (club, agent):
-- the launch cutoff once per club, the complement of the agent's settlement
-- periods as ranges, and one index-only range scan of
-- agent_commissions_open_idx per uncovered range. Row for row the predicate
-- is the view's (settled_at IS NULL, no period with start <= created_at <
-- end, and the launch cutoff exactly as fn_ca_launch_accounting_accepts
-- applies it, including a NULL or infinite created_at). Read-only on
-- production 2026-10-15 03:4x UTC this read returned 239 accounts,
-- 2,193,973.14 owed over 6,184,371 rows, equal to the rollup to the cent and
-- to the row, 0 drifted, in 90 s cold; it grows with what is owed, not with
-- history. No index is added (the write path keeps only the indexes it
-- reads, 20261003031000); the existing partial index serves every range.
--
-- AND THE TWO JOBS STOP SHARING A TRANSACTION: job 286 keeps the replay
-- (same schedule, same advisory lock, same REPEATABLE READ, same 600 s), and
-- the meter moves to its own job, ca-currency-meter-nightly at 07:20 UTC
-- with its own 600 s, so neither can roll the other back and each has its
-- own run history in cron.job_run_details. The roster
-- (docs/attestation/cron-roster.tsv) moves 133 -> 134 with this file.
--
-- periodic-work: the nightly currency meter is the product, not compensation.
-- It already runs every night inside job 286; this file only moves it to its
-- own job so a slow meter cannot roll back the ledger replay. It repairs
-- nothing: it reads the books and records one meter verdict per night.
--
-- HOW: the pinned-preimage substitution of 20261007212545. The live meter
-- must hash to its measured md5, the anchor must occur exactly once, and the
-- result must hash to the postimage derived read-only on production with
-- replace() (e58e5217... -> 183fd3ef..., measured 2026-10-15); owner,
-- SECURITY DEFINER, proconfig and grants must not move. Job 286's command
-- must hash to its measured md5 (12b1a4fb...) and becomes d241144c....
--
-- Regression: scripts/ci/test-currency-meter-reads-what-is-owed.py (native
-- PostgreSQL), run by .github/workflows/currency-meter-reads-what-is-owed.yml.
--
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_ca_currency_meter()'::regprocedure)) = '183fd3efa020fbe1fed47a692b2b63f1' AND (SELECT md5(command) FROM cron.job WHERE jobname = 'ca-ledger-replay-nightly') = 'd241144c298803f43466859c4e76f6d0' AND EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ca-currency-meter-nightly' AND active))

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

CREATE FUNCTION pg_temp.ca_meter_subst(p_sig text, p_before text, p_after text,
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

SELECT pg_temp.ca_meter_subst(
  'public.fn_ca_currency_meter()',
  'e58e52177046c958f9daacb20a63fade', '183fd3efa020fbe1fed47a692b2b63f1',
  ARRAY[$o1$  /* AGENT COMMISSIONS: every rollup against the sum of its unsettled rows. Enforced. */
  WITH u AS (SELECT club_id, user_id, sum(amount) AS owed FROM public.agent_commissions_unsettled GROUP BY 1, 2)
$o1$],
  ARRAY[$n1$  /* AGENT COMMISSIONS: every rollup against the sum of its unsettled rows. Enforced.
     ONE RANGE PER UNCOVERED GAP, ONE CUTOFF PER CLUB (2026-10-15). This read
     used to aggregate the agent_commissions_unsettled view, which calls the
     SECURITY DEFINER fn_ca_launch_accounting_accepts once per ROW (a definer
     function is never inlined) and walks every settled_at IS NULL row ever
     written, including the ones a settlement period already covers (a claim
     records what it covered, 20260908033445; it does not stamp the row).
     21 million rows on 2026-10-14, two definer calls each: the nightly job
     hit its 600 s statement_timeout. The same answer is read here per
     (club, agent): the cutoff once per club, the complement of the agent's
     settlement periods as ranges, and one index-only range scan of
     agent_commissions_open_idx per uncovered range, so the read grows with
     what is owed, not with history. Row for row it is the view's predicate:
     settled_at IS NULL, no period with start <= created_at < end, and the
     launch cutoff exactly as fn_ca_launch_accounting_accepts applies it. */
  WITH RECURSIVE pairs AS (
    (SELECT a.club_id, a.user_id FROM public.agent_commissions a
      WHERE a.settled_at IS NULL ORDER BY a.club_id, a.user_id LIMIT 1)
    UNION ALL
    SELECT n.club_id, n.user_id
      FROM pairs p
      CROSS JOIN LATERAL (
        SELECT a.club_id, a.user_id FROM public.agent_commissions a
         WHERE a.settled_at IS NULL AND (a.club_id, a.user_id) > (p.club_id, p.user_id)
         ORDER BY a.club_id, a.user_id LIMIT 1) n
  ), cut AS MATERIALIZED (
    SELECT c.club_id, public.fn_ca_launch_accounting_cutoff('club', c.club_id) AS cutoff
      FROM (SELECT DISTINCT club_id FROM pairs) c
  ), iv AS MATERIALIZED (
    SELECT s.club_id, s.user_id, s.period_start, s.period_end
      FROM public.agent_commission_settlements s
      JOIN pairs p ON p.club_id = s.club_id AND p.user_id = s.user_id
     WHERE s.period_start < s.period_end
  ), gaps AS MATERIALIZED (
    SELECT l.club_id, l.user_id, l.lo,
           (SELECT min(i.period_start) FROM iv i
             WHERE i.club_id = l.club_id AND i.user_id = l.user_id AND i.period_start > l.lo) AS hi
      FROM (SELECT p.club_id, p.user_id, '-infinity'::timestamptz AS lo FROM pairs p
            UNION
            SELECT i.club_id, i.user_id, i.period_end FROM iv i) l
     WHERE NOT EXISTS (SELECT 1 FROM iv i
                        WHERE i.club_id = l.club_id AND i.user_id = l.user_id
                          AND l.lo >= i.period_start AND l.lo < i.period_end)
  ), legs AS (
    SELECT g.club_id, g.user_id, x.owed, x.n
      FROM gaps g
      JOIN cut k ON k.club_id = g.club_id
      CROSS JOIN LATERAL (
        SELECT sum(a.amount) AS owed, count(*) AS n FROM public.agent_commissions a
         WHERE a.club_id = g.club_id AND a.user_id = g.user_id AND a.settled_at IS NULL
           AND a.created_at >= CASE WHEN k.cutoff IS NULL THEN g.lo ELSE greatest(g.lo, k.cutoff) END
           AND a.created_at <= COALESCE(g.hi, 'infinity'::timestamptz)
           AND (g.hi IS NULL OR a.created_at < g.hi)
           AND (k.cutoff IS NULL OR isfinite(a.created_at))) x
    UNION ALL
    SELECT p.club_id, p.user_id, x.owed, x.n
      FROM pairs p
      JOIN cut k ON k.club_id = p.club_id AND k.cutoff IS NULL
      CROSS JOIN LATERAL (
        SELECT sum(a.amount) AS owed, count(*) AS n FROM public.agent_commissions a
         WHERE a.club_id = p.club_id AND a.user_id = p.user_id AND a.settled_at IS NULL
           AND a.created_at IS NULL) x
  ), u AS (
    SELECT club_id, user_id, sum(owed) AS owed FROM legs GROUP BY 1, 2 HAVING sum(n) > 0
  )
$n1$]
);

DO $cron$
DECLARE
  v_job cron.job%ROWTYPE;
  v_after text;
BEGIN
  SELECT * INTO STRICT v_job FROM cron.job WHERE jobname = 'ca-ledger-replay-nightly';
  IF v_job.schedule <> '40 6 * * *' OR v_job.active IS DISTINCT FROM true
     OR md5(v_job.command) <> '12b1a4fb66380fb2d6e9b80d55bed439' THEN
    RAISE EXCEPTION 'ca-ledger-replay-nightly is not the pinned preimage (md5 %)', md5(v_job.command);
  END IF;
  IF (length(v_job.command) - length(replace(v_job.command, E'\n          SELECT public.fn_ca_currency_meter();', '')))
       / length(E'\n          SELECT public.fn_ca_currency_meter();') <> 1 THEN
    RAISE EXCEPTION 'ca-ledger-replay-nightly meter anchor count differs';
  END IF;
  v_after := replace(v_job.command, E'\n          SELECT public.fn_ca_currency_meter();', '');
  IF md5(v_after) <> 'd241144c298803f43466859c4e76f6d0' THEN
    RAISE EXCEPTION 'ca-ledger-replay-nightly postimage %', md5(v_after);
  END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ca-currency-meter-nightly') THEN
    RAISE EXCEPTION 'ca-currency-meter-nightly already exists';
  END IF;

  PERFORM cron.alter_job(v_job.jobid, command := v_after);
  PERFORM cron.schedule(
    'ca-currency-meter-nightly',
    '20 7 * * *',
    $job$SET statement_timeout = '600s'; SELECT public.fn_ca_currency_meter();$job$);

  IF (SELECT to_jsonb(j) - 'command' FROM cron.job j WHERE j.jobid = v_job.jobid)
       IS DISTINCT FROM (to_jsonb(v_job) - 'command') THEN
    RAISE EXCEPTION 'ca-ledger-replay-nightly changed beyond its command';
  END IF;
  IF (SELECT count(*) FROM cron.job WHERE command LIKE '%fn_ca_currency_meter()%') <> 1 THEN
    RAISE EXCEPTION 'the meter must run from exactly one job';
  END IF;
END
$cron$;

COMMIT;
