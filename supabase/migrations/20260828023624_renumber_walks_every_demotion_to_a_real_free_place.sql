-- The first cut of fn_renumber_duplicate_places paired the i-th demoted row
-- with the i-th free place across the whole event and then discarded any pair
-- where the free place turned out to be ABOVE the contested one (a demotion
-- must never become a promotion). That discard was silent: it planned 31 moves
-- where 200+ rows needed one, and reported ok:true. A filter that drops work
-- instead of doing it differently is the same shape as the back-pay starvation
-- in 20260827_hu_backpay_head_of_line_fix - every pass looks successful and the
-- backlog never moves.
--
-- Matching is an explicit walk now: for each contested place, in order, take
-- the smallest place strictly BELOW it that nobody holds. It cannot promote, it
-- cannot collide, and it cannot silently skip a row - if it ever fails to place
-- somebody it raises rather than returning a short plan.

CREATE OR REPLACE FUNCTION public.fn_renumber_duplicate_places(
  p_apply boolean DEFAULT false,
  p_limit integer DEFAULT 100000)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_t record; v_d record;
  v_taken integer[]; v_pos integer;
  v_moved integer := 0; v_events integer := 0; v_skipped_first integer := 0;
  v_demoted_total integer := 0; v_plan jsonb;
BEGIN
  CREATE TEMP TABLE IF NOT EXISTS _renum_plan (
    tournament_id uuid, user_id uuid, old_position integer,
    new_position integer, prize_paid numeric) ON COMMIT DROP;
  DELETE FROM _renum_plan;

  SELECT count(*) INTO v_skipped_first
    FROM (SELECT tournament_id FROM public.tournament_players
           WHERE position = 1 GROUP BY 1 HAVING count(*) > 1) x;

  FOR v_t IN
    SELECT DISTINCT tournament_id FROM (
      SELECT tournament_id, position FROM public.tournament_players
       WHERE position IS NOT NULL GROUP BY 1,2 HAVING count(*) > 1) d
     WHERE tournament_id NOT IN (
       SELECT tournament_id FROM public.tournament_players
        WHERE position = 1 GROUP BY 1 HAVING count(*) > 1)
     LIMIT GREATEST(p_limit, 1)
  LOOP
    v_events := v_events + 1;

    SELECT array_agg(DISTINCT position) INTO v_taken
      FROM public.tournament_players
     WHERE tournament_id = v_t.tournament_id AND position IS NOT NULL;

    FOR v_d IN
      SELECT user_id, old_pos, prize FROM (
        SELECT tp.user_id, tp.position AS old_pos, COALESCE(tp.prize, 0) AS prize,
               row_number() OVER (PARTITION BY tp.position
                 ORDER BY tp.eliminated_at DESC NULLS FIRST,
                          COALESCE(tp.chips, 0) DESC, tp.id) AS grp_rn
          FROM public.tournament_players tp
         WHERE tp.tournament_id = v_t.tournament_id AND tp.position IS NOT NULL) r
       WHERE grp_rn > 1
       ORDER BY old_pos, prize DESC
    LOOP
      v_demoted_total := v_demoted_total + 1;

      -- Smallest place strictly worse than the contested one that nobody holds.
      v_pos := v_d.old_pos + 1;
      WHILE v_pos = ANY (v_taken) LOOP
        v_pos := v_pos + 1;
        IF v_pos > 100000 THEN
          RAISE EXCEPTION 'no free finishing place below % in tournament %',
            v_d.old_pos, v_t.tournament_id;
        END IF;
      END LOOP;

      v_taken := v_taken || v_pos;
      INSERT INTO _renum_plan VALUES
        (v_t.tournament_id, v_d.user_id, v_d.old_pos, v_pos, v_d.prize);
      v_moved := v_moved + 1;
    END LOOP;
  END LOOP;

  -- Nothing may be dropped between "needs a place" and "got a place".
  IF v_moved <> v_demoted_total THEN
    RAISE EXCEPTION 'planned % moves for % demoted rows', v_moved, v_demoted_total;
  END IF;

  IF p_apply THEN
    INSERT INTO public.tournament_place_renumbers
      (tournament_id, user_id, old_position, new_position, prize_paid, reason)
    SELECT tournament_id, user_id, old_position, new_position, prize_paid,
           'duplicate finishing place; later elimination keeps the place'
      FROM _renum_plan
    ON CONFLICT DO NOTHING;

    UPDATE public.tournament_players tp
       SET position = p.new_position
      FROM _renum_plan p
     WHERE tp.tournament_id = p.tournament_id
       AND tp.user_id = p.user_id
       AND tp.position = p.old_position;
  END IF;

  SELECT jsonb_agg(jsonb_build_object('tournament_id', tournament_id,
           'from', old_position, 'to', new_position, 'prize_paid', prize_paid)
           ORDER BY tournament_id, old_position)
    INTO v_plan
    FROM (SELECT * FROM _renum_plan ORDER BY tournament_id, old_position LIMIT 12) s;

  RETURN jsonb_build_object('ok', true, 'applied', p_apply,
    'rows_moved', v_moved, 'tournaments', v_events,
    'events_excluded_contested_first_place', v_skipped_first,
    'sample', COALESCE(v_plan, '[]'::jsonb));
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_renumber_duplicate_places(boolean, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_renumber_duplicate_places(boolean, integer) TO service_role;
