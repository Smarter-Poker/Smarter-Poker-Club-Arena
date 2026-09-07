-- AN ATTESTATION NOBODY RE-READS IS A PHOTOGRAPH, NOT A GUARD.
--
-- Phase 6, roadmap 9.2. The roadmap's complaint is that the daily ledger
-- manifest lives in the same database as the journal it hashes, so it "proves
-- the journal has not been altered only to somebody who already trusts the
-- database". True. But measuring it first found something sharper, and it is
-- live right now:
--
--   THE ATTESTATION FOR 2026-08-31 HAS BEEN WRONG SINCE 2026-09-01 14:34,
--   AND NOTHING HAS NOTICED.
--
-- Measured 2026-09-07 across all eight retained days:
--
--   day         manifest rows   actual rows   delta
--   2026-09-06        263,705       263,705       0
--   2026-09-05        225,648       225,648       0
--   2026-09-04        392,608       392,608       0
--   2026-09-03        527,563       527,563       0
--   2026-09-02        169,076       169,076       0
--   2026-09-01         90,734        90,734       0
--   2026-08-31         56,893        56,327    -566
--   2026-08-30         24,107        24,107       0
--
-- Seven of eight match to the row. One does not, and its sha256 does not match
-- a recompute either.
--
-- THE JOURNAL IS FINE. THE ATTESTATION OF IT IS NOT. The 566 legs were removed
-- deliberately at 2026-09-01 14:34 through the sanctioned maintenance path,
-- reason `dan-2026-09-01-deep-stack-clean-funding-redo`, and every one of them
-- is preserved in `ca_ledger_mutation_log` with its whole old row. That is the
-- append-only guard working exactly as designed. What failed is everything
-- after it:
--
--   1. `fn_ca_ledger_day_manifest` only ever examines CURRENT_DATE - 1. It
--      computed 08-31 once, on 09-01 at 04:25 - ten hours BEFORE the deletion -
--      and has never looked at that day again. It never will.
--   2. Nothing restates a manifest when sanctioned maintenance changes a day,
--      so the stored sha silently became a description of a journal that no
--      longer exists.
--   3. `ca_drift_incidents` has recorded **zero** manifest mismatches, ever.
--
-- The tamper check inside `fn_ca_ledger_day_manifest` is good - it refuses to
-- overwrite a changed day and raises a critical incident - but it is wired to
-- exactly one day. A guard that looks at yesterday and never again cannot see
-- a change to the day before, which is where a quiet edit would go.
--
-- WHAT THIS MIGRATION DOES
--
--   * `fn_ca_ledger_day_manifest_verify_all()` recomputes EVERY retained day
--     and raises the existing incident for each one that drifts. Wired into
--     the cron that already runs at 04:25 - no new scheduler, no new job
--     (CLAUDE.md 10.85).
--   * `ca_ledger_day_manifest_restatements` records a manifest that had to
--     change and why, keeping the old sha and count. A sanctioned change to
--     history must leave the record CORRECTED, not silently wrong - this is
--     roadmap 9.3's restatement policy, in the one place it is already needed.
--   * 2026-08-31 is restated now, citing the mutation-log reason and the 566
--     rows, so the eight days on record are true again.
--
-- WHAT IT DOES NOT DO: it does not anchor the sha outside the database. That
-- is the other half of 9.2 and it is a repo change, not a migration - it
-- follows in the same phase.

BEGIN;

SET LOCAL lock_timeout = '4s';

-- ---------------------------------------------------------------------------
-- A RESTATEMENT IS A RECORD, NOT AN EDIT.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ca_ledger_day_manifest_restatements (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  day           date        NOT NULL,
  restated_at   timestamptz NOT NULL DEFAULT now(),
  old_row_count bigint,
  new_row_count bigint,
  old_sha256    text,
  new_sha256    text,
  reason        text        NOT NULL
);

COMMENT ON TABLE public.ca_ledger_day_manifest_restatements IS
  'Every time a day''s ledger manifest had to change, with the value it held before and why. A sanctioned change to history leaves the attestation corrected rather than silently wrong; the journal rows themselves are in ca_ledger_mutation_log.';

CREATE INDEX IF NOT EXISTS idx_ca_ledger_day_manifest_restatements_day
  ON public.ca_ledger_day_manifest_restatements (day, restated_at DESC);

