\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned
\pset fieldsep '|'

-- Match the production renderer and migration exactly. Full-row JSON hashes
-- must not depend on the operator machine's session settings.
SET TimeZone = 'UTC';
SET DateStyle = 'ISO, YMD';
SET IntervalStyle = 'iso_8601';
SET extra_float_digits = 3;
SET bytea_output = 'hex';

WITH source AS (
  SELECT
    t.id AS tournament_id,
    tb.id AS table_id,
    s.id AS seat_id,
    s.joined_at AS seat_joined_at,
    s.seat_number,
    s.user_id,
    s.stack AS old_stack,
    tp.chips AS old_player_chips,
    to_jsonb(t) AS tournament_before,
    to_jsonb(tb) AS table_before,
    to_jsonb(s) AS seat_before,
    to_jsonb(tp) AS player_before
  FROM public.tournaments t
  JOIN public.tables tb ON tb.tournament_id = t.id
  JOIN public.table_seats s ON s.table_id = tb.id AND s.left_at IS NULL
  JOIN public.tournament_players tp
    ON tp.tournament_id = t.id AND tp.user_id = s.user_id
  WHERE t.id IN (
    '00000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-000000000002'
  )
), ranked AS (
  SELECT
    source.*,
    floor(old_stack) AS base_stack,
    (sum(old_stack) OVER (PARTITION BY tournament_id)
     - sum(floor(old_stack)) OVER (PARTITION BY tournament_id))::bigint AS bonus_count,
    row_number() OVER (
      PARTITION BY tournament_id
      ORDER BY (old_stack - floor(old_stack)) DESC,
               table_id, seat_number, seat_id, seat_joined_at, user_id
    ) AS remainder_rank
  FROM source
), plan AS (
  SELECT ranked.*,
         (base_stack + CASE WHEN remainder_rank <= bonus_count THEN 1 ELSE 0 END)
           ::numeric(15,2) AS target_stack
    FROM ranked
), hashes AS (
  SELECT
    encode(extensions.digest(COALESCE(string_agg(
      jsonb_build_object(
        'tournament', tournament_before,
        'table', table_before,
        'seat', seat_before,
        'tournament_player', player_before
      )::text,
      E'\n' ORDER BY tournament_id, table_id, seat_number,
                     seat_id, seat_joined_at, user_id
    ), ''), 'sha256'), 'hex') AS pre_sha,
    encode(extensions.digest(COALESCE(string_agg(
      jsonb_build_object(
        'tournament', tournament_before,
        'table', table_before,
        'seat', jsonb_set(seat_before, '{stack}', to_jsonb(target_stack), false),
        'tournament_player', jsonb_set(
          player_before, '{chips}', to_jsonb(target_stack::bigint), false
        )
      )::text,
      E'\n' ORDER BY tournament_id, table_id, seat_number,
                     seat_id, seat_joined_at, user_id
    ), ''), 'sha256'), 'hex') AS post_sha
  FROM plan
)
SELECT
  count(DISTINCT tournament_id),
  count(DISTINCT table_id),
  count(*),
  count(*) FILTER (WHERE old_stack <> trunc(old_stack)),
  sum(old_stack),
  (SELECT pre_sha FROM hashes),
  (SELECT post_sha FROM hashes)
FROM plan;
