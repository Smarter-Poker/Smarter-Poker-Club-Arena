/*
 * A generated column is computed, not supplied. `INSERT ... SELECT (record).*`
 * offers every column including min_buy_in_bb, max_buy_in_bb, min_buyin and
 * max_buyin, which Postgres refuses with 428C9. Build the column list from
 * the catalogue instead of hard-coding it, so a generated column added later
 * is skipped automatically rather than breaking this again.
 */
CREATE OR REPLACE FUNCTION public.fn_ca_restore_tournament_felt(
  p_tournament_id uuid DEFAULT NULL,
  p_dry_run       boolean DEFAULT true,
  p_max_tables    integer DEFAULT 40
) RETURNS TABLE(
  tournament_id uuid,
  tournament_name text,
  active_roster integer,
  open_capacity integer,
  tables_added integer,
  outcome text
)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  r         record;
  v_tmpl    record;
  v_need    integer;
  v_add     integer;
  v_seats   integer;
  v_next    integer;
  v_made    integer;
  v_id      uuid;
  v_name    text;
  v_msg     text;
  v_state   text;
  v_cols    text;
  v_budget  integer := GREATEST(COALESCE(p_max_tables, 0), 0);
BEGIN
  SELECT string_agg(quote_ident(c.column_name), ', ' ORDER BY c.ordinal_position)
    INTO v_cols
    FROM information_schema.columns c
   WHERE c.table_schema = 'public' AND c.table_name = 'tables'
     AND c.is_generated <> 'ALWAYS';

  FOR r IN
    SELECT t.id AS tid, t.name AS tname,
           (SELECT count(*) FROM public.tournament_players p
             WHERE p.tournament_id = t.id AND p.status IN ('registered','playing')) AS roster,
           (SELECT COALESCE(sum(COALESCE(tb.max_players, 9)), 0) FROM public.tables tb
             WHERE tb.tournament_id = t.id AND COALESCE(tb.is_deleted,false) = false
               AND lower(tb.status::text) <> 'closed') AS capacity
      FROM public.tournaments t
     WHERE t.status = 'RUNNING'
       AND (p_tournament_id IS NULL OR t.id = p_tournament_id)
     ORDER BY t.id
  LOOP
    CONTINUE WHEN r.roster <= r.capacity;

    tournament_id := r.tid; tournament_name := r.tname;
    active_roster := r.roster::int; open_capacity := r.capacity::int; tables_added := 0;

    SELECT * INTO v_tmpl FROM public.tables tb
     WHERE tb.tournament_id = r.tid AND COALESCE(tb.is_deleted,false) = false
       AND lower(tb.status::text) <> 'closed'
     ORDER BY tb.created_at DESC LIMIT 1;

    IF v_tmpl.id IS NULL THEN
      outcome := 'no open table to copy - live table recovery owns this event';
      RETURN NEXT; CONTINUE;
    END IF;

    v_seats := GREATEST(COALESCE(v_tmpl.max_players, 9), 1);
    v_need  := (r.roster - r.capacity)::int;
    v_add   := LEAST(CEIL(v_need::numeric / v_seats)::int, v_budget);

    IF v_add <= 0 THEN
      outcome := 'budget exhausted';
      RETURN NEXT; CONTINUE;
    END IF;

    IF p_dry_run THEN
      tables_added := v_add;
      outcome := format('would add %s table(s) of %s seats for %s uncovered player(s)',
                        v_add, v_seats, v_need);
      RETURN NEXT; CONTINUE;
    END IF;

    SELECT COALESCE(max(NULLIF(regexp_replace(tb.name, '^.*Table ', ''), tb.name)::int), 0)
      INTO v_next
      FROM public.tables tb
     WHERE tb.tournament_id = r.tid AND tb.name ~ 'Table [0-9]+$';
    v_next := COALESCE(v_next, 0);

    v_made := 0;
    FOR i IN 1 .. v_add LOOP
      v_id := gen_random_uuid();
      v_name := r.tname || ' - Table ' || (v_next + i)::text;
      BEGIN
        EXECUTE format(
          'INSERT INTO public.tables (%s) SELECT %s FROM jsonb_populate_record(NULL::public.tables, $1)',
          v_cols, v_cols)
        USING (to_jsonb(v_tmpl)
               || jsonb_build_object(
                    'id', v_id,
                    'name', v_name,
                    'status', 'waiting',
                    'current_players', 0,
                    'hands_dealt', 0,
                    'avg_pot', 0,
                    'live_state', NULL,
                    'live_at', NULL,
                    'opened_at', NULL,
                    'first_button_seat', NULL,
                    'terminal_closed_at', NULL,
                    'lifecycle', NULL,
                    'break_started_at', NULL,
                    'break_eligible_since', NULL,
                    'seat_game_scope', 'table:' || v_id::text,
                    'seat_admission_key', 'tournament:' || r.tid::text,
                    'created_at', now(),
                    'updated_at', now()));
        v_made := v_made + 1;
        v_budget := v_budget - 1;
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT, v_state = RETURNED_SQLSTATE;
        tables_added := v_made;
        outcome := format('added %s then refused [%s] %s', v_made, v_state, v_msg);
        RETURN NEXT;
        EXIT;
      END;
    END LOOP;

    IF v_made = v_add THEN
      tables_added := v_made;
      outcome := format('added %s table(s) of %s seats', v_made, v_seats);
      RETURN NEXT;
    END IF;
  END LOOP;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_ca_restore_tournament_felt(uuid, boolean, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_ca_restore_tournament_felt(uuid, boolean, integer) FROM anon;
REVOKE ALL ON FUNCTION public.fn_ca_restore_tournament_felt(uuid, boolean, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_restore_tournament_felt(uuid, boolean, integer) TO service_role;
