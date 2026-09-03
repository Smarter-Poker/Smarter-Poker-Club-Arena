-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260831142242; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- PGRST002 root fix (2026-08-31).
-- PostgREST loads its schema cache over a connection logged in as `authenticator`,
-- which carried Supabase's default statement_timeout=8s. This schema (966 relations,
-- 2,729 functions) needs 18-31s to load, so every DDL-triggered reload was killed at 8s
-- (SQLSTATE 57014 on PostgREST's internal catalog query), putting PostgREST into a
-- PGRST002 retry loop and 503ing live traffic (47k 503s in the 13:00 UTC hour).
--
-- 1) Give the login role room for the cache query. Per-request API timeouts are NOT
--    governed by this: PostgREST applies the impersonated role's own settings
--    (anon=3s, authenticated=8s) per request.
ALTER ROLE authenticator SET statement_timeout = '5min';

-- 2) service_role had no explicit timeout and therefore inherited authenticator's 8s
--    for API requests. Pin it to its current effective value so raising authenticator
--    does not silently remove the cap on service-role API queries.
ALTER ROLE service_role SET statement_timeout = '8s';

-- 3) Ask PostgREST to re-read config and rebuild the schema cache.
NOTIFY pgrst, 'reload config';
NOTIFY pgrst, 'reload schema';
