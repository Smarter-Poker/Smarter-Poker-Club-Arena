/*
  A PLAYER THE FELT HAS LOST IS OUT OF THE EVENT (2026-09-09).

  Measured this afternoon: 106 players across 20 RUNNING tournaments carry
  status 'playing' with zero chips, and 101 of them hold no chair anywhere in
  their event. They have been that way for hours. Between them their events
  hold 10,673.18 of prize money that cannot be paid, because a tournament with
  an unranked player never reaches a finish.

  WHY THEY CANNOT BE ELIMINATED.  fn_eliminate_tournament_player_atomic is the
  only door into 'eliminated', and it demands a knockout: either a candidate row
  naming who won the chips, or a settlement receipt showing this player written
  to zero or less in a hand. Both are proofs that a HAND took the stack. A
  player whose stack was lost when their chair moved was never knocked out by
  anybody, so neither proof will ever exist, and the eliminator answers
  'knockout_evidence_not_found' for ever. That refusal is right on its own
  terms - a bust with no counterparty is exactly what it is built to refuse -
  but it leaves no door at all for the other way a player leaves the felt.

  So this is a second door, not a hole in the first. It never asks who won the
  chips, because nobody did; it proves ABSENCE instead, and absence has its own
  evidence:

    - the roster says zero chips, and
    - the player holds no live seat anywhere in the event, and
    - no seat row of theirs in that event still carries a positive stack (a
      stack parked on a chair they left is a money question, not an absence -
      those are left alone for fn_ca_stranded_tournament_players to report), and
    - the chair they last left has been gone for longer than the dwell time.

  The dwell time is what makes this safe. executePlayerMoves vacates a seat and
  writes the destination a second or two later, so a player mid-move is
  chairless for an instant. Ten minutes is four hundred times that gap.

  WHAT IT DOES NOT DO.  It does not stamp a finishing place. Positions belong to
  fn_normalize_tournament_final_standings, which derives them from bust
  chronology at the finish; that is why eliminated_at is set to the moment the
  chair was actually lost rather than to now(). Stamping a place here from a
  live count is precisely the mistake that scrambled $100 Freeroll 6:00 AM,
  where five players who busted between 14:32 and 14:44 were paid places 2, 21,
  26, 30 and 35 because the live count they were measured against still counted
  players who had left the felt hours before.

  It also never empties a field: if eliminating the absent would leave nobody
  playing, the event is left exactly as it is and reported instead.
*/

------------------------------------------------------------------------------
-- 1. THE MEASUREMENT.
------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_absent_tournament_players(
  p_min_absent_minutes integer DEFAULT 10)
