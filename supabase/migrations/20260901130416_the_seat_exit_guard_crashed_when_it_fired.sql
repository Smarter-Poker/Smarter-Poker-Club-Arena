-- The guard written for the chips that vanished crashed the moment it saw any.
--
-- fn_ca_quick_reconcile step 3e loops over fn_unaccounted_seat_exits() -- the
-- detector built after 2026-08-25, when a probe deleted two table_seats rows
-- and 48 chips left a member wallet and landed nowhere. Its entire job is to
-- make chips leaving the felt LOUD.
--
-- That function returns a column called `exit_id`. The loop body reads `r.id`,
-- twice. plpgsql resolves record fields at RUNTIME, so the mistake is invisible
-- until the loop actually has a row to iterate -- which is to say, invisible
-- until the guard fires:
--
--     ERROR: record "r" has no field "id"
--     CONTEXT: ... 'qr:seatexit:' || r.id::text ...
--     PL/pgSQL function fn_ca_quick_reconcile() line 112 at PERFORM
--
-- A guard that reports nothing when it finds nothing, and throws when it finds
-- something, is worse than no guard: the silence is identical either way, and
-- the one time it mattered the exception replaced the alert.
--
-- It is not hypothetical. ca-quick-reconcile-5m failed on this four times
-- between 11:15 and 11:30 today -- a fifteen minute window in which unaccounted
-- seat exits genuinely existed. Nobody was told. (They have since been
-- accounted for: the matching credits landed inside the grace, and the seven-day
-- unaccounted total is 0.00 across 0 exits as this is written.)
--
-- The blast radius is bigger than the one check. The exception aborts the whole
-- function, so step 3f (ledger write failures) and everything after it did not
-- run either, for those four cycles. One wrong field name took the five-minute
-- reconciler offline exactly when it had something to say.
--
-- REPRODUCED FIRST, in a transaction that was rolled back: inserting one
-- synthetic exit into ca_seat_stack_exits made fn_unaccounted_seat_exits return
-- 1 row and fn_ca_quick_reconcile() raise the error above verbatim. Rollback
-- left 0 probe rows behind.
--
-- The fix is `r.id` -> `r.exit_id`, applied as a targeted substitution on the
-- live definition rather than by retyping 200 lines of a money-adjacent
-- function, so nothing else can drift by transcription. Both occurrences are
-- asserted present before the swap and absent after.

DO $$
DECLARE
  v_def  text;
  v_new  text;
  v_hits int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_ca_quick_reconcile';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'fn_ca_quick_reconcile not found';
  END IF;

  -- Only the two reads inside the seat-exit loop. Other loops in this function
  -- rebind `r` to records that legitimately DO have an `id`, so the match has
  -- to be anchored on the surrounding text, never on `r.id` alone.
  v_hits := 0;

  IF position('''qr:seatexit:'' || r.id::text' IN v_def) = 0 THEN
    RAISE EXCEPTION 'the seat-exit key does not read r.id -- already fixed, or the function changed shape';
  END IF;
  v_new := replace(v_def,
    '''qr:seatexit:'' || r.id::text',
    '''qr:seatexit:'' || r.exit_id::text');
  v_hits := v_hits + 1;

  IF position('jsonb_build_object(''exit_id'', r.id, ''exit_kind'', r.exit_kind)' IN v_new) = 0 THEN
    RAISE EXCEPTION 'the seat-exit context does not read r.id -- already fixed, or the function changed shape';
  END IF;
  v_new := replace(v_new,
    'jsonb_build_object(''exit_id'', r.id, ''exit_kind'', r.exit_kind)',
    'jsonb_build_object(''exit_id'', r.exit_id, ''exit_kind'', r.exit_kind)');
  v_hits := v_hits + 1;

  IF v_hits <> 2 THEN
    RAISE EXCEPTION 'expected exactly 2 substitutions, made %', v_hits;
  END IF;

  EXECUTE v_new;
END $$;

-- Assert the swap landed, on the definition now in the catalogue.
DO $$
DECLARE v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_ca_quick_reconcile';

  IF position('''qr:seatexit:'' || r.exit_id::text' IN v_def) = 0
     OR position('jsonb_build_object(''exit_id'', r.exit_id' IN v_def) = 0 THEN
    RAISE EXCEPTION 'the seat-exit loop still does not read exit_id';
  END IF;
  IF position('''qr:seatexit:'' || r.id::text' IN v_def) > 0 THEN
    RAISE EXCEPTION 'a stale r.id read survived in the seat-exit loop';
  END IF;
  RAISE NOTICE 'the seat-exit guard reads exit_id';
END $$;

REVOKE ALL ON FUNCTION public.fn_ca_quick_reconcile() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_quick_reconcile() TO service_role;;
