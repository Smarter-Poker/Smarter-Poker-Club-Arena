-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260831085650; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- RETIRE remove_horse - a seat exit that vacates the seat and refunds nothing.
-- Live production body set status='left', left_at=NOW() with NO wallet credit,
-- destroying the seat stack (CLAUDE.md 11.5). HORSES ARE PLAYERS (10.5): a horse's
-- stack must be paid back exactly as a human's is, via atomic_seat_cashout_locked.
-- Verified 2026-08-31: zero recorded calls, no live caller in server/src or client.
-- TIER 3. Rollback pasted at the bottom.

-- PRE-FLIGHT
DO $$
DECLARE v_n integer;
BEGIN
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='remove_horse';
  IF v_n > 1 THEN
    RAISE EXCEPTION 'pre-flight: expected at most 1 remove_horse overload, found %', v_n;
  END IF;
  RAISE NOTICE 'pre-flight: % remove_horse overload(s) present', v_n;
END $$;

DROP FUNCTION IF EXISTS public.remove_horse(uuid, uuid);

CREATE FUNCTION public.remove_horse(p_table_id uuid, p_horse_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $fn$
BEGIN
  RAISE EXCEPTION
    'retired: use atomic_seat_cashout_locked - remove_horse vacated the seat and refunded nothing, destroying the stack (CLAUDE.md 11.5, 10.5). Table %, horse %.',
    p_table_id, p_horse_id;
END;
$fn$;

REVOKE ALL ON FUNCTION public.remove_horse(uuid, uuid) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.remove_horse(uuid, uuid) IS
  'RETIRED TOMBSTONE 2026-08-31. The original vacated the table_seats row and credited nothing, destroying the seat stack. Cash a seat out with atomic_seat_cashout_locked, which credits and vacates in one locked transaction. Raises on every call; had no live caller when retired.';

-- POST-APPLY ASSERTIONS
DO $$
DECLARE v_n integer; v_body text; v_state text;
BEGIN
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='remove_horse';
  IF v_n <> 1 THEN RAISE EXCEPTION 'assertion failed: expected exactly 1 remove_horse, found %', v_n; END IF;

  SELECT p.prosrc INTO v_body FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='remove_horse';

  IF v_body ILIKE '%DELETE FROM table_seats%' OR v_body ILIKE '%UPDATE table_seats%' THEN
    RAISE EXCEPTION 'assertion failed: remove_horse still mutates a seat row';
  END IF;
  IF v_body NOT ILIKE '%atomic_seat_cashout_locked%' THEN
    RAISE EXCEPTION 'assertion failed: remove_horse does not name its replacement';
  END IF;

  BEGIN
    PERFORM public.remove_horse('00000000-0000-0000-0000-000000000000'::uuid,
                                '00000000-0000-0000-0000-000000000000'::uuid);
    RAISE EXCEPTION 'assertion failed: remove_horse returned instead of raising';
  EXCEPTION WHEN raise_exception THEN
    GET STACKED DIAGNOSTICS v_state = MESSAGE_TEXT;
    IF v_state NOT LIKE 'retired:%' THEN RAISE; END IF;
    RAISE NOTICE 'post-apply: remove_horse refuses as expected';
  END;

  IF has_function_privilege('anon', 'public.remove_horse(uuid,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'assertion failed: anon can still execute remove_horse';
  END IF;
END $$;

-- ROLLBACK (restores the destructive live definition; fix the caller instead):
--   DROP FUNCTION IF EXISTS public.remove_horse(uuid, uuid);
--   CREATE FUNCTION public.remove_horse(p_table_id uuid, p_horse_id uuid)
--   RETURNS void LANGUAGE plpgsql AS $rb$
--   BEGIN
--     UPDATE table_seats SET status='left', left_at=NOW()
--      WHERE table_id=p_table_id AND horse_id=p_horse_id;
--     UPDATE horses SET status='available', current_table_id=NULL, updated_at=NOW()
--      WHERE id=p_horse_id;
--   END; $rb$;
