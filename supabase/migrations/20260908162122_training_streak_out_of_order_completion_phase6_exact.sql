-- BACKFILLED 2026-09-12 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260908162122; the .sql file was never committed at the
-- time. Content below is byte-exact to what ran. Do NOT re-apply; it is already live.
--
-- ===========================================================================
--  THIS IS A MIRROR. IT DESCRIBES DDL PRODUCTION ALREADY HAS.
-- ===========================================================================
--
-- LEDGER ROW
--   version     20260908162122   (the stamp IS the apply time, UTC: 2026-09-08 16:21:22)
--   name        training_streak_out_of_order_completion_phase6_exact
--   created_by  daniel@bekavactrading.com
--   statements  1 statement(s), 30638 bytes
--
-- WHY THE FILENAME VERSION WAS NOT RESERVED
--
-- CLAUDE.md 4.5 says never hand-pick a migration version and always run
-- scripts/new-migration.mjs. A mirror is the one sanctioned exception, and the
-- exception is what makes it safe: 20260908162122 IS ALREADY IN
-- supabase_migrations.schema_migrations under the name above. Reserving a fresh
-- version would open a SECOND ledger row for DDL that has run once, and a
-- rebuild would then apply it twice. The file must carry the version the ledger
-- already holds, or it is not a mirror of anything.
--
-- WHAT IT CREATES OR CHANGES (read out of the recorded statements, not guessed)
--     TRIGGER        training_streak_activity_days_immutable_v1, training_attempts_capture_streak_activity_v1
--     FUNCTION       public.fn_training_streak_activity_immutable_v1, public.fn_training_streak_summary_v1, public.fn_training_capture_streak_activity_v1
--     TABLE          public.training_streak_activity_days, public.training_streak_interval_migration_v1
--     DROP           TRIGGER training_streak_activity_days_immutable_v1, TRIGGER training_attempts_capture_streak_activity_v1, TABLE public.training_streak_interval_migration_v1
--     RLS-ENABLE     
--
--   NOTE: it also changes GRANT/REVOKE on what it touches.
--   NOTE: it also contains DML (INSERT/UPDATE/DELETE) against live rows.
--
-- HOW FAITHFUL THIS IS
--
-- RECOVERED, NOT RECONSTRUCTED. The body is the ledger's own `statements`
-- array joined by newlines - the same text Supabase split the original file
-- INTO - so it is the SQL that ran, not a re-derivation from pg_proc. Nothing
-- below was typed by hand. The header is the only added text, and every fact
-- in it comes from the ledger row or from the body.
--
-- DO NOT APPLY THIS FILE BY HAND. It is already live. Where the body contains
-- DML, re-running it would repeat a live data change that nobody asked this
-- bookkeeping branch to make.
-- ===========================================================================

-- Completion order is not activity order. Persist one authoritative activity
-- day per user, then derive streak islands from that immutable ledger so a
-- late bridge (day 3, day 1, day 2) converges to the same result as chronological
-- settlement. Daily attempts use their issuance day; ordinary attempts keep
-- their completion day.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';
SET LOCAL search_path = pg_catalog;

CREATE TABLE IF NOT EXISTS public.training_streak_activity_days (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  activity_date date NOT NULL,
  first_attempt_id uuid,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, activity_date)
);

-- Refuse to backfill or trust a partial/pre-created ledger. The immutable
-- authority projection is safe only with this exact four-column, two-key
-- contract.
DO $streak_activity_shape$
DECLARE
  activity_oid pg_catalog.oid := pg_catalog.to_regclass('public.training_streak_activity_days');
