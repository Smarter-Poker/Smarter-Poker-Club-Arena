\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned
\pset fieldsep '|'

/*
 * One stopped-engine observation for the fractional-stack cutover.
 *
 * The caller supplies expected_engine_sha8 from the immutable Docker image and
 * min_remaining_seconds from the cutover budget.  This transaction takes the
 * normalization migration's lock order, materializes the complete cohort once,
 * emits only the nine reviewed literals, and rolls back.  No player row or
 * identifying JSON leaves PostgreSQL.  The rendered migration takes the same
 * locks and re-proves both hashes, so drift after this short observation is a
 * refusal, never a stale write.
 */

BEGIN;

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '30s';
SET LOCAL TimeZone = 'UTC';
SET LOCAL DateStyle = 'ISO, YMD';
SET LOCAL IntervalStyle = 'iso_8601';
SET LOCAL extra_float_digits = 3;
SET LOCAL bytea_output = 'hex';
SET LOCAL app.cutover_expected_engine_sha8 = :'expected_engine_sha8';
SET LOCAL app.cutover_min_remaining_seconds = :'min_remaining_seconds';

LOCK TABLE realtime.subscription IN ACCESS EXCLUSIVE MODE NOWAIT;
LOCK TABLE supabase_migrations.schema_migrations IN SHARE MODE NOWAIT;
LOCK TABLE public.engine_maintenance_break IN SHARE ROW EXCLUSIVE MODE NOWAIT;
LOCK TABLE public.engine_leader IN SHARE ROW EXCLUSIVE MODE NOWAIT;
LOCK TABLE public.engine_table_leases IN SHARE ROW EXCLUSIVE MODE NOWAIT;
LOCK TABLE public.engine_tournament_leases IN SHARE ROW EXCLUSIVE MODE NOWAIT;
LOCK TABLE public.tournaments IN ACCESS EXCLUSIVE MODE NOWAIT;
LOCK TABLE public.tournament_players IN ACCESS EXCLUSIVE MODE NOWAIT;
DO $lock_optional_flights$
BEGIN
  IF to_regclass('public.tournament_flights') IS NOT NULL THEN
    EXECUTE 'LOCK TABLE public.tournament_flights IN ACCESS EXCLUSIVE MODE NOWAIT';
  END IF;
END;
$lock_optional_flights$;
LOCK TABLE public.tables IN ACCESS EXCLUSIVE MODE NOWAIT;
LOCK TABLE public.table_seats IN ACCESS EXCLUSIVE MODE NOWAIT;
LOCK TABLE public.hand_state_snapshots IN SHARE ROW EXCLUSIVE MODE NOWAIT;
LOCK TABLE public.settlement_idempotency_keys IN SHARE ROW EXCLUSIVE MODE NOWAIT;
LOCK TABLE public.hand_atomic_commits IN SHARE ROW EXCLUSIVE MODE NOWAIT;

CREATE TEMP TABLE pg_temp.fractional_stack_cutover_cohort
ON COMMIT DROP
AS
SELECT DISTINCT t.id AS tournament_id
  FROM public.tournaments t
  JOIN public.tables tb ON tb.tournament_id = t.id
  JOIN public.table_seats s ON s.table_id = tb.id AND s.left_at IS NULL
 WHERE upper(COALESCE(t.status::text, ''))
         NOT IN ('COMPLETED', 'CANCELLED', 'CANCELED')
   AND s.stack IS NOT NULL
   AND (
     lower(s.stack::text) IN ('nan', 'infinity', '-infinity')
     OR s.stack <> trunc(s.stack)
     OR (
       s.stack = trunc(s.stack)
       AND s.stack >= 1
       AND EXISTS (
         SELECT 1
           FROM public.tournament_players tp
          WHERE tp.tournament_id = t.id
            AND tp.user_id = s.user_id
            AND tp.table_id = tb.id
            AND tp.seat_number = s.seat_number
            AND tp.status::text IN ('registered', 'playing')
            AND tp.chips = s.stack::bigint - 1
       )
     )
   );

