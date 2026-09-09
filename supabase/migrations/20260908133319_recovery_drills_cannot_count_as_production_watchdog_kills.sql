-- 20260908131435_recovery_drills_cannot_count_as_production_watchdog_kills.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
-- `engine_recovery_events.event` says what recovery action ran, but not why it
-- ran. A fault-injection drill deliberately exercises the same kill/rebuild
-- path as a real watchdog failure, so DealRateVerifier counted the drill as a
-- production kill storm. Unit probes made it worse when their shell inherited
-- the service key: dozens of rows from reserved fixture UUIDs reached production.
--
-- Give provenance its own constrained column. Existing/rolling engines default
-- to automatic_recovery so a real kill can never disappear merely because one
-- process has not upgraded yet. The new engine writes both values explicitly;
-- the verifier positively selects the exact real-kill pair. Drills remain in
-- the immutable evidence table, but cannot page the production incident lane.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena production DDL policy).

BEGIN;

ALTER TABLE public.engine_recovery_events
  ADD COLUMN event_class text NOT NULL DEFAULT 'automatic_recovery';

ALTER TABLE public.engine_recovery_events
  ADD CONSTRAINT engine_recovery_events_event_class_check
  CHECK (event_class IN ('automatic_recovery', 'fault_injection'));

COMMENT ON COLUMN public.engine_recovery_events.event_class IS
  'Provenance of the recovery action. automatic_recovery is production incident evidence; fault_injection is an explicit drill and never counts toward the production kill-rate alarm.';

/*
 * Correct only the precisely identified historical probes. These patterned
 * UUIDs are constants in the server test suite and were confirmed absent from
 * public.tables before this migration was authored. The NOT EXISTS guard keeps
 * that proof local to the transaction and refuses to relabel a real table if
 * another environment ever used one of the same UUIDs.
 */
UPDATE public.engine_recovery_events r
   SET event_class = 'fault_injection'
 WHERE r.table_id IN (
         'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid,
         '50505050-5050-4050-8050-505050505050'::uuid,
         'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'::uuid
       )
   AND NOT EXISTS (SELECT 1 FROM public.tables t WHERE t.id = r.table_id);

/* Authorized live drills used this exact reason before structured provenance. */
UPDATE public.engine_recovery_events
   SET event_class = 'fault_injection'
 WHERE event = 'watchdog_kill_rebuild'
   AND detail = 'fault_injection_drill';

/*
 * Rolling-version and stale-test protection at the data boundary. Old engines
 * do not send event_class, and old test branches can still inherit a service
 * key after this migration lands. The legacy drill vocabulary and the three
 * measured fixture UUIDs are exact, closed sets; everything else retains the
 * fail-safe automatic_recovery default so real kills are never hidden during
 * rollout.
 */
CREATE FUNCTION public.fn_classify_engine_recovery_event()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.event_class = 'fault_injection' THEN
    RETURN NEW;
  END IF;

  IF NEW.detail IN ('drill', 'fault_injection_drill') THEN
    NEW.event_class := 'fault_injection';
    RETURN NEW;
  END IF;

  IF NEW.table_id IN (
       'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid,
       '50505050-5050-4050-8050-505050505050'::uuid,
       'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'::uuid
     )
     AND NOT EXISTS (SELECT 1 FROM public.tables t WHERE t.id = NEW.table_id) THEN
    NEW.event_class := 'fault_injection';
  END IF;

  RETURN NEW;
END
$function$;

COMMENT ON FUNCTION public.fn_classify_engine_recovery_event() IS
  'Compatibility classifier for recovery events written by pre-event_class engines and known test fixtures. New engines write event_class explicitly; exact legacy drills are forced to fault_injection while every other row retains automatic_recovery.';

/* Trigger invocation does not require callers to own a direct RPC door. */
REVOKE ALL ON FUNCTION public.fn_classify_engine_recovery_event()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER classify_engine_recovery_event
BEFORE INSERT ON public.engine_recovery_events
FOR EACH ROW
EXECUTE FUNCTION public.fn_classify_engine_recovery_event();

/*
 * The durable maintenance-break scorecard reads the same ledger independently
 * of DealRateVerifier. Patch its one current kill-count expression under an
 * exact-once assertion so a changed function body aborts this migration rather
 * than silently preserving a drill-shaped false result. CREATE OR REPLACE via
 * pg_get_functiondef preserves every unrelated byte and the existing ACL.
 */
