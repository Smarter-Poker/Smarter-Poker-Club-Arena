/*
  A CHAIR HELD WITH NOTHING ON IT IS PROVED TWICE, THEN RELEASED (2026-09-09).

  The companion to the absent-player door. Twelve players sit at a live chair in
  a RUNNING event with a stack of exactly 0.00 - the youngest for ten and a half
  hours, the oldest for nearly twenty-seven. They are on the felt and cannot act;
  no hand can take their stack because there is nothing to take, so the knockout
  door will never reach them either, and their events cannot finish.

  WHY THIS NEEDS ITS OWN PROOF.  The absent-player door reads a player who holds
  NO chair: a chair is either held or it is not, so one look settles it. A chair
  held with 0.00 on it is different, because there is one honest reason for a
  stack to read zero for an instant - the player is all in and the hand has not
  settled yet. Busting them at that instant would take a pot away from someone
  who had already won it.

  The engine can ask its own table object whether it is between hands
  (isBetweenHands / hasSettlementInFlight in TournamentManager). Nothing in the
  database can: a hand in flight leaves no row that says so. So this door proves
  it by time instead, the same way fn_ca_resolve_cleared_incidents proves a
  finding has cleared - it never acts on one sighting. A chair reading zero is
  recorded the first time it is seen and acted on only when a LATER run, at
  least the dwell apart, sees the same chair still reading zero. No hand of poker
  survives two sweeps a quarter of an hour apart, so an all-in player is settled
  and back above zero long before the second look, and drops out of the set on
  its own. A sighting is deleted the moment the player no longer qualifies, so
  nothing carries over from one broke moment to an unrelated later one.

  A player with an open rebuy decision is never in the set at all: they are not
  out, they are choosing.
*/

CREATE TABLE IF NOT EXISTS public.ca_broke_seat_sightings (
  tournament_id uuid NOT NULL REFERENCES public.tournaments(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL,
  seat_id       uuid NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_seen_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tournament_id, user_id, seat_id)
);

COMMENT ON TABLE public.ca_broke_seat_sightings IS
  'One row per (event, player, chair) seen holding a live chair at exactly zero chips. A chair is released and the player recorded out only when a run at least the dwell later still sees the same chair at zero, so an all-in player mid-hand is never mistaken for a broke one.';