RETURNS TABLE(tournament_id uuid, tournament_name text, absent_players bigint,
              oldest_absence_minutes numeric, prize_held numeric, detail text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
  WITH absent AS (
    SELECT t.id, t.name, p.user_id,
           (SELECT max(s.left_at)
              FROM public.table_seats s
              JOIN public.tables tb ON tb.id = s.table_id
             WHERE tb.tournament_id = t.id AND s.user_id = p.user_id) AS lost_chair_at
      FROM public.tournaments t
      JOIN public.tournament_players p ON p.tournament_id = t.id
     WHERE t.status = 'RUNNING'
       AND p.status IN ('playing', 'registered')
       AND COALESCE(p.chips, 0) <= 0
       AND NOT EXISTS (
             SELECT 1 FROM public.table_seats s
               JOIN public.tables tb ON tb.id = s.table_id
              WHERE tb.tournament_id = t.id AND s.user_id = p.user_id
                AND s.left_at IS NULL)
       AND NOT EXISTS (
             SELECT 1 FROM public.table_seats s
               JOIN public.tables tb ON tb.id = s.table_id
              WHERE tb.tournament_id = t.id AND s.user_id = p.user_id
                AND COALESCE(s.stack, 0) > 0)
  )
  SELECT a.id, a.name, count(*),
         round(extract(epoch FROM (now() - min(a.lost_chair_at))) / 60.0, 1),
         round(COALESCE((SELECT e.prize_balance FROM public.tournament_escrow e
                          WHERE e.tournament_id = a.id), 0), 2),
         count(*) || ' player(s) are still in this event with no chips and no chair, the '
           || 'oldest for '
           || round(extract(epoch FROM (now() - min(a.lost_chair_at))) / 3600.0, 1)
           || ' hour(s). An unranked player keeps the event from finishing, so the '
           || round(COALESCE((SELECT e.prize_balance FROM public.tournament_escrow e
                               WHERE e.tournament_id = a.id), 0), 2)
           || ' still in escrow cannot be paid to anyone' AS detail
    FROM absent a
   WHERE a.lost_chair_at IS NOT NULL
     AND a.lost_chair_at <= now() - make_interval(mins => GREATEST(p_min_absent_minutes, 1))
   GROUP BY a.id, a.name
   ORDER BY 3 DESC
$fn$;

COMMENT ON FUNCTION public.fn_ca_absent_tournament_players(integer) IS
  'Players still in a RUNNING event with no chips and no chair for longer than the dwell time. They cannot be eliminated by fn_eliminate_tournament_player_atomic because no hand took their stack, and an unranked player holds the whole event - and its escrow - open.';

------------------------------------------------------------------------------
-- 2. THE DOOR.
------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_eliminate_absent_tournament_players(
  p_min_absent_minutes integer DEFAULT 10,
  p_limit integer DEFAULT 500,
  p_dry_run boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_dwell integer := GREATEST(COALESCE(p_min_absent_minutes, 10), 1);
  v_limit integer := GREATEST(COALESCE(p_limit, 500), 0);
  r record;
  v_considered integer := 0;
  v_eliminated integer := 0;
  v_refused_by_guard integer := 0;
  v_field_protected integer := 0;
  v_live_after integer;
  v_events jsonb := '[]'::jsonb;
  v_per_event jsonb := '{}'::jsonb;
  v_key text;
BEGIN
  FOR r IN
    SELECT p.tournament_id, p.user_id, t.name AS tournament_name,
           (SELECT max(s.left_at)
              FROM public.table_seats s
              JOIN public.tables tb ON tb.id = s.table_id
             WHERE tb.tournament_id = t.id AND s.user_id = p.user_id) AS lost_chair_at
      FROM public.tournaments t
      JOIN public.tournament_players p ON p.tournament_id = t.id
     WHERE t.status = 'RUNNING'
       AND p.status IN ('playing', 'registered')
       AND COALESCE(p.chips, 0) <= 0
       AND NOT EXISTS (
             SELECT 1 FROM public.table_seats s
               JOIN public.tables tb ON tb.id = s.table_id
              WHERE tb.tournament_id = t.id AND s.user_id = p.user_id
                AND s.left_at IS NULL)
       AND NOT EXISTS (
             SELECT 1 FROM public.table_seats s
               JOIN public.tables tb ON tb.id = s.table_id
              WHERE tb.tournament_id = t.id AND s.user_id = p.user_id
                AND COALESCE(s.stack, 0) > 0)
     ORDER BY p.tournament_id, p.user_id
     LIMIT v_limit
  LOOP
    IF r.lost_chair_at IS NULL
       OR r.lost_chair_at > now() - make_interval(mins => v_dwell) THEN
      CONTINUE;
    END IF;
    v_considered := v_considered + 1;

    /* NEVER EMPTY A FIELD. Counted fresh for every row, because the rows
       before it in this same call have already changed the count. */
    SELECT count(*) - 1 INTO v_live_after
      FROM public.tournament_players tp
     WHERE tp.tournament_id = r.tournament_id
       AND tp.status IN ('playing', 'registered');
    IF v_live_after < 1 THEN
      v_field_protected := v_field_protected + 1;
      CONTINUE;
    END IF;

    IF p_dry_run THEN
      v_eliminated := v_eliminated + 1;
    ELSE
      /* eliminated_at is the moment the chair was lost, not the moment this
         sweep noticed. The finish normalizer ranks by that column, so a late
         stamp would hand a player who left at noon a better place than one who
         busted at midnight. position is deliberately left NULL: places are the
         normalizer's to assign from chronology at the finish. */
      UPDATE public.tournament_players tp
         SET status = 'eliminated',
             chips = 0,
             eliminated_at = r.lost_chair_at
       WHERE tp.tournament_id = r.tournament_id
         AND tp.user_id = r.user_id
         AND tp.status IN ('playing', 'registered');
      IF FOUND THEN
        v_eliminated := v_eliminated + 1;
      ELSE
        /* fn_refuse_zero_chip_field_elimination returns NULL rather than
           raising when every live player reads zero, so a dropped write is
           counted, not assumed. */
        v_refused_by_guard := v_refused_by_guard + 1;
        CONTINUE;
      END IF;
    END IF;

    v_key := r.tournament_id::text;
    v_per_event := jsonb_set(v_per_event, ARRAY[v_key],
      to_jsonb(COALESCE((v_per_event->>v_key)::integer, 0) + 1), true);
  END LOOP;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'tournament_id', k.key,
           'tournament_name', (SELECT t.name FROM public.tournaments t WHERE t.id = k.key::uuid),
           'players', k.value)), '[]'::jsonb)
    INTO v_events
    FROM jsonb_each(v_per_event) k;

  IF v_eliminated > 0 AND NOT p_dry_run THEN
    PERFORM public.fn_raise_server_financial_alert(
      'warning', 'fn_ca_eliminate_absent_tournament_players',
      v_eliminated || ' player(s) with no chips and no chair were recorded out of their event. '
        || 'Each had been off the felt for more than ' || v_dwell || ' minute(s) and no hand '
        || 'had taken their stack, so the knockout door could never have reached them. '
        || 'Their finishing places are left for the finish normalizer to derive from '
        || 'bust chronology.',
      jsonb_build_object('events', v_events, 'dwell_minutes', v_dwell,
                         'considered', v_considered,
                         'refused_by_zero_chip_guard', v_refused_by_guard,
                         'field_protected', v_field_protected),
      'absent-players:' || CURRENT_DATE::text);
  END IF;

  INSERT INTO public.ca_detector_runs (detector, detail)
  VALUES ('fn_ca_absent_tournament_players',
          jsonb_build_object('eliminated', v_eliminated, 'considered', v_considered,
                             'refused_by_zero_chip_guard', v_refused_by_guard,
                             'field_protected', v_field_protected,
                             'dry_run', p_dry_run, 'dwell_minutes', v_dwell));

  RETURN jsonb_build_object(
    'ok', true, 'dry_run', p_dry_run, 'dwell_minutes', v_dwell,
    'considered', v_considered, 'eliminated', v_eliminated,
    'refused_by_zero_chip_guard', v_refused_by_guard,
    'field_protected', v_field_protected, 'events', v_events);
