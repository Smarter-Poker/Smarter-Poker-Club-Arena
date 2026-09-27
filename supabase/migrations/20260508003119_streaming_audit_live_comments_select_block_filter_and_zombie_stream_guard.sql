-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260508003119 "streaming_audit_live_comments_select_block_filter_and_zombie_stream_guard"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 7aee3729a9893d15c366d40b6056ba14 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.


-- ═══════════════════════════════════════════════════════════════════════════
-- Streaming rigor audit pass — DB-side fixes
--
-- A5 (high): live_comments SELECT policy was qual=true. Mutual-block filter
--            was applied client-side only, which Realtime + direct REST
--            queries bypass. Adversary subscribing directly to
--            postgres_changes received raw INSERTs from blocked users.
--            Fix: enforce mutual-block at the RLS layer. Realtime respects
--            RLS, so block enforcement now extends to:
--               - Direct table SELECTs
--               - postgres_changes payloads
--               - REST queries via supabase-js
--            Service-role paths (comment.js, moderate.js) bypass RLS so
--            broadcasters can still see all comments to moderate them.
--
-- E5 (medium): no UNIQUE constraint preventing one broadcaster from owning
--            multiple status='live' rows. Two-tab go-live race produced
--            zombie streams. Partial UNIQUE INDEX seals it.
-- ═══════════════════════════════════════════════════════════════════════════

-- ───────────────────────────────────────────────────────────────────────────
-- A5: live_comments SELECT — mutual-block filter at RLS layer
-- ───────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS lc_sel ON public.live_comments;
CREATE POLICY lc_sel
  ON public.live_comments
  FOR SELECT
  USING (
    -- Anonymous (auth.uid() IS NULL) callers can read everything — replay
    -- viewers and SSR/SEO crawlers depend on this. Service-role queries
    -- (moderation, server-side reads in /api/live/comment slow-mode check)
    -- always bypass RLS regardless.
    auth.uid() IS NULL
    -- Authenticated callers can read their OWN comments unconditionally,
    -- the broadcaster can read everything in their own stream, and
    -- otherwise we filter mutually-blocked author/viewer pairs.
    OR (SELECT auth.uid()) = user_id
    OR EXISTS (
      SELECT 1 FROM public.live_streams s
      WHERE s.id = live_comments.stream_id 
        AND s.broadcaster_id = (SELECT auth.uid())
    )
    OR (
      NOT EXISTS (
        SELECT 1 FROM public.blocked_users b
        WHERE b.blocker_id = (SELECT auth.uid()) AND b.blocked_id = live_comments.user_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.blocked_users b
        WHERE b.blocker_id = live_comments.user_id AND b.blocked_id = (SELECT auth.uid())
      )
    )
  );

COMMENT ON POLICY lc_sel ON public.live_comments IS
  'A5 fix: mutual-block filter enforced at RLS layer so Realtime postgres_changes payloads also respect blocks. Broadcaster sees all comments in their own stream (for moderation). Service-role bypass intact for server-side moderation paths.';


-- ───────────────────────────────────────────────────────────────────────────
-- E5: prevent multi-tab dup live broadcasts via partial unique index
-- ───────────────────────────────────────────────────────────────────────────
-- Partial unique index lets a broadcaster have many ended/cancelled rows
-- but at most ONE 'live' row at any time. Second-tab Go Live now fails at
-- the DB level with a clean unique-violation that LiveStreamService can
-- surface to the user instead of silently creating a zombie.
--
-- Race-tolerant: if two parallel inserts hit at the same instant, exactly
-- one wins; the loser gets a 23505 unique_violation that the client can
-- handle as "you're already live in another tab".
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes 
    WHERE schemaname='public' AND indexname='live_streams_one_live_per_broadcaster'
  ) THEN
    CREATE UNIQUE INDEX live_streams_one_live_per_broadcaster
      ON public.live_streams (broadcaster_id)
      WHERE status = 'live';
  END IF;
END $$;

COMMENT ON INDEX public.live_streams_one_live_per_broadcaster IS
  'E5 fix: partial unique index — at most one live row per broadcaster. Prevents dup-tab zombie streams. Second concurrent Go Live raises unique_violation (23505) which LiveStreamService surfaces to the user.';

