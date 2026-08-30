-- ═══════════════════════════════════════════════════════════════════════════
--  IS ANYTHING ACTUALLY WRONG RIGHT NOW?
--  Read-only. Nothing here writes, so it is safe to run against production.
-- ═══════════════════════════════════════════════════════════════════════════
--
--  SEE ALSO: scripts/dev/money-conservation.sql -- does the money add up.
--  This file asks whether the GAME is stuck; that one asks whether the MONEY
--  is right. Every money bug found on 2026-08-29/30 was found by one of its
--  queries, and none by reading code first.
--
-- WHY THIS FILE EXISTS. The deadlock check that agents have been passing to
-- each other in handoff notes reads:
--
--     select count(*) from tournament_players tp
--       join tournaments t on t.id = tp.tournament_id
--      where t.status in ('RUNNING','COMPLETING')
--        and tp.status = 'playing'
--        and coalesce(tp.chips, 0) <= 0;   -- "expect 0"
--
-- It does not expect 0. It cannot.
--
-- Measured 2026-08-29 on `$100 Freeroll - 6:00 AM` (355 entrants, 40 tables):
-- 132 players sitting at exactly zero chips, unplaced, 82 minutes in, and
-- NOTHING WRONG. That event runs unlimited rebuys through level 6 plus an
-- add-on period, so a busted player is not out — they are waiting to buy back
-- in, and the field correctly piles up until the window shuts and then flushes
-- in batches. The same event's four previous runs recorded their first
-- elimination at 67, 69, 70 and 74 minutes: every one of them at the moment
-- the rebuy window closed, not before.
--
-- Roughly forty minutes went into confirming a healthy tournament was healthy.
-- A check that fires on healthy systems is worse than no check, because the
-- next person ignores it.
--
-- The two things the naive query is missing:
--
--   1. HOW LONG. A player at zero chips is normal for the seconds between
--      busting and the 5-second sweep reaching them. It is only a symptom if
--      it persists.
--   2. IS THE REBUY WINDOW SHUT. While `current_level <= coalesce(
--      late_reg_levels, rebuy_levels)` on a rebuy event, a zero stack is a
--      player deciding, not a player stuck.

-- ── 1. DEADLOCKED TOURNAMENTS ──────────────────────────────────────────────
-- Zero-chip players who are past their rebuy window and have been sitting
-- there while the sweep has had many chances to reach them. Expect 0 rows.
--
-- The clock is the last hand dealt at the tournament rather than a per-player
-- timestamp, because nothing stamps "went broke at". A tournament still
-- dealing hands two minutes after a player hit zero has had 24 sweeps to
-- eliminate them.
WITH live AS (
  SELECT t.id,
         t.name,
         t.current_level,
         COALESCE(t.late_reg_levels, t.rebuy_levels, 0) AS rebuy_cap,
         t.is_rebuy,
         t.add_on_available
    FROM tournaments t
   WHERE t.status IN ('RUNNING', 'COMPLETING')
), last_hand AS (
  SELECT tb.tournament_id, max(h.created_at) AS at
    FROM hand_history h
    JOIN tables tb ON tb.id = h.table_id
   WHERE h.created_at > now() - interval '2 hours'
   GROUP BY tb.tournament_id
)
SELECT l.id,
       left(l.name, 34)                       AS name,
       l.current_level,
       l.rebuy_cap,
       count(*)                               AS zero_chip_players,
       lh.at                                  AS last_hand_dealt,
       round(extract(epoch FROM (now() - lh.at))) AS seconds_since_last_hand
  FROM live l
  JOIN tournament_players tp ON tp.tournament_id = l.id
  LEFT JOIN last_hand lh     ON lh.tournament_id = l.id
 WHERE tp.status = 'playing'
   AND COALESCE(tp.chips, 0) <= 0
   -- The rebuy window is shut: nobody is buying back in, so a zero stack can
   -- only mean an elimination that has not happened.
   AND NOT (COALESCE(l.is_rebuy, false) AND l.current_level <= l.rebuy_cap)
   -- And the tournament is still alive, so the sweep has had its chances.
   AND lh.at > now() - interval '5 minutes'
 GROUP BY l.id, l.name, l.current_level, l.rebuy_cap, lh.at
 -- One or two in flight is the sweep doing its job. A pile is not.
