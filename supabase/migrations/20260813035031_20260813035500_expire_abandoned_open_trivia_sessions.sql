-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260813035031 "20260813035500_expire_abandoned_open_trivia_sessions"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 98639152879b703ff0359333d2d51195 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════
-- 20260813035500_expire_abandoned_open_trivia_sessions.sql
-- ═══════════════════════════════════════════════════════════════════════
-- TIER:        2   (status-only data hygiene, no schema change)
-- AUTHOR:      Claude (Cowork session 2026-08-12)
-- AFFECTS:     public.trivia_sessions (status, submitted_at)
-- IRREVERSIBLE: no in practice — an abandoned session pays nothing either way.
--
-- WHY:
--   trivia_sessions rows are opened by session-start and closed by
--   session-submit. A player who walks away leaves the row 'open' forever:
--   nothing sweeps them. Rows from 2026-08-06 were still 'open' six days
--   later, alongside test rows created during this session's play-throughs.
--
--   No diamonds are at stake — solo entry is charged outside the session row
--   and PvP stake refunds are owned by the pvp-settle sweep, which keys off
--   diamond_transactions, not session status. The cost is analytical:
--   "abandoned" and "in progress" are indistinguishable, so any engagement
--   or completion-rate metric built on trivia_sessions is wrong from day one.
--
--   session-start already uses status = 'expired' for exactly this meaning
--   (see the double-start race handler), so this reuses that vocabulary
--   rather than inventing a new state.
--
-- SCOPE:
--   Only rows that are still 'open' AND older than 6 hours — the expiry
--   window the existing audits already describe. PvP sessions are included:
--   a 6h-old PvP session is long past PVP_MATCH_JOIN_WINDOW_MS.
--
-- NOT SOLVED HERE:
--   This is a one-off backfill. The recurring sweep belongs in a
--   pages/api/cron/ handler scheduled through Open Claw on Hetzner per
--   CLAUDE.md section 11 — that needs Hetzner deploy access, which this
--   session does not have. Without it, abandoned rows will accumulate again.
--
-- ROLLBACK:
--   UPDATE public.trivia_sessions
--      SET status = 'open', submitted_at = NULL
--    WHERE status = 'expired' AND submitted_at = <the timestamp this wrote>;
--   (Not recommended — these runs are genuinely abandoned.)
-- ═══════════════════════════════════════════════════════════════════════

BEGIN;

-- ─── 1. PRE-FLIGHT ────────────────────────────────────────────────────
DO $$
DECLARE
    v_open integer;
BEGIN
    SELECT count(*) INTO v_open
      FROM public.trivia_sessions
     WHERE status = 'open' AND created_at < now() - interval '6 hours';

    IF v_open > 1000 THEN
        RAISE EXCEPTION
            'pre-flight failed: % stale open sessions is far more than expected — investigate before sweeping', v_open;
    END IF;

    RAISE NOTICE 'pre-flight ok: % stale open sessions will be expired', v_open;
END $$;

-- ─── 2. THE CHANGE ────────────────────────────────────────────────────
UPDATE public.trivia_sessions
   SET status       = 'expired',
       submitted_at = now()
 WHERE status = 'open'
   AND created_at < now() - interval '6 hours';

-- ─── 3. POST-APPLY ASSERTIONS ─────────────────────────────────────────
DO $$
DECLARE
    v_remaining integer;
    v_graded    integer;
BEGIN
    SELECT count(*) INTO v_remaining
      FROM public.trivia_sessions
     WHERE status = 'open' AND created_at < now() - interval '6 hours';
    IF v_remaining <> 0 THEN
        RAISE EXCEPTION 'post-apply failed: % stale open sessions remain', v_remaining;
    END IF;

    -- Nothing that had already been graded may have been touched.
    SELECT count(*) INTO v_graded
      FROM public.trivia_sessions
     WHERE status = 'expired' AND correct_count IS NOT NULL;
    IF v_graded <> 0 THEN
        RAISE EXCEPTION 'post-apply failed: % graded sessions were marked expired', v_graded;
    END IF;

    RAISE NOTICE 'post-apply ok: no stale open sessions, no graded rows touched';
END $$;

COMMIT;
