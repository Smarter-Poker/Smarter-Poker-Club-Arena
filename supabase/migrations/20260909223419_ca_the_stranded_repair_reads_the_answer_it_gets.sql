/*
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE REPAIR READS THE ANSWER IT GETS
 *  2026-09-09
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * fn_ca_move_tournament_seat can now decline without raising: a maintenance
 * freeze or an unseatable event comes back as {ok:false, reason:...} from
 * fn_ca_lock_tournament_seat_acquisition, because neither is a fault in the
 * move and the right answer is to retry later.
 *
 * This repair only had an EXCEPTION handler, so a declined move would have
 * been counted as "seated". That is precisely the class of bug this whole
 * day has been about - a caller believing a write it never checked - so the
 * repair now reads the returned jsonb and reports what actually happened.
 */

CREATE OR REPLACE FUNCTION public.fn_ca_return_stranded_to_the_felt(
  p_tournament_id uuid DEFAULT NULL,
  p_dry_run       boolean DEFAULT true,
  p_limit         integer DEFAULT 200
) RETURNS TABLE(
  tournament_id uuid,
  tournament_name text,
  user_id uuid,
  stack numeric,
  to_table_id uuid,
  to_seat integer,
  outcome text
)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  r        record;
  d        record;
  v_free   integer;
  v_done   integer := 0;
  v_msg    text;
  v_state  text;
  v_res    jsonb;
BEGIN
  FOR r IN
    SELECT t.id AS tid, t.name AS tname, p.user_id AS uid,
           (SELECT s.stack FROM public.table_seats s
              JOIN public.tables tb ON tb.id = s.table_id
             WHERE tb.tournament_id = t.id AND s.user_id = p.user_id
             ORDER BY s.left_at DESC NULLS FIRST LIMIT 1) AS last_stack
      FROM public.tournaments t
      JOIN public.tournament_players p ON p.tournament_id = t.id
     WHERE t.status = 'RUNNING'
       AND (p_tournament_id IS NULL OR t.id = p_tournament_id)
       AND p.status IN ('registered', 'playing')
       AND NOT EXISTS (
             SELECT 1 FROM public.table_seats s
               JOIN public.tables tb ON tb.id = s.table_id
              WHERE tb.tournament_id = t.id AND s.user_id = p.user_id AND s.left_at IS NULL)
     ORDER BY 4 DESC NULLS LAST
  LOOP
    CONTINUE WHEN COALESCE(r.last_stack, 0) <= 0;
    EXIT WHEN v_done >= GREATEST(p_limit, 0);

    SELECT tb.id AS id, COALESCE(tb.max_players, 9) AS mx INTO d
      FROM public.tables tb
     WHERE tb.tournament_id = r.tid
       AND COALESCE(tb.is_deleted, false) = false
       AND lower(tb.status::text) <> 'closed'
     ORDER BY (SELECT count(*) FROM public.table_seats x
                WHERE x.table_id = tb.id AND x.left_at IS NULL) ASC, tb.id ASC
     LIMIT 1;

    IF d.id IS NULL THEN
      tournament_id := r.tid; tournament_name := r.tname; user_id := r.uid;
      stack := r.last_stack; to_table_id := NULL; to_seat := NULL;
      outcome := 'no open table in this event - felt must be restored first';
      RETURN NEXT; CONTINUE;
    END IF;

    SELECT g INTO v_free FROM generate_series(1, d.mx) g
     WHERE NOT EXISTS (SELECT 1 FROM public.table_seats x
                        WHERE x.table_id = d.id AND x.seat_number = g AND x.left_at IS NULL)
     ORDER BY g LIMIT 1;

    IF v_free IS NULL THEN
      tournament_id := r.tid; tournament_name := r.tname; user_id := r.uid;
      stack := r.last_stack; to_table_id := d.id; to_seat := NULL;
      outcome := 'every open table is full';
      RETURN NEXT; CONTINUE;
    END IF;

    tournament_id := r.tid; tournament_name := r.tname; user_id := r.uid;
    stack := r.last_stack; to_table_id := d.id; to_seat := v_free;

    IF p_dry_run THEN
      outcome := 'would seat';
    ELSE
      BEGIN
        v_res := public.fn_ca_move_tournament_seat(r.tid, r.uid, d.id, v_free, 'stranded_return');
        /* READ THE ANSWER. A decline is not an exception and must not be
           counted as a success - see the header. */
        IF COALESCE((v_res->>'moved')::boolean, false)
           OR COALESCE((v_res->>'replayed')::boolean, false) THEN
          outcome := CASE WHEN COALESCE((v_res->>'replayed')::boolean, false)
                          THEN 'already seated' ELSE 'seated' END;
          v_done := v_done + 1;
        ELSE
          outcome := 'declined: ' || COALESCE(v_res->>'refused', v_res::text);
        END IF;
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT, v_state = RETURNED_SQLSTATE;
        outcome := format('refused [%s] %s', v_state, v_msg);
      END;
    END IF;
    RETURN NEXT;
  END LOOP;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_ca_return_stranded_to_the_felt(uuid, boolean, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_ca_return_stranded_to_the_felt(uuid, boolean, integer) FROM anon;
REVOKE ALL ON FUNCTION public.fn_ca_return_stranded_to_the_felt(uuid, boolean, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_return_stranded_to_the_felt(uuid, boolean, integer) TO service_role;
