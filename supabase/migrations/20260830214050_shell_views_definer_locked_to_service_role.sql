-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260830214050; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- 2026-08-30 advisor cleanup (security_definer_view, ERROR level): the two
-- shell-telemetry aggregate views are SECURITY DEFINER (they must read the
-- whole client_shell_telemetry table past its own-rows RLS), and
-- `authenticated` still held SELECT on them - any logged-in user could read
-- fleet-wide telemetry aggregates. No client code reads these views (the CA
-- ShellTelemetryService only WRITES client_shell_telemetry; the views appear
-- solely in its doc comment). Ops and agents read them via service_role,
-- which keeps access.
revoke all on public.v_shell_staleness_rate from public, anon, authenticated;
revoke all on public.v_shell_reload_lateness from public, anon, authenticated;
grant select on public.v_shell_staleness_rate to service_role;
grant select on public.v_shell_reload_lateness to service_role;