ALTER TABLE public.ca_broke_seat_sightings ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.fn_ca_release_broke_seats(
  p_min_dwell_minutes integer DEFAULT 15,
  p_limit integer DEFAULT 200,
  p_dry_run boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_dwell integer := GREATEST(COALESCE(p_min_dwell_minutes, 15), 1);
  v_limit integer := GREATEST(COALESCE(p_limit, 200), 0);
  r record;
  v_seen integer := 0;
  v_new_sightings integer := 0;
  v_stale_cleared integer := 0;
  v_released integer := 0;
  v_field_protected integer := 0;
  v_refused_by_guard integer := 0;
  v_live_after integer;
  v_events jsonb := '{}'::jsonb;
  v_key text;
BEGIN
  /* A sighting only means anything while it is still true. Drop every row whose
     player has since found chips, left the chair, been eliminated, or whose
     event has ended - otherwise a stack that dipped to zero yesterday would
     count as the first of two sightings for a broke moment tomorrow. */
  WITH still_true AS (
    SELECT s.tournament_id, s.user_id, s.seat_id
      FROM public.ca_broke_seat_sightings s
      JOIN public.tournaments t ON t.id = s.tournament_id AND t.status = 'RUNNING'
      JOIN public.tournament_players tp ON tp.tournament_id = s.tournament_id
                                       AND tp.user_id = s.user_id
                                       AND tp.status IN ('playing', 'registered')
                                       AND COALESCE(tp.chips, 0) <= 0
      JOIN public.table_seats ts ON ts.id = s.seat_id
                                AND ts.user_id = s.user_id
                                AND ts.left_at IS NULL
                                AND COALESCE(ts.stack, 0) <= 0
  )
  DELETE FROM public.ca_broke_seat_sightings d
   WHERE NOT EXISTS (SELECT 1 FROM still_true k
                      WHERE k.tournament_id = d.tournament_id
                        AND k.user_id = d.user_id AND k.seat_id = d.seat_id);
  GET DIAGNOSTICS v_stale_cleared = ROW_COUNT;

  FOR r IN
    SELECT tp.tournament_id, tp.user_id, ts.id AS seat_id, t.name AS tournament_name
      FROM public.tournaments t
      JOIN public.tournament_players tp ON tp.tournament_id = t.id
      JOIN public.table_seats ts ON ts.user_id = tp.user_id AND ts.left_at IS NULL
      JOIN public.tables tb ON tb.id = ts.table_id AND tb.tournament_id = t.id
     WHERE t.status = 'RUNNING'
       AND tp.status IN ('playing', 'registered')
       AND COALESCE(tp.chips, 0) <= 0
       AND COALESCE(ts.stack, 0) <= 0
       AND (tp.rebuy_prompt_until IS NULL OR tp.rebuy_prompt_until <= now())
       AND NOT EXISTS (
             SELECT 1 FROM public.table_seats s2
               JOIN public.tables tb2 ON tb2.id = s2.table_id
              WHERE tb2.tournament_id = t.id AND s2.user_id = tp.user_id
                AND COALESCE(s2.stack, 0) > 0)
     ORDER BY tp.tournament_id, tp.user_id
     LIMIT v_limit
  LOOP
    v_seen := v_seen + 1;

    INSERT INTO public.ca_broke_seat_sightings (tournament_id, user_id, seat_id)
    VALUES (r.tournament_id, r.user_id, r.seat_id)
    ON CONFLICT (tournament_id, user_id, seat_id)
      DO UPDATE SET last_seen_at = clock_timestamp();
    IF NOT EXISTS (
      SELECT 1 FROM public.ca_broke_seat_sightings s
       WHERE s.tournament_id = r.tournament_id AND s.user_id = r.user_id
         AND s.seat_id = r.seat_id
         AND s.first_seen_at <= clock_timestamp() - make_interval(mins => v_dwell)) THEN
      v_new_sightings := v_new_sightings + 1;
      CONTINUE;   -- one sighting is a moment; two is a state
    END IF;

    SELECT count(*) - 1 INTO v_live_after
      FROM public.tournament_players tp2
     WHERE tp2.tournament_id = r.tournament_id
       AND tp2.status IN ('playing', 'registered');
    IF v_live_after < 1 THEN
      v_field_protected := v_field_protected + 1;
      CONTINUE;
    END IF;

    IF p_dry_run THEN
      v_released := v_released + 1;
    ELSE
      UPDATE public.tournament_players tp3
         SET status = 'eliminated', chips = 0, eliminated_at = now()
       WHERE tp3.tournament_id = r.tournament_id AND tp3.user_id = r.user_id
         AND tp3.status IN ('playing', 'registered');
      IF NOT FOUND THEN
        v_refused_by_guard := v_refused_by_guard + 1;
        CONTINUE;
      END IF;
      /* The chair goes back to the table only after the roster says they are
         out, so no moment exists in which a live seat has no live roster row
         (tournament_roster_cannot_orphan_live_seat is deferred and would
         refuse the pair the other way round). */
      UPDATE public.table_seats ts2
         SET left_at = now()
       WHERE ts2.id = r.seat_id AND ts2.left_at IS NULL;
      DELETE FROM public.ca_broke_seat_sightings s
       WHERE s.tournament_id = r.tournament_id AND s.user_id = r.user_id
         AND s.seat_id = r.seat_id;
      v_released := v_released + 1;
    END IF;

    v_key := r.tournament_id::text;
    v_events := jsonb_set(v_events, ARRAY[v_key],
      to_jsonb(COALESCE((v_events->>v_key)::integer, 0) + 1), true);
  END LOOP;

  IF v_released > 0 AND NOT p_dry_run THEN
    PERFORM public.fn_raise_server_financial_alert(
      'warning', 'fn_ca_release_broke_seats',
      v_released || ' chair(s) held at exactly zero chips were released and their players '
        || 'recorded out. Each was seen at zero on two separate runs at least '
        || v_dwell || ' minute(s) apart, so none was an unsettled all-in, and no hand could '
        || 'ever have taken a stack that was not there.',
      jsonb_build_object('events', v_events, 'dwell_minutes', v_dwell,
                         'seen', v_seen, 'first_sightings', v_new_sightings,
                         'refused_by_zero_chip_guard', v_refused_by_guard,
                         'field_protected', v_field_protected),
      'broke-seats:' || CURRENT_DATE::text);
  END IF;

  INSERT INTO public.ca_detector_runs (detector, detail)
  VALUES ('fn_ca_release_broke_seats',
          jsonb_build_object('seen', v_seen, 'released', v_released,
                             'first_sightings', v_new_sightings,
                             'stale_sightings_cleared', v_stale_cleared,
                             'refused_by_zero_chip_guard', v_refused_by_guard,
                             'field_protected', v_field_protected,
                             'dry_run', p_dry_run, 'dwell_minutes', v_dwell));

  RETURN jsonb_build_object(
    'ok', true, 'dry_run', p_dry_run, 'dwell_minutes', v_dwell,
    'seen', v_seen, 'released', v_released, 'first_sightings', v_new_sightings,
    'stale_sightings_cleared', v_stale_cleared,
    'refused_by_zero_chip_guard', v_refused_by_guard,
    'field_protected', v_field_protected, 'events', v_events);
END;
$fn$;

COMMENT ON FUNCTION public.fn_ca_release_broke_seats(integer, integer, boolean) IS
  'Releases a live chair whose stack has read exactly zero on two runs at least the dwell apart, and records its holder out. The two sightings are what tell a broke player apart from an unsettled all-in, which the database cannot otherwise see.';

REVOKE ALL ON FUNCTION public.fn_ca_release_broke_seats(integer, integer, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_ca_release_broke_seats(integer, integer, boolean) TO service_role;

SELECT cron.unschedule('ca-release-broke-seats')
 WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ca-release-broke-seats');
SELECT cron.schedule('ca-release-broke-seats', '*/15 * * * *',
  $cron$SELECT public.fn_ca_release_broke_seats(15, 200, false)$cron$);

DO $assert$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ca-release-broke-seats') THEN
    RAISE EXCEPTION 'the broke-seat sweep was not scheduled';
  END IF;
  IF to_regclass('public.ca_broke_seat_sightings') IS NULL THEN
    RAISE EXCEPTION 'the sighting table was not created';
  END IF;
END
$assert$;
