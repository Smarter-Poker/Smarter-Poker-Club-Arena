-- the_minutely_reconciler_stops_rewriting_a_column_a_trigger_owns
--
-- CLAUDE.md 10.9: the reasoning goes in this header, not just the SQL.
--
-- fn_reconcile_tournament_denormals() runs every minute, 1,440 times a day.
-- Its second branch rewrote public.tables.stakes from the row's own blinds.
-- That branch existed because nothing else kept the column true: the only
-- authority over stakes was BEFORE INSERT, so every blind level change after
-- a table was born left the label frozen at the birth level.
--
-- That is fixed. zzzzzz_tables_stakes_follows_its_own_blinds has been live
-- since 2026-09-19:
--
--   BEFORE UPDATE OF small_blind, big_blind, stakes ON public.tables
--   FOR EACH ROW WHEN (NEW.tournament_id IS NOT NULL AND (...distinct...))
--
-- and tournament_table_inherits_committed_blinds still covers the INSERT.
--
-- FULL CYCLE, MEASURED, NOT ASSUMED. Since the trigger landed: 163 tournament
-- tables born, 184 touched, and 0 of them drifted. The branch's own predicate,
-- run as a count rather than an update, returns 0 rows across every tournament
-- in RUNNING, REGISTERING or ANNOUNCED. It has nothing left to do.
--
-- The trigger is strictly broader than the branch it replaces: the branch only
-- ever looked at three tournament statuses, the trigger fires for any
-- tournament table. The only remaining way to drift is a write that bypasses
-- triggers outright, and a minutely UPDATE is not the answer to that.
--
-- WHY THE KEY STAYS. 'stakes_rows_fixed' is in the returned jsonb. Nothing in
-- the application reads it, only the two migrations that defined it, but a
-- dashboard that does read it should see the retirement rather than a missing
-- key, so it stays at 0 and says who owns the column now.
--
-- HISTORY IS NOT TOUCHED HERE. 40,996 tournament tables still carry a wrong
-- label, 28,649 of them the literal string 'undefined/undefined'. Every one
-- belongs to a CANCELLED or COMPLETED tournament, which is why this branch
-- never fixed them either: it only ever looked at live statuses. That
-- correction is its own change with its own blast radius, and hiding it
-- inside a reconciler removal would be the same mistake in a new direction.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.fn_reconcile_tournament_denormals()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_roster int := 0;
  v_dupes  int := 0;
  v_counts int := 0;
BEGIN
  WITH live_seat AS (
    SELECT s.user_id, tb.tournament_id, s.table_id, s.seat_number,
           ROW_NUMBER() OVER (
             PARTITION BY tb.tournament_id, s.user_id ORDER BY s.joined_at DESC NULLS LAST
           ) AS rn
      FROM public.table_seats s
      JOIN public.tables tb ON tb.id = s.table_id
     WHERE s.left_at IS NULL AND tb.tournament_id IS NOT NULL
  ), upd AS (
    UPDATE public.tournament_players tp
       SET table_id = ls.table_id, seat_number = ls.seat_number
      FROM live_seat ls
     WHERE ls.rn = 1
       AND tp.tournament_id = ls.tournament_id
       AND tp.user_id = ls.user_id
       AND tp.status IN ('registered', 'playing')
       AND (tp.table_id IS DISTINCT FROM ls.table_id
         OR tp.seat_number IS DISTINCT FROM ls.seat_number)
    RETURNING 1
  ) SELECT count(*) INTO v_roster FROM upd;

  -- The stakes branch was here. zzzzzz_tables_stakes_follows_its_own_blinds
  -- owns public.tables.stakes on UPDATE and
  -- tournament_table_inherits_committed_blinds owns it on INSERT. Do not add
  -- a third writer: if this column ever drifts again, the trigger is what was
  -- bypassed, and a minutely UPDATE would only hide that.

  WITH seat_first AS (
    SELECT t.id
      FROM public.tournaments t
     WHERE t.status IN ('REGISTERING', 'ANNOUNCED', 'RUNNING')
       AND (lower(COALESCE(t.variant, '')) IN ('spin', 'sng')
            OR COALESCE(t.max_players, 0) <= 2)
  ), ranked AS (
    SELECT tb.id,
           (SELECT count(*) FROM public.table_seats s
             WHERE s.table_id = tb.id AND s.left_at IS NULL) AS seats,
           public.fn_tournament_primary_table(tb.tournament_id) AS keep_id
      FROM public.tables tb
      JOIN seat_first sf ON sf.id = tb.tournament_id
     WHERE lower(COALESCE(tb.status, '')) <> 'closed'
  ), upd3 AS (
    UPDATE public.tables tb
       SET status = 'closed', current_players = 0
      FROM ranked r
     WHERE tb.id = r.id
       AND r.seats = 0
       AND r.keep_id IS NOT NULL
       AND r.keep_id <> r.id
    RETURNING 1
  ) SELECT count(*) INTO v_dupes FROM upd3;

  WITH truth AS (
    SELECT t.id,
           (lower(COALESCE(t.variant, '')) IN ('spin', 'sng')
            OR COALESCE(t.max_players, 0) <= 2) AS is_seat_first,
           public.fn_tournament_primary_table(t.id) AS primary_table,
           CASE
             WHEN lower(COALESCE(t.variant, '')) IN ('spin', 'sng')
                  OR COALESCE(t.max_players, 0) <= 2
             THEN (
               SELECT count(*) FROM public.table_seats s
                WHERE s.table_id = public.fn_tournament_primary_table(t.id)
                  AND s.left_at IS NULL
             )
             ELSE (
               SELECT count(*) FROM public.tournament_players tp
                WHERE tp.tournament_id = t.id
                  AND tp.status IN ('registered', 'playing')
             )
           END AS real_count
      FROM public.tournaments t
     WHERE t.status IN ('REGISTERING', 'ANNOUNCED', 'RUNNING')
  ), upd4 AS (
    UPDATE public.tournaments t
       SET current_players = truth.real_count
      FROM truth
     WHERE t.id = truth.id
       AND NOT (truth.is_seat_first AND truth.primary_table IS NULL)
       AND COALESCE(t.current_players, -1) IS DISTINCT FROM truth.real_count
    RETURNING 1
  ) SELECT count(*) INTO v_counts FROM upd4;

  RETURN jsonb_build_object(
    'roster_rows_fixed',   v_roster,
    'stakes_rows_fixed',   0,
    'stakes_owner',        'zzzzzz_tables_stakes_follows_its_own_blinds',
    'empty_dupes_closed',  v_dupes,
    'player_counts_fixed', v_counts
  );
