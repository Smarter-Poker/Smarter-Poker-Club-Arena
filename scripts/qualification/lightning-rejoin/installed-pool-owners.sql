-- Exact installed owner bodies read 2026-10-26; surrounding fixture supplies synthetic schema.
CREATE OR REPLACE FUNCTION public.fn_lightning_anchor_is_live_eligible(p_seat_id uuid, p_cluster_id uuid, p_player_id uuid DEFAULT NULL::uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT EXISTS (
    SELECT 1
      FROM public.table_seats ts
      JOIN public.tables tb ON tb.id = ts.table_id
     WHERE ts.id = p_seat_id
       AND tb.cluster_id = p_cluster_id AND coalesce(tb.is_deleted, false) = false
       AND coalesce(tb.lifecycle, '') <> 'closed'
       AND ts.left_at IS NULL
       AND ts.user_id IS NOT NULL
       AND (p_player_id IS NULL OR ts.user_id = p_player_id)
       AND coalesce(ts.is_sitting_out, false) = false
       AND coalesce(ts.leave_pending, false) = false
       AND coalesce(ts.stack, 0) > 0);
$function$
;
CREATE OR REPLACE FUNCTION public.fn_lightning_pool_enter(p_seat_id uuid, p_now timestamp with time zone DEFAULT clock_timestamp())
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  s     record;
  g     record;
  v_ps  uuid;
  v_cps uuid;
  v_now timestamptz := LEAST(coalesce(p_now, clock_timestamp()), clock_timestamp());
BEGIN
  SELECT ts.id, ts.user_id, ts.table_id, ts.stack, tb.cluster_id
    INTO s
    FROM public.table_seats ts
    JOIN public.tables tb ON tb.id = ts.table_id
   WHERE ts.id = p_seat_id;
  IF NOT FOUND OR s.cluster_id IS NULL OR s.user_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT cg.id, cg.cluster_mode, cg.lightning_enabled, cg.cluster_epoch
    INTO g FROM public.cash_games cg WHERE cg.id = s.cluster_id;
  IF NOT FOUND OR g.cluster_mode IS DISTINCT FROM 'lightning'
     OR coalesce(g.lightning_enabled, false) = false THEN
    RETURN NULL;
  END IF;

  IF NOT public.fn_lightning_anchor_is_live_eligible(s.id, g.id, s.user_id) THEN
    RETURN NULL;
  END IF;

  -- LIGHTNING PHASE 10 (20261008111425): THE POOL DOOR HONORS RESPONSIBLE
  -- GAMING. The same gate the matcher consults (fn_rg_require_not_excluded:
  -- self-exclusion and cooling-off) refuses entry outright, so an excluded
  -- player never sits in the pool at all. The door's refusal is its NULL,
  -- as for every other ineligible seat.
  IF (public.fn_rg_require_not_excluded(s.user_id) ->> 'ok')::boolean IS DISTINCT FROM true THEN
    RETURN NULL;
  END IF;

  SELECT ps.id INTO v_ps
    FROM public.lightning_pool_session ps
   WHERE ps.cluster_id = g.id AND ps.player_id = s.user_id AND ps.exited_at IS NULL;
  IF v_ps IS NOT NULL THEN
    PERFORM public.fn_lightning_pool_slot_open(v_ps, v_now);
    RETURN v_ps;
  END IF;

  -- LIGHTNING PHASE 13 (20261009235505): JOINS CAN BE CLOSED. An operator's
  -- disable_joins closes the pool to newcomers; the door's refusal is its
  -- NULL, as for every other ineligible seat, and the player's seat and
  -- cash session are untouched.
  IF NOT public.fn_lightning_joins_enabled(g.id) THEN
    RETURN NULL;
  END IF;

  SELECT cps.id INTO v_cps
    FROM public.cash_player_session cps
   WHERE cps.player_id = s.user_id AND cps.closed_at IS NULL
     AND (cps.cluster_id = g.id
          OR cps.scope_id IN (SELECT t.id FROM public.tables t WHERE t.cluster_id = g.id)
          OR cps.table_id IN (SELECT t.id FROM public.tables t WHERE t.cluster_id = g.id))
   ORDER BY coalesce(cps.cluster_id = g.id, false) DESC, cps.opened_at DESC, cps.id
   LIMIT 1;
  IF v_cps IS NULL THEN
    RETURN NULL;
  END IF;

  BEGIN
    INSERT INTO public.lightning_pool_session
      (cluster_id, cluster_epoch, player_id, cash_player_session_id, state, entered_at,
       starting_stack, anchor_seat_id)
    VALUES (g.id, g.cluster_epoch, s.user_id, v_cps, 'active', v_now, s.stack, s.id)
    RETURNING id INTO v_ps;
  EXCEPTION WHEN unique_violation THEN
    SELECT ps.id INTO v_ps
      FROM public.lightning_pool_session ps
     WHERE ps.cluster_id = g.id AND ps.player_id = s.user_id AND ps.exited_at IS NULL;
    RETURN v_ps;
  END;

  INSERT INTO public.cash_cluster_events (game_id, table_id, kind, payload, cluster_epoch)
  VALUES (g.id, s.table_id, 'pool_player_joined', jsonb_build_object(
    'cluster_id', g.id, 'cluster_epoch', g.cluster_epoch, 'player_id', s.user_id,
    'pool_session_id', v_ps, 'anchor_seat_id', s.id, 'starting_stack', s.stack,
    'cash_player_session_id', v_cps, 'via', 'fn_lightning_pool_enter', 'at', v_now), g.cluster_epoch);

  -- THE PLAYER IS TOLD THE ROOM IS OPEN (20261025025154), exactly as the
  -- conversion tells every player it enters: one owner-only signal, delivered
  -- only if this entry commits, answered by a re-read of fn_lightning_my_session.
  PERFORM realtime.send(
    jsonb_build_object('user_id', s.user_id, 'cluster_id', g.id,
      'reason', 'lightning_room_opened', 'domains', '[]'::jsonb),
    'account_changed', 'profile-account:' || s.user_id::text, true);

  PERFORM public.fn_lightning_pool_slot_open(v_ps, v_now);
  RETURN v_ps;
END
$function$
;
CREATE OR REPLACE FUNCTION public.fn_lightning_pool_slot_open(p_pool_session_id uuid, p_now timestamp with time zone DEFAULT clock_timestamp())
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  ps      record;
  v_slot  uuid;
  v_closed integer := 0;
BEGIN
  IF public.fn_platform_frozen() THEN
    RETURN jsonb_build_object('ok', false, 'opened', false, 'reason', 'platform_frozen');
  END IF;

  SELECT s.id, s.cluster_id, s.cluster_epoch, s.player_id, s.state, s.exited_at
    INTO ps FROM public.lightning_pool_session s WHERE s.id = p_pool_session_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'opened', false, 'reason', 'no_such_pool_session');
  END IF;
  IF ps.exited_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'opened', false, 'reason', 'pool_session_has_exited');
  END IF;

  -- IDEMPOTENT ON PURPOSE. This is called from a sync pass that may run twice
  -- in the same second, from two workers, during a deploy. An existing open
  -- slot is the right answer, not a unique violation.
  -- A SESSION FROM A DEAD EPOCH OPENS NOTHING (2026-09-26). The sync pass only
  -- offers sessions at the Cluster's current epoch, but this is callable on its
  -- own, and a slot at a dead epoch is one the barrier can never use and the
  -- one-open-per-player index will not let the player replace.
  IF ps.cluster_epoch IS DISTINCT FROM
     (SELECT g.cluster_epoch FROM public.cash_games g WHERE g.id = ps.cluster_id) THEN
    RETURN jsonb_build_object('ok', false, 'opened', false,
                              'reason', 'pool_session_epoch_is_not_current',
                              'pool_session_epoch', ps.cluster_epoch);
  END IF;

  -- IDEMPOTENT ON THE POOL SESSION (2026-09-26), not on the player. The read
  -- used to be keyed on (Cluster, player, open), so a player who left and came
  -- back - a new pool session - was answered already_open with the slot of the
  -- session that had exited, and one who survived an epoch bump with a slot
  -- at the dead epoch.
  SELECT sl.id INTO v_slot FROM public.lightning_pool_slot sl
   WHERE sl.cluster_id = ps.cluster_id AND sl.player_id = ps.player_id
     AND sl.closed_at IS NULL
     AND sl.pool_session_id = ps.id AND sl.cluster_epoch = ps.cluster_epoch;
  IF FOUND THEN
    RETURN jsonb_build_object('ok', true, 'opened', false, 'reason', 'already_open',
                              'pool_slot_id', v_slot);
  END IF;

  -- ANY OTHER OPEN SLOT OF THIS PLAYER IN THIS CLUSTER IS STALE, and is closed
  -- here, in this call, rather than left for a sync pass: it is bound to a
  -- session that has gone or an epoch that has ended, and while it stays open
  -- lightning_pool_slot_one_open_per_player refuses the slot this player
  -- actually needs. A hand in flight that sat in it is untouched - the hand
  -- names the slot by id, and the player's committed reservation still bars a
  -- second hand until that one ends.
  UPDATE public.lightning_pool_slot sl
     SET closed_at = GREATEST(p_now, sl.opened_at),
         close_reason = CASE WHEN sl.cluster_epoch IS DISTINCT FROM ps.cluster_epoch
                             THEN 'epoch_advanced' ELSE 'superseded_by_pool_session' END,
         updated_at = p_now
   WHERE sl.cluster_id = ps.cluster_id AND sl.player_id = ps.player_id
     AND sl.closed_at IS NULL;
  GET DIAGNOSTICS v_closed = ROW_COUNT;

  -- slot 1, ALWAYS, and the header says why: lightning_pool_slot.slot ranges
  -- 1..24 because the pool was designed for a player to hold several
  -- concurrent seats, and specification 725 forbids a player holding more than
  -- one active reservation in a session. The column keeps its range so that
  -- the day the specification changes, only an index moves.
  INSERT INTO public.lightning_pool_slot
    (pool_session_id, cluster_id, cluster_epoch, player_id, slot, opened_at, updated_at)
  VALUES (ps.id, ps.cluster_id, ps.cluster_epoch, ps.player_id, 1, p_now, p_now)
  RETURNING id INTO v_slot;

  RETURN jsonb_build_object('ok', true, 'opened', true, 'pool_slot_id', v_slot,
                            'player_id', ps.player_id, 'cluster_id', ps.cluster_id,
                            'cluster_epoch', ps.cluster_epoch,
                            'stale_slots_closed', v_closed);
END
$function$
;