BEGIN
  IF NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_class
       WHERE oid = activity_oid AND relkind = 'r'
     )
     OR (SELECT count(*) FROM pg_catalog.pg_attribute
         WHERE attrelid = activity_oid AND attnum > 0 AND NOT attisdropped) <> 4
     OR EXISTS (
       SELECT 1
       FROM (VALUES
         ('user_id', 1, 'uuid', true, NULL::text),
         ('activity_date', 2, 'date', true, NULL::text),
         ('first_attempt_id', 3, 'uuid', false, NULL::text),
         ('recorded_at', 4, 'timestamp with time zone', true, 'now()'::text)
       ) expected(attname, attnum, type_name, not_null, default_expr)
       LEFT JOIN pg_catalog.pg_attribute attributes
         ON attributes.attrelid = activity_oid
        AND attributes.attname = expected.attname
        AND attributes.attnum = expected.attnum
        AND NOT attributes.attisdropped
       LEFT JOIN pg_catalog.pg_attrdef defaults
         ON defaults.adrelid = attributes.attrelid
        AND defaults.adnum = attributes.attnum
       WHERE attributes.attname IS NULL
          OR pg_catalog.format_type(attributes.atttypid, attributes.atttypmod)
             IS DISTINCT FROM expected.type_name
          OR attributes.attnotnull IS DISTINCT FROM expected.not_null
          OR pg_catalog.pg_get_expr(defaults.adbin, defaults.adrelid)
             IS DISTINCT FROM expected.default_expr
     )
     OR (SELECT count(*) FROM pg_catalog.pg_constraint
         WHERE conrelid = activity_oid) <> 2
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_constraint
       WHERE conrelid = activity_oid
         AND conname = 'training_streak_activity_days_pkey'
         AND contype = 'p'
         AND convalidated
         AND NOT condeferrable
         AND NOT condeferred
         AND conkey = ARRAY[1, 2]::smallint[]
     )
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_constraint
       WHERE conrelid = activity_oid
         AND conname = 'training_streak_activity_days_user_id_fkey'
         AND contype = 'f'
         AND confrelid = 'auth.users'::pg_catalog.regclass
         AND conkey = ARRAY[1]::smallint[]
         AND confdeltype = 'c'
     ) THEN
    RAISE EXCEPTION 'TRAINING_STREAK_ACTIVITY_TABLE_SHAPE_INVALID';
  END IF;
END;
$streak_activity_shape$;

-- Both the transition trigger and the final completion function use
-- ON CONFLICT (user_id). PostgreSQL cannot use a DEFERRABLE unique constraint
-- as that arbiter, so reject compatible-looking predecessor drift up front.
DO $streak_conflict_arbiter_shape$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint constraint_row
    WHERE constraint_row.conrelid = 'public.training_streaks'::pg_catalog.regclass
      AND constraint_row.contype IN ('p', 'u')
      AND constraint_row.convalidated
      AND NOT constraint_row.condeferrable
      AND NOT constraint_row.condeferred
      AND constraint_row.conkey = ARRAY[
        (SELECT attribute_row.attnum
         FROM pg_catalog.pg_attribute attribute_row
         WHERE attribute_row.attrelid = 'public.training_streaks'::pg_catalog.regclass
           AND attribute_row.attname = 'user_id'
           AND NOT attribute_row.attisdropped)
      ]::smallint[]
  ) THEN
    RAISE EXCEPTION 'TRAINING_STREAK_CONFLICT_ARBITER_INVALID';
  END IF;
END;
$streak_conflict_arbiter_shape$;

COMMENT ON TABLE public.training_streak_activity_days IS
  'Immutable authoritative Training activity days used to derive order-independent streak islands.';

