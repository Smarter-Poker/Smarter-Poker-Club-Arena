-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260828021832; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.


-- ═══════════════════════════════════════════════════════════════════════════
--  commander_clock_write: a SECURITY DEFINER hole straight through the RLS
--  policy that already guards this table
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The body was a bare UPDATE with no authorization of any kind, SECURITY
-- DEFINER, and EXECUTE granted to `authenticated`. Any logged-in user who knew
-- (or guessed, ids are readable — captain_tournaments_select is `true`) a
-- tournament id could pause it, jump its level, restart it or end it.
--
-- commander_tournaments ALREADY has the correct rule. captain_tournaments_update:
--   venue_id IN (SELECT venue_id FROM commander_staff
--                 WHERE user_id = auth.uid() AND is_active)
-- SECURITY DEFINER runs the body as the owner, and the owner has BYPASSRLS, so
-- that policy was never consulted. The function was a way around it.
--
-- Proven on 2026-08-27 in a rolled-back probe, as a logged-in user holding no
-- staff role at any venue:
--   PROBE2 "Noon Turbo NLH" venue=1996 status scheduled->completed level 0->99
--          clock={"paused": true, "hijacked_by_probe": true}
--
-- THE FIX. The function now enforces the same predicate the RLS policy states.
-- Two callers stay working:
--   * smarter-poker-commander's API routes (pages/api/tournaments/[id]/
--     clock.js, hand-for-hand.js, message.js, final-table.js, floor-view.js)
--     hold the service-role key and are already gated by guardWriteStaff.
--   * a genuine staff member's own JWT passes the membership check.
-- Everyone else is refused with 42501.
--
-- WHY auth.role() AND NOT current_user: SECURITY DEFINER rewrites current_user
-- to the owner, so it reads 'postgres' for a browser too. A guard built on it
-- is a silent no-op — that trap cost a false "fixed" on the club_members chip
-- mint earlier the same day. NULL means no PostgREST request context at all
-- (psql, pg_cron, a migration), which is trusted; a browser cannot produce it,
-- because reaching the `authenticated` role requires a verified JWT and
-- PostgREST always sets request.jwt.claims from it.

CREATE OR REPLACE FUNCTION public.commander_clock_write(
  p_tournament_id uuid,
  p_clock_state jsonb,
  p_updates jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  result jsonb;
  v_venue integer;
  v_is_engine boolean;
BEGIN
  v_is_engine := COALESCE(auth.role(), 'service_role') = 'service_role';

  SELECT venue_id INTO v_venue FROM commander_tournaments WHERE id = p_tournament_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tournament % not found', p_tournament_id;
  END IF;

  -- The clock is the room's authority. Only the floor may move it.
  IF NOT v_is_engine THEN
    IF NOT EXISTS (
      SELECT 1 FROM commander_staff s
       WHERE s.venue_id = v_venue
         AND s.user_id = (SELECT auth.uid())
         AND s.is_active
    ) THEN
      RAISE EXCEPTION
        'commander_clock_write refused: not active staff at venue %', v_venue
        USING ERRCODE = '42501';
    END IF;
  END IF;

  UPDATE commander_tournaments SET
    settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{clock_state}', COALESCE(p_clock_state, 'null'::jsonb)),
    status = COALESCE(p_updates->>'status', status),
    current_level = COALESCE((p_updates->>'current_level')::integer, current_level),
    actual_start = COALESCE((p_updates->>'actual_start')::timestamptz, actual_start),
    ended_at = COALESCE((p_updates->>'ended_at')::timestamptz, ended_at),
    updated_at = now()
  WHERE id = p_tournament_id
  RETURNING to_jsonb(commander_tournaments.*) INTO result;

  IF result IS NULL THEN
    RAISE EXCEPTION 'Tournament % not found', p_tournament_id;
  END IF;

  RETURN result;
END;
$function$;

REVOKE ALL ON FUNCTION public.commander_clock_write(uuid, jsonb, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.commander_clock_write(uuid, jsonb, jsonb) TO authenticated, service_role;

COMMENT ON FUNCTION public.commander_clock_write(uuid, jsonb, jsonb) IS
  'Atomic write of settings.clock_state plus status/current_level/actual_start/ended_at. Requires service_role or active commander_staff at the tournament venue - the same predicate as the captain_tournaments_update RLS policy this SECURITY DEFINER function would otherwise bypass. Hardened 2026-08-27.';

