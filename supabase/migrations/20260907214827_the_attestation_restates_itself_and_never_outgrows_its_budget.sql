-- 20260907213447_the_attestation_restates_itself_and_never_outgrows_its_budge.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- THE DEEP DIVE OVER PHASE 6 (roadmap 9.2 / 9.4), 2026-09-07 evening.
-- Everything below was MEASURED on production before it was written.
--
-- Phase 6 shipped in two pull requests today (#3456, #3463). This is the deep
-- dive Dan requires before phase 7 opens, and it found four defects in that
-- work. Each one is the shape CLAUDE.md 10.86 names - a guard that answers
-- confidently about a scope nobody stated - and each is fixed here at the root
-- (10.11), not detected and left for a person.
--
-- 1. A SANCTIONED CHANGE TO AN ATTESTED DAY WAS STILL A DETECTOR PLUS A HUMAN.
--    The maintenance path (app.ledger_maintenance -> fn_ca_journal_append_only
--    -> ca_ledger_mutation_log) is allowed to remove legs from a day that
--    already carries a manifest. Phase 6 made sure that is NOTICED - the
--    verifier raises a critical incident at 04:25 - and then a person has to
--    hand-write a row in ca_ledger_day_manifest_restatements, exactly the way
--    2026-08-31 was fixed by hand in migration 20260907161921. Dan's ruling on
--    this programme: "I DON'T JUST WANT IT FLAGGED AND RECONCILED, I WANT THEM
--    FIXED AT THE ROOT CAUSE." So the restatement now happens IN THE SAME
--    TRANSACTION as the maintenance that caused it: a statement-level trigger
--    on chip_ledger re-attests every affected day through the writer, with the
--    maintenance reason as the restatement reason and the old sha kept. The
--    manifest can no longer be wrong for even one second after a sanctioned
--    change, and a person no longer has to remember to write a row.
--
--    And the manifest tables themselves had no guard at all: any service-role
--    session could UPDATE a sha or DELETE a manifest with nothing recording
--    it. Now a manifest is RESTATED, never edited: a change to any attested
--    field is refused unless it comes through the writer, and when it does the
--    guard itself writes the restatement row - so a restatement exists BY
--    CONSTRUCTION for every change, not by convention. Restatements are
--    append-only. A manifest cannot be deleted, and a day cannot be restated
--    to zero rows (a maintenance statement that would empty an attested day
--    is refused whole).
--
-- 2. THE VERIFIER'S COST WAS STILL O(JOURNAL) AGAINST A 2-MINUTE TIMEOUT.
--    #3463 replaced one scan per day with one pass over the whole table -
--    11,683 ms at 04:25 - and called that flat. It is flat in DAYS. It is
--    linear in the JOURNAL, which Dan ruled the same day is kept for ever and
--    which grew 263,705 legs on 2026-09-06 alone. Measured this evening under
--    ordinary load: 53,513 ms. The cron runs as `postgres`, whose
--    statement_timeout is 2 minutes. At the September rate the pass crosses
--    that in roughly ten weeks, and from that night on the verifier fails
--    every morning and "a verification that has stopped running looks exactly
--    like one that finds nothing" - #3463's own sentence.
--
--    The root cause underneath is that chip_ledger had no index on created_at
--    alone. Every per-day read - the daily writer included - was planned as a
--    filter over the whole (club_id, created_at) index: 30,124 ms to read the
--    24,107 legs of 2026-08-30. With idx_chip_ledger_created_at (built
--    CONCURRENTLY before this migration, so no write was ever blocked - it is
--    recorded here idempotently) the same read is 1,558 ms, and the set of
--    distinct days in the journal is a loose index scan: 124 ms for 37 days,
--    proportional to DAYS, not legs.
--
--    With that, the verifier stops re-reading the whole journal every night
--    and instead re-reads days on a ROTATION under a WALL-CLOCK BUDGET
--    (60 s by default, half the timeout): least-recently-checked first, every
--    manifest stamped last_checked_at when it is re-read. The nightly cost is
--    now bounded by the budget, not by the size of the journal, and there is
--    no cliff. What replaces the cliff is a NUMBER: the answer carries
--    `oldest_check_age_days`, and a warning incident is raised when any day
--    has gone more than 30 days without being re-read - measured basis: the
--    whole journal (35 days, 2.18M legs) re-reads in about two nights today,
--    so 30 days is fifteen-fold headroom, and when it fires the decision is
--    Dan's (a bigger budget or a longer rotation), made on a number rather
--    than on a job that silently died.
--
--    The DAILY protection does not weaken: the maintenance trigger above is
--    what catches a sanctioned change the moment it happens, and an
--    UNSANCTIONED change cannot happen at all (fn_ca_journal_append_only
--    refuses it). The rotation is the net under that, and it says how wide its
--    mesh is.
--
-- 3. THE DAY BOUNDARY DEPENDED ON WHO WAS ASKING. created_at is timestamptz,
--    and every `created_at::date` and `created_at >= p_day` in these functions
--    is evaluated in the SESSION's TimeZone. The server is UTC and no role
--    overrides it, so nothing has gone wrong - but a caller with a different
--    TimeZone would have hashed different rows into the same day, raised a
--    false critical incident and, after this migration, written a false
--    restatement. Every function here now pins `timezone = 'UTC'`. A day is a
--    UTC day; that is now written down in the catalogue, not assumed.
--
-- 4. (in the same pull request, outside this file) THE ANCHOR'S APPEND PATH
--    HAD NEVER WORKED. The workflow step that carries a new day's line into
--    git pushes with GITHUB_TOKEN and calls `gh pr create` - and github-actions
--    has opened ZERO pull requests in this repository, ever (the refresh job
--    in the same file says why in a comment). So every day after the 35 an
--    agent pushed by hand would have been appended to a branch nobody sees,
--    for ever, while the job stayed green. It now mints the estate's own App
--    token, the same way agent-open-pr.yml does, so the branch push fires the
--    machinery that opens and merges every other pull request here. And the
--    script's REST reads had no pagination guard: PostgREST caps a response at
--    1,000 rows, which is one line a day for under three years, after which
--    days would silently stop being anchored. It now asks for the exact count
--    and refuses a truncated answer.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

-- ---------------------------------------------------------------------------
-- 0. The index. Built with CREATE INDEX CONCURRENTLY at 21:31 UTC on
--    2026-09-07 (41 MB, valid) so that no writer to chip_ledger was ever
--    blocked; a plain CREATE INDEX here would take a SHARE lock on a table the
--    engine writes ~500 times a minute, against an 8 s lock_timeout on the
--    engine's role. IF NOT EXISTS makes this a no-op on production and the
--    real build anywhere the index is missing.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_chip_ledger_created_at
  ON public.chip_ledger USING btree (created_at);

-- ---------------------------------------------------------------------------
-- 1. The manifest remembers when it was last re-read, and when it was
--    restated. Both are bookkeeping, not attested fields: the guard below lets
--    them change freely and refuses everything else.
-- ---------------------------------------------------------------------------
ALTER TABLE public.ca_ledger_day_manifests
  ADD COLUMN IF NOT EXISTS last_checked_at timestamptz,
  ADD COLUMN IF NOT EXISTS restated_at     timestamptz;

COMMENT ON COLUMN public.ca_ledger_day_manifests.last_checked_at IS
  'When this day was last re-read from chip_ledger and compared with the stored sha (by the writer or by the rotation in fn_ca_ledger_day_manifest_verify_all). NULL = never re-read since it was written.';
COMMENT ON COLUMN public.ca_ledger_day_manifests.restated_at IS
  'When the attested fields last changed. Every change has a row in ca_ledger_day_manifest_restatements, written by the guard, not by convention.';

ALTER TABLE public.ca_ledger_day_manifest_restatements
  ADD COLUMN IF NOT EXISTS restated_by text,
  ADD COLUMN IF NOT EXISTS application text;

-- ---------------------------------------------------------------------------
-- 2. A manifest is restated, never edited. A restatement is never edited.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_manifest_is_restated_not_edited()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET timezone = 'UTC'
AS $fn$
DECLARE
  v_reason text := NULLIF(current_setting('app.manifest_restatement', true), '');
  v_changed boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'DELETE on ca_ledger_day_manifests is forbidden: an attested day stays attested. If its rows legitimately changed, restate it through fn_ca_ledger_day_manifest(day, reason).'
      USING ERRCODE = 'P0403';
  END IF;

  v_changed :=
       NEW.sha256     IS DISTINCT FROM OLD.sha256
    OR NEW.row_count  IS DISTINCT FROM OLD.row_count
    OR NEW.first_seq  IS DISTINCT FROM OLD.first_seq
    OR NEW.last_seq   IS DISTINCT FROM OLD.last_seq
    OR NEW.net_amount IS DISTINCT FROM OLD.net_amount
    OR NEW.day        IS DISTINCT FROM OLD.day;

  IF NOT v_changed THEN
    RETURN NEW;                       -- bookkeeping only (last_checked_at)
  END IF;

  IF NEW.day IS DISTINCT FROM OLD.day THEN
    RAISE EXCEPTION 'a manifest cannot be moved to another day' USING ERRCODE = 'P0403';
  END IF;

  IF v_reason IS NULL THEN
    RAISE EXCEPTION
      'UPDATE of an attested field on ca_ledger_day_manifests (%) is forbidden: a manifest is restated, never edited. Call fn_ca_ledger_day_manifest(day, reason), which keeps the old value.',
      OLD.day
      USING ERRCODE = 'P0403';
  END IF;

  /* The restatement exists by construction. Nobody has to remember. */
  INSERT INTO public.ca_ledger_day_manifest_restatements
    (day, old_row_count, new_row_count, old_sha256, new_sha256, reason, restated_by, application)
  VALUES
    (OLD.day, OLD.row_count, NEW.row_count, OLD.sha256, NEW.sha256, v_reason,
     current_user, current_setting('application_name', true));

  NEW.restated_at := now();
  RETURN NEW;
END $fn$;

REVOKE ALL ON FUNCTION public.fn_ca_manifest_is_restated_not_edited() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS zz_ca_manifest_is_restated_not_edited ON public.ca_ledger_day_manifests;
CREATE TRIGGER zz_ca_manifest_is_restated_not_edited
  BEFORE UPDATE OR DELETE ON public.ca_ledger_day_manifests
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_manifest_is_restated_not_edited();

CREATE OR REPLACE FUNCTION public.fn_ca_restatement_is_append_only()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  RAISE EXCEPTION
    '% on ca_ledger_day_manifest_restatements is forbidden: the record of a restatement is append-only.',
    TG_OP
    USING ERRCODE = 'P0403';
END $fn$;

REVOKE ALL ON FUNCTION public.fn_ca_restatement_is_append_only() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS zz_ca_restatement_is_append_only ON public.ca_ledger_day_manifest_restatements;
CREATE TRIGGER zz_ca_restatement_is_append_only
  BEFORE UPDATE OR DELETE ON public.ca_ledger_day_manifest_restatements
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_restatement_is_append_only();

-- ---------------------------------------------------------------------------
-- 3. The writer. Same hash expression as before, character for character
--    (the verifier below carries the other copy, and the DO block re-proves
--    them equal from the catalogue). New: a restatement mode, a UTC pin, and
--    the day is stamped last_checked_at whenever it is read and agrees.
--
--    The (date) overload is dropped first: with two overloads whose parameters
--    all default, `fn_ca_ledger_day_manifest()` - the cron's call - would be
--    ambiguous.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.fn_ca_ledger_day_manifest(date);

CREATE FUNCTION public.fn_ca_ledger_day_manifest(
  p_day            date DEFAULT (CURRENT_DATE - 1),
  p_restate_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET timezone = 'UTC'
AS $fn$
DECLARE v_count bigint; v_net numeric; v_first bigint; v_last bigint; v_sha text; v_prior text; v_prior_rows bigint;
BEGIN
  /* One index range over idx_chip_ledger_created_at: the cost is this day's
     legs, not the journal's. A day is a UTC day (SET timezone above). */
  SELECT count(*), COALESCE(sum(amount), 0), min(chain_seq), max(chain_seq),
         encode(extensions.digest(
           COALESCE(string_agg(
             id::text || '|' || amount::text || '|' || from_type || ':' || COALESCE(from_entity_id::text,'') ||
             '>' || to_type || ':' || COALESCE(to_entity_id::text,'') || '|' || category || '|' ||
             extract(epoch from created_at)::text || '|' || COALESCE(row_hash,''),
             E'\n' ORDER BY created_at, id), ''), 'sha256'), 'hex')
    INTO v_count, v_net, v_first, v_last, v_sha
    FROM public.chip_ledger
   WHERE created_at >= p_day AND created_at < p_day + 1;

  SELECT sha256, row_count INTO v_prior, v_prior_rows
    FROM public.ca_ledger_day_manifests WHERE day = p_day;

  IF v_prior IS NULL THEN
    IF v_count = 0 THEN
      /* Nothing to attest and nothing attested: not a manifest, not an error. */
      RETURN jsonb_build_object('day', p_day, 'rows', 0, 'attested', false, 'tampered', false);
    END IF;
    INSERT INTO public.ca_ledger_day_manifests
      (day, row_count, first_seq, last_seq, net_amount, sha256, last_checked_at)
    VALUES (p_day, v_count, v_first, v_last, v_net, v_sha, now())
    ON CONFLICT (day) DO NOTHING;
    RETURN jsonb_build_object('day', p_day, 'rows', v_count, 'net', v_net,
      'first_seq', v_first, 'last_seq', v_last, 'sha256', v_sha, 'tampered', false, 'restated', false);
  END IF;

  IF v_prior = v_sha THEN
    /* Read and agreed: that is a verification, so say when it happened. */
    UPDATE public.ca_ledger_day_manifests SET last_checked_at = now() WHERE day = p_day;
    RETURN jsonb_build_object('day', p_day, 'rows', v_count, 'net', v_net,
      'first_seq', v_first, 'last_seq', v_last, 'sha256', v_sha, 'tampered', false, 'restated', false);
  END IF;

  /* The stored attestation and the journal disagree. */
  IF p_restate_reason IS NULL THEN
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_ledger_day_manifest', 'unauthorized_adjustment', 'critical',
      'manifest-mismatch:' || p_day::text,
      0, NULL, NULL, 'ledger', 'ca_ledger_day_manifests',
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      'the recomputed ledger manifest for ' || p_day || ' no longer matches the stored one - historical rows changed',
      false, jsonb_build_object('day', p_day, 'stored', v_prior, 'recomputed', v_sha,
                                'stored_rows', v_prior_rows, 'actual_rows', v_count));
    RETURN jsonb_build_object('day', p_day, 'tampered', true, 'stored', v_prior, 'recomputed', v_sha,
                              'stored_rows', v_prior_rows, 'actual_rows', v_count);
  END IF;

  IF v_count = 0 THEN
    /* A day that was attested cannot become a day that never happened. The
       statement that would empty it is refused whole. */
    RAISE EXCEPTION
      'refusing to restate % to zero rows (it attested % rows): an attested day cannot be emptied. Reason offered: %',
      p_day, v_prior_rows, p_restate_reason
      USING ERRCODE = 'P0403';
  END IF;

  /* Open the guard for exactly this update, in this transaction only. The
     guard writes the restatement row itself, old value kept. */
  PERFORM set_config('app.manifest_restatement', p_restate_reason, true);
  UPDATE public.ca_ledger_day_manifests
     SET row_count = v_count, first_seq = v_first, last_seq = v_last,
         net_amount = v_net, sha256 = v_sha, last_checked_at = now()
   WHERE day = p_day;
  PERFORM set_config('app.manifest_restatement', '', true);

  RETURN jsonb_build_object('day', p_day, 'rows', v_count, 'net', v_net,
    'first_seq', v_first, 'last_seq', v_last, 'sha256', v_sha, 'tampered', false,
    'restated', true, 'old_sha256', v_prior, 'old_rows', v_prior_rows, 'reason', p_restate_reason);
END $fn$;

REVOKE ALL ON FUNCTION public.fn_ca_ledger_day_manifest(date, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_ledger_day_manifest(date, text) TO service_role;

-- ---------------------------------------------------------------------------
-- 4. A sanctioned change to an attested day restates it in the same
--    transaction. Statement-level, with transition tables, so a maintenance
--    DELETE of 4,317 legs across two days (2026-09-01 14:34, the real case)
--    costs two per-day re-reads, not 4,317 trigger calls.
--
--    It does nothing unless app.ledger_maintenance is set - the only way a
--    DELETE, or an UPDATE of a hashed field, gets past fn_ca_journal_append_only
--    in the first place - so it costs the hot path exactly one GUC read on the
--    UPDATEs that trigger permits without it (none observed: n_tup_upd = 0).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_attested_day_is_restated()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET timezone = 'UTC'
AS $fn$
DECLARE
  v_reason text := NULLIF(current_setting('app.ledger_maintenance', true), '');
  r record;
  v_res jsonb;
BEGIN
  IF v_reason IS NULL THEN
    RETURN NULL;
  END IF;

  IF TG_OP = 'DELETE' THEN
    FOR r IN
      SELECT DISTINCT o.created_at::date AS day
        FROM old_rows o
        JOIN public.ca_ledger_day_manifests m ON m.day = o.created_at::date
       ORDER BY 1
    LOOP
      v_res := public.fn_ca_ledger_day_manifest(r.day, 'maintenance:' || v_reason);
      IF COALESCE((v_res->>'tampered')::boolean, false) THEN
        RAISE EXCEPTION 'the manifest for % could not be restated after maintenance "%": %', r.day, v_reason, v_res
          USING ERRCODE = 'P0403';
      END IF;
    END LOOP;
  ELSE
    FOR r IN
      SELECT DISTINCT d.day
        FROM (SELECT created_at::date AS day FROM old_rows
              UNION
              SELECT created_at::date FROM new_rows) d
        JOIN public.ca_ledger_day_manifests m ON m.day = d.day
       ORDER BY 1
    LOOP
      v_res := public.fn_ca_ledger_day_manifest(r.day, 'maintenance:' || v_reason);
      IF COALESCE((v_res->>'tampered')::boolean, false) THEN
        RAISE EXCEPTION 'the manifest for % could not be restated after maintenance "%": %', r.day, v_reason, v_res
          USING ERRCODE = 'P0403';
      END IF;
    END LOOP;
  END IF;

  RETURN NULL;
END $fn$;

REVOKE ALL ON FUNCTION public.fn_ca_attested_day_is_restated() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS zz_ca_attested_day_is_restated_del ON public.chip_ledger;
CREATE TRIGGER zz_ca_attested_day_is_restated_del
  AFTER DELETE ON public.chip_ledger
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.fn_ca_attested_day_is_restated();

DROP TRIGGER IF EXISTS zz_ca_attested_day_is_restated_upd ON public.chip_ledger;
CREATE TRIGGER zz_ca_attested_day_is_restated_upd
  AFTER UPDATE ON public.chip_ledger
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.fn_ca_attested_day_is_restated();

-- ---------------------------------------------------------------------------
-- 5. The days the journal has: a loose index scan, O(days). Shared by the
--    backfill and the verifier so that "which days exist" has one definition.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_ledger_finished_days()
RETURNS SETOF date
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET timezone = 'UTC'
AS $fn$
  WITH RECURSIVE d AS (
    SELECT (SELECT min(created_at) FROM public.chip_ledger)::date AS day
    UNION ALL
    SELECT (SELECT min(created_at) FROM public.chip_ledger
             WHERE created_at >= (d.day + 1)::timestamptz)::date
      FROM d WHERE d.day IS NOT NULL
  )
  SELECT day FROM d WHERE day IS NOT NULL AND day < CURRENT_DATE ORDER BY day
$fn$;

REVOKE ALL ON FUNCTION public.fn_ca_ledger_finished_days() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_ledger_finished_days() TO service_role;

-- ---------------------------------------------------------------------------
-- 6. The backfill: same contract as #3463 (every finished day with legs and
--    no manifest is attested by calling the writer), without the sequential
--    scan it used to find them.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_ledger_day_manifest_backfill(p_since date DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET timezone = 'UTC'
AS $fn$
DECLARE
  r      record;
  v_done int   := 0;
  v_days jsonb := '[]'::jsonb;
  v_res  jsonb;
BEGIN
  FOR r IN
    SELECT d.day
      FROM public.fn_ca_ledger_finished_days() d(day)
     WHERE (p_since IS NULL OR d.day >= p_since)
       AND NOT EXISTS (SELECT 1 FROM public.ca_ledger_day_manifests m WHERE m.day = d.day)
     ORDER BY d.day
  LOOP
    v_res  := public.fn_ca_ledger_day_manifest(r.day);
    v_done := v_done + 1;
    v_days := v_days || jsonb_build_object('day', r.day, 'rows', v_res->'rows');
  END LOOP;

  RETURN jsonb_build_object('attested', v_done, 'days', v_days,
                            'since', COALESCE(p_since::text, 'the whole journal'));
END $fn$;

REVOKE ALL ON FUNCTION public.fn_ca_ledger_day_manifest_backfill(date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_ledger_day_manifest_backfill(date) TO service_role;

-- ---------------------------------------------------------------------------
-- 7. The verifier: a rotation under a wall-clock budget, and an answer that
--    says how stale the oldest re-read is. Coverage (unattested days, orphan
--    manifests) is still checked EVERY run - that part is O(days).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_ledger_day_manifest_verify_all(p_budget_ms integer DEFAULT 60000)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET timezone = 'UTC'
AS $fn$
DECLARE
  r            record;
  v_checked    int   := 0;
  v_drifted    int   := 0;
  v_unattested int   := 0;
  v_deferred   int   := 0;
  v_days       jsonb := '[]'::jsonb;
  v_missing    jsonb := '[]'::jsonb;
  v_t0         timestamptz := clock_timestamp();
  v_sha        text;
  v_count      bigint;
  v_oldest_age numeric;
  v_never      int;
BEGIN
  /* COVERAGE, every run. Which finished days have legs, and which of those
     carry no manifest. Loose index scan: proportional to days, not legs. */
  FOR r IN
    SELECT d.day
      FROM public.fn_ca_ledger_finished_days() d(day)
     WHERE NOT EXISTS (SELECT 1 FROM public.ca_ledger_day_manifests m WHERE m.day = d.day)
     ORDER BY d.day
  LOOP
    v_unattested := v_unattested + 1;
    v_missing := v_missing || jsonb_build_object('day', r.day);
  END LOOP;

  /* THE ROTATION. Least recently re-read first (never re-read first of all),
     until the budget is spent. Every manifest is a candidate, including one
     whose day has lost every row - that recomputes to the empty digest and is
     reported as drift with rows_present=false, the same failure #3463 named. */
  FOR r IN
    SELECT m.day, m.row_count AS stored_rows, m.sha256 AS stored_sha
      FROM public.ca_ledger_day_manifests m
     ORDER BY m.last_checked_at ASC NULLS FIRST, m.day ASC
  LOOP
    IF extract(epoch from (clock_timestamp() - v_t0)) * 1000 > p_budget_ms THEN
      v_deferred := v_deferred + 1;
      CONTINUE;
    END IF;

    /* The same expression fn_ca_ledger_day_manifest uses. If that one changes,
       this must change with it, or the pair will disagree about a journal
       neither has touched. */
    SELECT count(*),
           encode(extensions.digest(
             COALESCE(string_agg(
               id::text || '|' || amount::text || '|' || from_type || ':' || COALESCE(from_entity_id::text,'') ||
               '>' || to_type || ':' || COALESCE(to_entity_id::text,'') || '|' || category || '|' ||
               extract(epoch from created_at)::text || '|' || COALESCE(row_hash,''),
               E'\n' ORDER BY created_at, id), ''), 'sha256'), 'hex')
      INTO v_count, v_sha
      FROM public.chip_ledger
     WHERE created_at >= r.day AND created_at < r.day + 1;

    v_checked := v_checked + 1;
    UPDATE public.ca_ledger_day_manifests SET last_checked_at = now() WHERE day = r.day;

    IF v_sha IS DISTINCT FROM r.stored_sha THEN
      v_drifted := v_drifted + 1;
      v_days := v_days || jsonb_build_object(
        'day', r.day, 'stored_rows', r.stored_rows, 'actual_rows', v_count,
        'stored_sha', r.stored_sha, 'recomputed_sha', v_sha,
        'rows_present', v_count > 0);

      PERFORM public.fn_ca_raise_drift_incident(
        'fn_ca_ledger_day_manifest_verify_all', 'unauthorized_adjustment', 'critical',
        'manifest-mismatch:' || r.day::text,
        0, NULL, NULL, 'ledger', 'ca_ledger_day_manifests',
        NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
        'the ledger manifest for ' || r.day || ' no longer matches the journal: '
          || r.stored_rows || ' rows attested, ' || v_count || ' present. Sanctioned maintenance '
          || 'restates a manifest in its own transaction (zz_ca_attested_day_is_restated), so a mismatch '
          || 'here means the day changed some other way. Read ca_ledger_mutation_log for it first.',
        false,
        jsonb_build_object('day', r.day, 'stored_rows', r.stored_rows, 'actual_rows', v_count,
                           'stored', r.stored_sha, 'recomputed', v_sha));
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

  /* HOW WIDE THE MESH IS. The oldest re-read, in days, over every manifest -
     a manifest never re-read counts from the moment it was written. */
  SELECT max(extract(epoch from (now() - COALESCE(m.last_checked_at, m.created_at))) / 86400.0),
         count(*) FILTER (WHERE m.last_checked_at IS NULL)
    INTO v_oldest_age, v_never
    FROM public.ca_ledger_day_manifests m;

  IF COALESCE(v_oldest_age, 0) > 30 THEN
    /* Measured basis, 2026-09-07: the whole journal (35 days, 2.18M legs)
       re-reads inside the 60 s budget in about two nights. Thirty days is
       fifteen-fold headroom. When this fires the rotation can no longer cover
       the journal in a month, and the decision - a bigger budget or a longer
       rotation - is Dan's, made on this number. Warning, not critical: nothing
       has drifted, something has merely not been re-read lately. */
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_ledger_day_manifest_verify_all', 'unauthorized_adjustment', 'warning',
      'manifest-rotation-stale',
      0, NULL, NULL, 'ledger', 'ca_ledger_day_manifests',
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      'the oldest ledger-day manifest was last re-read ' || round(v_oldest_age, 1)
        || ' days ago: the nightly budget of ' || p_budget_ms || ' ms no longer re-reads the whole '
        || 'journal inside 30 days. Raise the budget (cron.job ca-ledger-day-manifest) or accept a '
        || 'longer rotation; either is a decision, not a repair.',
      true, jsonb_build_object('oldest_check_age_days', round(v_oldest_age, 2),
                               'never_checked', v_never, 'budget_ms', p_budget_ms));
  END IF;

  RETURN jsonb_build_object(
    'checked', v_checked, 'drifted', v_drifted, 'days', v_days,
    /* The coverage travels WITH the answer. "0 drifted" on its own was the
       defect #3463 was written for; "checked N" on its own is the one this
       migration was written for. */
    'unattested', v_unattested, 'unattested_days', v_missing,
    'deferred', v_deferred,
    'oldest_check_age_days', round(COALESCE(v_oldest_age, 0), 2),
    'never_checked', v_never,
    'budget_ms', p_budget_ms,
    'ms', round(extract(epoch from (clock_timestamp() - v_t0)) * 1000));
END $fn$;

REVOKE ALL ON FUNCTION public.fn_ca_ledger_day_manifest_verify_all(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_ledger_day_manifest_verify_all(integer) TO service_role;

-- The (no-argument) overload from #3463 must go, or the cron's call is
-- ambiguous between it and the defaulted one above.
DROP FUNCTION IF EXISTS public.fn_ca_ledger_day_manifest_verify_all();

-- ---------------------------------------------------------------------------
-- 8. The daily job is unchanged in shape and schedule (no cron.schedule,
--    CLAUDE.md 10.85): write yesterday, backfill, verify. Re-asserted below.
-- ---------------------------------------------------------------------------
SELECT cron.alter_job(
  (SELECT jobid FROM cron.job WHERE jobname = 'ca-ledger-day-manifest'),
  command := 'SELECT public.fn_ca_ledger_day_manifest(); SELECT public.fn_ca_ledger_day_manifest_backfill(); SELECT public.fn_ca_ledger_day_manifest_verify_all();'
);

-- ---------------------------------------------------------------------------
-- 9. PROVE IT, in this transaction, or abort it.
-- ---------------------------------------------------------------------------
DO $verify$
DECLARE
  v_writer   text;
  v_verifier text;
  v_expr_w   text;
  v_expr_v   text;
  v_cmd      text;
  v_res      jsonb;
  v_n        int;
  v_day      date;
  v_id       uuid;
  v_before   text;
  v_after    text;
  v_manifests int;
BEGIN
  -- the index exists and is valid
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
     WHERE c.relname = 'idx_chip_ledger_created_at' AND i.indisvalid AND i.indisready
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED: idx_chip_ledger_created_at is missing or invalid';
  END IF;

  -- the writer and the verifier still hash the same thing, read from the catalogue
  v_writer   := pg_get_functiondef('public.fn_ca_ledger_day_manifest(date, text)'::regprocedure);
  v_verifier := pg_get_functiondef('public.fn_ca_ledger_day_manifest_verify_all(integer)'::regprocedure);
  v_expr_w := substring(v_writer   from 'encode\(extensions\.digest\(.*?''sha256''\), ''hex''\)');
  v_expr_v := substring(v_verifier from 'encode\(extensions\.digest\(.*?''sha256''\), ''hex''\)');
  IF v_expr_w IS NULL OR v_expr_v IS NULL
     OR regexp_replace(v_expr_w, '\s+', ' ', 'g') <> regexp_replace(v_expr_v, '\s+', ' ', 'g') THEN
    RAISE EXCEPTION 'VERIFY FAILED: the writer and the verifier no longer hash the same thing';
  END IF;

  -- every function that decides which UTC day a leg belongs to says so
  FOR v_cmd IN
    SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('fn_ca_ledger_day_manifest', 'fn_ca_ledger_day_manifest_backfill',
                         'fn_ca_ledger_day_manifest_verify_all', 'fn_ca_ledger_finished_days',
                         'fn_ca_attested_day_is_restated', 'fn_ca_manifest_is_restated_not_edited')
       AND NOT EXISTS (SELECT 1 FROM unnest(COALESCE(p.proconfig, '{}')) c WHERE lower(c) = 'timezone=utc')
  LOOP
    RAISE EXCEPTION 'VERIFY FAILED: % does not pin timezone=UTC', v_cmd;
  END LOOP;

  -- no manifest function is reachable from a browser role
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND (p.proname LIKE 'fn_ca_ledger_%'
            OR p.proname IN ('fn_ca_attested_day_is_restated', 'fn_ca_manifest_is_restated_not_edited', 'fn_ca_restatement_is_append_only'))
       AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED: a manifest function is executable by a browser role';
  END IF;

  -- exactly one writer overload and one verifier overload remain
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_ca_ledger_day_manifest';
  IF v_n <> 1 THEN RAISE EXCEPTION 'VERIFY FAILED: % overloads of fn_ca_ledger_day_manifest (want 1)', v_n; END IF;
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_ca_ledger_day_manifest_verify_all';
  IF v_n <> 1 THEN RAISE EXCEPTION 'VERIFY FAILED: % overloads of fn_ca_ledger_day_manifest_verify_all (want 1)', v_n; END IF;

  -- the daily job still does all three things
  SELECT command INTO v_cmd FROM cron.job WHERE jobname = 'ca-ledger-day-manifest';
  IF v_cmd IS NULL OR v_cmd NOT LIKE '%fn_ca_ledger_day_manifest()%' THEN
    RAISE EXCEPTION 'VERIFY FAILED: extending the job dropped the manifest write it already did';
  END IF;
  IF v_cmd NOT LIKE '%fn_ca_ledger_day_manifest_backfill()%' THEN
    RAISE EXCEPTION 'VERIFY FAILED: the daily job does not call the backfill';
  END IF;
  IF v_cmd NOT LIKE '%fn_ca_ledger_day_manifest_verify_all()%' THEN
    RAISE EXCEPTION 'VERIFY FAILED: extending the job dropped the verification it already did';
  END IF;

  -- the guards are attached
  IF (SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public.chip_ledger'::regclass
        AND tgname IN ('zz_ca_attested_day_is_restated_del', 'zz_ca_attested_day_is_restated_upd')) <> 2 THEN
    RAISE EXCEPTION 'VERIFY FAILED: the attested-day restatement triggers are not both on chip_ledger';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.ca_ledger_day_manifests'::regclass
                    AND tgname = 'zz_ca_manifest_is_restated_not_edited') THEN
    RAISE EXCEPTION 'VERIFY FAILED: the manifest edit guard is not attached';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.ca_ledger_day_manifest_restatements'::regclass
                    AND tgname = 'zz_ca_restatement_is_append_only') THEN
    RAISE EXCEPTION 'VERIFY FAILED: the restatement append-only guard is not attached';
  END IF;

  -- a manifest cannot be edited or deleted by hand (subtransactions, rolled back)
  SELECT day INTO v_day FROM public.ca_ledger_day_manifests ORDER BY day LIMIT 1;
  BEGIN
    UPDATE public.ca_ledger_day_manifests SET sha256 = repeat('0', 64) WHERE day = v_day;
    RAISE EXCEPTION 'VERIFY FAILED: a manifest sha was edited by hand and nothing refused it';
  EXCEPTION WHEN SQLSTATE 'P0403' THEN NULL;
  END;
  BEGIN
    DELETE FROM public.ca_ledger_day_manifests WHERE day = v_day;
    RAISE EXCEPTION 'VERIFY FAILED: a manifest was deleted and nothing refused it';
  EXCEPTION WHEN SQLSTATE 'P0403' THEN NULL;
  END;
  BEGIN
    UPDATE public.ca_ledger_day_manifest_restatements SET reason = 'x' WHERE id = (SELECT min(id) FROM public.ca_ledger_day_manifest_restatements);
    IF FOUND THEN RAISE EXCEPTION 'VERIFY FAILED: a restatement was edited and nothing refused it'; END IF;
  EXCEPTION WHEN SQLSTATE 'P0403' THEN NULL;
  END;

  -- bookkeeping is not an edit
  UPDATE public.ca_ledger_day_manifests SET last_checked_at = last_checked_at WHERE day = v_day;

  -- THE ROOT FIX, PROVED: a sanctioned DELETE on an attested day restates
  -- that day's manifest in the same transaction, old sha kept, and the
  -- whole probe is rolled back by the RAISE that ends it. Cold row: the
  -- oldest attested day (2026-03-19 on production), never a hot one.
  SELECT sha256 INTO v_before FROM public.ca_ledger_day_manifests WHERE day = v_day;
  SELECT l.id INTO v_id FROM public.chip_ledger l
   WHERE l.created_at >= v_day AND l.created_at < v_day + 1
     AND NOT EXISTS (SELECT 1 FROM public.ca_mint_ledger ml WHERE ml.chip_ledger_id = l.id)
   ORDER BY l.created_at, l.id LIMIT 1;
  IF v_id IS NULL THEN RAISE EXCEPTION 'VERIFY FAILED: the oldest attested day % has no rows to probe with', v_day; END IF;
  BEGIN
    PERFORM set_config('app.ledger_maintenance', 'probe:20260907213447 the attestation restates itself', true);
    DELETE FROM public.chip_ledger WHERE id = v_id;
    SELECT sha256 INTO v_after FROM public.ca_ledger_day_manifests WHERE day = v_day;
    IF v_after = v_before THEN
      RAISE EXCEPTION 'VERIFY FAILED: a sanctioned DELETE on % left its manifest unchanged', v_day;
    END IF;
    SELECT count(*) INTO v_n FROM public.ca_ledger_day_manifest_restatements
     WHERE day = v_day AND old_sha256 = v_before AND new_sha256 = v_after
       AND reason = 'maintenance:probe:20260907213447 the attestation restates itself';
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'VERIFY FAILED: the restatement for % was not written by the guard (% rows)', v_day, v_n;
    END IF;
    RAISE EXCEPTION 'PROBE_ROLLBACK' USING ERRCODE = 'P0999';
  EXCEPTION WHEN SQLSTATE 'P0999' THEN
    NULL;  -- the probe's DELETE, its restatement and its mutation-log row are all gone
  END;
  -- and they are: the manifest is exactly what it was, no restatement survives
  IF (SELECT sha256 FROM public.ca_ledger_day_manifests WHERE day = v_day) <> v_before THEN
    RAISE EXCEPTION 'VERIFY FAILED: the probe did not roll back the manifest for %', v_day;
  END IF;
  IF EXISTS (SELECT 1 FROM public.ca_ledger_day_manifest_restatements WHERE reason LIKE 'maintenance:probe:20260907213447%') THEN
    RAISE EXCEPTION 'VERIFY FAILED: the probe restatement survived the rollback';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.chip_ledger WHERE id = v_id) THEN
    RAISE EXCEPTION 'VERIFY FAILED: the probe leg % is gone', v_id;
  END IF;

  -- the verifier runs end to end under a small budget, its answer carries its
  -- coverage, and nothing is unattested or drifted right now
  SELECT count(*) INTO v_manifests FROM public.ca_ledger_day_manifests;
  v_res := public.fn_ca_ledger_day_manifest_verify_all(5000);
  IF v_res->>'unattested' IS NULL OR v_res->>'deferred' IS NULL OR v_res->>'oldest_check_age_days' IS NULL THEN
    RAISE EXCEPTION 'VERIFY FAILED: the verifier answer carries no coverage: %', v_res;
  END IF;
  IF (v_res->>'unattested')::int <> 0 THEN
    RAISE EXCEPTION 'VERIFY FAILED: % finished day(s) still carry no manifest after the backfill: %', v_res->>'unattested', v_res->'unattested_days';
  END IF;
  IF (v_res->>'drifted')::int <> 0 THEN
    RAISE EXCEPTION 'VERIFY FAILED: the verifier reports drift: %', v_res->'days';
  END IF;
  IF (v_res->>'checked')::int + (v_res->>'deferred')::int <> v_manifests THEN
    RAISE EXCEPTION 'VERIFY FAILED: checked % + deferred % <> % manifests', v_res->>'checked', v_res->>'deferred', v_manifests;
  END IF;
  IF (v_res->>'checked')::int < 1 THEN
    RAISE EXCEPTION 'VERIFY FAILED: the verifier re-read nothing inside a 5 s budget';
  END IF;

  RAISE NOTICE 'the attestation restates itself and never outgrows its budget: %', v_res;
END $verify$;

COMMIT;
