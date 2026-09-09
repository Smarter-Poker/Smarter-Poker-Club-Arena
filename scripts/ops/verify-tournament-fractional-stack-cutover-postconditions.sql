\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned
\pset fieldsep '|'

WITH expected AS (
  SELECT CASE WHEN :'tournament_ids_csv' = '' THEN '{}'::uuid[]
              ELSE string_to_array(:'tournament_ids_csv', ',')::uuid[]
         END AS tournament_ids
), active AS (
  SELECT t.id AS tournament_id,
         upper(COALESCE(t.status::text, '')) AS tournament_status,
         tb.id AS table_id,
         s.id AS seat_id,
         s.joined_at,
         s.seat_number,
         s.user_id,
         s.stack
    FROM public.tournaments t
    JOIN public.tables tb ON tb.tournament_id = t.id
    JOIN public.table_seats s ON s.table_id = tb.id AND s.left_at IS NULL
   WHERE upper(COALESCE(t.status::text, ''))
           NOT IN ('COMPLETED', 'CANCELLED', 'CANCELED')
), invalid_active AS (
  SELECT count(*) AS n
    FROM active a
   WHERE a.stack IS NULL
      OR lower(a.stack::text) IN ('nan', 'infinity', '-infinity')
      OR a.stack < 0
      OR a.stack > 9999999999999
      OR a.stack <> trunc(a.stack)
), active_roster_mismatch AS (
  SELECT count(*) AS n
    FROM active a
   WHERE (
     SELECT count(*)
       FROM public.tournament_players tp
      WHERE tp.tournament_id = a.tournament_id
        AND tp.user_id = a.user_id
        AND (
          tp.status::text IN ('registered', 'playing')
          OR (a.tournament_status = 'COMPLETING' AND tp.status::text = 'winner')
        )
        AND (a.tournament_status <> 'RUNNING' OR tp.status::text = 'playing')
        AND tp.table_id = a.table_id
        AND tp.seat_number = a.seat_number
        AND tp.chips = a.stack::bigint
   ) <> 1
), reverse_roster_mismatch AS (
  SELECT count(*) AS n
   FROM public.tournament_players tp
    JOIN public.tournaments t ON t.id = tp.tournament_id
   WHERE upper(COALESCE(t.status::text, ''))
           NOT IN ('COMPLETED', 'CANCELLED', 'CANCELED')
     AND (
       (upper(COALESCE(t.status::text, '')) = 'RUNNING'
        AND tp.status::text = 'playing')
       OR (
         tp.status::text IN ('registered', 'playing')
         AND (tp.table_id IS NOT NULL OR tp.seat_number IS NOT NULL)
       )
       OR (
         upper(COALESCE(t.status::text, '')) = 'COMPLETING'
         AND tp.status::text = 'winner'
         AND (tp.table_id IS NOT NULL OR tp.seat_number IS NOT NULL)
       )
     )
     AND (
       SELECT count(*)
         FROM active a
        WHERE a.tournament_id = tp.tournament_id
          AND a.user_id = tp.user_id
          AND a.table_id IS NOT DISTINCT FROM tp.table_id
          AND a.seat_number IS NOT DISTINCT FROM tp.seat_number
          AND a.stack::bigint = tp.chips
     ) <> 1
), trigger_state AS (
  SELECT count(*) AS n
    FROM pg_trigger g
   WHERE g.tgname = 'a1_require_whole_tournament_chips'
     AND g.tgrelid IN (
       'public.tournaments'::regclass,
       'public.tournament_players'::regclass,
       'public.tables'::regclass,
       'public.table_seats'::regclass
     )
     AND NOT g.tgisinternal
     AND g.tgenabled = 'O'
), cohort AS (
  SELECT count(DISTINCT a.tournament_id) AS tournament_count,
         count(DISTINCT a.table_id) AS table_count,
         count(*) AS active_seat_count,
         count(*) FILTER (WHERE a.stack <> trunc(a.stack)) AS fractional_seat_count,
         COALESCE(sum(a.stack), 0) AS total_chips
    FROM active a, expected e
   WHERE a.tournament_id = ANY(e.tournament_ids)
)
SELECT
  format_type(
    (SELECT a.atttypid FROM pg_attribute a
      WHERE a.attrelid = 'public.tournament_players'::regclass
        AND a.attname = 'chips' AND NOT a.attisdropped),
    (SELECT a.atttypmod FROM pg_attribute a
      WHERE a.attrelid = 'public.tournament_players'::regclass
        AND a.attname = 'chips' AND NOT a.attisdropped)
  ),
  CASE WHEN to_regclass('public.tournament_flights') IS NULL THEN 'absent'
       ELSE format_type(
         (SELECT a.atttypid FROM pg_attribute a
           WHERE a.attrelid = to_regclass('public.tournament_flights')
             AND a.attname = 'bagged_chips' AND NOT a.attisdropped),
         (SELECT a.atttypmod FROM pg_attribute a
           WHERE a.attrelid = to_regclass('public.tournament_flights')
             AND a.attname = 'bagged_chips' AND NOT a.attisdropped)
       ) END,
  invalid_active.n,
  active_roster_mismatch.n,
  reverse_roster_mismatch.n,
  trigger_state.n,
  cohort.tournament_count,
  cohort.table_count,
  cohort.active_seat_count,
  cohort.fractional_seat_count,
  cohort.total_chips
FROM invalid_active, active_roster_mismatch, reverse_roster_mismatch,
     trigger_state, cohort;
