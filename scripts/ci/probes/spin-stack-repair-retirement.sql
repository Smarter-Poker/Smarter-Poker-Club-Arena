-- Read-only post-publish proof for 20260908153223. This probe never repairs a
-- row: any non-zero count is a deployment refusal that must be investigated.
DO $spin_stack_probe$
DECLARE
  v_source text;
BEGIN
  IF to_regprocedure('public.fn_credit_stalled_seat_first_stacks()') IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL retired stack-credit function still exists';
  END IF;
  IF to_regclass('cron.job') IS NULL THEN
    RAISE EXCEPTION 'FAIL cron inventory is unavailable';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM cron.job j
     WHERE regexp_replace(lower(COALESCE(j.jobname,'')),'[^a-z0-9]+','','g')
             = 'creditstalledseatfirststacks'
        OR lower(COALESCE(j.command,'')) LIKE '%fn_credit_stalled_seat_first_stacks%'
  ) THEN
    RAISE EXCEPTION 'FAIL retired stack-credit cron is still scheduled';
  END IF;

  SELECT p.prosrc INTO v_source
    FROM pg_proc p
   WHERE p.oid = to_regprocedure('public.fn_ca_guard_seat_creation()');
  IF v_source IS NULL
     OR v_source NOT LIKE '%TOURNAMENT_SEAT_REQUIRES_POSITIVE_STACK%'
     OR v_source NOT LIKE '%SEAT_FIRST_STACK_MUST_EQUAL_STARTING_CHIPS%'
     OR position('TOURNAMENT_SEAT_REQUIRES_POSITIVE_STACK' IN v_source)
          > position('public.fn_caller_is_engine()' IN v_source) THEN
    RAISE EXCEPTION 'FAIL paid-seat invariant is absent or follows a caller bypass';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_trigger tr
     WHERE tr.tgrelid = 'public.table_seats'::regclass
       AND tr.tgname = 'trg_ca_guard_seat_creation'
       AND tr.tgfoid = 'public.fn_ca_guard_seat_creation()'::regprocedure
       AND NOT tr.tgisinternal
       AND tr.tgenabled <> 'D'
  ) OR NOT EXISTS (
    SELECT 1
      FROM pg_trigger tr
     WHERE tr.tgrelid = 'public.table_seats'::regclass
       AND tr.tgname = 'trg_seat_change_syncs_seat_first_count'
       AND tr.tgfoid = 'public.fn_seat_change_syncs_seat_first_count()'::regprocedure
       AND NOT tr.tgisinternal
       AND tr.tgenabled <> 'D'
  ) THEN
    RAISE EXCEPTION 'FAIL one of the two paid-seat triggers is not armed';
  END IF;

  SELECT p.prosrc INTO v_source
    FROM pg_proc p
   WHERE p.oid = 'public.fn_seat_change_syncs_seat_first_count()'::regprocedure;
  IF v_source LIKE '%EXCEPTION WHEN OTHERS%'
     OR v_source LIKE '%IN (''spin'', ''sng'')%'
     OR v_source NOT LIKE '%PERFORM public.fn_sync_seat_first_player_count(v_tid)%' THEN
    RAISE EXCEPTION 'FAIL paid-third-seat hook still catches or uses the legacy predicate';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.tournaments t
      JOIN public.tables tb ON tb.tournament_id = t.id
      JOIN public.table_seats s ON s.table_id = tb.id AND s.left_at IS NULL
     WHERE upper(COALESCE(t.status::text,'')) IN ('ANNOUNCED','REGISTERING','RUNNING')
       AND NOT EXISTS (SELECT 1 FROM public.hand_history hh WHERE hh.table_id = tb.id)
       AND (s.stack IS NULL
            OR s.stack::text IN ('NaN','Infinity','-Infinity')
            OR s.stack <= 0)
  ) THEN
    RAISE EXCEPTION 'FAIL a live pre-deal tournament seat is not positive';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.tournaments t
      JOIN public.tables tb ON tb.tournament_id = t.id
      JOIN public.table_seats s ON s.table_id = tb.id AND s.left_at IS NULL
      LEFT JOIN public.tournament_players tp
        ON tp.tournament_id = t.id AND tp.user_id = s.user_id
     WHERE upper(COALESCE(t.status::text,'')) IN ('ANNOUNCED','REGISTERING','RUNNING')
       AND (lower(COALESCE(t.variant,'')) = 'spin' OR COALESCE(t.max_players,0) <= 2)
       AND NOT EXISTS (SELECT 1 FROM public.hand_history hh WHERE hh.table_id = tb.id)
       AND (t.starting_chips IS NULL
            OR t.starting_chips::text IN ('NaN','Infinity','-Infinity')
            OR t.starting_chips <= 0
            OR s.stack IS DISTINCT FROM t.starting_chips
            OR tp.user_id IS NULL
            OR tp.status IS DISTINCT FROM 'playing'
            OR tp.chips IS DISTINCT FROM t.starting_chips
            OR tp.table_id IS DISTINCT FROM s.table_id
            OR tp.seat_number IS DISTINCT FROM s.seat_number)
  ) OR EXISTS (
    SELECT 1
      FROM public.tournaments t
      JOIN public.tournament_players tp ON tp.tournament_id = t.id
     WHERE upper(COALESCE(t.status::text,'')) IN ('ANNOUNCED','REGISTERING','RUNNING')
       AND (lower(COALESCE(t.variant,'')) = 'spin' OR COALESCE(t.max_players,0) <= 2)
       AND tp.status IN ('registered','playing')
       AND NOT EXISTS (
         SELECT 1
           FROM public.table_seats s
           JOIN public.tables tb ON tb.id = s.table_id
          WHERE tb.tournament_id = t.id
            AND s.user_id = tp.user_id
            AND s.left_at IS NULL)
  ) THEN
    RAISE EXCEPTION 'FAIL canonical seat-first seat/roster stack parity is not exact';
  END IF;
END;
$spin_stack_probe$;

SELECT
  count(*) FILTER (WHERE lower(COALESCE(t.variant,'')) = 'spin') AS live_predeal_spin_seats,
  count(*) FILTER (WHERE COALESCE(t.max_players,0) <= 2) AS live_predeal_heads_up_seats,
  count(*) AS exact_live_predeal_seat_first_seats
FROM public.tournaments t
JOIN public.tables tb ON tb.tournament_id = t.id
JOIN public.table_seats s ON s.table_id = tb.id AND s.left_at IS NULL
WHERE upper(COALESCE(t.status::text,'')) IN ('ANNOUNCED','REGISTERING','RUNNING')
  AND (lower(COALESCE(t.variant,'')) = 'spin' OR COALESCE(t.max_players,0) <= 2)
  AND NOT EXISTS (SELECT 1 FROM public.hand_history hh WHERE hh.table_id = tb.id);