CREATE OR REPLACE FUNCTION public.fn_training_streak_activity_immutable_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog
AS $function$
BEGIN
  -- PostgreSQL executes child-table DELETE triggers during an ON DELETE
  -- CASCADE. Account erasure is the sole legitimate delete path for this
  -- otherwise immutable authority ledger.
  IF TG_OP = 'DELETE' AND NOT EXISTS (
    SELECT 1 FROM auth.users users WHERE users.id = OLD.user_id
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION USING
    ERRCODE = '23514',
    MESSAGE = 'TRAINING_STREAK_ACTIVITY_DAY_IMMUTABLE';
END;
$function$;

DROP TRIGGER IF EXISTS training_streak_activity_days_immutable_v1
  ON public.training_streak_activity_days;
CREATE TRIGGER training_streak_activity_days_immutable_v1
  BEFORE UPDATE OR DELETE ON public.training_streak_activity_days
  FOR EACH ROW EXECUTE FUNCTION public.fn_training_streak_activity_immutable_v1();

-- Snapshot the pre-migration authoritative intervals before publishing the
-- capture trigger. This short lock prevents a predecessor completion from
-- collapsing an interval whose middle days exist only in the materialized
-- streak row. A private durable staging table survives a failed later
-- transaction/retry and lets direct attempt evidence win every overlap. The
-- expensive attempt scan stays outside this lock.
LOCK TABLE public.training_streaks IN SHARE MODE;

CREATE TABLE IF NOT EXISTS public.training_streak_interval_migration_v1 (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  activity_date date NOT NULL,
  PRIMARY KEY (user_id, activity_date)
);

DO $streak_interval_stage_shape$
DECLARE
  stage_oid pg_catalog.oid := pg_catalog.to_regclass(
    'public.training_streak_interval_migration_v1'
  );
BEGIN
  IF NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_class
       WHERE oid = stage_oid AND relkind = 'r'
     )
     OR (SELECT count(*) FROM pg_catalog.pg_attribute
         WHERE attrelid = stage_oid AND attnum > 0 AND NOT attisdropped) <> 2
     OR EXISTS (
       SELECT 1
       FROM (VALUES
         ('user_id', 1, 'uuid', true, NULL::text),
         ('activity_date', 2, 'date', true, NULL::text)
       ) expected(attname, attnum, type_name, not_null, default_expr)
       LEFT JOIN pg_catalog.pg_attribute attributes
         ON attributes.attrelid = stage_oid
        AND attributes.attname = expected.attname
        AND attributes.attnum = expected.attnum
        AND NOT attributes.attisdropped
       LEFT JOIN pg_catalog.pg_attrdef defaults
         ON defaults.adrelid = attributes.attrelid
        AND defaults.adnum = attributes.attnum
       WHERE attributes.attname IS NULL
          OR pg_catalog.format_type(attributes.atttypid, attributes.atttypmod)
             IS DISTINCT FROM expected.type_name
          OR attributes.attnotnull IS DISTINCT FROM expected.not_null
          OR pg_catalog.pg_get_expr(defaults.adbin, defaults.adrelid)
             IS DISTINCT FROM expected.default_expr
     )
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_constraint
       WHERE conrelid = stage_oid
         AND conname = 'training_streak_interval_migration_v1_pkey'
         AND contype = 'p' AND convalidated
         AND NOT condeferrable
         AND NOT condeferred
         AND conkey = ARRAY[1, 2]::smallint[]
         AND pg_catalog.pg_get_constraintdef(oid, true)
             = 'PRIMARY KEY (user_id, activity_date)'
     )
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_constraint
       WHERE conrelid = stage_oid
         AND conname = 'training_streak_interval_migration_v1_user_id_fkey'
         AND contype = 'f' AND convalidated
         AND conkey = ARRAY[1]::smallint[]
         AND confrelid = 'auth.users'::pg_catalog.regclass
         AND confdeltype = 'c'
         AND pg_catalog.pg_get_constraintdef(oid, true)
             = 'FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE'
     )
     OR (SELECT count(*) FROM pg_catalog.pg_constraint
         WHERE conrelid = stage_oid) <> 2 THEN
    RAISE EXCEPTION 'TRAINING_STREAK_INTERVAL_STAGE_SHAPE_INVALID';
  END IF;
END;
$streak_interval_stage_shape$;

ALTER TABLE public.training_streak_interval_migration_v1 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.training_streak_interval_migration_v1
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL PRIVILEGES (user_id, activity_date)
  ON public.training_streak_interval_migration_v1
  FROM PUBLIC, anon, authenticated, service_role;

INSERT INTO public.training_streak_interval_migration_v1 (
  user_id, activity_date
)
SELECT
  streaks.user_id,
  inferred.activity_date::date
FROM public.training_streaks streaks
CROSS JOIN LATERAL generate_series(
  coalesce(
    streaks.authority_streak_start_date,
    streaks.authority_last_training_date
      - greatest(streaks.authority_current_streak - 1, 0)
  )::timestamp,
  streaks.authority_last_training_date::timestamp,
  interval '1 day'
) AS inferred(activity_date)
WHERE streaks.authority_current_streak > 0
  AND streaks.authority_last_training_date IS NOT NULL
  AND coalesce(
    streaks.authority_streak_start_date,
    streaks.authority_last_training_date
      - greatest(streaks.authority_current_streak - 1, 0)
  ) <= streaks.authority_last_training_date
