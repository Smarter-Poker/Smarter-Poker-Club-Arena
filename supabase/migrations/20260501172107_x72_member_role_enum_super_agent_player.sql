-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260501172107 "x72_member_role_enum_super_agent_player"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 3ade3bedff99574e02cb4ff8a747c1b8 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Round 72 fix: production club_members.role values include 'super_agent'
-- and 'player' but the member_role enum didn't list them. The column is
-- text so the rows were never rejected, but the schema-vs-reality drift
-- meant tooling that reads the enum (e.g. introspection, type-gen) saw
-- a misleading list. Make the enum match production:
--   - add 'super_agent' (1 row in prod, used as the de-facto club admin
--     role across waitlist / club-analytics / lobby-ordering / etc.)
--   - add 'player' (355 rows in prod, rendered identically to 'member'
--     in client UI; we keep both for now until a separate cleanup
--     migration unifies them)
ALTER TYPE member_role ADD VALUE IF NOT EXISTS 'super_agent';
ALTER TYPE member_role ADD VALUE IF NOT EXISTS 'player';

