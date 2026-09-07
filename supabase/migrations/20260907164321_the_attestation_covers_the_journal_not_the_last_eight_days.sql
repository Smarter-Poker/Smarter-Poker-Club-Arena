-- THE ATTESTATION COVERS THE JOURNAL, NOT THE LAST EIGHT DAYS.
--
-- Phase 6 follow-up, written by the deep dive over the work phase 6 landed a
-- few hours earlier (migration 20260907161921). Two defects in that work, both
-- of the shape CLAUDE.md 10.86 is about: a signal that answers confidently
-- about a scope nobody stated.
--
-- ---------------------------------------------------------------------------
-- DEFECT 1: "8 days checked, 0 drifted" reads as "the journal is intact".
--
-- Measured on 2026-09-07. `chip_ledger` holds legs on 35 days before today.
-- Eight of them carry a manifest (2026-08-30 .. 2026-09-06). The other
-- TWENTY-SEVEN - 2026-03-19 through 2026-08-29, 176,140 legs, 8.8% of the
-- journal - are attested by nothing, and never would be:
--
--   * `fn_ca_ledger_day_manifest` only ever examines CURRENT_DATE - 1, so it
--     cannot reach backwards;
--   * `fn_ca_ledger_day_manifest_verify_all` iterates the MANIFESTS, so a day
--     with no manifest is not an unchecked day to it - it is not a day at all.
--
-- The verifier therefore returned {"checked": 8, "drifted": 0} while 27 days of
-- real money movement sat outside every guard on this platform, and the answer
-- contained nothing that would let a reader notice. That is the same failure
-- phase 6 was written to fix - an attestation that looks like coverage - one
-- level up.
--
-- FIXED AT THE ROOT (10.11): the writer gains a backfill so coverage follows
-- the JOURNAL rather than the date the cron happened to start, and the
-- verifier now counts the days it did NOT check and says so in its own answer.
-- After this migration a day with rows and no manifest is a reported incident,
-- not an invisible hole.
--
-- ---------------------------------------------------------------------------
-- DEFECT 2: the verifier cost was O(days x journal), and Dan ruled the journal
-- is kept for ever.
--
-- Measured, not guessed. `fn_ca_ledger_day_manifest_verify_all` opened one
-- sequential scan of `chip_ledger` PER DAY: 9,463 ms for eight days, 1.18 s
-- each, on a 2,004,587-row table with no index on `created_at` alone. At 35
-- days that is 41 s; at a year of retention it is seven minutes and climbing,
-- for a job with a statement timeout. It would not have failed loudly - it
-- would have got slower until something killed it, and a verification that
-- stops running is indistinguishable from one that finds nothing.
--
-- The recompute is now ONE pass with GROUP BY, so the cost is proportional to
-- the journal and no longer multiplied by the number of days retained. The
-- distinct-day pass alone measured 735 ms.
--
-- WHAT IS DELIBERATELY UNCHANGED: the hash expression. There are exactly two
-- copies of it - the writer's and the verifier's - and
-- `tests/an-attestation-nobody-re-reads-is-a-photograph.law.test.ts` pins that
-- they are identical, because a pair that disagrees would report drift on a
-- journal neither had touched. The backfill below adds no third copy: it calls
-- the writer, which stays the only place a manifest row is ever composed.
--
-- WHAT AN ANCHORED DAY DOES AND DOES NOT PROVE, since this migration attests
-- 27 historical days at once and that is easy to over-read. Hashing 2026-03-24
-- today proves nothing about what that day held in March. It proves that from
-- today onward that day cannot change without the change being visible - in
-- the database by this verifier, and outside it by
-- `docs/attestation/chip-ledger-days.tsv`, which git owns. That is the whole
-- claim, and `docs/attestation/README.md` says so in those words.

BEGIN;

SET LOCAL lock_timeout = '4s';
SET LOCAL statement_timeout = '270s';

