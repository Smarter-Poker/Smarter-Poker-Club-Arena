-- 20260907035649_the_jackpot_pool_row_leaves_the_realtime_publication.sql
--
-- Reserved by scripts/new-migration.mjs as 20260907035622, then RENAMED to the
-- version the Supabase MCP recorded when it applied this, so a rebuild from
-- these files records the same version the database has.
--
-- ═══════════════════════════════════════════════════════════════════════════
--  THE JACKPOT POOL ROW LEAVES THE FIREHOSE
--  BBJ build plan phase 3.2, the second half (docs/BBJ-BUILD-PLAN.md)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHAT WAS BEING PAID FOR. `bbj_pools` is updated on every raked hand, because
-- every raked hand contributes to the jackpot. Measured on production
-- 2026-09-06: 40,219 updates in twenty-four hours, one every 2.1 seconds,
-- around the clock. Each one was decoded by the WAL reader, filtered per
-- subscriber, and pushed to every open tab, visible or not.
--
-- NINE surfaces subscribed to it - six in Club Arena and three in the World
-- Hub - to keep current a figure a player glances at, and to carry a signal
-- (the jackpot being hit) that fires about once a fortnight.
--
-- WHAT REPLACED IT, and why this is safe now:
--
--   THE FIGURE  One poll of fn_bbj_pool_for_club per CLUB every ten seconds,
--               shared by every surface, paused while the tab is hidden
--               (src/lib/bbjPoolFeed.ts). Club Arena PR #3385.
--   THE HIT     The `bbj_winners` INSERT - one row per jackpot, written inside
--               the payout transaction (src/lib/bbjHitFeed.ts), plus the
--               engine's own socket fan-out to every live table. It never came
--               through bbj_pools in a form worth having: the client inferred
--               it from `hit_count` going up, and `payload.old` carries only
--               the primary key, so the previous count was always 0.
--
-- BOTH BUNDLES ARE LIVE. This is the gate, and it is why this migration is
-- separate from the code that made it safe. Verified before applying:
--   Club Arena  ca_sha 2567496732, and b0a646b8bc (#3385) is its ancestor
--   World Hub   deployed sha 093b03bfb8, and 0666d1d547 (#1516) is its ancestor
--   origin/main carries ZERO `table: 'bbj_pools'` bindings across all six
--   Club Arena surfaces, and none in the World Hub.
-- A browser still holding an older bundle keeps its last figure until it
-- reloads. That is the one accepted cost, and it self-heals.
--
-- bbj_winners STAYS in the publication. It is the hit path now, and the
-- assertions below refuse to let this migration pass if it went with it.
--
-- ROLLBACK:
--   ALTER PUBLICATION supabase_realtime ADD TABLE public.bbj_pools;
BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'bbj_pools'
  ) THEN
    RAISE NOTICE 'bbj_pools is already out of the publication; this is a no-op.';
  ELSE
    ALTER PUBLICATION supabase_realtime DROP TABLE public.bbj_pools;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'bbj_pools'
  ) THEN
    RAISE EXCEPTION 'post-check: bbj_pools is still in supabase_realtime';
  END IF;

  -- The hit path. If this ever goes, the jackpot stops announcing itself and
  -- the only remaining route is the engine socket, which reaches a player at a
  -- table and nobody in the lobby.
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'bbj_winners'
  ) THEN
    RAISE EXCEPTION 'post-check: bbj_winners is NOT in supabase_realtime - the hit would announce to nobody outside a table';
  END IF;
END $$;

COMMIT;
