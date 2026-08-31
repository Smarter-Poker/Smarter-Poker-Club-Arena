-- ===========================================================================
-- AN EVENT TRIGGER FUNCTION IS NOT AN API EITHER (2026-08-31)
--
-- check-definer-authorization blocked the push for the migration that shipped
-- fn_new_view_respects_the_caller, and it was right. The function is SECURITY
-- DEFINER and carried the default EXECUTE grant to anon and authenticated,
-- while never asking who the caller is.
--
-- This is the same rule phase 3 established when it revoked 173 such grants
-- from trigger functions in 20260831d ("a trigger function is not an API"), and
-- the new function broke it within hours of the audit that found it. The rule
-- was not carried forward because nothing carries it forward - which is exactly
-- why the guard exists, and why it is worth more than the sweep it enforces.
--
-- PostgREST never exposes a function returning `event_trigger`, and an event
-- trigger is invoked by the server rather than by a role holding EXECUTE, so
-- the grant buys nothing and only widens the surface. Phase 3 proved the
-- equivalent for row triggers in a rolled-back probe: revoking EXECUTE does not
-- stop a trigger firing, because firing does not re-check the privilege.
-- ===========================================================================

begin;

-- PRE-FLIGHT
do $$
begin
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'fn_new_view_respects_the_caller'
  ) then
    raise exception 'PRE-FLIGHT: fn_new_view_respects_the_caller does not exist';
  end if;

  if not exists (select 1 from pg_event_trigger
                  where evtname = 'trg_new_view_respects_the_caller' and evtenabled <> 'D') then
    raise exception 'PRE-FLIGHT: the event trigger is missing or disabled - fix that before re-permissioning it';
  end if;
end $$;

-- THE CHANGE
revoke all on function public.fn_new_view_respects_the_caller() from public;
revoke all on function public.fn_new_view_respects_the_caller() from anon;
revoke all on function public.fn_new_view_respects_the_caller() from authenticated;

-- POST-APPLY: BOTH HALVES
do $$
declare v_probe text;
begin
  -- HALF ONE: the browser is out.
  if has_function_privilege('anon', 'public.fn_new_view_respects_the_caller()', 'EXECUTE') then
    raise exception 'POST-APPLY: anon can still execute the event trigger function';
  end if;
  if has_function_privilege('authenticated', 'public.fn_new_view_respects_the_caller()', 'EXECUTE') then
    raise exception 'POST-APPLY: authenticated can still execute the event trigger function';
  end if;

  -- HALF TWO: and it STILL FIRES. This is the half that matters - revoking a
  -- privilege from a function the server calls for you is only safe if the
  -- server does not consult that privilege. Proved here rather than remembered,
  -- on a throwaway view created and dropped inside this transaction.
  execute 'create view public.zz_revoke_still_fires as select 1 as one';
  select coalesce(array_to_string(c.reloptions, ','), '') into v_probe
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'zz_revoke_still_fires';
  execute 'drop view public.zz_revoke_still_fires';

  if v_probe not like '%security_invoker=true%' then
    raise exception 'POST-APPLY: the event trigger stopped firing after the revoke (reloptions were %)', v_probe;
  end if;

  if exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
              where n.nspname = 'public' and c.relname = 'zz_revoke_still_fires') then
    raise exception 'POST-APPLY: the probe view was left behind';
  end if;

  raise notice 'POST-APPLY: browser roles revoked, and a new view is still stamped automatically';
end $$;

commit;

-- ===========================================================================
-- ROLLBACK - restores a grant that buys nothing:
--
--   GRANT EXECUTE ON FUNCTION public.fn_new_view_respects_the_caller()
--     TO anon, authenticated;
-- ===========================================================================
