-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260830213957; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- 2026-08-30 advisor cleanup (auth_rls_initplan): these three policies call
-- auth.uid() bare, which Postgres re-evaluates PER ROW. Wrapping it in a
-- scalar subselect makes it an InitPlan evaluated once per statement.
-- Semantics identical; performance advisory resolved.

alter policy bomb_pot_award_units_read on public.bomb_pot_award_units
  using (
    (user_id = (select auth.uid()))
    or exists (
      select 1
        from tables t
        join club_members cm on cm.club_id = t.club_id
       where t.id = bomb_pot_award_units.table_id
         and cm.user_id = (select auth.uid())
    )
  );

alter policy client_shell_telemetry_insert_own on public.client_shell_telemetry
  with check (user_id = (select auth.uid()));

alter policy customization_operations_insert_own on public.customization_operations
  with check (user_id = (select auth.uid()));