ON CONFLICT (user_id, activity_date) DO NOTHING;

CREATE OR REPLACE FUNCTION public.fn_training_streak_summary_v1(
  p_user_id uuid
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO pg_catalog
AS $function$
  -- Until the historical scan commits, the durable private interval snapshot
  -- is part of the authority projection. Without this union, a live completion
  -- between migration checkpoints could collapse a preserved streak to only
  -- the newly captured day. UNION also prevents a staged/direct overlap from
  -- appearing twice.
  WITH authority_days AS (
    SELECT activity_date
    FROM public.training_streak_activity_days
    WHERE user_id = p_user_id
    UNION
    SELECT activity_date
    FROM public.training_streak_interval_migration_v1
    WHERE user_id = p_user_id
  ), ordered_days AS (
    SELECT
      activity_date,
      activity_date
        - row_number() OVER (ORDER BY activity_date)::integer AS island_key
    FROM authority_days
  ), islands AS (
    SELECT
      min(activity_date) AS start_date,
      max(activity_date) AS last_date,
      count(*)::integer AS day_count
    FROM ordered_days
    GROUP BY island_key
  ), ranked AS (
    SELECT
      islands.*,
      max(day_count) OVER () AS longest_count,
      row_number() OVER (ORDER BY last_date DESC) AS recency_rank
    FROM islands
  )
  SELECT jsonb_build_object(
    'current', day_count,
    'longest', longest_count,
    'startDate', start_date,
    'lastDate', last_date
  )
  FROM ranked
  WHERE recency_rank = 1;
$function$;

-- Install a durable write-through projection before beginning any bulk
-- backfill. This closes the deployment window without holding a table-wide
-- completion lock for the duration of the historical scan: an old application
-- completion that commits while the migration continues is captured and its
-- materialized streak is corrected after the predecessor function's update.
CREATE OR REPLACE FUNCTION public.fn_training_capture_streak_activity_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog
AS $function$
DECLARE
  v_activity_date date;
  v_summary jsonb;
BEGIN
  IF NEW.status IS DISTINCT FROM 'completed'
     OR NEW.practice_only
     OR (
       TG_OP = 'UPDATE'
       AND OLD.status IS NOT DISTINCT FROM 'completed'
     ) THEN
    RETURN NEW;
  END IF;
  IF NEW.session_kind = 'daily'
     AND NOT public.fn_training_daily_attempt_matches_start_v1(
       NEW.client_nonce,
       NEW.started_at
     ) THEN
    RETURN NEW;
  END IF;

  v_activity_date := CASE
    WHEN NEW.session_kind = 'daily'
      THEN timezone('America/Chicago', NEW.started_at)::date
    ELSE timezone('America/Chicago', NEW.completed_at)::date
  END;
  IF v_activity_date IS NULL THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.training_streaks AS streaks (
    user_id, current_streak, longest_streak, last_training_date,
    streak_start_date, milestones_claimed,
    authority_current_streak, authority_longest_streak,
    authority_last_training_date, authority_streak_start_date,
    authority_milestones_claimed, created_at, updated_at
  ) VALUES (
    NEW.user_id, 1, 1, v_activity_date,
    v_activity_date, '[]'::jsonb,
    1, 1, v_activity_date, v_activity_date, '[]'::jsonb, now(), now()
  )
  ON CONFLICT (user_id) DO NOTHING;

  PERFORM 1
  FROM public.training_streaks streaks
  WHERE streaks.user_id = NEW.user_id
  FOR UPDATE;

  INSERT INTO public.training_streak_activity_days (
    user_id, activity_date, first_attempt_id
  ) VALUES (
    NEW.user_id, v_activity_date, NEW.id
  )
  ON CONFLICT (user_id, activity_date) DO NOTHING;

  v_summary := public.fn_training_streak_summary_v1(NEW.user_id);
  UPDATE public.training_streaks AS streaks
  SET
    authority_current_streak = (v_summary ->> 'current')::integer,
    authority_longest_streak = greatest(
      streaks.authority_longest_streak,
      (v_summary ->> 'longest')::integer
    ),
    authority_last_training_date = (v_summary ->> 'lastDate')::date,
    authority_streak_start_date = (v_summary ->> 'startDate')::date,
    current_streak = (v_summary ->> 'current')::integer,
    longest_streak = greatest(
      streaks.authority_longest_streak,
      (v_summary ->> 'longest')::integer
    ),
    last_training_date = (v_summary ->> 'lastDate')::date,
    streak_start_date = (v_summary ->> 'startDate')::date,
    milestones_claimed = streaks.authority_milestones_claimed,
    updated_at = now()
  WHERE streaks.user_id = NEW.user_id;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS training_attempts_capture_streak_activity_v1
  ON public.training_attempts;
CREATE TRIGGER training_attempts_capture_streak_activity_v1
  AFTER INSERT OR UPDATE OF status ON public.training_attempts
  FOR EACH ROW EXECUTE FUNCTION public.fn_training_capture_streak_activity_v1();

-- The first durable boundary must already be private. Supabase production
-- grants broad default privileges on new public tables, so committing before
-- both table and per-column ACL cleanup would expose an INSERT poisoning
-- window for the duration of the historical backfill.
ALTER TABLE public.training_streak_activity_days ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.training_streak_activity_days
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL PRIVILEGES (user_id, activity_date, first_attempt_id, recorded_at)
  ON public.training_streak_activity_days
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_training_streak_activity_immutable_v1()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_training_streak_summary_v1(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_training_capture_streak_activity_v1()
  FROM PUBLIC, anon, authenticated, service_role;

-- Make the private write-through capture and preserved historical intervals
-- visible before the completed-attempt scan. The second transaction can now
-- backfill without blocking live completions for its full duration.
COMMIT;

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';
SET LOCAL search_path = pg_catalog;

-- Recover every date that has direct sealed completion evidence. The daily
-- branch deliberately uses started_at and rejects malformed issuance identity;
-- all other real attempts retain their historical completion-day semantics.
WITH completed_attempt_days AS (
  SELECT
    attempts.user_id,
    CASE
      WHEN attempts.session_kind = 'daily'
        THEN timezone('America/Chicago', attempts.started_at)::date
      ELSE timezone('America/Chicago', attempts.completed_at)::date
    END AS activity_date,
    attempts.id AS attempt_id,
    attempts.completed_at
  FROM public.training_attempts attempts
  WHERE attempts.status = 'completed'
    AND NOT attempts.practice_only
    AND (
      attempts.session_kind <> 'daily'
      OR public.fn_training_daily_attempt_matches_start_v1(
        attempts.client_nonce,
        attempts.started_at
      )
    )
), first_attempt_per_day AS (
  SELECT DISTINCT ON (user_id, activity_date)
    user_id, activity_date, attempt_id
  FROM completed_attempt_days
  WHERE activity_date IS NOT NULL
  ORDER BY user_id, activity_date, completed_at ASC, attempt_id ASC
)
INSERT INTO public.training_streak_activity_days (
  user_id, activity_date, first_attempt_id
)
SELECT user_id, activity_date, attempt_id
FROM first_attempt_per_day
ON CONFLICT (user_id, activity_date) DO NOTHING;

-- Preserve snapshot-only historical days after direct evidence has won every
-- overlap. NULL explicitly means the day came from the pre-cutover authority
-- interval rather than from a retained completed attempt.
INSERT INTO public.training_streak_activity_days (
  user_id, activity_date, first_attempt_id
)
SELECT user_id, activity_date, NULL
FROM public.training_streak_interval_migration_v1
ON CONFLICT (user_id, activity_date) DO NOTHING;

-- Publish the complete historical ledger before reconciling its materialized
-- projection. A completion captured during this transaction may temporarily
-- compute from only the rows visible to its own snapshot; the final, bounded
-- transaction below drains those pre-cutover writers and recomputes from the
-- now-committed union.
COMMIT;

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';
SET LOCAL search_path = pg_catalog;

-- This dated migration has a verified production cardinality of one streak
-- row. Fail closed instead of taking a long blocking lock if it is ever
-- replayed against an unexpectedly large environment; that environment needs
-- an explicit online/batched reconciliation plan.
DO $bounded_final_reconciliation$
DECLARE
  v_rows integer;
BEGIN
  SELECT count(*)::integer INTO v_rows
  FROM (
    SELECT 1
    FROM public.training_streaks
    LIMIT 10001
  ) bounded;
  IF v_rows > 10000 THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'TRAINING_STREAK_RECONCILIATION_REQUIRES_ONLINE_BACKFILL';
  END IF;
END;
$bounded_final_reconciliation$;

-- EXCLUSIVE conflicts with the RowShare lock obtained by completion's early
-- SELECT ... FOR UPDATE while still allowing ordinary reads. This drains even
-- a pre-backfill function invocation before the short final projection and
-- function-swap window. The streak lock also serializes milestone writers.
LOCK TABLE public.training_attempts IN EXCLUSIVE MODE;
LOCK TABLE public.training_streaks IN SHARE ROW EXCLUSIVE MODE;

-- Bring the materialized projection into agreement immediately; do not wait
-- for a player's next completion to repair already out-of-order history. Both
-- the historical backfill and any write-through rows are committed and no old
-- completion writer remains in flight while this snapshot is materialized.
WITH summaries AS MATERIALIZED (
  SELECT
    streaks.user_id,
    public.fn_training_streak_summary_v1(streaks.user_id) AS value
  FROM public.training_streaks streaks
)
UPDATE public.training_streaks AS streaks
SET
  authority_current_streak = (summaries.value ->> 'current')::integer,
  authority_longest_streak = greatest(
    streaks.authority_longest_streak,
    (summaries.value ->> 'longest')::integer
  ),
  authority_last_training_date = (summaries.value ->> 'lastDate')::date,
  authority_streak_start_date = (summaries.value ->> 'startDate')::date,
  current_streak = (summaries.value ->> 'current')::integer,
  longest_streak = greatest(
    streaks.authority_longest_streak,
    (summaries.value ->> 'longest')::integer
  ),
  last_training_date = (summaries.value ->> 'lastDate')::date,
  streak_start_date = (summaries.value ->> 'startDate')::date,
  milestones_claimed = streaks.authority_milestones_claimed,
  updated_at = now()
FROM summaries
WHERE summaries.user_id = streaks.user_id
  AND summaries.value IS NOT NULL;

DO $streak_completion_patch$
DECLARE
  definition text;
  updated_definition text;
  start_marker constant text := 'INSERT INTO public.training_streaks AS streaks (';
  end_marker constant text := 'RETURNING * INTO streak_row;';
  applied_marker constant text := 'INSERT INTO public.training_streak_activity_days (';
  replacement text;
  start_at integer;
  end_relative integer;
  replace_length integer;
BEGIN
  IF to_regprocedure('public.fn_complete_training_attempt_v2(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'TRAINING_COMPLETION_FUNCTION_MISSING';
  END IF;
  SELECT pg_get_functiondef(
    'public.fn_complete_training_attempt_v2(uuid,uuid)'::regprocedure
  ) INTO definition;

  IF position(applied_marker IN definition) > 0 THEN
    RETURN;
  END IF;
  start_at := position(start_marker IN definition);
  end_relative := position(end_marker IN substring(definition FROM start_at));
  IF start_at = 0 OR end_relative = 0 THEN
    RAISE EXCEPTION 'TRAINING_STREAK_UPSERT_BOUNDARY_UNKNOWN';
  END IF;
  replace_length := end_relative - 1 + length(end_marker);

  replacement := $sql$
INSERT INTO public.training_streaks AS streaks (
    user_id, current_streak, longest_streak, last_training_date,
    streak_start_date, milestones_claimed,
    authority_current_streak, authority_longest_streak,
    authority_last_training_date, authority_streak_start_date,
    authority_milestones_claimed, created_at, updated_at
  ) VALUES (
    attempt_row.user_id, 1, 1, activity_chicago_date,
    activity_chicago_date, '[]'::jsonb,
    1, 1, activity_chicago_date, activity_chicago_date, '[]'::jsonb, now(), now()
  )
  ON CONFLICT (user_id) DO NOTHING;

  -- Serialize all days for one player before adding evidence and recomputing
  -- islands. The ledger PK makes same-day concurrent completions idempotent.
  SELECT * INTO streak_row
  FROM public.training_streaks
  WHERE user_id = attempt_row.user_id
  FOR UPDATE;

  INSERT INTO public.training_streak_activity_days (
    user_id, activity_date, first_attempt_id
  ) VALUES (
    attempt_row.user_id, activity_chicago_date, attempt_row.id
  )
  ON CONFLICT (user_id, activity_date) DO NOTHING;

  WITH summary AS MATERIALIZED (
    SELECT public.fn_training_streak_summary_v1(attempt_row.user_id) AS value
  )
  UPDATE public.training_streaks AS streaks
  SET
    authority_current_streak = (summary.value ->> 'current')::integer,
    authority_longest_streak = greatest(
      streaks.authority_longest_streak,
      (summary.value ->> 'longest')::integer
    ),
    authority_last_training_date = (summary.value ->> 'lastDate')::date,
    authority_streak_start_date = (summary.value ->> 'startDate')::date,
    current_streak = (summary.value ->> 'current')::integer,
    longest_streak = greatest(
      streaks.authority_longest_streak,
      (summary.value ->> 'longest')::integer
    ),
    last_training_date = (summary.value ->> 'lastDate')::date,
    streak_start_date = (summary.value ->> 'startDate')::date,
    milestones_claimed = streaks.authority_milestones_claimed,
    updated_at = now()
  FROM summary
  WHERE streaks.user_id = attempt_row.user_id
  RETURNING streaks.* INTO streak_row;
$sql$;

  updated_definition := overlay(
    definition PLACING replacement FROM start_at FOR replace_length
  );
  IF position(applied_marker IN updated_definition) = 0
     OR position('fn_training_streak_summary_v1' IN updated_definition) = 0
     OR position('FOR UPDATE;' IN updated_definition) = 0
     OR position('RETURNING streaks.* INTO streak_row;' IN updated_definition) = 0 THEN
    RAISE EXCEPTION 'TRAINING_STREAK_OUT_OF_ORDER_PATCH_FAILED';
  END IF;
  EXECUTE updated_definition;
END;
$streak_completion_patch$;

ALTER TABLE public.training_streak_activity_days ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.training_streak_activity_days
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL PRIVILEGES (user_id, activity_date, first_attempt_id, recorded_at)
  ON public.training_streak_activity_days
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_training_streak_activity_immutable_v1()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_training_streak_summary_v1(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_training_capture_streak_activity_v1()
  FROM PUBLIC, anon, authenticated, service_role;

-- The historical ledger is now complete and the final writer drain has made
-- the materialized projection exact. Remove the migration-stage dependency
-- from the durable summary function before dropping private staging state.
CREATE OR REPLACE FUNCTION public.fn_training_streak_summary_v1(
  p_user_id uuid
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO pg_catalog
AS $function$
  WITH ordered_days AS (
    SELECT
      activity_date,
      activity_date
        - row_number() OVER (ORDER BY activity_date)::integer AS island_key
    FROM public.training_streak_activity_days
    WHERE user_id = p_user_id
  ), islands AS (
    SELECT
      min(activity_date) AS start_date,
      max(activity_date) AS last_date,
      count(*)::integer AS day_count
    FROM ordered_days
    GROUP BY island_key
  ), ranked AS (
    SELECT
      islands.*,
      max(day_count) OVER () AS longest_count,
      row_number() OVER (ORDER BY last_date DESC) AS recency_rank
    FROM islands
  )
  SELECT jsonb_build_object(
    'current', day_count,
    'longest', longest_count,
    'startDate', start_date,
    'lastDate', last_date
  )
  FROM ranked
  WHERE recency_rank = 1;
$function$;
REVOKE ALL ON FUNCTION public.fn_training_streak_summary_v1(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

-- Remove migration-only state only in the same transaction that has drained
-- predecessor completions, reconciled every projection, and swapped the
-- completion function. A failure before here deliberately leaves the private
-- snapshot available to the next retry.
DROP TABLE public.training_streak_interval_migration_v1;

DO $audit$
DECLARE
  completion_definition text;
BEGIN
  SELECT pg_get_functiondef(
    'public.fn_complete_training_attempt_v2(uuid,uuid)'::regprocedure
  ) INTO completion_definition;
  IF to_regclass('public.training_streak_activity_days') IS NULL
     OR to_regclass('public.training_streak_interval_migration_v1') IS NOT NULL
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_class
       WHERE oid = 'public.training_streak_activity_days'::pg_catalog.regclass
         AND relkind = 'r' AND relrowsecurity
     )
     OR NOT EXISTS (
       SELECT 1 FROM pg_trigger
       WHERE tgrelid = 'public.training_streak_activity_days'::regclass
         AND tgname = 'training_streak_activity_days_immutable_v1'
         AND NOT tgisinternal
     )
     OR NOT EXISTS (
       SELECT 1 FROM pg_trigger
       WHERE tgrelid = 'public.training_attempts'::regclass
         AND tgname = 'training_attempts_capture_streak_activity_v1'
         AND NOT tgisinternal
     )
     OR EXISTS (
       SELECT 1
       FROM (VALUES ('anon'), ('authenticated'), ('service_role'))
         AS role_under_test(role_name)
       CROSS JOIN (
         VALUES
           ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'),
           ('REFERENCES'), ('TRIGGER'), ('MAINTAIN')
       ) AS privilege_under_test(privilege_name)
       WHERE has_table_privilege(
         role_under_test.role_name,
         'public.training_streak_activity_days',
         privilege_under_test.privilege_name
       )
     )
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_attribute attributes
       CROSS JOIN LATERAL pg_catalog.aclexplode(attributes.attacl) acl
       WHERE attributes.attrelid = 'public.training_streak_activity_days'::pg_catalog.regclass
         AND attributes.attnum > 0
         AND NOT attributes.attisdropped
         AND acl.grantee IN (
           0,
           pg_catalog.to_regrole('anon'),
           pg_catalog.to_regrole('authenticated'),
           pg_catalog.to_regrole('service_role')
         )
     )
     OR (SELECT count(*)
         FROM pg_catalog.pg_proc
         WHERE oid IN (
           'public.fn_training_streak_activity_immutable_v1()'::pg_catalog.regprocedure,
           'public.fn_training_streak_summary_v1(uuid)'::pg_catalog.regprocedure,
           'public.fn_training_capture_streak_activity_v1()'::pg_catalog.regprocedure
         )
           AND prosecdef
           AND coalesce(proconfig, ARRAY[]::text[])
             @> ARRAY['search_path=pg_catalog']) <> 3
     OR has_function_privilege(
       'anon', 'public.fn_training_streak_summary_v1(uuid)', 'EXECUTE'
     )
     OR has_function_privilege(
       'authenticated', 'public.fn_training_streak_summary_v1(uuid)', 'EXECUTE'
     )
     OR has_function_privilege(
       'service_role', 'public.fn_training_streak_summary_v1(uuid)', 'EXECUTE'
     )
     OR has_function_privilege(
       'anon', 'public.fn_training_streak_activity_immutable_v1()', 'EXECUTE'
     )
     OR has_function_privilege(
       'authenticated', 'public.fn_training_streak_activity_immutable_v1()', 'EXECUTE'
     )
     OR has_function_privilege(
       'service_role', 'public.fn_training_streak_activity_immutable_v1()', 'EXECUTE'
     )
     OR has_function_privilege(
       'anon', 'public.fn_training_capture_streak_activity_v1()', 'EXECUTE'
     )
     OR has_function_privilege(
       'authenticated', 'public.fn_training_capture_streak_activity_v1()', 'EXECUTE'
     )
     OR has_function_privilege(
       'service_role', 'public.fn_training_capture_streak_activity_v1()', 'EXECUTE'
     )
     OR position('INSERT INTO public.training_streak_activity_days (' IN completion_definition) = 0
     OR position('fn_training_streak_summary_v1' IN completion_definition) = 0
     OR position('FOR UPDATE;' IN completion_definition) = 0 THEN
    RAISE EXCEPTION 'TRAINING_STREAK_OUT_OF_ORDER_CONTRACT_INCOMPLETE';
  END IF;
END;
$audit$;

COMMIT;
