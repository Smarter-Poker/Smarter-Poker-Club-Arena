-- ===========================================================================
-- A PLAYER CANNOT NAME THEMSELVES THE BOUNTY COLLECTOR (2026-08-31)
--
-- `fn_collect_bounty(p_tournament_id, p_eliminated_user_id, p_collector_user_id,
-- p_claimants)` pays a knockout bounty. Found by the daily live definer audit:
--
--   [definer-exposure] NEW LIVE EXPOSURE.
--     fn_collect_bounty(...)  executable by: authenticated
--     It writes, and it never consults auth.uid(), auth.role() or auth.jwt()
--
-- Read from pg_proc, never by calling it (CLAUDE.md 11.5 - a money path is not
-- probed against production):
--
--   prosecdef ......... true, owner postgres, so it runs past RLS
--   proacl ............ postgres=X | authenticated=X | service_role=X
--   auth.uid() ........ ABSENT from all 7,432 characters of the body
--   auth.role() ....... ABSENT
--
-- So the function cannot know who is calling, and it takes the person to be
-- PAID as a parameter. That is the same shape as the 2026-08-31 club-role
-- escalation: an actor read from a caller-supplied argument. This one pays
-- chips.
--
-- WHY REVOKING IS SAFE, CHECKED RATHER THAN ASSUMED. The only caller anywhere
-- is the engine, server/src/tournament/TournamentManagerEliminations.ts:1914,
-- and it goes through server/src/services/supabase/client.ts, which is built
-- with SUPABASE_SERVICE_ROLE_KEY. Every other mention in the repository is a
-- comment in a React component describing the data this function maintains.
-- No browser path calls it, so no browser needs the grant.
--
-- ROLLBACK, if it is ever needed:
--   GRANT EXECUTE ON FUNCTION
--     public.fn_collect_bounty(uuid, uuid, uuid, jsonb) TO authenticated;
-- ===========================================================================

begin;

-- PRE-FLIGHT
do $$
begin
  if to_regprocedure('public.fn_collect_bounty(uuid, uuid, uuid, jsonb)') is null then
    raise exception 'PRE-FLIGHT: fn_collect_bounty(uuid, uuid, uuid, jsonb) does not exist';
  end if;
  if not has_function_privilege(
    'service_role', 'public.fn_collect_bounty(uuid, uuid, uuid, jsonb)', 'EXECUTE'
  ) then
    raise exception 'PRE-FLIGHT: service_role cannot execute it, so the engine would break';
  end if;
end $$;

-- THE CHANGE. PUBLIC is named as well as the roles: a grant to PUBLIC lets
-- authenticated straight back in, and revoking one role alone reads as a fix
-- and does nothing.
revoke all on function public.fn_collect_bounty(uuid, uuid, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.fn_collect_bounty(uuid, uuid, uuid, jsonb)
  to service_role;

-- VERIFICATION
do $$
begin
  if has_function_privilege(
    'anon', 'public.fn_collect_bounty(uuid, uuid, uuid, jsonb)', 'EXECUTE'
  ) then
    raise exception 'VERIFY: anon can still pay a bounty';
  end if;
  if has_function_privilege(
    'authenticated', 'public.fn_collect_bounty(uuid, uuid, uuid, jsonb)', 'EXECUTE'
  ) then
    raise exception 'VERIFY: a logged-in player can still name themselves the collector';
  end if;
  if not has_function_privilege(
    'service_role', 'public.fn_collect_bounty(uuid, uuid, uuid, jsonb)', 'EXECUTE'
  ) then
    raise exception 'VERIFY: the engine lost the grant it needs to pay bounties';
  end if;
end $$;

commit;
