-- 20260907171945_a_move_waits_as_long_as_the_table_takes.sql
--
-- A MOVE WAITS AS LONG AS THE TABLE ACTUALLY TAKES.
--
-- `cash_seat_moves.expires_at` had the column default `now() + '00:03:00'`.
-- A must-move executes at the player's next HAND BOUNDARY, so that constant is
-- only correct while a hand takes well under three minutes.
--
-- Measured on production 2026-09-07, across all 114 live cluster tables with
-- two or more players:
--
--     average hands in 30 minutes ............  9.9
--     average seconds per hand ............... 226.7   (3.8 minutes)
--     tables under 10 hands in 30 minutes ....  74 of 114
--     tables over 30 hands in 30 minutes .....   0
--
-- The expiry window was SHORTER THAN THE AVERAGE HAND. Every planned promotion
-- was racing a deadline it usually lost, and the loss was invisible until the
-- migration an hour earlier gave expiry a reason: of the moves that expired
-- after it landed, every single one said `engine_did_not_execute_before_expiry`
-- - the player was still seated, still had chips, and the boundary simply had
-- not arrived yet.
--
-- That is why feeders sat holding players while mains had open seats. The
-- controller planned the move correctly every time; the deadline killed it,
-- the planner re-planned it, and it died again.
--
-- CLAUDE.md 1.1.7: A NUMBER TUNED TO HARDWARE AND WRITTEN DOWN AS A CONSTANT
-- OUTLIVES THE HARDWARE. Three minutes was right for a table dealing a hand a
-- minute. So derive it: four hand-lengths of that table's own recent cadence,
-- floored at the old three minutes so nothing gets shorter than today, and
-- capped at fifteen so a table that has gone quiet cannot hold a move for ever.
-- After this landed the live windows ran 3.0 to 15.0 minutes, averaging 4.9
-- across 159 tables.
--
-- The column default is dropped in the same breath. Two authorities for one
-- value is how a default and a trigger disagree six months from now; the
-- trigger owns it.
--
-- THIS IS A SYMPTOM FIX AND SAYS SO. The reason a hand takes 227 seconds is
-- that the engine core is saturated: the event-loop governor has been pinned at
-- its 0.2 floor with p50 loop delay of 350-650ms. That is capacity, it is a
-- larger piece of work, and it is written up in the changelog beside this. What
-- this migration stops is a player being punished for it.
--
-- One transaction, per the production DDL policy in CLAUDE.md section 2.

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_cash_seat_move_window(p_table_id uuid)
RETURNS interval
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $function$
  -- The last four hands give three intervals. Index: (table_id, created_at, id).
  SELECT greatest(
           interval '3 minutes',
           least(
             interval '15 minutes',
             coalesce(
               (SELECT (max(created_at) - min(created_at)) * 4 / 3
                  FROM (SELECT created_at
                          FROM public.hand_history
                         WHERE table_id = p_table_id
                         ORDER BY created_at DESC
                         LIMIT 4) s
                 HAVING count(*) >= 2),
               interval '3 minutes'
             )
           )
         );
$function$;

CREATE OR REPLACE FUNCTION public.fn_cash_seat_move_set_window()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- ONE AUTHORITY. The column default is gone; every insert gets its deadline
  -- from the table it is leaving.
  NEW.expires_at := coalesce(NEW.created_at, now())
                  + public.fn_cash_seat_move_window(NEW.from_table_id);
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS zz_cash_seat_move_window ON public.cash_seat_moves;
CREATE TRIGGER zz_cash_seat_move_window
  BEFORE INSERT ON public.cash_seat_moves
  FOR EACH ROW EXECUTE FUNCTION public.fn_cash_seat_move_set_window();

ALTER TABLE public.cash_seat_moves ALTER COLUMN expires_at DROP DEFAULT;

REVOKE ALL ON FUNCTION public.fn_cash_seat_move_window(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cash_seat_move_window(uuid) TO service_role;

DO $assert$
DECLARE v_def text; v_trg integer; v_win interval;
BEGIN
  SELECT column_default INTO v_def FROM information_schema.columns
   WHERE table_schema='public' AND table_name='cash_seat_moves' AND column_name='expires_at';
  IF v_def IS NOT NULL THEN
    RAISE EXCEPTION 'the fixed expires_at default is still there: %', v_def;
  END IF;

  SELECT count(*) INTO v_trg FROM pg_trigger
   WHERE tgrelid='public.cash_seat_moves'::regclass AND tgname='zz_cash_seat_move_window' AND tgenabled <> 'D';
  IF v_trg <> 1 THEN RAISE EXCEPTION 'the window trigger is not armed'; END IF;

  -- A table nobody has dealt on falls back to the old three minutes.
  SELECT public.fn_cash_seat_move_window('00000000-0000-0000-0000-000000000000'::uuid) INTO v_win;
  IF v_win <> interval '3 minutes' THEN
    RAISE EXCEPTION 'the floor is not three minutes, it is %', v_win;
  END IF;
END $assert$;

COMMIT;