ALTER TABLE public.ca_ledger_day_manifest_restatements ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ca_ledger_day_manifest_restatements FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.ca_ledger_day_manifest_restatements TO service_role;

-- ---------------------------------------------------------------------------
-- VERIFY EVERY DAY ON RECORD, NOT JUST YESTERDAY.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_ledger_day_manifest_verify_all()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  r          record;
  v_sha      text;
  v_count    bigint;
  v_checked  int := 0;
  v_drifted  int := 0;
  v_days     jsonb := '[]'::jsonb;
BEGIN
  FOR r IN SELECT day, row_count, sha256 FROM public.ca_ledger_day_manifests ORDER BY day
  LOOP
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

    IF v_sha IS DISTINCT FROM r.sha256 THEN
      v_drifted := v_drifted + 1;
      v_days := v_days || jsonb_build_object(
        'day', r.day, 'stored_rows', r.row_count, 'actual_rows', v_count,
        'stored_sha', r.sha256, 'recomputed_sha', v_sha);

      PERFORM public.fn_ca_raise_drift_incident(
        'fn_ca_ledger_day_manifest_verify_all', 'unauthorized_adjustment', 'critical',
        'manifest-mismatch:' || r.day::text,
        0, NULL, NULL, 'ledger', 'ca_ledger_day_manifests',
        NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
        'the ledger manifest for ' || r.day || ' no longer matches the journal: '
          || r.row_count || ' rows attested, ' || v_count || ' present. If this was sanctioned '
          || 'maintenance, restate the manifest (ca_ledger_day_manifest_restatements) and say why; '
          || 'the rows themselves are in ca_ledger_mutation_log.',
        false,
        jsonb_build_object('day', r.day, 'stored_rows', r.row_count, 'actual_rows', v_count,
                           'stored', r.sha256, 'recomputed', v_sha));
    END IF;
  END LOOP;

  RETURN jsonb_build_object('checked', v_checked, 'drifted', v_drifted, 'days', v_days);
END $function$;

COMMENT ON FUNCTION public.fn_ca_ledger_day_manifest_verify_all() IS
  'Recomputes every retained day manifest and raises a critical drift incident for each that no longer matches the journal. fn_ca_ledger_day_manifest only ever checks CURRENT_DATE - 1, so before this a change to any older day was invisible - 2026-08-31 was wrong for six days and nothing noticed.';

REVOKE ALL ON FUNCTION public.fn_ca_ledger_day_manifest_verify_all() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_ledger_day_manifest_verify_all() TO service_role;

-- ---------------------------------------------------------------------------
-- RESTATE 2026-08-31, KEEPING WHAT IT SAID BEFORE.
-- ---------------------------------------------------------------------------
DO $restate$
DECLARE
  v_old   record;
  v_sha   text;
  v_count bigint;
  v_net   numeric;
  v_first bigint;
  v_last  bigint;
  v_removed int;
