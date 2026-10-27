-- Version reserved by scripts/new-migration.mjs.
-- Player-page filters were transient React state. Store each preference
-- independently so saving one control never replaces another control's value.
-- No game-table dependency or production player-data rewrite. Account deletion
-- removes only that account's preferences through its auth owner.
BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';
CREATE TABLE public.user_page_preferences (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  preference_key text NOT NULL CHECK (length(preference_key) BETWEEN 1 AND 240),
  value jsonb NOT NULL CHECK (octet_length(value::text) <= 16384),
  PRIMARY KEY (user_id, preference_key)
);
ALTER TABLE public.user_page_preferences ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.user_page_preferences FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.user_page_preferences TO authenticated;
GRANT ALL ON public.user_page_preferences TO service_role;
CREATE POLICY own_page_preference_read ON public.user_page_preferences
  FOR SELECT TO authenticated USING ((SELECT auth.uid()) = user_id);
CREATE POLICY own_page_preference_insert ON public.user_page_preferences
  FOR INSERT TO authenticated WITH CHECK ((SELECT auth.uid()) = user_id);
CREATE POLICY own_page_preference_update ON public.user_page_preferences
  FOR UPDATE TO authenticated USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);
COMMENT ON TABLE public.user_page_preferences IS
  'Player-selected page filters and view preferences, without expiration. No gameplay or financial state.';
COMMIT;