END;
$function$;

DO $verify$
DECLARE
  v_body text := pg_get_functiondef('public.fn_reconcile_tournament_denormals()'::regprocedure);
  v_code text;
  v_out  jsonb;
BEGIN
  -- CLAUDE.md 7.3: assert the negative against the function BODY, not the
  -- header above, which describes the very write being forbidden. Slice out
  -- the dollar-quoted body and strip its own line comments before asserting.
  v_code := substring(v_body from position('$function$' in v_body));
  v_code := regexp_replace(v_code, '--[^\n]*', '', 'g');

  IF v_code LIKE '%UPDATE public.tables tb%SET stakes%' THEN
    RAISE EXCEPTION 'the stakes branch is still in the body';
  END IF;
  IF v_code NOT LIKE '%trim_scale%' THEN
    NULL; -- trim_scale may legitimately be absent now; this is not an assertion
  END IF;

  -- The branches that stay must still be there, or this removed more than one.
  IF v_code NOT LIKE '%tournament_players tp%' THEN
    RAISE EXCEPTION 'the roster branch went missing';
  END IF;
  IF v_code NOT LIKE '%empty_dupes_closed%' THEN
    RAISE EXCEPTION 'the duplicate-table branch went missing';
  END IF;
  IF v_code NOT LIKE '%player_counts_fixed%' THEN
    RAISE EXCEPTION 'the player-count branch went missing';
  END IF;

  -- The authority that replaced the branch must be live, enabled, and cover
  -- UPDATE. Removing the branch while the trigger is missing would reopen the
  -- exact defect.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
     WHERE t.tgrelid = 'public.tables'::regclass
       AND t.tgname = 'zzzzzz_tables_stakes_follows_its_own_blinds'
       AND t.tgenabled = 'O'
       AND pg_get_triggerdef(t.oid) LIKE '%BEFORE UPDATE OF small_blind, big_blind, stakes%'
  ) THEN
    RAISE EXCEPTION 'the UPDATE-path stakes authority is absent or disabled';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
     WHERE t.tgrelid = 'public.tables'::regclass
       AND t.tgname = 'tournament_table_inherits_committed_blinds'
       AND t.tgenabled = 'O'
  ) THEN
    RAISE EXCEPTION 'the INSERT-path stakes authority is absent or disabled';
  END IF;

  -- Behavioural: the function still runs and still reports its remaining work.
  v_out := public.fn_reconcile_tournament_denormals();
  IF v_out->>'stakes_rows_fixed' <> '0' THEN
    RAISE EXCEPTION 'stakes_rows_fixed is no longer the constant 0: %', v_out;
  END IF;
  IF NOT (v_out ? 'roster_rows_fixed' AND v_out ? 'empty_dupes_closed'
          AND v_out ? 'player_counts_fixed') THEN
    RAISE EXCEPTION 'the reported shape lost a key: %', v_out;
  END IF;

  RAISE NOTICE 'PASS: the minutely reconciler no longer writes a column a trigger owns; %', v_out;
END;
$verify$;