CREATE TEMP TABLE pg_temp.fractional_stack_cutover_observation
ON COMMIT DROP
AS
SELECT
  t.id AS tournament_id,
  upper(COALESCE(t.status::text, '')) AS tournament_status,
  tb.id AS table_id,
  s.id AS seat_id,
  s.joined_at AS seat_joined_at,
  s.seat_number,
  s.user_id,
  s.stack AS old_stack,
  tp.id AS tournament_player_id,
  tp.chips AS old_player_chips,
  tp.status::text AS old_player_status,
  to_jsonb(t) AS tournament_before,
  to_jsonb(tb) AS table_before,
  to_jsonb(s) AS seat_before,
  to_jsonb(tp) AS player_before,
  NULL::numeric(15,2) AS target_stack
FROM pg_temp.fractional_stack_cutover_cohort cohort
JOIN public.tournaments t ON t.id = cohort.tournament_id
JOIN public.tables tb ON tb.tournament_id = t.id
JOIN public.table_seats s ON s.table_id = tb.id AND s.left_at IS NULL
LEFT JOIN public.tournament_players tp
  ON tp.tournament_id = t.id AND tp.user_id = s.user_id;

DO $prove_stopped_exact_observation$
DECLARE
  v_expected_sha8 text := current_setting('app.cutover_expected_engine_sha8');
  v_min_remaining integer :=
    current_setting('app.cutover_min_remaining_seconds')::integer;
  v_announced_at timestamptz;
