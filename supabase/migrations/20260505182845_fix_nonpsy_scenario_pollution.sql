-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260505182845 "fix_nonpsy_scenario_pollution"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 52aeb24ef9f18b05ddcee83c512794c1 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Replace SCENARIO-type backfill clones in non-PSY games with PIO clones.
-- Captures (game_id, level) of each row to delete, deletes them, then
-- re-fills those exact pairs from PIO/CHART donors of matching gameType.

BEGIN;

-- ─── 1. PRE-FLIGHT ────────────────────────────────────────────────────
DO $$
DECLARE
    bad_rows integer;
BEGIN
    SELECT COUNT(*) INTO bad_rows
    FROM training_question_cache
    WHERE game_id NOT LIKE 'psy-%'
      AND question_id LIKE '%backfill%'
      AND (question_data->>'type') = 'SCENARIO';
    RAISE NOTICE 'pre-flight: % mis-typed SCENARIO backfill clones found', bad_rows;
    IF bad_rows < 100 OR bad_rows > 5000 THEN
        RAISE EXCEPTION 'pre-flight failed: bad_rows=% outside expected band [100,5000]', bad_rows;
    END IF;
END $$;

-- ─── 2. Capture which (game_id, level) lost rows, then delete bad rows ─
CREATE TEMP TABLE _to_refill ON COMMIT DROP AS
SELECT game_id, level, COUNT(*) AS rows_to_replace
FROM training_question_cache
WHERE game_id NOT LIKE 'psy-%'
  AND question_id LIKE '%backfill%'
  AND (question_data->>'type') = 'SCENARIO'
GROUP BY game_id, level;

DELETE FROM training_question_cache
WHERE game_id NOT LIKE 'psy-%'
  AND question_id LIKE '%backfill%'
  AND (question_data->>'type') = 'SCENARIO';

-- ─── 3. Re-fill using PIO/CHART donors of matching gameType ────────────
WITH refill AS (
    SELECT
        r.game_id,
        r.level,
        r.rows_to_replace,
        CASE
            WHEN r.game_id LIKE 'mtt-%'   THEN 'tournament'
            WHEN r.game_id LIKE 'spins-%' THEN 'sng'
            ELSE 'cash'
        END AS game_type
    FROM _to_refill r
),
donors AS (
    SELECT
        c.id            AS donor_uuid,
        c.engine_type   AS donor_engine_type,
        c.game_type     AS donor_game_type_col,
        c.level         AS donor_level,
        c.question_data AS donor_data,
        CASE
            WHEN c.game_id LIKE 'mtt-%'   THEN 'tournament'
            WHEN c.game_id LIKE 'spins-%' THEN 'sng'
            ELSE 'cash'
        END AS inferred_game_type
    FROM training_question_cache c
    WHERE (c.question_data->>'type') IN ('PIO', 'CHART')
      AND c.game_id NOT LIKE 'psy-%'
),
clones AS (
    SELECT
        r.game_id AS new_game_id,
        r.level   AS new_level,
        r.rows_to_replace,
        d.donor_uuid,
        d.donor_engine_type,
        d.donor_game_type_col,
        d.donor_data,
        ROW_NUMBER() OVER (
            PARTITION BY r.game_id, r.level
            ORDER BY md5(d.donor_uuid::text || ':' || r.game_id || ':' || r.level::text || ':rfx')
        ) AS rn
    FROM refill r
    JOIN donors d
      ON d.inferred_game_type = r.game_type
     AND d.donor_level         = r.level
)
INSERT INTO training_question_cache
    (id, question_id, game_id, engine_type, game_type, level, question_data, generated_at, times_used)
SELECT
    gen_random_uuid(),
    new_game_id || '_L' || new_level || '_refill_'
        || substr(md5(donor_uuid::text || rn::text), 1, 8)
        || '_' || rn::text,
    new_game_id,
    COALESCE(donor_engine_type, 'PIO'),
    COALESCE(donor_game_type_col, 'cash'),
    new_level,
    jsonb_set(
        donor_data, '{id}',
        to_jsonb(new_game_id || '_L' || new_level || '_refill_'
            || substr(md5(donor_uuid::text || rn::text), 1, 8)
            || '_' || rn::text),
        true
    ),
    now(),
    0
FROM clones
WHERE rn <= rows_to_replace;

-- ─── 4. POST-APPLY ASSERTIONS ─────────────────────────────────────────
DO $$
DECLARE
    remaining_bad integer;
    psy_pure      integer;
BEGIN
    SELECT COUNT(*) INTO remaining_bad
    FROM training_question_cache
    WHERE game_id NOT LIKE 'psy-%'
      AND question_id LIKE '%backfill%'
      AND (question_data->>'type') = 'SCENARIO';

    SELECT COUNT(*) INTO psy_pure
    FROM training_question_cache
    WHERE game_id LIKE 'psy-%' AND (question_data->>'type') <> 'SCENARIO';

    RAISE NOTICE 'post-apply: remaining_bad_clones=%, psy_non_scenario=%',
        remaining_bad, psy_pure;

    IF remaining_bad <> 0 THEN
        RAISE EXCEPTION 'post-apply failed: % bad clones remain', remaining_bad;
    END IF;
    IF psy_pure <> 0 THEN
        RAISE EXCEPTION 'post-apply failed: % non-SCENARIO rows in psy-* games', psy_pure;
    END IF;
END $$;

COMMIT;
