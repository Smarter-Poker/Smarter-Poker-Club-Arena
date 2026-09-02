-- ═══════════════════════════════════════════════════════════════════════════
--  A NEW VIEW MUST NOT INHERIT WRITE GRANTS
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHAT BROKE. CHECK 10 of the Build Safety Gate (`no_client_writable_views`)
-- went red on 2026-08-28 and blocked every pull request in the estate. The
-- named offenders were `v_insurance_activity` and `v_insurance_pnl`, created
-- earlier the same day by 20260828120500_insurance_reconciliation_and_views.sql.
--
-- THAT MIGRATION CONTAINS NO GRANT STATEMENT. It did not do this. The default
-- ACL did:
--
--   pg_default_acl, schema public, objtype r
--     anon=arwdxtm/postgres, authenticated=arwdxtm/postgres
--
-- `a`, `w` and `d` are INSERT, UPDATE and DELETE. Postgres applies the default
-- ACL for relations to VIEWS as well as tables, so EVERY view created in
-- `public` is born holding client write grants that nobody typed. The author
-- of the next view will be blamed for this in exactly the same way.
--
-- THIS IS THE SECOND TIME. `20260827010000_revoke_client_write_grants_on_club_hand_daily`
-- is the same failure on a different view, one day earlier. That migration
-- revoked the grants on the one view it knew about and left the mechanism
-- untouched, so the estate paid for it again within 24 hours. Hand-patching
-- the next one is not a fix, it is a subscription.
--
-- WHY THE GRANTS WERE INERT, AND WHY THEY STILL MATTER. Both views aggregate
-- (`GROUP BY`), so `information_schema.views` reports is_insertable_into = NO
-- and is_updatable = NO; a write through either one is refused by Postgres
-- before privileges are ever consulted. Nothing was exposed. But the invariant
-- is not testing these two views, it is testing a CLASS of mistake: a simple
-- one-table view carrying the same inherited grants IS an RLS bypass, because
-- the write reaches the base table with the view's rules and not the table's.
-- The guard is correct to fail closed, and the correct answer is to stop
-- minting the grants rather than to widen the exemption list.
--
-- WHY NOT CHANGE THE DEFAULT ACL ITSELF. Because it is shared with tables, and
-- clients legitimately write to tables here — the protection on those is RLS,
-- not the absence of a grant. Revoking `arwd` by default would silently break
-- the next ordinary table instead. So this narrows to views only, at the exact
-- moment a view is created.
--
-- Migrated per .agent/workflows/migration-safety.md: assertions abort rather
-- than half-apply, and the post-apply block re-reads the live catalog.

begin;

-- ── 1. THE TWO VIEWS THAT ARE RED RIGHT NOW ────────────────────────────────
-- SELECT is deliberately left in place. Both views are security_invoker=true,
-- so a reader still sees only the rows the underlying RLS policies allow them.
revoke insert, update, delete, truncate
  on public.v_insurance_activity, public.v_insurance_pnl
  from anon, authenticated;

-- ── 2. THE MECHANISM, SO THE NEXT ONE NEVER LANDS ──────────────────────────
create or replace function public.fn_strip_client_writes_from_new_views()
returns event_trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $fn$
declare
  cmd record;
begin
  for cmd in select * from pg_event_trigger_ddl_commands() loop
    -- Only views and materialised views, only in public. Everything else in
    -- the estate — tables above all — keeps the grants it was given.
    if cmd.object_type in ('view', 'materialized view')
       and cmd.schema_name = 'public' then
      execute format(
        'revoke insert, update, delete, truncate on %s from anon, authenticated',
        cmd.object_identity
      );
    end if;
  end loop;
end;
$fn$;

comment on function public.fn_strip_client_writes_from_new_views() is
  'Event trigger body. The default ACL on schema public grants anon and authenticated INSERT/UPDATE/DELETE on every new relation, views included; this takes those back the moment a view is created, so CHECK 10 no_client_writable_views cannot be tripped by a view whose author never wrote a GRANT. Tables are untouched: their protection is RLS.';

drop event trigger if exists trg_strip_client_writes_from_new_views;
create event trigger trg_strip_client_writes_from_new_views
  on ddl_command_end
  when tag in ('CREATE VIEW', 'CREATE MATERIALIZED VIEW')
  execute function public.fn_strip_client_writes_from_new_views();

-- ── 3. POST-APPLY ASSERTIONS ───────────────────────────────────────────────
do $postcheck$
declare
  n_writable int;
  n_trigger  int;
begin
  -- (a) The invariant CHECK 10 runs must now be satisfied, read exactly the
  --     way scripts/check-economy-invariants.mjs reads it.
  select count(*) into n_writable
    from information_schema.role_table_grants g
    join pg_class c on c.relname = g.table_name
    join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
   where g.table_schema = 'public'
     and c.relkind = 'v'
     and g.grantee in ('anon', 'authenticated')
     and g.privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
     and g.table_name not in ('geography_columns', 'geometry_columns');
  if n_writable <> 0 then
    raise exception
      'no_client_writable_views still fails: % client-writable view grants remain',
      n_writable;
  end if;

  -- (b) The guard exists and is enabled.
  select count(*) into n_trigger
    from pg_event_trigger
   where evtname = 'trg_strip_client_writes_from_new_views'
     and evtenabled <> 'D';
  if n_trigger <> 1 then
    raise exception 'the event trigger is missing or disabled (found %)', n_trigger;
  end if;

  -- (c) Reading is untouched. A revoke that took SELECT as well would break
  --     both insurance dashboards silently, which is the failure mode this
  --     whole migration exists to argue against.
  if not has_table_privilege('authenticated', 'public.v_insurance_pnl', 'SELECT') then
    raise exception 'SELECT was revoked from v_insurance_pnl; that is collateral damage, not a fix';
  end if;
end;
$postcheck$;

commit;

-- ROLLBACK (Tier 3: this creates an event trigger)
--   drop event trigger if exists trg_strip_client_writes_from_new_views;
--   drop function if exists public.fn_strip_client_writes_from_new_views();
--   grant insert, update, delete on public.v_insurance_activity, public.v_insurance_pnl
--     to anon, authenticated;   -- restores the inherited state; CHECK 10 goes red again
