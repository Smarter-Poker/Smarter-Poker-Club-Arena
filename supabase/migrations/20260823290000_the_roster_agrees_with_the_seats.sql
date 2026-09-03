-- ============================================================================
-- 20260823290000_the_roster_agrees_with_the_seats.sql
-- TIER: 1  |  AFFECTS: data repair only - tournament_players.table_id /
--                      seat_number, tables.stakes. No function, no schema.
--
-- TWO COLUMNS THAT HAVE BEEN LYING
--
-- Both were found while tracing Dan's 2026-08-23 report, "I REGISTERED FOR A
-- TOURNAMENT DURING LATE REGISTRATION... IT TOOK ME TO THE PAGE, BUT DIDN'T
-- SIT ME". Neither IS that bug; both are why it was so hard to see.
--
-- 1. tournament_players.table_id
--
--    createTablesAndSeatPlayers wrote the table_seats row and stopped. Only
--    the late-reg sweep and the table-move path ever set table_id, so it
--    stayed NULL for every player seated at start.
--
--    Measured immediately before this ran: across all RUNNING tournaments,
--    297 live entrants, 297 genuinely holding a seat in table_seats - and 166
--    of them with table_id NULL. Every feature that navigates by that column
--    was broken for more than half the field; TournamentDetails' "go to my
--    table" link resolved to /table/undefined.
--
-- 2. tables.stakes
--
--    Written once at table creation as the LEVEL-1 blinds and never updated
--    again, while advanceBlindLevel moved small_blind/big_blind up on every
--    level. 151 live tournament tables disagreed with their own numeric
--    columns. TablePage preferred `stakes`, so a table at 750/1500 displayed
--    "25/50" - and because each seat's depth badge is stack / bigBlind, every
--    stack on the felt was shown thirty times too deep.
--
-- SAFETY
--
--   Repairs only. It moves nobody, seats nobody, and touches no money. Both
--   statements are restricted to live tournaments and derive every value from
--   table_seats or from the tables row itself, so re-running is a no-op.
-- ============================================================================

-- 0. Say out loud if anybody is sitting in two chairs. -----------------------
--
-- The repair below resolves a double-seated player to their most recent seat
-- and moves on, which would hide exactly the condition worth knowing about:
-- table_seats forbids two seats at ONE table and permits two seats at two.
DO $$
DECLARE v_dupes int;
BEGIN
  SELECT count(*) INTO v_dupes FROM (
    SELECT tb.tournament_id, s.user_id
      FROM public.table_seats s
      JOIN public.tables tb ON tb.id = s.table_id
     WHERE s.left_at IS NULL AND tb.tournament_id IS NOT NULL
     GROUP BY tb.tournament_id, s.user_id
    HAVING count(*) > 1
  ) d;
  IF v_dupes > 0 THEN
    RAISE WARNING
      'DOUBLE-SEATED: % player(s) hold more than one live seat in the same tournament. The repair keeps their most recent seat; the others are still live and need review.',
      v_dupes;
  END IF;
END $$;

-- 1. The roster learns where its players are actually sitting. ---------------
--
-- seat_number is FORCED, not COALESCEd. Preferring the existing value would
-- keep a stale seat number after a table move - the identical denormalisation
-- failure this repair exists to correct for table_id. The live table_seats row
-- is the authority for both columns or for neither.
WITH live_seat AS (
  SELECT s.user_id,
         tb.tournament_id,
         s.table_id,
         s.seat_number,
         ROW_NUMBER() OVER (
           PARTITION BY tb.tournament_id, s.user_id ORDER BY s.joined_at DESC NULLS LAST
         ) AS rn
    FROM public.table_seats s
    JOIN public.tables tb ON tb.id = s.table_id
   WHERE s.left_at IS NULL
     AND tb.tournament_id IS NOT NULL
)
UPDATE public.tournament_players tp
   SET table_id    = ls.table_id,
       seat_number = ls.seat_number
  FROM live_seat ls
 WHERE ls.rn = 1
   AND tp.tournament_id = ls.tournament_id
   AND tp.user_id       = ls.user_id
   AND tp.status IN ('registered', 'playing')
   AND (tp.table_id    IS DISTINCT FROM ls.table_id
     OR tp.seat_number IS DISTINCT FROM ls.seat_number);

-- 2. `stakes` agrees with the blinds the table is actually dealing. ----------
--
-- trim_scale(), not a bare ::text. small_blind is numeric(_,2), so ::text
-- renders "384000.00" while the engine writes "384000" from a JS number
-- (TournamentManagerBase.advanceBlindLevel). Two writers with two formats for
-- one column means the next level-up rewrites every row and any equality check
-- between them calls a correct row stale forever. trim_scale drops the
-- trailing zeros a numeric carries and leaves a genuine fraction alone
-- (0.50 -> 0.5, 2.25 -> 2.25) - exactly what JS number-to-string does.
UPDATE public.tables tb
   SET stakes = trim_scale(tb.small_blind)::text || '/' || trim_scale(tb.big_blind)::text
  FROM public.tournaments t
 WHERE t.id = tb.tournament_id
   AND t.status IN ('RUNNING', 'REGISTERING', 'ANNOUNCED')
   AND tb.small_blind IS NOT NULL
   AND tb.big_blind IS NOT NULL
   AND tb.stakes IS DISTINCT FROM
       (trim_scale(tb.small_blind)::text || '/' || trim_scale(tb.big_blind)::text);

-- Post-apply assertions ------------------------------------------------------
DO $$
DECLARE v_lying int; v_stale int;
BEGIN
  SELECT count(*) INTO v_lying
    FROM public.tournament_players tp
    JOIN public.tournaments t ON t.id = tp.tournament_id
   WHERE t.status = 'RUNNING'
     AND tp.status IN ('registered', 'playing')
     AND tp.table_id IS NULL
     AND EXISTS (
       SELECT 1 FROM public.table_seats s
        JOIN public.tables tb ON tb.id = s.table_id
       WHERE tb.tournament_id = tp.tournament_id
         AND s.user_id = tp.user_id
         AND s.left_at IS NULL
     );
  IF v_lying > 0 THEN
    RAISE EXCEPTION '% seated player(s) still have a NULL table_id', v_lying;
  END IF;

  SELECT count(*) INTO v_stale
    FROM public.tables tb
    JOIN public.tournaments t ON t.id = tb.tournament_id
   WHERE t.status = 'RUNNING'
     AND tb.small_blind IS NOT NULL AND tb.big_blind IS NOT NULL
     AND tb.stakes IS DISTINCT FROM
         (trim_scale(tb.small_blind)::text || '/' || trim_scale(tb.big_blind)::text);
  IF v_stale > 0 THEN
    RAISE EXCEPTION '% live tournament table(s) still advertise stale stakes', v_stale;
  END IF;
END $$;
