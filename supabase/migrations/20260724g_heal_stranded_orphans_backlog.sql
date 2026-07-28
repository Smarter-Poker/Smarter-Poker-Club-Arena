-- ═══════════════════════════════════════════════════════════════════════════════
--  DATA HEAL — Stranded tournament players + orphan tournament tables (backlog)
-- ═══════════════════════════════════════════════════════════════════════════════
--  Applied to production (kuklfnapbkmacvwxktbh) 2026-07-24 after the sweep-4/5/6
--  engine restart. The new build stops NEW stranded/orphan rows (the 100-game
--  scorecard showed zero on recent completions), but the engine's boot sweep does
--  NOT retroactively backfill months-old residue, so this one-time heal clears the
--  pre-restart backlog — the same kind of heal migration 20260724c performed.
--
--  SAFETY — STATUS ONLY, ZERO MONEY MOVEMENT:
--    • Stranded players (102): all on COMPLETED/CANCELLED tournaments. The 96 on
--      CANCELLED events were ALL horses (register free → nothing to refund); the 6
--      on a COMPLETED event were non-cashing finishers (prize=0, the winner was
--      already paid). Setting status→'eliminated' only corrects the status row; it
--      pays/refunds nothing.
--    • Orphan tables (893): tables left 'waiting'/'running' whose tournament is
--      COMPLETED/CANCELLED. Setting status→'closed' is pure lifecycle hygiene.
--
--  Idempotent: re-running matches nothing once healed.
-- ═══════════════════════════════════════════════════════════════════════════════

-- 1. Close stranded tournament_players rows on finished tournaments.
UPDATE tournament_players tp
SET status = 'eliminated',
    eliminated_at = COALESCE(tp.eliminated_at, t.ended_at, now())
FROM tournaments t
WHERE t.id = tp.tournament_id
  AND tp.status IN ('playing','registered','active')
  AND t.status IN ('COMPLETED','CANCELLED');

-- 2. Close orphan tables whose tournament has finished.
UPDATE tables tb
SET status = 'closed'
FROM tournaments t
WHERE t.id = tb.tournament_id
  AND t.status IN ('COMPLETED','CANCELLED')
  AND COALESCE(tb.status,'') IN ('waiting','running');
