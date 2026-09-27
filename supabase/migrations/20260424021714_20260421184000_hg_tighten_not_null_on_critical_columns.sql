-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260424021714 "20260421184000_hg_tighten_not_null_on_critical_columns"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 4863c83f81b8b5e87bd7a8fd0836451d of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Deeper bug hunt: critical identity/lifecycle columns were nullable
-- (relying on DEFAULTs only). Now enforced NOT NULL. Verified zero
-- existing NULL rows before tightening.
--
-- Defense-in-depth: RLS already prevents direct INSERT, but a mistake
-- in a future SECDEF fn could insert explicit NULL. NOT NULL makes
-- the DB refuse outright.

ALTER TABLE public.commander_home_members
  ALTER COLUMN role        SET NOT NULL,
  ALTER COLUMN status      SET NOT NULL,
  ALTER COLUMN created_at  SET NOT NULL;

ALTER TABLE public.commander_home_games
  ALTER COLUMN status      SET NOT NULL,
  ALTER COLUMN created_at  SET NOT NULL;

ALTER TABLE public.commander_home_groups
  ALTER COLUMN created_at  SET NOT NULL;

ALTER TABLE public.commander_home_posts
  ALTER COLUMN created_at  SET NOT NULL;

ALTER TABLE public.commander_home_game_reviews
  ALTER COLUMN created_at  SET NOT NULL;
