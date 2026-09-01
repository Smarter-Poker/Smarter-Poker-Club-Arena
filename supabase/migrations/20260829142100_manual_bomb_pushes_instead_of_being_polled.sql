-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260829142100; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

CREATE OR REPLACE FUNCTION public.fn_request_manual_bomb_pot(p_table_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_club uuid;
  v_enabled boolean;
  v_role text;
  v_is_owner boolean := false;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  END IF;

  SELECT club_id, bomb_pot_enabled INTO v_club, v_enabled
  FROM public.tables WHERE id = p_table_id;

  IF v_club IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'table_not_found');
  END IF;
  IF v_enabled IS DISTINCT FROM true THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'bomb_pots_disabled');
  END IF;

  SELECT EXISTS (SELECT 1 FROM public.clubs c WHERE c.id = v_club AND c.owner_id = v_uid)
    INTO v_is_owner;
  SELECT lower(cm.role) INTO v_role
  FROM public.club_members cm
  WHERE cm.club_id = v_club AND cm.user_id = v_uid
  LIMIT 1;

  IF NOT (v_is_owner OR v_role IN ('owner', 'co_owner', 'admin')) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authorized');
  END IF;

  UPDATE public.tables SET bomb_pot_manual_pending = true WHERE id = p_table_id;
  INSERT INTO public.bomb_pot_manual_requests (table_id, club_id, requested_by)
  VALUES (p_table_id, v_club, v_uid);

  -- The push (2026-08-29): same topic the engine already holds open. Wrapped
  -- because a broadcast that fails must not fail the REQUEST - the column is
  -- written above and the engine's throttled refresh is the backstop.
  BEGIN
    PERFORM realtime.send(
      jsonb_build_object('table_id', p_table_id, 'requested_by', v_uid),
      'bomb_pot_manual_requested',
      'table:' || p_table_id::text,
      false
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'fn_request_manual_bomb_pot: realtime.send failed: %', SQLERRM;
  END;

  RETURN jsonb_build_object('ok', true);
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_request_manual_bomb_pot(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_request_manual_bomb_pot(uuid) TO authenticated, service_role;

DO $chk$
BEGIN
  IF (SELECT pg_get_functiondef(p.oid) FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'fn_request_manual_bomb_pot')
     NOT LIKE '%bomb_pot_manual_requested%' THEN
    RAISE EXCEPTION 'assertion failed: fn_request_manual_bomb_pot does not broadcast';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.role_routine_grants
    WHERE routine_schema = 'public' AND routine_name = 'fn_request_manual_bomb_pot'
      AND grantee = 'anon'
  ) THEN
    RAISE EXCEPTION 'assertion failed: anon can still execute fn_request_manual_bomb_pot';
  END IF;
END $chk$;
