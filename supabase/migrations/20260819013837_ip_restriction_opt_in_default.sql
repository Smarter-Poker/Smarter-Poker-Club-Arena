-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260819013837 "ip_restriction_opt_in_default"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 bdbdad19c41de27ddff83e96cc5200b6 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- IP Restriction becomes a real, enforced control (engine WS upgrade refuses a
-- second account at a table from an address already there).
--
-- The column default was `true`, so all 56,053 live tables carry
-- ip_restriction = true — not because any owner chose it, but because the
-- switch never meant anything. Turning enforcement on with that data would
-- silently apply a collusion control to the entire fleet overnight: two people
-- in one household could not sit at the same table anywhere on the site.
--
-- Same shape as the rake-cap rollout: move the DATA to a deliberate value
-- FIRST, ship the enforcing code after. Owners opt in.
--
-- DDL only here. The 56k-row backfill runs in batches afterwards — a single
-- bulk UPDATE plus DDL against this hot table deadlocked once already (40P01).
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.tables ALTER COLUMN ip_restriction SET DEFAULT false;