DO $patch_scorecard$
DECLARE
  v_def text := pg_get_functiondef(
    'public.fn_ca_record_break_scorecard(timestamp with time zone)'::regprocedure
  );
  v_old constant text := $old$SELECT count(*) INTO v_kill FROM public.engine_recovery_events
   WHERE event = 'watchdog_kill_rebuild' AND created_at >= v_end AND created_at < v_end + interval '5 min';$old$;
  v_new constant text := $new$SELECT count(*) INTO v_kill FROM public.engine_recovery_events
   WHERE event = 'watchdog_kill_rebuild'
     AND event_class = 'automatic_recovery'
     AND created_at >= v_end AND created_at < v_end + interval '5 min';$new$;
  v_matches integer;
BEGIN
  v_matches := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_matches <> 1 THEN
    RAISE EXCEPTION
      'fn_ca_record_break_scorecard kill query anchor found % times; refusing an unproved rewrite',
      v_matches;
  END IF;
  EXECUTE replace(v_def, v_old, v_new);
END
$patch_scorecard$;

CREATE INDEX idx_engine_recovery_events_real_kills_created
  ON public.engine_recovery_events (created_at DESC)
  WHERE event = 'watchdog_kill_rebuild'
    AND event_class = 'automatic_recovery';

DO $assert$
DECLARE
  v_default text;
  v_nullable text;
BEGIN
  SELECT column_default, is_nullable
    INTO v_default, v_nullable
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name = 'engine_recovery_events'
     AND column_name = 'event_class';

  IF v_nullable IS DISTINCT FROM 'NO'
     OR v_default IS NULL
     OR v_default NOT LIKE '%automatic_recovery%' THEN
    RAISE EXCEPTION 'engine recovery event provenance is not fail-safe: default %, nullable %',
      v_default, v_nullable;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint c
      JOIN pg_class r ON r.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = r.relnamespace
     WHERE n.nspname = 'public'
       AND r.relname = 'engine_recovery_events'
       AND c.conname = 'engine_recovery_events_event_class_check'
       AND pg_get_constraintdef(c.oid) LIKE '%automatic_recovery%'
       AND pg_get_constraintdef(c.oid) LIKE '%fault_injection%'
  ) THEN
    RAISE EXCEPTION 'engine recovery event provenance constraint is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_indexes
     WHERE schemaname = 'public'
       AND tablename = 'engine_recovery_events'
       AND indexname = 'idx_engine_recovery_events_real_kills_created'
       AND indexdef LIKE '%watchdog_kill_rebuild%'
       AND indexdef LIKE '%automatic_recovery%'
  ) THEN
    RAISE EXCEPTION 'production watchdog kill index is missing or too broad';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_trigger t
      JOIN pg_class r ON r.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = r.relnamespace
     WHERE n.nspname = 'public'
       AND r.relname = 'engine_recovery_events'
       AND t.tgname = 'classify_engine_recovery_event'
       AND t.tgenabled = 'O'
       AND NOT t.tgisinternal
  ) THEN
    RAISE EXCEPTION 'legacy recovery-event classifier is missing or disabled';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_proc p
      CROSS JOIN LATERAL aclexplode(
        COALESCE(p.proacl, acldefault('f', p.proowner))
      ) a
      LEFT JOIN pg_roles r ON r.oid = a.grantee
     WHERE p.oid = 'public.fn_classify_engine_recovery_event()'::regprocedure
       AND a.privilege_type = 'EXECUTE'
       AND (a.grantee = 0 OR r.rolname IN ('anon', 'authenticated', 'service_role'))
  ) THEN
    RAISE EXCEPTION 'recovery-event classifier retained a direct RPC execute grant';
  END IF;

  IF position(
       'event_class = ''automatic_recovery''' IN
       pg_get_functiondef(
         'public.fn_ca_record_break_scorecard(timestamp with time zone)'::regprocedure
       )
     ) = 0 THEN
    RAISE EXCEPTION 'maintenance break scorecard still counts fault-injection kills';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.engine_recovery_events
     WHERE table_id IN (
             'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid,
             '50505050-5050-4050-8050-505050505050'::uuid,
             'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'::uuid
           )
       AND event_class <> 'fault_injection'
       AND NOT EXISTS (
         SELECT 1
           FROM public.tables t
          WHERE t.id = engine_recovery_events.table_id
       )
  ) THEN
    RAISE EXCEPTION 'known synthetic recovery rows still look like production incidents';
  END IF;
END
$assert$;

COMMIT;
