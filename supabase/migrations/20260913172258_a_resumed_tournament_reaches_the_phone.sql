-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260913172258 "a_resumed_tournament_reaches_the_phone"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 2fdb8c886795dacd2a9b3090f1c0e524 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_notify_tournament_resumed(
  p_tournament_id uuid,
  p_reason text,
  p_exclude_user_ids uuid[] DEFAULT '{}'::uuid[]
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_name text;
  v_n integer := 0;
  r record;
BEGIN
  IF p_tournament_id IS NULL THEN RETURN 0; END IF;

  -- Only a RUNNING event resumes. A completed or cancelled one has nothing to
  -- come back to, and a replayed call after the finish must page nobody.
  SELECT COALESCE(NULLIF(btrim(t.name), ''), 'Your Tournament') INTO v_name
    FROM public.tournaments t
   WHERE t.id = p_tournament_id AND t.status = 'RUNNING';
  IF NOT FOUND THEN RETURN 0; END IF;

  FOR r IN
    SELECT tp.user_id
      FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.status IN ('registered', 'playing')
       AND NOT (tp.user_id = ANY (COALESCE(p_exclude_user_ids, '{}'::uuid[])))
       -- REACHABILITY, NEVER SPECIES (CLAUDE.md 10.5): the same predicate
       -- prepare_tournament_reminders uses. A player with a device is reached.
       AND EXISTS (SELECT 1 FROM public.push_subscriptions s
                    WHERE s.user_id = tp.user_id AND s.is_active)
  LOOP
    PERFORM public.fn_raise_notification(
      r.user_id,
      'tournament_resumed',
      'Your Tournament Has Resumed',
      v_name || ' Is Dealing Again. Tap To Return To Your Seat.',
      '/hub/club-arena/tournaments/' || p_tournament_id::text,
      jsonb_build_object(
        'tournamentId', p_tournament_id,
        'reason', COALESCE(p_reason, 'break'),
        'resumedAt', now()
      )
    );
    v_n := v_n + 1;
  END LOOP;

  RETURN v_n;
END $function$;

REVOKE ALL ON FUNCTION public.fn_notify_tournament_resumed(uuid, text, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_notify_tournament_resumed(uuid, text, uuid[]) TO service_role;

COMMENT ON FUNCTION public.fn_notify_tournament_resumed(uuid, text, uuid[]) IS
  'Called by the engine when a RUNNING tournament resumes after a maintenance or add-on break. Raises one tournament_resumed notification (-> push_outbox) for every registered/playing entrant with an active push subscription who is not in p_exclude_user_ids (the players with an open socket). Reachability decides, never species.';

COMMIT;
