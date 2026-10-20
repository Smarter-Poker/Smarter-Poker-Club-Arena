CREATE OR REPLACE FUNCTION public.fn_lightning_instance_keepalive(p_instance_id uuid, p_extend interval DEFAULT '00:02:00'::interval, p_now timestamp with time zone DEFAULT clock_timestamp())
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  i          record;
  -- Never from the future, for the same reason the reaper never reaps by a
  -- clock that has not arrived: a deadline is a statement about real time.
  v_now      timestamp with time zone := LEAST(coalesce(p_now, clock_timestamp()), clock_timestamp());
  -- A heartbeat, not a lease: at least thirty seconds so that a keepalive is
  -- worth sending, at most fifteen minutes so that one leaked call cannot keep
  -- a dead engine's players out of the pool for an evening.
  v_extend   interval := LEAST(GREATEST(coalesce(p_extend, interval '2 minutes'), interval '30 seconds'),
                               interval '15 minutes');
  v_deadline timestamp with time zone;
BEGIN
  -- NOT GATED ON THE FREEZE. A hand already in flight when a maintenance break
  -- begins is allowed to finish - "allow already-started hands to resolve
  -- normally" - and refusing its heartbeat would have the reaper abandon it
  -- under a live engine, which is the one thing this function exists to stop.
  SELECT li.id, li.state, li.deadline_at, li.hand_id
    INTO i FROM public.lightning_instance li WHERE li.id = p_instance_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'alive', false, 'reason', 'not_found');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.lightning_instance li
                  WHERE li.id = i.id AND li.state IN ('dealing', 'settling')) THEN
    RETURN jsonb_build_object('ok', false, 'alive', false, 'reason', 'wrong_state', 'state', i.state);
  END IF;

  -- A HAND DECLARED DEAD STAYS DEAD. Past its deadline the reaper is entitled
  -- to it and may already hold it, so a late heartbeat is told so rather than
  -- being allowed to race the reaper for a hand whose players are about to be
  -- handed back.
  IF i.deadline_at <= v_now THEN
    RETURN jsonb_build_object('ok', false, 'alive', false, 'reason', 'past_deadline',
                              'deadline_at', i.deadline_at);
  END IF;

  -- FORWARD ONLY. A short keepalive never shortens a longer window that
  -- begin_dealing or an earlier keepalive granted.
  v_deadline := GREATEST(i.deadline_at, v_now + v_extend);
  UPDATE public.lightning_instance li SET deadline_at = v_deadline WHERE li.id = i.id;

  RETURN jsonb_build_object('ok', true, 'alive', true, 'instance_id', i.id, 'hand_id', i.hand_id,
                            'state', i.state, 'deadline_at', v_deadline);
END
$function$
