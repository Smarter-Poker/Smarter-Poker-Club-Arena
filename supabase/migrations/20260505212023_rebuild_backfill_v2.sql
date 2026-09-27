-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260505212023 "rebuild_backfill_v2"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 e88d90e1a06ae602f2175a5ebb86eb6d of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Phase 5 corrective rebuild — v2 with relaxed level matching for psy
-- and adv-family compatibility for L1-3 gaps.

BEGIN;

DO $$
DECLARE
    bulk_rows integer;
BEGIN
    SELECT COUNT(*) INTO bulk_rows
    FROM training_question_cache
    WHERE question_id LIKE '%backfill%'
       OR question_id LIKE '%refill%'
       OR question_id LIKE '%psyfix%'
       OR question_id LIKE '%_v2_%';
    RAISE NOTICE 'pre-flight: % bulk-cloned rows to purge & rebuild', bulk_rows;
END $$;

CREATE TEMP TABLE _gaps_to_refill ON COMMIT DROP AS
SELECT DISTINCT game_id, level
FROM training_question_cache
WHERE question_id LIKE '%backfill%'
   OR question_id LIKE '%refill%'
   OR question_id LIKE '%psyfix%'
   OR question_id LIKE '%_v2_%';

DELETE FROM training_question_cache
WHERE question_id LIKE '%backfill%'
   OR question_id LIKE '%refill%'
   OR question_id LIKE '%psyfix%'
   OR question_id LIKE '%_v2_%';

-- Add the entirely-missing pairs (after delete, gaps include those that
-- never had any clones either — the 7 named games + adv L1-3 + etc).
INSERT INTO _gaps_to_refill (game_id, level)
WITH master_games(game_id) AS (
    VALUES
        ('adv-001'),('adv-002'),('adv-003'),('adv-004'),('adv-005'),
        ('adv-006'),('adv-007'),('adv-008'),('adv-009'),('adv-010'),
        ('adv-011'),('adv-012'),('adv-013'),('adv-014'),('adv-015'),
        ('adv-016'),('adv-017'),('adv-018'),('adv-019'),('adv-020'),
        ('cash-001'),('cash-002'),('cash-003'),('cash-004'),('cash-005'),
        ('cash-006'),('cash-007'),('cash-008'),('cash-009'),('cash-010'),
        ('cash-011'),('cash-012'),('cash-013'),('cash-014'),('cash-015'),
        ('cash-016'),('cash-017'),('cash-018'),('cash-019'),('cash-020'),
        ('cash-021'),('cash-022'),('cash-023'),('cash-024'),('cash-025'),
        ('mtt-001'),('mtt-002'),('mtt-003'),('mtt-004'),('mtt-005'),
        ('mtt-006'),('mtt-007'),('mtt-008'),('mtt-009'),('mtt-010'),
        ('mtt-011'),('mtt-012'),('mtt-013'),('mtt-014'),('mtt-015'),
        ('mtt-016'),('mtt-017'),('mtt-018'),('mtt-019'),('mtt-020'),
        ('mtt-021'),('mtt-022'),('mtt-023'),('mtt-024'),('mtt-025'),
        ('psy-001'),('psy-002'),('psy-003'),('psy-004'),('psy-005'),
        ('psy-006'),('psy-007'),('psy-008'),('psy-009'),('psy-010'),
        ('psy-011'),('psy-012'),('psy-013'),('psy-014'),('psy-015'),
        ('psy-016'),('psy-017'),('psy-018'),('psy-019'),('psy-020'),
        ('spins-001'),('spins-002'),('spins-003'),('spins-004'),('spins-005'),
        ('spins-006'),('spins-007'),('spins-008'),('spins-009'),('spins-010'),
        ('bluff-catcher'),('final-table-sim'),('hand-lab'),
        ('mixed-strategy-lab'),('quiz-gauntlet'),('study-group'),
        ('tournament-prep')
)
SELECT m.game_id, l.level
FROM master_games m
CROSS JOIN generate_series(1, 10) AS l(level)
LEFT JOIN (SELECT DISTINCT game_id, level FROM training_question_cache) c USING (game_id, level)
LEFT JOIN _gaps_to_refill r USING (game_id, level)
WHERE c.game_id IS NULL AND r.game_id IS NULL;

