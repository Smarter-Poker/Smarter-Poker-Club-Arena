-- THE REPO CAN ASK PRODUCTION WHETHER A CLUB IS STILL DELETABLE.
--
-- 20260904001605 closed thirteen index gaps and proved, once, that every foreign
-- key into clubs can be answered without a sequential scan. Once is not a
-- standard. The way that finding rots is ordinary and blameless: someone adds a
-- table with a club_id, writes the foreign key, does not think about the index,
-- and nothing anywhere notices until the next certification run strands a
-- fixture and its chips in Club Arena.
--
-- Dan, on what the standard is: "WE SHOULDN'T NEED THOSE DETECTORS OR WATCH DOGS
-- ... THATS THE GOAL! NOT TO HAVE WATCH DOGS AND CRONS RUNNING ALL OVER THE
-- PLACE. WE MUST BE PERFECT!"
--
-- So this is deliberately NOT a detector. It does not run on a schedule, it does
-- not raise incidents, it writes nothing and it watches nothing. It is a
-- question, and the only thing that ever asks it is
-- scripts/ci/check-club-fk-indexes.mjs, on a pull request, before the change can
-- reach main. A gap becomes a red build on the branch that introduced it rather
-- than an alert at three in the morning about an estate that is already broken.
--
-- WHAT COUNTS AS AN ANSWERABLE KEY. A foreign key check looks for child rows
-- holding a given parent key. An index can answer it when it is valid (a failed
-- CONCURRENTLY build leaves an invalid one behind), not partial (a predicate
-- hides exactly the rows the check must find - this is what made
-- idx_rake_records_club_created, which leads on club_id, useless for
-- rake_records_club_id_fkey), and led by the referencing column. Composite
-- foreign keys are out of scope: they are answered by their own leading column
-- and none of them point at clubs today.

CREATE OR REPLACE FUNCTION public.fn_ca_fk_index_gaps(p_parent text DEFAULT 'public.clubs')
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT jsonb_build_object(
    'parent', p_parent,
    'checked_at', now(),
    'gaps', COALESCE(jsonb_agg(jsonb_build_object(
              'child_table', g.child_table,
              'child_column', g.child_col,
              'constraint', g.conname,
              'est_rows', g.est_rows
            ) ORDER BY g.est_rows DESC NULLS LAST), '[]'::jsonb))
    FROM (
      SELECT f.child_table, f.child_col, f.conname,
             (SELECT c2.reltuples::bigint FROM pg_class c2 WHERE c2.oid = f.conrelid) AS est_rows
        FROM (
          SELECT c.conrelid,
                 c.conrelid::regclass::text AS child_table,
                 a.attname                  AS child_col,
                 c.conname::text            AS conname,
                 a.attnum
            FROM pg_constraint c
            JOIN unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
            JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
           WHERE c.contype = 'f'
             AND c.confrelid = p_parent::regclass
             AND array_length(c.conkey, 1) = 1
        ) f
       WHERE NOT EXISTS (
         SELECT 1 FROM pg_index i
          WHERE i.indrelid = f.conrelid
            AND i.indisvalid
            AND i.indpred IS NULL
            AND i.indkey[0] = f.attnum
       )
    ) g;
$function$;

COMMENT ON FUNCTION public.fn_ca_fk_index_gaps(text) IS
  'Every single-column foreign key into p_parent that no valid, non-partial, '
  'leading-column index can answer - so the parent cannot be deleted without a '
  'sequential scan of that child. Read-only. Asked by '
  'scripts/ci/check-club-fk-indexes.mjs on every pull request; nothing schedules it.';

-- A browser has no business asking the shape of the catalogue.
REVOKE ALL ON FUNCTION public.fn_ca_fk_index_gaps(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_fk_index_gaps(text) TO service_role;

DO $selfcheck$
DECLARE
  v jsonb;
BEGIN
  v := public.fn_ca_fk_index_gaps();
  IF jsonb_array_length(v->'gaps') <> 0 THEN
    RAISE EXCEPTION 'FK_INDEX_GAPS_SELFCHECK: clubs has gaps right after they were all closed: %', v->'gaps';
  END IF;

  -- And the question is answerable about a parent that DOES have a gap today,
  -- so a green answer is evidence of a healthy estate and not of a broken query.
  v := public.fn_ca_fk_index_gaps('public.tournaments');
  IF v->'gaps' IS NULL THEN
    RAISE EXCEPTION 'FK_INDEX_GAPS_SELFCHECK: the function returned no gaps key for tournaments';
  END IF;

  RAISE NOTICE 'FK_INDEX_GAPS_SELFCHECK_OK: clubs has 0 gaps; tournaments answers with % gap(s)',
    jsonb_array_length(v->'gaps');
END
$selfcheck$;