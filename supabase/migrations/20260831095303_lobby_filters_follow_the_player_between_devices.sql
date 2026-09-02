-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260831095303; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- ─────────────────────────────────────────────────────────────────────────────
-- LOBBY FILTERS FOLLOW THE PLAYER (2026-08-31)
--
-- Dan 2026-08-30: "ALL FILTERS SELECTED MUST SAVE WHEN CLICKED UNTIL CHANGED
-- BY THE USER." That shipped, but only to localStorage
-- (ca_advanced_filters_<clubId>), which is per BROWSER. A player who sets
-- their filters on a laptop and opens the lobby on their phone gets the
-- unfiltered board, and "until changed by the user" is not true across the
-- devices one person actually uses.
--
-- This is the durable half. The pattern is the one user_theme_settings
-- already proves in this codebase: the DATABASE is the truth, and
-- localStorage stays as the synchronous first-paint cache so the lobby never
-- waits on a round trip to draw. Neither replaces the other.
--
-- ONE ROW PER PLAYER PER CLUB. Filters are per club by design - the game mix
-- differs - and the client keeps every game-type tab inside one JSON blob, so
-- the row shape mirrors the blob rather than exploding it into columns that
-- would have to migrate every time a filter is added.
--
-- RLS, AND WHY IT IS NOT OPTIONAL HERE. This is the first thing in this area
-- a BROWSER writes directly, so the row must be locked to its owner: policies
-- are USING/WITH CHECK auth.uid() = user_id on all four verbs. Without the
-- WITH CHECK on insert and update a player could write filters onto somebody
-- else's account - harmless-looking, but it is somebody else's lobby.
--
-- ROLLBACK: DROP TABLE IF EXISTS public.user_lobby_filters;
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.user_lobby_filters (
  user_id    uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  club_id    uuid        NOT NULL,
  filters    jsonb       NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, club_id)
);

COMMENT ON TABLE public.user_lobby_filters IS
  'Per-player, per-club lobby filter selections (the AdvancedFilters store, one JSON blob keyed by game type). Database is the truth; localStorage ca_advanced_filters_<clubId> remains the first-paint cache. Added 2026-08-31 so filters follow the player between devices.';

ALTER TABLE public.user_lobby_filters ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS user_lobby_filters_select_own ON public.user_lobby_filters;
CREATE POLICY user_lobby_filters_select_own ON public.user_lobby_filters
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

DROP POLICY IF EXISTS user_lobby_filters_insert_own ON public.user_lobby_filters;
CREATE POLICY user_lobby_filters_insert_own ON public.user_lobby_filters
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS user_lobby_filters_update_own ON public.user_lobby_filters;
CREATE POLICY user_lobby_filters_update_own ON public.user_lobby_filters
  FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS user_lobby_filters_delete_own ON public.user_lobby_filters;
CREATE POLICY user_lobby_filters_delete_own ON public.user_lobby_filters
  FOR DELETE TO authenticated USING (auth.uid() = user_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_lobby_filters TO authenticated;
GRANT ALL ON public.user_lobby_filters TO service_role;
REVOKE ALL ON public.user_lobby_filters FROM anon;

-- Post-apply assertions.
DO $$
DECLARE v_pol int; v_rls boolean; v_anon boolean;
BEGIN
  SELECT relrowsecurity INTO v_rls
    FROM pg_class WHERE oid = 'public.user_lobby_filters'::regclass;
  IF NOT v_rls THEN
    RAISE EXCEPTION 'post-apply failed: RLS is not enabled on user_lobby_filters';
  END IF;

  SELECT count(*) INTO v_pol FROM pg_policies
   WHERE schemaname='public' AND tablename='user_lobby_filters';
  IF v_pol <> 4 THEN
    RAISE EXCEPTION 'post-apply failed: expected 4 policies, found %', v_pol;
  END IF;

  -- anon must not be able to read one player's lobby preferences.
  SELECT has_table_privilege('anon', 'public.user_lobby_filters', 'SELECT') INTO v_anon;
  IF v_anon THEN
    RAISE EXCEPTION 'post-apply failed: anon can select user_lobby_filters';
  END IF;
END $$;
