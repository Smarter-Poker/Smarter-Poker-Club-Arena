-- ═════════════════════════════════════════════════════════════════════════════
-- THE PUBLISHED WINDOW: 72 HOURS, AND 200 IS A FEATURE EVENT
-- Dan 2026-08-26: "USE 72H/6 DAY FOR $200 BUY IN OR MORE"
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Two changes to the bound inside get_club_home, both revising the first pass:
--
--   48 hours -> 72 hours. 72 was already what the TOURNAMENT lobby used
--   (TournamentLobbyPage), so this is the two surfaces agreeing rather than a
--   new number. A player checking the club board and the tournament board
--   should not be told two different things about how far ahead this room
--   publishes. The client half of the rule moves with it, in
--   src/utils/tournamentScheduleWindow.ts, and both pages now read it.
--
--   `> 200` -> `>= 200`. The first pass read "more then 200" literally, which
--   put a flat 200 event on the SHORT window - and the Sunday Deep Stack added
--   in the same batch is priced at exactly 200. "OR MORE" settles it.
--
-- The long window is unchanged at 6 days total, so the CASE now adds 3 days to
-- the 72-hour base rather than 4 days to a 48-hour base.
--
-- REWRITTEN FROM THE FUNCTION'S OWN DEFINITION rather than re-typed. This
-- function is ~200 lines and only one predicate is changing; re-transcribing
-- it is how a body drifts from what was reviewed. pg_get_functiondef gives the
-- exact current statement, the replacement is asserted to have hit, and the
-- result is executed. If the predicate is not found verbatim, the migration
-- ABORTS rather than silently leaving the old window in place.

DO $$
DECLARE
  v_def  text;
  v_new  text;
  v_old_pred CONSTANT text :=
    'AND start_time <= now() + interval ''48 hours''' || E'\n' ||
    '             + CASE' || E'\n' ||
    '                 WHEN COALESCE(buy_in_amount, 0) + COALESCE(buy_in_fee, 0) > 200' || E'\n' ||
    '                   THEN interval ''4 days''' || E'\n' ||
    '                 ELSE interval ''0''' || E'\n' ||
    '               END';
  v_new_pred CONSTANT text :=
    'AND start_time <= now() + interval ''72 hours''' || E'\n' ||
    '             + CASE' || E'\n' ||
    '                 WHEN COALESCE(buy_in_amount, 0) + COALESCE(buy_in_fee, 0) >= 200' || E'\n' ||
    '                   THEN interval ''3 days''' || E'\n' ||
    '                 ELSE interval ''0''' || E'\n' ||
    '               END';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'get_club_home';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'get_club_home not found';
  END IF;
  IF position(v_old_pred in v_def) = 0 THEN
    RAISE EXCEPTION 'the 48-hour predicate is not present verbatim - get_club_home has changed since this migration was written. Re-read it before re-running.';
  END IF;

  v_new := replace(v_def, v_old_pred, v_new_pred);

  IF position(v_new_pred in v_new) = 0 THEN
    RAISE EXCEPTION 'replacement did not take';
  END IF;

  EXECUTE v_new;
END $$;

-- ── POST-APPLY ASSERTIONS ───────────────────────────────────────────────────

DO $$
DECLARE
  v_src text;
BEGIN
  SELECT prosrc INTO v_src
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'get_club_home';

  IF v_src NOT LIKE '%interval ''72 hours''%' THEN
    RAISE EXCEPTION 'get_club_home does not carry the 72 hour window';
  END IF;
  IF v_src NOT LIKE '%>= 200%' THEN
    RAISE EXCEPTION 'get_club_home still uses a strict > 200 threshold';
  END IF;
  IF v_src LIKE '%interval ''48 hours''%' THEN
    RAISE EXCEPTION 'the old 48 hour window is still present';
  END IF;

  -- The function must still RUN. A body rebuilt by string replacement that
  -- parses but throws is worse than one that never applied.
  PERFORM public.get_club_home('fade0000-0000-0000-0000-000000000001');
END $$;

-- ROLLBACK: re-run this migration with the two predicates swapped
-- (72 hours -> 48 hours, >= 200 -> > 200, 3 days -> 4 days).