BEGIN
  IF v_expected_sha8 !~ '^[0-9a-f]{8}$' THEN
    RAISE EXCEPTION
      'FRACTIONAL_STACK_MEASUREMENT_ENGINE_INVALID: expected engine must be eight lowercase hex characters'
      USING ERRCODE = '22023';
  END IF;
  IF v_min_remaining < 210 OR v_min_remaining >= 900 THEN
    RAISE EXCEPTION
      'FRACTIONAL_STACK_MEASUREMENT_BUDGET_INVALID: remaining-time floor must be 210..899 seconds'
      USING ERRCODE = '22023';
  END IF;

  SELECT b.announced_at
    INTO STRICT v_announced_at
    FROM public.engine_maintenance_break b
   WHERE b.id
     AND b.phase = 'counting_down'
     AND b.enforce_freeze
     AND b.break_started_at IS NOT NULL
     AND b.break_ends_at >
           clock_timestamp() + make_interval(secs => v_min_remaining)
     AND b.break_ends_at < clock_timestamp() + interval '15 minutes'
     AND b.declared_by = v_expected_sha8;

  IF NOT public.fn_platform_frozen() THEN
    RAISE EXCEPTION
      'FRACTIONAL_STACK_MEASUREMENT_FREEZE_INVALID: exact build must own a live enforced counting_down freeze'
      USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
       SELECT 1 FROM public.engine_leader l
        WHERE l.heartbeat_at >= clock_timestamp() - interval '30 seconds'
     )
     OR EXISTS (
       SELECT 1 FROM public.engine_table_leases l
        WHERE l.heartbeat_at >= clock_timestamp() - interval '30 seconds'
     )
     OR EXISTS (
       SELECT 1 FROM public.engine_tournament_leases l
        WHERE l.heartbeat_at >= clock_timestamp() - interval '30 seconds'
     ) THEN
    RAISE EXCEPTION
      'FRACTIONAL_STACK_MEASUREMENT_ENGINE_STILL_LIVE: stop the exact engine and wait more than 30 seconds'
      USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
       SELECT 1 FROM public.engine_leader l
        WHERE (l.acquired_at >= v_announced_at OR l.heartbeat_at >= v_announced_at)
          AND l.engine_version IS DISTINCT FROM v_expected_sha8
     )
     OR EXISTS (
       SELECT 1 FROM public.engine_table_leases l
        WHERE (l.acquired_at >= v_announced_at OR l.heartbeat_at >= v_announced_at)
          AND (l.engine_version IS DISTINCT FROM v_expected_sha8
               OR l.protocol_version IS DISTINCT FROM 2)
     )
     OR EXISTS (
       SELECT 1 FROM public.engine_tournament_leases l
        WHERE (l.acquired_at >= v_announced_at OR l.heartbeat_at >= v_announced_at)
          AND (l.engine_version IS DISTINCT FROM v_expected_sha8
               OR l.protocol_version IS DISTINCT FROM 2)
     ) THEN
    RAISE EXCEPTION
      'FRACTIONAL_STACK_MEASUREMENT_ENGINE_VERSION_DRIFT: every authority since announcement must be the expected protocol-2 build'
      USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.table_seats s
      JOIN public.tables tb ON tb.id = s.table_id
     WHERE tb.tournament_id IS NULL
       AND lower(COALESCE(tb.game_type::text, '')) = 'tournament'
       AND s.left_at IS NULL
       AND s.stack IS NOT NULL
       AND (
         lower(s.stack::text) IN ('nan', 'infinity', '-infinity')
         OR s.stack <> trunc(s.stack)
       )
  ) THEN
    RAISE EXCEPTION
      'FRACTIONAL_STACK_MEASUREMENT_UNOWNED_TABLE: a tournament-classified table has no tournament parent'
      USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
       SELECT 1
         FROM public.hand_state_snapshots h
         JOIN public.tables t ON t.id = h.table_id
        WHERE t.tournament_id IN (
                SELECT c.tournament_id
                  FROM pg_temp.fractional_stack_cutover_cohort c
              )
          AND NOT h.is_complete
     )
     OR EXISTS (
       SELECT 1
         FROM public.settlement_idempotency_keys k
         JOIN public.tables t ON t.id = k.table_id
        WHERE t.tournament_id IN (
                SELECT c.tournament_id
                  FROM pg_temp.fractional_stack_cutover_cohort c
              )
          AND k.status = 'in_flight'
     )
     OR EXISTS (
       SELECT 1
         FROM public.hand_atomic_commits c
         JOIN public.tables t ON t.id = c.table_id
        WHERE t.tournament_id IN (
                SELECT cohort.tournament_id
                  FROM pg_temp.fractional_stack_cutover_cohort cohort
              )
          AND c.post_commit_payload IS NOT NULL
          AND c.post_commit_completed_at IS NULL
     ) THEN
    RAISE EXCEPTION
      'FRACTIONAL_STACK_MEASUREMENT_HAND_IN_FLIGHT: hand state must be fully quiet'
      USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_temp.fractional_stack_cutover_observation p
     WHERE p.tournament_player_id IS NULL
        OR p.seat_joined_at IS NULL
        OR p.user_id IS NULL
        OR p.old_stack IS NULL
        OR p.old_stack < 0
        OR p.old_stack > 9999999999999
        OR lower(p.old_stack::text) IN ('nan', 'infinity', '-infinity')
        OR (
          p.old_player_chips IS DISTINCT FROM floor(p.old_stack)::bigint
          AND NOT (
            p.old_stack = trunc(p.old_stack)
            AND p.old_stack >= 1
            AND p.old_player_chips = p.old_stack::bigint - 1
          )
        )
  ) THEN
    RAISE EXCEPTION
      'FRACTIONAL_STACK_MEASUREMENT_IDENTITY_MISMATCH: every active seat needs one finite stack and its floor-valued roster mirror'
      USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_temp.fractional_stack_cutover_observation p
     WHERE NOT (
             p.old_player_status IN ('registered', 'playing')
             OR (
               p.tournament_status = 'COMPLETING'
               AND p.old_player_status = 'winner'
             )
           )
        OR (p.tournament_status = 'RUNNING' AND p.old_player_status <> 'playing')
        OR EXISTS (
          SELECT 1 FROM public.tournament_players tp
           WHERE tp.id = p.tournament_player_id
             AND (tp.table_id IS DISTINCT FROM p.table_id
                  OR tp.seat_number IS DISTINCT FROM p.seat_number)
        )
  )
  OR EXISTS (
    SELECT 1
      FROM pg_temp.fractional_stack_cutover_observation p
     GROUP BY p.tournament_id, p.user_id
    HAVING count(*) <> 1
  )
  OR EXISTS (
    SELECT 1
      FROM public.tournament_players tp
      JOIN public.tournaments t ON t.id = tp.tournament_id
     WHERE tp.tournament_id IN (
             SELECT c.tournament_id
               FROM pg_temp.fractional_stack_cutover_cohort c
           )
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
       AND NOT EXISTS (
         SELECT 1
           FROM pg_temp.fractional_stack_cutover_observation p
          WHERE p.tournament_player_id = tp.id
       )
  ) THEN
    RAISE EXCEPTION
      'FRACTIONAL_STACK_MEASUREMENT_IDENTITY_MISMATCH: status, table, seat, or active-generation mapping drifted'
      USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_temp.fractional_stack_cutover_observation p
     GROUP BY p.tournament_id
    HAVING sum(p.old_stack) <> trunc(sum(p.old_stack))
  ) THEN
    RAISE EXCEPTION
      'FRACTIONAL_STACK_MEASUREMENT_AGGREGATE_INVALID: every tournament total must already be whole'
      USING ERRCODE = '22003';
  END IF;
