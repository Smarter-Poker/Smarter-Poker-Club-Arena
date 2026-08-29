-- ═══════════════════════════════════════════════════════════════════════════
-- A MANUAL BOMB REQUEST PUSHES; THE ENGINE STOPS ASKING (2026-08-29)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- MANUAL_NEXT_HAND has to reach the engine before the next hand is dealt, and
-- the only mechanism it had was the engine ASKING, at the top of every hand,
-- on every bomb-enabled table, forever — for a flag that is false essentially
-- always. One round trip per hand to learn nothing.
--
-- (The write amplification is already gone: since the atomic-claim change, the
-- statement is `UPDATE ... WHERE id = ? AND bomb_pot_manual_pending = true`,
-- which matches no row and writes nothing. What remains is the round trip, and
-- it sits on the hand-start critical path.)
--
-- Reversing it costs one line in the RPC. `realtime.send` puts a broadcast on
-- the SAME `table:<id>` topic the engine already opens for its own broadcasts,
-- so the engine learns the instant a host clicks, with no new channel, no new
-- subscription per table, and no polling at all.
--
-- THE POLL IS NOT DELETED, IT IS DEMOTED. A broadcast is best-effort: an engine
-- that restarted between the click and the hand never hears it. So the engine
-- keeps the flag in memory when the broadcast arrives, and still reads the
-- column on the throttled table refresh it already performs — one read that
-- was already happening, instead of one read per hand. The claim itself is
-- unchanged and still atomic, so a broadcast that arrives twice, or arrives
-- alongside the throttled read, still fires exactly one bomb.
--
-- Tier 2: CREATE OR REPLACE of one SECURITY DEFINER function. The
-- authorization checks, the audit insert and the column write are byte-identical
-- to the 2026-08-28 version; only the broadcast is added.

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

  -- ── The push (2026-08-29) ────────────────────────────────────────────────
  -- Same topic the engine already holds open. Wrapped because a broadcast that
  -- fails must not fail the REQUEST: the column is written above and the
  -- engine's throttled refresh is the backstop, so the worst case without this
  -- line is the latency the poll used to have — never a lost request.
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

-- The 2026-08-28 grants stand: anon was explicitly revoked and must stay that
-- way. Re-assert rather than assume — CREATE OR REPLACE preserves ACLs, but
-- this function is the one whose anon grant survived a REVOKE ... FROM public
-- once already (20260828_clone_never_inherits_bomb_scheduler_state.sql).
REVOKE ALL ON FUNCTION public.fn_request_manual_bomb_pot(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_request_manual_bomb_pot(uuid) TO authenticated, service_role;

DO $$
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
END $$;

-- ROLLBACK: CREATE OR REPLACE the function without the BEGIN ... realtime.send
-- ... END block. The engine tolerates never hearing the broadcast — it falls
-- back to the throttled column read — so the rollback degrades latency and
-- nothing else.
