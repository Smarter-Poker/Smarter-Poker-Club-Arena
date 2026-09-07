-- 20260907171656_a_transient_failure_is_not_a_refusal.sql
--
-- A TRANSIENT FAILURE IS NOT A REFUSAL.
--
-- fn_cash_seat_move_execute ended with a bare WHEN OTHERS that cancels the
-- player's move and writes SQLERRM into its note:
--
--     EXCEPTION WHEN OTHERS THEN
--       UPDATE public.cash_seat_moves SET state = 'cancelled', note = left(SQLERRM, 200) ...
--
-- That is right for a real refusal - the destination filled, the player is
-- gone, the seat is taken. It is wrong for the three states that mean "the
-- database was busy, try again": 40P01 deadlock, 55P03 lock timeout, 40001
-- serialization failure. Measured over six hours on production: 11 moves
-- cancelled with note 'deadlock detected'.
--
-- The cost is not one lost move. The planner's back-off then refuses to
-- re-plan that player for 60 seconds (a deliberate rule, so a refusal is not
-- retried every 5s), so a database hiccup becomes a player sitting on a feeder
-- watching an open main seat for a minute. An infrastructure fault should
-- never be charged to a player.
--
-- The move now stays PENDING on those three states and the next hand boundary
-- retries it, bounded by its own expires_at. The exception has already rolled
-- the inner block back, so no half-moved seat survives. Same taxonomy the
-- tournament side already uses in server/src/tournament/completedFlip.ts.
--
-- Applied as an asserted single substitution on the live definition rather
-- than a retyped body; it fails if the search text is not found exactly once.
--
-- One transaction, per the production DDL policy in CLAUDE.md section 2.

BEGIN;

DO $patch$
DECLARE v_old text; v_new text; v_find text; v_repl text; v_hits integer;
BEGIN
  v_old := pg_get_functiondef('public.fn_cash_seat_move_execute'::regproc);

  v_find := '  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config(''app.cash_seat_move'', '''', true);
    UPDATE public.cash_seat_moves SET state = ''cancelled'', note = left(SQLERRM, 200) WHERE id = m.id;';

  v_repl := '  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config(''app.cash_seat_move'', '''', true);
    -- A TRANSIENT FAILURE IS NOT A REFUSAL (2026-09-07). 40P01 deadlock,
    -- 55P03 lock timeout and 40001 serialization all mean "try again", and
    -- cancelling for them also puts the player under the planner''s 60 second
    -- back-off. The move stays pending; the next hand boundary retries it,
    -- bounded by its own expires_at.
    IF SQLSTATE IN (''40P01'', ''55P03'', ''40001'') THEN
      UPDATE public.cash_seat_moves
         SET note = left(''retry after '' || SQLSTATE || '': '' || SQLERRM, 200)
       WHERE id = m.id;
      RETURN jsonb_build_object(''ok'', false, ''reason'', ''transient'',
                                ''retry'', true, ''detail'', left(SQLERRM, 200));
    END IF;
    UPDATE public.cash_seat_moves SET state = ''cancelled'', note = left(SQLERRM, 200) WHERE id = m.id;';

  SELECT count(*) INTO v_hits
    FROM regexp_matches(v_old, regexp_replace(v_find, '([.^$*+?()\[\]{}|\\])', '\\\1', 'g'), 'g');
  IF v_hits <> 1 THEN
    RAISE EXCEPTION 'expected exactly one WHEN OTHERS handler, found %', v_hits;
  END IF;

  v_new := replace(v_old, v_find, v_repl);
  IF v_new = v_old THEN RAISE EXCEPTION 'the substitution changed nothing'; END IF;
  EXECUTE v_new;
END $patch$;

DO $assert$
DECLARE v_def text;
BEGIN
  v_def := pg_get_functiondef('public.fn_cash_seat_move_execute'::regproc);
  IF position('40P01' in v_def) = 0 OR position('''transient''' in v_def) = 0 THEN
    RAISE EXCEPTION 'the live function does not carry the transient branch';
  END IF;
  -- The real refusal path must still be there.
  IF position('destination_refused' in v_def) = 0 THEN
    RAISE EXCEPTION 'the refusal path was lost';
  END IF;
END $assert$;

REVOKE ALL ON FUNCTION public.fn_cash_seat_move_execute(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cash_seat_move_execute(uuid) TO service_role;

COMMIT;