-- Now generate clones with proper filters.
WITH gaps AS (
    SELECT
        g.game_id,
        g.level,
        CASE
            WHEN g.game_id LIKE 'mtt-%'   THEN 'mtt'
            WHEN g.game_id LIKE 'spins-%' THEN 'spins'
            WHEN g.game_id LIKE 'adv-%'   THEN 'adv'
            WHEN g.game_id LIKE 'cash-%'  THEN 'cash'
            WHEN g.game_id LIKE 'psy-%'   THEN 'psy'
            ELSE 'special'
        END AS family,
        CASE
            WHEN g.game_id LIKE 'psy-%' THEN ARRAY['SCENARIO']
            WHEN g.game_id LIKE 'mtt-%' OR g.game_id LIKE 'spins-%' THEN ARRAY['PIO','CHART']
            ELSE ARRAY['PIO']
        END AS allowed_types,
        -- Psy games clone from any-level psy donor (originals are only L1-3).
        -- All other gaps require donor at exact same level.
        CASE
            WHEN g.game_id LIKE 'psy-%' THEN false
            ELSE true
        END AS require_same_level
    FROM _gaps_to_refill g
),
donors AS (
    SELECT
        c.id            AS donor_uuid,
        c.engine_type   AS donor_engine_type,
        c.game_type     AS donor_game_type_col,
        c.level         AS donor_level,
        c.question_data AS donor_data,
        CASE
            WHEN c.game_id LIKE 'mtt-%'   THEN 'mtt'
            WHEN c.game_id LIKE 'spins-%' THEN 'spins'
            WHEN c.game_id LIKE 'adv-%'   THEN 'adv'
            WHEN c.game_id LIKE 'cash-%'  THEN 'cash'
            WHEN c.game_id LIKE 'psy-%'   THEN 'psy'
            ELSE 'special'
        END AS donor_family,
        c.question_data->>'type' AS donor_qtype
    FROM training_question_cache c
    WHERE c.question_id NOT LIKE '%backfill%'
      AND c.question_id NOT LIKE '%refill%'
      AND c.question_id NOT LIKE '%psyfix%'
      AND c.question_id NOT LIKE '%_v2_%'
),
family_compat AS (
    SELECT 'mtt'     AS gap_family, 'mtt'     AS donor_family UNION ALL
    SELECT 'mtt'     , 'spins'   UNION ALL
    SELECT 'spins'   , 'spins'   UNION ALL
    SELECT 'spins'   , 'mtt'     UNION ALL
    SELECT 'cash'    , 'cash'    UNION ALL
    SELECT 'cash'    , 'adv'     UNION ALL
    SELECT 'adv'     , 'cash'    UNION ALL
    SELECT 'adv'     , 'adv'     UNION ALL
    SELECT 'special' , 'cash'    UNION ALL
    SELECT 'special' , 'adv'     UNION ALL
    SELECT 'psy'     , 'psy'
),
clones AS (
    SELECT
        g.game_id AS new_game_id,
        g.level   AS new_level,
        d.donor_uuid,
        d.donor_engine_type,
        d.donor_game_type_col,
        d.donor_data,
        ROW_NUMBER() OVER (
            PARTITION BY g.game_id, g.level
            ORDER BY md5(d.donor_uuid::text || ':' || g.game_id || ':' || g.level::text || ':v3')
        ) AS rn
    FROM gaps g
    JOIN family_compat fc ON fc.gap_family = g.family
    JOIN donors d
      ON d.donor_family = fc.donor_family
     AND (NOT g.require_same_level OR d.donor_level = g.level)
     AND d.donor_qtype = ANY(g.allowed_types)
)
INSERT INTO training_question_cache
    (id, question_id, game_id, engine_type, game_type, level, question_data, generated_at, times_used)
SELECT
    gen_random_uuid(),
    new_game_id || '_L' || new_level || '_v3_'
        || substr(md5(donor_uuid::text || rn::text), 1, 8)
        || '_' || rn::text,
    new_game_id,
    COALESCE(donor_engine_type, 'PIO'),
    COALESCE(donor_game_type_col, 'cash'),
    new_level,
    jsonb_set(
        donor_data, '{id}',
        to_jsonb(new_game_id || '_L' || new_level || '_v3_'
            || substr(md5(donor_uuid::text || rn::text), 1, 8)
            || '_' || rn::text),
        true
    ),
    now(),
    0
FROM clones
WHERE rn <= 25;

DO $$
DECLARE
    bad_psy       integer;
    bad_adv_chart integer;
    coverage_pct  numeric;
    total         integer;
BEGIN
    SELECT COUNT(*) INTO bad_adv_chart
    FROM training_question_cache
    WHERE game_id LIKE 'adv-%' AND (question_data->>'type') = 'CHART'
      AND question_id LIKE '%_v3_%';

    SELECT COUNT(*) INTO bad_psy
    FROM training_question_cache
    WHERE game_id LIKE 'psy-%' AND (question_data->>'type') <> 'SCENARIO';

    SELECT COUNT(*) INTO total FROM training_question_cache;
    SELECT ROUND(100.0 * COUNT(DISTINCT (game_id, level)) / 1070, 1) INTO coverage_pct
    FROM training_question_cache;

    RAISE NOTICE 'post-apply: total=%, coverage=%%%, bad_adv_chart_v3=%, bad_psy_non_scenario=%',
        total, coverage_pct, bad_adv_chart, bad_psy;

    IF bad_psy <> 0 THEN
        RAISE EXCEPTION 'post-apply failed: % non-SCENARIO rows in psy games', bad_psy;
    END IF;
    IF bad_adv_chart <> 0 THEN
        RAISE EXCEPTION 'post-apply failed: % CHART rows in adv (v3 clones)', bad_adv_chart;
    END IF;
    IF coverage_pct < 99 THEN
        RAISE EXCEPTION 'post-apply failed: coverage %%% below 99', coverage_pct;
    END IF;
END $$;

COMMIT;
