-- ===========================================================================
-- THE SEAT-EXIT ALARM IS NOT A BROWSER API (2026-08-31)
--
-- Caught by scripts/ci/check-definer-authorization.mjs the moment the previous
-- migration re-declared the function. The exposure PRE-DATES that migration;
-- re-declaring it is simply what made a guard look.
--
-- fn_unaccounted_seat_exits() is SECURITY DEFINER, runs as the owner past RLS,
-- and never calls auth.uid(), auth.role() or auth.jwt(). It was executable by
-- `authenticated` and through PUBLIC. So any signed-in player could ask it for
-- every seat exit on the platform - user_id, club_id, table_id and the exact
-- stack that walked off each seat. Read-only is not the same as harmless: that
-- is a per-player chip-movement feed for the whole estate.
--
-- Nothing in either repo calls it from a browser. Its one real caller is
-- reconcile_ledger_nightly, which runs as postgres/service_role. This is
-- operator telemetry and it is closed to the browser roles here, which is the
-- first remedy the guard itself recommends for exactly this shape.
--
-- fn_club_chip_circulation() is the neighbouring function of the same kind and
-- is NOT touched here: it is a different decision on a different function and
-- gets its own migration rather than riding along on this one.
-- ===========================================================================

begin;

-- PRE-FLIGHT
do $$
begin
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'fn_unaccounted_seat_exits'
  ) then
    raise exception 'PRE-FLIGHT: fn_unaccounted_seat_exits does not exist';
  end if;

  if not has_function_privilege('service_role', 'public.fn_unaccounted_seat_exits(interval, interval)', 'EXECUTE') then
    raise exception 'PRE-FLIGHT: service_role cannot already execute it; this migration would be removing the wrong grants';
  end if;
end $$;

-- THE CHANGE
revoke all on function public.fn_unaccounted_seat_exits(interval, interval) from public;
revoke all on function public.fn_unaccounted_seat_exits(interval, interval) from anon;
revoke all on function public.fn_unaccounted_seat_exits(interval, interval) from authenticated;

-- POST-APPLY: BOTH HALVES
do $$
begin
  -- HALF ONE: the browser is out.
  if has_function_privilege('anon', 'public.fn_unaccounted_seat_exits(interval, interval)', 'EXECUTE') then
    raise exception 'POST-APPLY: anon can still execute the seat-exit alarm';
  end if;
  if has_function_privilege('authenticated', 'public.fn_unaccounted_seat_exits(interval, interval)', 'EXECUTE') then
    raise exception 'POST-APPLY: authenticated can still execute the seat-exit alarm';
  end if;

  -- HALF TWO: the alarm still works for the only caller that needs it. A
  -- hardening migration that silently switches off reconciliation is worse
  -- than the exposure it closed.
  if not has_function_privilege('service_role', 'public.fn_unaccounted_seat_exits(interval, interval)', 'EXECUTE') then
    raise exception 'POST-APPLY: service_role lost EXECUTE; reconcile_ledger_nightly could no longer call it';
  end if;

  perform 1 from public.fn_unaccounted_seat_exits('24 hours'::interval) limit 1;
  raise notice 'POST-APPLY: the alarm still runs as owner and is closed to the browser roles';
end $$;

commit;

-- ===========================================================================
-- ROLLBACK - restores the exposure, so do this only deliberately:
--
--   GRANT EXECUTE ON FUNCTION public.fn_unaccounted_seat_exits(interval, interval)
--     TO authenticated;
-- ===========================================================================
