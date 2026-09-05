-- ═══════════════════════════════════════════════════════════════════════════
--  AN INDEX FOR THE COMMISSIONS THE BREAKDOWN ADDS UP
--  Club Operations upgrade, phase 7 of 8. The last measured component.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- With the per-hand re-derivation gone (20260905042100), the live edge on a
-- rollup (20260905074228) and the range indexed (20260905042500),
-- `fn_ca_rake_by_agent` is 703ms for the page's default month range. Of that,
-- **425ms is one CTE**:
--
--     SELECT ac.user_id, SUM(ac.amount), SUM(...) FILTER (...), SUM(...) FILTER (...)
--       FROM agent_commissions ac
--      WHERE ac.club_id = p_club_id
--        AND ac.created_at >= v_from AND ac.created_at < v_to
--      GROUP BY ac.user_id
--
-- `agent_commissions` has six indexes and not one of them leads on
-- `(club_id, created_at)`. The planner uses `idx_agent_commissions_club_id`,
-- which knows the club and nothing about the date, so it bitmap-scans every
-- commission the club has ever paid and discards what falls outside the
-- window: **694,941 rows for a seven-day question**.
--
-- The nearest existing index, `agent_commissions_unsettled_idx`, is
-- `(club_id, user_id) INCLUDE (amount, created_at) WHERE settled_at IS NULL` -
-- partial, so it cannot answer a query that counts settled commissions too,
-- and led by user rather than by date.
--
-- This one covers the whole CTE: `(club_id, created_at)` for the range, with
-- `user_id`, `amount` and `settled_at` carried in the leaf so the three
-- aggregates and both FILTERs are answered without touching the heap at all.
--
-- APPLIED INSIDE THE `:55` MAINTENANCE FREEZE (CLAUDE.md 13). This is the
-- third hot table this phase has indexed and the rule has not changed:
-- `agent_commissions` takes a row per agent per raked hand - 694,941 in seven
-- days on this club alone - so a plain CREATE INDEX blocks the engine's
-- writers for the length of its scan. During the freeze every table is parked
-- at a hand boundary and nothing is writing. CREATE INDEX CONCURRENTLY cannot
-- run inside the single transaction a migration must be.
--
-- WHY IT IS WORTH A FREEZE FOR 425ms. The operator page has been failing at
-- the `authenticated` role's 8 second ceiling, intermittently, all through
-- this phase. Every structural cause is now gone and what remains is variance:
-- typical reads are 0.5-2.2s and a burst can still reach the ceiling. Taking
-- 425ms out of the median is what moves the whole distribution away from it.
-- ═══════════════════════════════════════════════════════════════════════════
BEGIN;

SET LOCAL lock_timeout = '30s';
SET LOCAL statement_timeout = '0';

CREATE INDEX IF NOT EXISTS idx_agent_commissions_club_created
  ON public.agent_commissions (club_id, created_at)
  INCLUDE (user_id, amount, settled_at);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public'
       AND tablename  = 'agent_commissions'
       AND indexname  = 'idx_agent_commissions_club_created'
  ) THEN
    RAISE EXCEPTION 'the commission CTE still has no index that knows the date';
  END IF;
END $$;

COMMIT;
