-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260815212649 "messenger_prefs_rls_allow_update_delete_and_stop_cross_user_reads"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 cc3f11c2aecf50a8d882a81fc7602463 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- MESSENGER PREFERENCES — the RLS was write-once and read-everyone
-- ═══════════════════════════════════════════════════════════════════════════
-- messenger_bookmarks / messenger_labels / messenger_themes are all EMPTY
-- platform-wide. The messenger upserts to them on every bookmark, label and
-- theme change, and catches failures with a console.warn, so nothing ever
-- surfaced. Reproduced under a real authenticated JWT:
--
--   theme CHANGE (ON CONFLICT DO UPDATE)  -> ERROR: new row violates
--                                            row-level security policy
--                                            (USING expression)
--   un-theme / un-label (DELETE)          -> no error, 0 rows deleted
--
-- Cause: labels and themes had ONLY an INSERT policy and a SELECT policy.
--   * No UPDATE policy, so the second write to the same key -- which is what
--     CHANGING a theme is -- is refused outright.
--   * No DELETE policy, so removing a label or a theme silently affects zero
--     rows: RLS filters the row out of the DELETE's scope rather than raising.
--   * bookmarks had DELETE but no UPDATE, so a repeat upsert failed the same
--     way as themes.
--
-- Separately, the SELECT policies on labels and themes were `USING (true)`:
-- ANY authenticated user could read EVERY other user's message labels
-- (including the urgent / normal / low priority flags they put on specific
-- messages) and their per-conversation themes. These are per-user preference
-- rows keyed by user_id; there is no reason for anyone but the owner to read
-- them.
--
-- All policies below are owner-only and use the (SELECT auth.uid()) form the
-- rest of this schema standardised on (it is evaluated once per statement
-- rather than once per row).

-- ── messenger_themes ───────────────────────────────────────────────────────
DROP POLICY IF EXISTS "messenger_themes_authenticated" ON public.messenger_themes;
CREATE POLICY "messenger_themes_select_self" ON public.messenger_themes
  FOR SELECT USING (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "messenger_themes_update_self" ON public.messenger_themes;
CREATE POLICY "messenger_themes_update_self" ON public.messenger_themes
  FOR UPDATE USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "messenger_themes_delete_self" ON public.messenger_themes;
CREATE POLICY "messenger_themes_delete_self" ON public.messenger_themes
  FOR DELETE USING (user_id = (SELECT auth.uid()));

-- ── messenger_labels ───────────────────────────────────────────────────────
DROP POLICY IF EXISTS "messenger_labels_authenticated" ON public.messenger_labels;
CREATE POLICY "messenger_labels_select_self" ON public.messenger_labels
  FOR SELECT USING (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "messenger_labels_update_self" ON public.messenger_labels;
CREATE POLICY "messenger_labels_update_self" ON public.messenger_labels
  FOR UPDATE USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "messenger_labels_delete_self" ON public.messenger_labels;
CREATE POLICY "messenger_labels_delete_self" ON public.messenger_labels
  FOR DELETE USING (user_id = (SELECT auth.uid()));

-- ── messenger_bookmarks ────────────────────────────────────────────────────
-- Already owner-only for SELECT/INSERT/DELETE; only UPDATE was missing, which
-- is what a repeat upsert of an existing bookmark needs.
DROP POLICY IF EXISTS "messenger_bookmarks_update_self" ON public.messenger_bookmarks;
CREATE POLICY "messenger_bookmarks_update_self" ON public.messenger_bookmarks
  FOR UPDATE USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));