END;
$prove_stopped_exact_observation$;

WITH ranked AS (
  SELECT
    p.seat_id,
    p.seat_joined_at,
    floor(p.old_stack) AS base_stack,
    (sum(p.old_stack) OVER (PARTITION BY p.tournament_id)
     - sum(floor(p.old_stack)) OVER (PARTITION BY p.tournament_id))::bigint
      AS bonus_count,
    row_number() OVER (
      PARTITION BY p.tournament_id
      ORDER BY (p.old_stack - floor(p.old_stack)) DESC,
               p.table_id, p.seat_number, p.seat_id,
               p.seat_joined_at, p.user_id
    ) AS remainder_rank
  FROM pg_temp.fractional_stack_cutover_observation p
)
UPDATE pg_temp.fractional_stack_cutover_observation p
   SET target_stack = (
     r.base_stack + CASE WHEN r.remainder_rank <= r.bonus_count THEN 1 ELSE 0 END
   )::numeric(15,2)
  FROM ranked r
 WHERE r.seat_id = p.seat_id
   AND r.seat_joined_at = p.seat_joined_at;

DO $prove_observed_plan$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_temp.fractional_stack_cutover_observation p
     WHERE p.target_stack IS NULL
        OR p.target_stack <> trunc(p.target_stack)
        OR p.target_stack < 0
        OR p.target_stack > 9999999999999
  )
  OR EXISTS (
    SELECT 1 FROM pg_temp.fractional_stack_cutover_observation p
     GROUP BY p.tournament_id
    HAVING sum(p.target_stack) IS DISTINCT FROM sum(p.old_stack)
  ) THEN
    RAISE EXCEPTION
      'FRACTIONAL_STACK_MEASUREMENT_PLAN_INVALID: largest-remainder plan is not whole and conservative'
      USING ERRCODE = '22003';
  END IF;
END;
$prove_observed_plan$;

WITH hashes AS (
  SELECT
    encode(extensions.digest(COALESCE(string_agg(
      jsonb_build_object(
        'tournament', p.tournament_before,
        'table', p.table_before,
        'seat', p.seat_before,
        'tournament_player', p.player_before
      )::text,
      E'\n' ORDER BY p.tournament_id, p.table_id, p.seat_number,
                     p.seat_id, p.seat_joined_at, p.user_id
    ), ''), 'sha256'), 'hex') AS pre_sha,
    encode(extensions.digest(COALESCE(string_agg(
      jsonb_build_object(
        'tournament', p.tournament_before,
        'table', p.table_before,
        'seat', jsonb_set(
          p.seat_before, '{stack}', to_jsonb(p.target_stack), false
        ),
        'tournament_player', jsonb_set(
          p.player_before, '{chips}', to_jsonb(p.target_stack::bigint), false
        )
      )::text,
      E'\n' ORDER BY p.tournament_id, p.table_id, p.seat_number,
                     p.seat_id, p.seat_joined_at, p.user_id
    ), ''), 'sha256'), 'hex') AS post_sha
  FROM pg_temp.fractional_stack_cutover_observation p
), literals AS (
  SELECT
    current_setting('app.cutover_expected_engine_sha8') AS engine_sha8,
    COALESCE((
      SELECT string_agg(c.tournament_id::text, ',' ORDER BY c.tournament_id)
        FROM pg_temp.fractional_stack_cutover_cohort c
    ), '') AS tournament_ids_csv,
    count(DISTINCT p.tournament_id) AS tournament_count,
    count(DISTINCT p.table_id) AS table_count,
    count(*) AS active_seat_count,
    count(*) FILTER (WHERE p.old_stack <> trunc(p.old_stack))
      AS fractional_seat_count,
    COALESCE(sum(p.old_stack), 0) AS total_chips,
    (SELECT h.pre_sha FROM hashes h) AS preimage_sha256,
    (SELECT h.post_sha FROM hashes h) AS postimage_sha256
  FROM pg_temp.fractional_stack_cutover_observation p
)
SELECT
  l.engine_sha8,
  l.tournament_ids_csv,
  l.tournament_count,
  l.table_count,
  l.active_seat_count,
  l.fractional_seat_count,
  l.total_chips,
  l.preimage_sha256,
  l.postimage_sha256
FROM literals l;

ROLLBACK;
