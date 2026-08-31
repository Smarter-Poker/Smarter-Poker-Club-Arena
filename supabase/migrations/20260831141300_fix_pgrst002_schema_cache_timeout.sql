-- Applied to production 2026-08-31 ~14:13 UTC via mgmt API (mirrored here per
-- CLAUDE.md rule: schema changes live in supabase/migrations/).
-- PGRST002 root fix. PostgREST loads its schema cache over a connection logged
-- in as `authenticator`, which carried Supabase's default statement_timeout=8s.
-- This schema (~970 relations, ~2,700 functions) needs ~28s to load, so every
-- DDL-triggered reload was killed at 8s (SQLSTATE 57014 on PostgREST's internal
-- catalog query), putting PostgREST into a PGRST002 retry loop and 503ing live
-- traffic (47k 503s in the 13:00 UTC hour).
ALTER ROLE authenticator SET statement_timeout = '5min';
-- service_role had no explicit timeout and inherited authenticator's 8s for API
-- requests; pin it so raising authenticator does not silently remove the cap.
ALTER ROLE service_role SET statement_timeout = '8s';
NOTIFY pgrst, 'reload config';
NOTIFY pgrst, 'reload schema';