HAVING count(*) >= 10
 ORDER BY count(*) DESC;

-- ── 2. LADDER HEALTH on recently completed events ──────────────────────────
-- max(position) should equal the entrant count, with nobody unplaced. Expect
-- correct = total.
SELECT count(*) FILTER (WHERE max_pos = entrants) AS correct,
       count(*)                                   AS total,
       sum(unplaced)                              AS players_left_unplaced
  FROM (
    SELECT t.id,
           count(*)                                        AS entrants,
           max(tp.position)                                AS max_pos,
           count(*) FILTER (WHERE tp.position IS NULL)     AS unplaced
      FROM tournaments t
      JOIN tournament_players tp ON tp.tournament_id = t.id
     WHERE t.status = 'COMPLETED'
       AND t.ended_at > now() - interval '1 day'
     GROUP BY t.id
  ) a;

-- ── 3. MONEY OWED ──────────────────────────────────────────────────────────
-- Every completed non-satellite event with a pool, dry run, nothing applied.
-- Expect 0.00.
--
-- NOTE THE WINDOW. `started_at`, not `updated_at`: `tournaments.updated_at` is
-- never maintained and holds row-creation time, which is what let 38 events
-- carrying 11,238.80 hide from fn_tournament_payout_sweep until 2026-08-29.
-- Widen the interval to reach further back; it is ~0.29ms per event.
WITH cand AS (
  SELECT id
    FROM tournaments
   WHERE status = 'COMPLETED'
     AND started_at > now() - interval '30 days'
     AND COALESCE(prize_pool, 0) > 0
     AND COALESCE(variant, '') <> 'satellite'
)
SELECT round(
         COALESCE(sum((fn_tournament_payout_reconcile(id, false)->>'total_top_up')::numeric), 0), 2
       ) AS total_owed
  FROM cand;

-- ── 4. DUPLICATE SEATS ─────────────────────────────────────────────────────
-- Multi-tabling is LEGAL: a player may sit at up to MAX_TABLES tables at once,
-- so ">1 open seat" is not a bug and reporting it as one has already wasted a
-- session. The real signatures are two seats at the SAME TABLE, or two seats
-- in the SAME TOURNAMENT. Expect 0 / 0.
WITH s AS (
  SELECT ts.user_id, ts.table_id, tb.tournament_id
    FROM table_seats ts
    JOIN tables tb ON tb.id = ts.table_id
   WHERE ts.left_at IS NULL
)
SELECT (SELECT count(*) FROM (
          SELECT user_id, table_id FROM s GROUP BY 1, 2 HAVING count(*) > 1
        ) a) AS same_table,
       (SELECT count(*) FROM (
          SELECT user_id, tournament_id FROM s
           WHERE tournament_id IS NOT NULL GROUP BY 1, 2 HAVING count(*) > 1
        ) b) AS same_tournament;

-- ── 5. IS THE ELIMINATION SWEEP ALIVE? ─────────────────────────────────────
-- Added 2026-08-29 alongside the sweep-lock watchdog. A tournament whose
-- manager has lost its sweep keeps DEALING (the table engines are separate)
-- while eliminating nobody, which is why "hands are being played" is not
-- evidence that anything is being reconciled. Compare the two directly.
SELECT left(t.name, 30)                                   AS name,
       t.current_level,
       count(*) FILTER (WHERE tp.status = 'playing')       AS playing,
       count(*) FILTER (WHERE tp.position IS NOT NULL)     AS placed,
       max(tp.eliminated_at)                               AS last_elimination,
       round(extract(epoch FROM (now() - max(tp.eliminated_at))) / 60) AS mins_since_elimination
  FROM tournaments t
  JOIN tournament_players tp ON tp.tournament_id = t.id
 WHERE t.status IN ('RUNNING', 'COMPLETING')
   AND t.started_at < now() - interval '90 minutes'
 GROUP BY t.id, t.name, t.current_level
 ORDER BY mins_since_elimination DESC NULLS FIRST;