END;
$fn$;

COMMENT ON FUNCTION public.fn_ca_eliminate_absent_tournament_players(integer, integer, boolean) IS
  'Records out of the event every player who has held no chips and no chair for longer than the dwell time. The second door into elimination: it proves absence rather than a knockout, because no hand took these stacks and the knockout door can never reach them. Leaves position NULL for the finish normalizer and never empties a field.';

REVOKE ALL ON FUNCTION public.fn_ca_absent_tournament_players(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_ca_eliminate_absent_tournament_players(integer, integer, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_ca_absent_tournament_players(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_eliminate_absent_tournament_players(integer, integer, boolean) TO service_role;

------------------------------------------------------------------------------
-- 3. THE SWEEP LEARNS TO LOOK FOR IT.
------------------------------------------------------------------------------
DO $mig$
DECLARE v_src text; v_new text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_ca_conservation_sweep';
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'fn_ca_conservation_sweep is gone';
  END IF;
  IF position($chk$      ('fn_ca_hand_commit_refusals',$chk$ IN v_src) = 0 THEN
    RAISE EXCEPTION 'the sweep list moved; re-read it before editing';
  END IF;
  IF position($chk$fn_ca_absent_tournament_players$chk$ IN v_src) <> 0 THEN
    RAISE EXCEPTION 'the sweep already looks for absent players';
  END IF;

  v_new := replace(v_src,
$old$      ('fn_ca_hand_commit_refusals',$old$,
$new$      ('fn_ca_absent_tournament_players',
       'select count(*), jsonb_agg(to_jsonb(t)) from (select * from public.fn_ca_absent_tournament_players(10) limit 20) t',
       'critical'),
      ('fn_ca_hand_commit_refusals',$new$);
  IF v_new = v_src THEN
    RAISE EXCEPTION 'the sweep was not extended';
  END IF;
  EXECUTE v_new;

  IF (SELECT position($chk$fn_ca_absent_tournament_players$chk$ IN pg_get_functiondef(p.oid))
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname='public' AND p.proname='fn_ca_conservation_sweep') = 0 THEN
    RAISE EXCEPTION 'the sweep did not learn the new check';
  END IF;
END
$mig$;

INSERT INTO public.ca_detector_registry (source, owner, sla_hours, status, note)
VALUES ('fn_ca_conservation_sweep:fn_ca_absent_tournament_players', 'tournament', 4, 'active',
        'A player with no chips and no chair cannot be eliminated by the knockout door and holds the whole event, and its escrow, open. fn_ca_eliminate_absent_tournament_players is the fix and runs every quarter hour.')
ON CONFLICT (source) DO UPDATE
  SET owner = EXCLUDED.owner, sla_hours = EXCLUDED.sla_hours,
      status = EXCLUDED.status, note = EXCLUDED.note, updated_at = now();

------------------------------------------------------------------------------
-- 4. IT RUNS WITHOUT BEING ASKED.
------------------------------------------------------------------------------
SELECT cron.unschedule('ca-eliminate-absent-players')
 WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ca-eliminate-absent-players');
SELECT cron.schedule('ca-eliminate-absent-players', '*/15 * * * *',
  $cron$SELECT public.fn_ca_eliminate_absent_tournament_players(10, 500, false)$cron$);

DO $assert$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ca-eliminate-absent-players') THEN
    RAISE EXCEPTION 'the absent-player sweep was not scheduled';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.ca_detector_registry
                  WHERE source = 'fn_ca_conservation_sweep:fn_ca_absent_tournament_players'
                    AND status = 'active') THEN
    RAISE EXCEPTION 'the absent-player check was not registered';
  END IF;
END
$assert$;
