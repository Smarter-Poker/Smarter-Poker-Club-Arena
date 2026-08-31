-- ===========================================================================
-- A NEW VIEW RESPECTS THE CALLER WITHOUT BEING ASKED (2026-08-31)
--
-- Phase 3 cleared every `security_definer_view` ERROR and swept 40-odd views to
-- `security_invoker = true` in 20260831e. Eight hours later the advisor reports
-- TWO of them again:
--
--   public.v_spin_draw_distribution_7d   SECURITY DEFINER, anon SELECT, auth SELECT
--   public.v_ca_suspense_balance         SECURITY DEFINER, anon SELECT, auth SELECT
--
-- Both are owned by postgres, so they read past RLS with the owner's rights on
-- behalf of a caller with no account. One is the spin game's own draw
-- distribution; the other is the net settlement-suspense balance.
--
-- Neither is referenced by application code in either repo - only by the schema
-- manifests and a changelog - so flipping them to invoker cannot break a
-- product surface. Checked before touching them.
--
-- 4 of the 52 views we own are missing the option; 2 of those are readable by a
-- browser role.
--
-- ---------------------------------------------------------------------------
-- THE SWEEP WAS NEVER THE FIX
--
-- 20260831e said it plainly - "naming views one at a time loses that race by
-- construction: this estate gains views faster than a migration can list them"
-- - and then fixed the moment rather than the mechanism. A sweep is a snapshot;
-- the next CREATE VIEW reopens the hole, and that is exactly what happened.
--
-- So this installs the guard the estate already uses for three neighbouring
-- problems: trg_rls_on_new_public_table, trg_autorevoke_privileged_anon and
-- trg_strip_client_writes_from_new_views are all ddl_command_end event triggers
-- that make the safe thing automatic. This is their sibling.
--
-- TERMINATION. The ALTER fires ddl_command_end again. On that second pass the
-- view HAS security_invoker, so the condition is false and it stops - the guard
-- depends on a state it can itself produce, which is precisely the property an
-- earlier fix in this estate got wrong and looped forever on. One extra pass,
-- then quiet.
--
-- MATERIALIZED VIEWS ARE EXCLUDED: they do not support security_invoker.
-- VIEWS WE DO NOT OWN ARE EXCLUDED: PostGIS and Supabase internals are not ours
-- to re-permission, which is the trap that aborted the first phase-3 run.
-- ===========================================================================

begin;

-- PRE-FLIGHT
do $$
begin
  if (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'v' and c.relowner = 'postgres'::regrole) < 10 then
    raise exception 'PRE-FLIGHT: fewer than 10 owned public views found - refusing to sweep a schema this does not recognise';
  end if;
end $$;

-- THE GUARD
create or replace function public.fn_new_view_respects_the_caller()
returns event_trigger
language plpgsql
security definer
set search_path to 'public', 'pg_catalog'
as $function$
declare
  cmd record;
begin
  for cmd in select * from pg_event_trigger_ddl_commands() loop
    -- Plain views only, in public, that we own, that do not already say so.
    -- The last clause is what makes this terminate: the ALTER below re-enters
    -- this function once, finds the option set, and stops.
    if cmd.object_type = 'view' and cmd.schema_name = 'public' then
      if exists (
        select 1 from pg_class c
         where c.oid = cmd.objid
           and c.relowner = 'postgres'::regrole
           and coalesce(array_to_string(c.reloptions, ','), '') not like '%security_invoker=%'
      ) then
        execute format('alter view %s set (security_invoker = true)', cmd.object_identity);
      end if;
    end if;
  end loop;
end;
$function$;

drop event trigger if exists trg_new_view_respects_the_caller;
create event trigger trg_new_view_respects_the_caller
  on ddl_command_end
  when tag in ('CREATE VIEW', 'ALTER VIEW')
  execute function public.fn_new_view_respects_the_caller();

-- AND THE FOUR THAT ARE ALREADY HERE
do $$
declare r record; n int := 0;
begin
  for r in
    select c.relname from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = 'public' and c.relkind = 'v' and c.relowner = 'postgres'::regrole
       and coalesce(array_to_string(c.reloptions, ','), '') not like '%security_invoker=%'
  loop
    execute format('alter view public.%I set (security_invoker = true)', r.relname);
    n := n + 1;
  end loop;
  raise notice 'swept % existing view(s)', n;
end $$;

-- POST-APPLY: BOTH HALVES
do $$
declare
  v_missing int;
  v_probe   text;
begin
  -- HALF ONE: nothing we own is left without it.
  select count(*) into v_missing
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'v' and c.relowner = 'postgres'::regrole
     and coalesce(array_to_string(c.reloptions, ','), '') not like '%security_invoker=%';
  if v_missing <> 0 then
    raise exception 'POST-APPLY: % owned view(s) still lack security_invoker', v_missing;
  end if;

  -- ...and the two the advisor named are specifically fixed.
  if exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relname in ('v_ca_suspense_balance', 'v_spin_draw_distribution_7d')
       and coalesce(array_to_string(c.reloptions, ','), '') not like '%security_invoker=%'
  ) then
    raise exception 'POST-APPLY: one of the two advisor-named views is still SECURITY DEFINER';
  end if;

  -- HALF TWO: the guard actually WORKS. Prove it on a throwaway view created
  -- and dropped inside this same transaction, so nothing is left behind - the
  -- 2026-08-25 probe incident left three zz_ functions in public and needed a
  -- second migration to remove them.
  execute 'create view public.zz_event_trigger_proof as select 1 as one';
  select coalesce(array_to_string(c.reloptions, ','), '') into v_probe
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'zz_event_trigger_proof';
  execute 'drop view public.zz_event_trigger_proof';

  if v_probe not like '%security_invoker=true%' then
    raise exception 'POST-APPLY: a newly created view was NOT stamped - the event trigger does not fire (reloptions were %)', v_probe;
  end if;

  if exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
              where n.nspname = 'public' and c.relname = 'zz_event_trigger_proof') then
    raise exception 'POST-APPLY: the probe view was left behind';
  end if;

  if not exists (select 1 from pg_event_trigger where evtname = 'trg_new_view_respects_the_caller' and evtenabled <> 'D') then
    raise exception 'POST-APPLY: the event trigger is missing or disabled';
  end if;

  raise notice 'POST-APPLY: 0 owned views without security_invoker; a new view is stamped automatically';
end $$;

commit;

-- ===========================================================================
-- ROLLBACK - reopens the class:
--
--   DROP EVENT TRIGGER IF EXISTS trg_new_view_respects_the_caller;
--   DROP FUNCTION IF EXISTS public.fn_new_view_respects_the_caller();
--
-- The individual views keep security_invoker unless separately reset.
-- ===========================================================================
