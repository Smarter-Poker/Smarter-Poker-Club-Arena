-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820204604 "close_abandoned_duplicate_tournament_tables"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 b455ffcdec9a1bba2529f1721745d529 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- 2026-08-20: close the ABANDONED duplicate tables left behind when an
-- engine restart re-ran createTablesAndSeatPlayers on an already-RUNNING
-- tournament.
--
-- That function inserted a fresh set of tables on every call and seated the
-- whole field into them, ignoring tables the tournament already had. start()
-- calls it BEFORE the "only REGISTERING -> RUNNING" status guard, so a restart
-- built a complete second set and re-seated everybody, leaving the originals
-- live and seated.
--
-- Observed: "5 Chip Turbo SNG 6-Max NLH" held THREE tables all named
-- "Table 1" -- the real one from 20:20:53 (22 hands, no hand since the
-- 20:33:41 restart) plus duplicates at 20:33:58 and 20:34:04, each with six
-- live seats. Six players sat at two tables dealing hands concurrently with
-- diverging stacks, so the field held 18,000 chips against 9,000 issued.
--
-- Fixed at source in Club Arena 77581ddcd: the function is now idempotent --
-- it adopts existing tables, creates only the shortfall, and never re-seats a
-- player who already holds a live seat.
--
-- This closes the abandoned copies. For each affected tournament it KEEPS the
-- table with the most recent hand -- the one the live engine is actually
-- dealing, and therefore the one carrying the current stacks -- and closes the
-- rest. The chips on a closed duplicate are phantom: they were never issued,
-- they are a second copy of the same players' stacks.
--
-- Verified before applying (dry run): exactly one tournament affected, KEEP
-- 730ab652 (last hand 20:44:51, 9,000 chips) / close 75967217 (last hand
-- 20:33:41, 9,000 phantom chips) -- restoring the field to exactly the 9,000
-- issued.
--
-- tournament_players.chips re-syncs from the surviving seats on the next
-- elimination sweep, which runs every 5s.
--
-- Idempotent: with no duplicates, dup_t is empty and nothing is updated.

WITH dup_t AS (
  SELECT tb.tournament_id AS tid
    FROM table_seats s JOIN tables tb ON tb.id = s.table_id
   WHERE s.left_at IS NULL AND tb.tournament_id IS NOT NULL
   GROUP BY s.user_id, tb.tournament_id
  HAVING count(*) > 1
),
ranked AS (
  SELECT tb.id, tb.tournament_id,
         row_number() OVER (
           PARTITION BY tb.tournament_id
           ORDER BY (SELECT max(h.created_at) FROM hand_history h WHERE h.table_id = tb.id)
                      DESC NULLS LAST,
                    tb.created_at DESC) AS rn
    FROM tables tb
   WHERE tb.tournament_id IN (SELECT DISTINCT tid FROM dup_t)
     AND tb.status IN ('running','waiting')
),
doomed AS (SELECT id FROM ranked WHERE rn > 1),
seats_closed AS (
  UPDATE table_seats ts SET left_at = now()
   WHERE ts.left_at IS NULL AND ts.table_id IN (SELECT id FROM doomed)
  RETURNING 1
)
UPDATE tables t SET status = 'closed'
 WHERE t.id IN (SELECT id FROM doomed);
