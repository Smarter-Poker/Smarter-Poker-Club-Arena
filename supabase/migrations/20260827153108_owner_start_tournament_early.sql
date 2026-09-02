-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260827153108; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- An owner may start early; an owner may not cancel by accident.
-- See repo migration 20260827_owner_start_tournament_early.sql for the full
-- header. Replaces the client-side startTournament path, which cancelled
-- tournaments under 3 players and created uppercase-status tables no engine
-- could adopt. This only moves start_time; the engine's own start (with its
-- paid-seat check, spin draw, deck clamp and engine attachment) does the rest.

CREATE OR REPLACE FUNCTION public.fn_owner_start_tournament_now(p_tournament_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid  uuid := auth.uid();
  v_t    record;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  END IF;

  SELECT id, club_id, status, start_time, current_players, min_players
    INTO v_t
    FROM tournaments
   WHERE id = p_tournament_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tournament_not_found');
  END IF;

  IF NOT public.fn_can_create_games(v_t.club_id, v_uid) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authorised');
  END IF;

  IF v_t.status NOT IN ('REGISTERING', 'ANNOUNCED') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_startable',
                              'status', v_t.status);
  END IF;

  IF v_t.start_time IS NOT NULL AND v_t.start_time <= now() THEN
    RETURN jsonb_build_object('ok', true, 'already_due', true,
                              'start_time', v_t.start_time);
  END IF;

  UPDATE tournaments
     SET start_time = now()
   WHERE id = p_tournament_id;

  RETURN jsonb_build_object(
    'ok', true,
    'already_due', false,
    'start_time', now(),
    'current_players', COALESCE(v_t.current_players, 0),
    'min_players', COALESCE(v_t.min_players, 3)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_owner_start_tournament_now(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_owner_start_tournament_now(uuid) TO authenticated, service_role;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc WHERE proname = 'fn_owner_start_tournament_now'
  ) THEN
    RAISE EXCEPTION 'owner_start_early: function was not created';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_proc
     WHERE proname = 'fn_owner_start_tournament_now'
       AND prosrc ILIKE '%CANCELLED%'
  ) THEN
    RAISE EXCEPTION 'owner_start_early: body must never cancel a tournament';
  END IF;
END $$;