BEGIN
  SELECT * INTO v_old FROM public.ca_ledger_day_manifests WHERE day = date '2026-08-31';
  IF v_old.day IS NULL THEN
    RAISE NOTICE 'RESTATE_SKIPPED no manifest row for 2026-08-31';
    RETURN;
  END IF;

  SELECT count(*), COALESCE(sum(amount),0), min(chain_seq), max(chain_seq),
         encode(extensions.digest(
           COALESCE(string_agg(
             id::text || '|' || amount::text || '|' || from_type || ':' || COALESCE(from_entity_id::text,'') ||
             '>' || to_type || ':' || COALESCE(to_entity_id::text,'') || '|' || category || '|' ||
             extract(epoch from created_at)::text || '|' || COALESCE(row_hash,''),
             E'\n' ORDER BY created_at, id), ''), 'sha256'), 'hex')
    INTO v_count, v_net, v_first, v_last, v_sha
    FROM public.chip_ledger
   WHERE created_at >= date '2026-08-31' AND created_at < date '2026-09-01';

  IF v_sha = v_old.sha256 THEN
    RAISE NOTICE 'RESTATE_NOT_NEEDED 2026-08-31 already matches the journal';
    RETURN;
  END IF;

  /* The removal has to be accounted for, or this is not a restatement, it is
     an overwrite. Everything taken out of that day is in the mutation log. */
  SELECT count(*) INTO v_removed
    FROM public.ca_ledger_mutation_log
   WHERE source_table = 'chip_ledger' AND operation = 'DELETE'
     AND (old_row->>'created_at')::timestamptz >= timestamptz '2026-08-31 00:00:00+00'
     AND (old_row->>'created_at')::timestamptz <  timestamptz '2026-09-01 00:00:00+00';

  IF v_old.row_count - v_count <> v_removed THEN
    RAISE EXCEPTION 'ABORT: the manifest is short by % rows but the mutation log accounts for % - do not restate an unexplained difference',
      v_old.row_count - v_count, v_removed;
  END IF;

  INSERT INTO public.ca_ledger_day_manifest_restatements
    (day, old_row_count, new_row_count, old_sha256, new_sha256, reason)
  VALUES (date '2026-08-31', v_old.row_count, v_count, v_old.sha256, v_sha,
          format('%s rows were deleted from this day at 2026-09-01 14:34 through the sanctioned maintenance path (ca_ledger_mutation_log reason dan-2026-09-01-deep-stack-clean-funding-redo), ten hours after the manifest was written at 04:25. Every removed row is preserved in ca_ledger_mutation_log. The manifest is restated to describe the journal as it now stands; the value it held before is kept above.', v_removed));

  UPDATE public.ca_ledger_day_manifests
     SET row_count = v_count, net_amount = v_net,
         first_seq = v_first, last_seq = v_last, sha256 = v_sha
   WHERE day = date '2026-08-31';

  RAISE NOTICE 'RESTATED 2026-08-31: % rows -> %, % accounted for in the mutation log', v_old.row_count, v_count, v_removed;
END $restate$;

-- ---------------------------------------------------------------------------
-- AND THE DAILY JOB CHECKS ALL OF THEM FROM NOW ON. No new schedule: the same
-- 04:25 job that writes yesterday's manifest now verifies every day on record
-- straight afterwards.
-- ---------------------------------------------------------------------------
DO $wire$
DECLARE v_id bigint;
BEGIN
  SELECT jobid INTO v_id FROM cron.job WHERE jobname = 'ca-ledger-day-manifest';
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'ABORT: the ca-ledger-day-manifest job is not there to extend';
  END IF;
  PERFORM cron.alter_job(v_id,
    command => 'SELECT public.fn_ca_ledger_day_manifest(); SELECT public.fn_ca_ledger_day_manifest_verify_all();');
END $wire$;

-- ---------------------------------------------------------------------------
-- PROVE IT.
-- ---------------------------------------------------------------------------
DO $verify$
DECLARE
  v_res      jsonb;
  v_restated int;
  v_cmd      text;
BEGIN
  v_res := public.fn_ca_ledger_day_manifest_verify_all();

  IF (v_res->>'checked')::int < 8 THEN
    RAISE EXCEPTION 'VERIFY FAILED: only % day(s) were checked, expected every retained day', v_res->>'checked';
  END IF;
  IF (v_res->>'drifted')::int <> 0 THEN
    RAISE EXCEPTION 'VERIFY FAILED: % day(s) still disagree with the journal after the restatement: %',
      v_res->>'drifted', v_res->>'days';
  END IF;

  SELECT count(*) INTO v_restated FROM public.ca_ledger_day_manifest_restatements WHERE day = date '2026-08-31';
  IF v_restated <> 1 THEN
    RAISE EXCEPTION 'VERIFY FAILED: 2026-08-31 has % restatement rows, expected exactly 1', v_restated;
  END IF;

  SELECT command INTO v_cmd FROM cron.job WHERE jobname = 'ca-ledger-day-manifest';
  IF v_cmd !~ 'fn_ca_ledger_day_manifest_verify_all' THEN
    RAISE EXCEPTION 'VERIFY FAILED: the daily job does not call the all-days verification';
  END IF;
  IF v_cmd !~ 'fn_ca_ledger_day_manifest\(\)' THEN
    RAISE EXCEPTION 'VERIFY FAILED: extending the job dropped the manifest write it already did';
  END IF;

  RAISE NOTICE 'EVERY_DAY_IS_RE_READ % days checked, 0 drifted, 2026-08-31 restated with its old value kept, and the 04:25 job now verifies all of them', v_res->>'checked';
END $verify$;

COMMIT;