-- ---------------------------------------------------------------------------
-- 1. THE BACKFILL. Every day the journal has, that nothing has attested.
--
--    It composes no manifest itself - it calls the writer, once per missing
--    day. That is what keeps the number of places that know how to hash a day
--    at two, and it is why the backfill cannot drift away from the daily job.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_ledger_day_manifest_backfill(p_since date DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  r          record;
  v_done     int   := 0;
  v_days     jsonb := '[]'::jsonb;
  v_res      jsonb;
BEGIN
  /* Days with rows, finished (never today - a partial day would be attested
     wrong and then disagree with itself at midnight), and unattested. */
  FOR r IN
    SELECT d.day
      FROM (SELECT DISTINCT created_at::date AS day
              FROM public.chip_ledger
             WHERE created_at < CURRENT_DATE
               AND (p_since IS NULL OR created_at >= p_since)) d
     WHERE NOT EXISTS (SELECT 1 FROM public.ca_ledger_day_manifests m WHERE m.day = d.day)
     ORDER BY d.day
  LOOP
    v_res  := public.fn_ca_ledger_day_manifest(r.day);
    v_done := v_done + 1;
    v_days := v_days || jsonb_build_object('day', r.day, 'rows', v_res->'rows');
  END LOOP;

  RETURN jsonb_build_object('attested', v_done, 'days', v_days,
                            'since', COALESCE(p_since::text, 'the whole journal'));
END $function$;

COMMENT ON FUNCTION public.fn_ca_ledger_day_manifest_backfill(date) IS
  'Attests every finished day the journal has that carries no manifest, by calling fn_ca_ledger_day_manifest for each. Exists because that writer only ever examines CURRENT_DATE - 1, so 27 days of real money movement (2026-03-19..2026-08-29) were outside every guard until 2026-09-07. Composes no manifest of its own: there are exactly two places that know how to hash a day, and this is not one of them.';

REVOKE ALL ON FUNCTION public.fn_ca_ledger_day_manifest_backfill(date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_ledger_day_manifest_backfill(date) TO postgres, service_role;

-- ---------------------------------------------------------------------------
-- 2. THE VERIFIER. One pass, and it reports what it could NOT check.
--
--    FULL JOIN, not a loop over either side, because both directions are real
--    failures: a manifest whose day has lost all its rows is as much a drift
--    as a day whose rows changed, and a day of rows with no manifest is the
--    hole this migration exists to close.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_ledger_day_manifest_verify_all()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  r            record;
  v_checked    int   := 0;
  v_drifted    int   := 0;
  v_unattested int   := 0;
  v_days       jsonb := '[]'::jsonb;
  v_missing    jsonb := '[]'::jsonb;
  v_t0         timestamptz := clock_timestamp();
BEGIN
  FOR r IN
    /* ONE pass over the journal for every day at once. This used to be one
       sequential scan PER DAY - 1.18 s each, measured - which made the cost of
       verifying grow with the retention Dan chose on 2026-09-07 ("keep every
       leg for ever"). A verification that gets slower until it is killed is
       indistinguishable from one that finds nothing. */
    WITH actual AS (
      SELECT created_at::date AS day,
             count(*) AS row_count,
             /* The same expression fn_ca_ledger_day_manifest uses. If that one
                changes, this must change with it, or the pair will disagree
                about a journal neither has touched. */
             encode(extensions.digest(
               COALESCE(string_agg(
                 id::text || '|' || amount::text || '|' || from_type || ':' || COALESCE(from_entity_id::text,'') ||
                 '>' || to_type || ':' || COALESCE(to_entity_id::text,'') || '|' || category || '|' ||
                 extract(epoch from created_at)::text || '|' || COALESCE(row_hash,''),
                 E'\n' ORDER BY created_at, id), ''), 'sha256'), 'hex') AS sha
        FROM public.chip_ledger
       WHERE created_at < CURRENT_DATE
       GROUP BY 1
    )
    SELECT COALESCE(a.day, m.day)  AS day,
           a.day IS NOT NULL       AS has_rows,
           m.day IS NOT NULL       AS has_manifest,
           COALESCE(a.row_count,0) AS actual_rows,
           m.row_count             AS stored_rows,
           a.sha                   AS actual_sha,
           m.sha256                AS stored_sha
      FROM actual a
      FULL JOIN public.ca_ledger_day_manifests m ON m.day = a.day
     ORDER BY 1
  LOOP
    IF NOT r.has_manifest THEN
      /* A day of real money movement that nothing has attested. Before
         2026-09-07 this was not reported at all, because the verifier walked
         the manifests and a day without one simply did not exist to it. */
      v_unattested := v_unattested + 1;
      v_missing := v_missing || jsonb_build_object('day', r.day, 'rows', r.actual_rows);
      CONTINUE;
    END IF;

    v_checked := v_checked + 1;

    IF r.actual_sha IS DISTINCT FROM r.stored_sha THEN
      v_drifted := v_drifted + 1;
      v_days := v_days || jsonb_build_object(
        'day', r.day, 'stored_rows', r.stored_rows, 'actual_rows', r.actual_rows,
        'stored_sha', r.stored_sha, 'recomputed_sha', r.actual_sha,
        'rows_present', r.has_rows);

      PERFORM public.fn_ca_raise_drift_incident(
        'fn_ca_ledger_day_manifest_verify_all', 'unauthorized_adjustment', 'critical',
        'manifest-mismatch:' || r.day::text,
        0, NULL, NULL, 'ledger', 'ca_ledger_day_manifests',
        NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
        'the ledger manifest for ' || r.day || ' no longer matches the journal: '
          || r.stored_rows || ' rows attested, ' || r.actual_rows || ' present. If this was sanctioned '
          || 'maintenance, restate the manifest (ca_ledger_day_manifest_restatements) and say why; '
          || 'the rows themselves are in ca_ledger_mutation_log.',
        false,
        jsonb_build_object('day', r.day, 'stored_rows', r.stored_rows, 'actual_rows', r.actual_rows,
                           'stored', r.stored_sha, 'recomputed', r.actual_sha));
    END IF;
  END LOOP;

  IF v_unattested > 0 THEN
    /* Not folded into `drifted`. They are different facts and a reader has to
       be able to tell them apart: drifted means a day changed, unattested
       means a day was never looked at. */
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_ledger_day_manifest_verify_all', 'unauthorized_adjustment', 'critical',
      'manifest-unattested-days',
      0, NULL, NULL, 'ledger', 'ca_ledger_day_manifests',
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      v_unattested || ' day(s) of chip_ledger carry no manifest at all, so nothing is '
        || 'verifying them. fn_ca_ledger_day_manifest_backfill() attests every finished day '
        || 'the journal has, and the daily job calls it, so seeing this means that call did not '
        || 'run or could not write.',
      false, jsonb_build_object('unattested', v_unattested, 'days', v_missing));
  END IF;

  RETURN jsonb_build_object(
    'checked', v_checked, 'drifted', v_drifted, 'days', v_days,
    /* The coverage travels WITH the answer. "0 drifted" on its own was the
       defect this migration was written for. */
    'unattested', v_unattested, 'unattested_days', v_missing,
    'ms', round(extract(epoch from (clock_timestamp() - v_t0)) * 1000));
END $function$;

COMMENT ON FUNCTION public.fn_ca_ledger_day_manifest_verify_all() IS
  'Recomputes every attested day of chip_ledger in ONE pass and compares it to its manifest, and counts the finished days that have NO manifest so that "0 drifted" can never again read as full coverage. Raises a critical drift incident for each mismatch and one for any unattested day.';

REVOKE ALL ON FUNCTION public.fn_ca_ledger_day_manifest_verify_all() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_ledger_day_manifest_verify_all() TO postgres, service_role;

-- ---------------------------------------------------------------------------
-- 3. THE ONE-TIME CATCH-UP. 27 days that nothing has ever attested.
-- ---------------------------------------------------------------------------
DO $backfill$
DECLARE v jsonb;
BEGIN
  v := public.fn_ca_ledger_day_manifest_backfill();
  RAISE NOTICE 'BACKFILL attested % previously unattested day(s)', v->>'attested';
END $backfill$;

-- ---------------------------------------------------------------------------
-- 4. THE DAILY JOB DOES THE CATCH-UP TOO.
--
--    Still no new scheduled trigger anywhere (CLAUDE.md 10.85): the same job
--    that has run at 04:25 since the manifests existed. A day the cron misses
--    is now filled in by the next run instead of becoming a permanent hole.
-- ---------------------------------------------------------------------------
DO $cron$
DECLARE v_id bigint;
BEGIN
  SELECT jobid INTO v_id FROM cron.job WHERE jobname = 'ca-ledger-day-manifest';
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'ABORT: the ca-ledger-day-manifest job is gone; the verification has no schedule to ride';
  END IF;
  PERFORM cron.alter_job(v_id,
    command => 'SELECT public.fn_ca_ledger_day_manifest(); SELECT public.fn_ca_ledger_day_manifest_backfill(); SELECT public.fn_ca_ledger_day_manifest_verify_all();');
END $cron$;

-- ---------------------------------------------------------------------------
-- 5. PROVE IT, and abort if any of it is untrue.
-- ---------------------------------------------------------------------------
DO $verify$
DECLARE
  v_result      jsonb;
  v_unattested  bigint;
  v_days_rows   bigint;
  v_attested    bigint;
  v_cmd         text;
  v_writer      text;
  v_verifier    text;
  v_wexpr       text;
  v_vexpr       text;
BEGIN
  /* a. Every finished day the journal has now carries a manifest. */
  SELECT count(*) INTO v_unattested
    FROM (SELECT DISTINCT created_at::date AS day FROM public.chip_ledger WHERE created_at < CURRENT_DATE) d
   WHERE NOT EXISTS (SELECT 1 FROM public.ca_ledger_day_manifests m WHERE m.day = d.day);
  IF v_unattested <> 0 THEN
    RAISE EXCEPTION 'VERIFY FAILED: % finished day(s) still carry no manifest after the backfill', v_unattested;
  END IF;

  SELECT count(*) INTO v_days_rows
    FROM (SELECT DISTINCT created_at::date FROM public.chip_ledger WHERE created_at < CURRENT_DATE) d;
  SELECT count(*) INTO v_attested FROM public.ca_ledger_day_manifests;
  IF v_attested <> v_days_rows THEN
    RAISE EXCEPTION 'VERIFY FAILED: % attested day(s) against % day(s) with rows - a manifest names a day the journal does not have',
      v_attested, v_days_rows;
  END IF;

  /* b. The verifier agrees with every one of them, and says so in its answer. */
  v_result := public.fn_ca_ledger_day_manifest_verify_all();
  IF (v_result->>'drifted')::int <> 0 THEN
    RAISE EXCEPTION 'VERIFY FAILED: % day(s) drifted: %', v_result->>'drifted', v_result->>'days';
  END IF;
  IF (v_result->>'unattested')::int <> 0 THEN
    RAISE EXCEPTION 'VERIFY FAILED: the verifier reports % unattested day(s) it cannot check: %',
      v_result->>'unattested', v_result->>'unattested_days';
  END IF;
  IF (v_result->>'checked')::int <> v_days_rows THEN
    RAISE EXCEPTION 'VERIFY FAILED: the verifier checked % of % day(s)', v_result->>'checked', v_days_rows;
  END IF;
  IF v_result->'unattested' IS NULL THEN
    RAISE EXCEPTION 'VERIFY FAILED: the verifier answer carries no coverage, which is the defect this migration was written for';
  END IF;

  /* c. The writer and the verifier still hash exactly the same thing. Read
        from the catalogue, not from this file - what is deployed is what
        matters, and a third copy of the expression is how the pair drifts. */
  v_writer   := pg_get_functiondef('public.fn_ca_ledger_day_manifest(date)'::regprocedure);
  v_verifier := pg_get_functiondef('public.fn_ca_ledger_day_manifest_verify_all()'::regprocedure);
  v_wexpr := regexp_replace(substring(v_writer   from 'encode\(extensions\.digest\(.*?''sha256''\), ''hex''\)'), '\s+', '', 'g');
  v_vexpr := regexp_replace(
               regexp_replace(substring(v_verifier from 'encode\(extensions\.digest\(.*?''sha256''\), ''hex''\)'), '/\*.*?\*/', '', 'g'),
               '\s+', '', 'g');
  IF v_wexpr IS NULL OR v_vexpr IS NULL THEN
    RAISE EXCEPTION 'VERIFY FAILED: the hash expression could not be read out of one of the two functions';
  END IF;
  IF v_wexpr <> v_vexpr THEN
    RAISE EXCEPTION 'VERIFY FAILED: the writer and the verifier no longer hash the same thing';
  END IF;

  /* d. The daily job runs all three, and still on the schedule it already had. */
  SELECT command INTO v_cmd FROM cron.job WHERE jobname = 'ca-ledger-day-manifest';
  IF v_cmd NOT LIKE '%fn_ca_ledger_day_manifest_backfill%' THEN
    RAISE EXCEPTION 'VERIFY FAILED: the daily job does not call the backfill';
  END IF;
  IF v_cmd NOT LIKE '%fn_ca_ledger_day_manifest_verify_all%' THEN
    RAISE EXCEPTION 'VERIFY FAILED: extending the job dropped the verification it already did';
  END IF;
  IF v_cmd NOT LIKE '%fn_ca_ledger_day_manifest()%' THEN
    RAISE EXCEPTION 'VERIFY FAILED: extending the job dropped the manifest write it already did';
  END IF;

  /* e. Neither function became reachable from a browser. */
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace,
         LATERAL aclexplode(p.proacl) a
     WHERE n.nspname = 'public'
       AND p.proname IN ('fn_ca_ledger_day_manifest_backfill','fn_ca_ledger_day_manifest_verify_all')
       AND a.privilege_type = 'EXECUTE'
       AND a.grantee IN (0, (SELECT oid FROM pg_roles WHERE rolname='anon'),
                            (SELECT oid FROM pg_roles WHERE rolname='authenticated'))) THEN
    RAISE EXCEPTION 'VERIFY FAILED: a manifest function is executable by a browser role';
  END IF;

  RAISE NOTICE 'THE_ATTESTATION_COVERS_THE_JOURNAL % day(s) with rows, % attested, % checked, 0 drifted, 0 unattested, one pass in % ms; the daily job backfills before it verifies',
    v_days_rows, v_attested, v_result->>'checked', v_result->>'ms';
END $verify$;

COMMIT;
