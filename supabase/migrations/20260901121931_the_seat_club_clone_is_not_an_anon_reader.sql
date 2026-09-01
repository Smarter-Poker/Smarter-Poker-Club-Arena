-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260901121931; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- ===========================================================================
-- THE CLONE NOBODY REVOKED (2026-09-01)
--
-- fn_seat_club_for_user_membership_unchecked(p_user_id, p_table_id,
-- p_preferred_club) decides which club a player is seated under. Found by the
-- estate's daily live definer audit, hours after it shipped: SECURITY DEFINER,
-- owner postgres, EXECUTE held by PUBLIC/anon/authenticated, and neither
-- auth.uid() nor auth.role() anywhere in its 2,779 character body.
--
-- Handed any user id and any table id it answers, for a stranger with no
-- account: which club that player is currently seated under in this union,
-- which clubs they are an active member of, and the order they joined them.
--
-- HOW IT GOT THERE. 20260901090000_club_card_human_realtime_stats.sql clones
-- three functions into new names via pg_get_functiondef + EXECUTE. Two clones
-- were revoked from PUBLIC, anon, authenticated. This one was not, and
-- CREATE FUNCTION grants EXECUTE to PUBLIC by default, so silence is open.
--
-- WHY REVOKING IS SAFE, CHECKED RATHER THAN ASSUMED: the only caller anywhere
-- is public.fn_seat_club_for_user, itself SECURITY DEFINER owned by postgres,
-- so it calls this one AS postgres; no policy, constraint or index expression
-- references it; no file in the repository calls it by name.
--
-- ROLLBACK: GRANT EXECUTE ON FUNCTION
--   public.fn_seat_club_for_user_membership_unchecked(uuid, uuid, uuid)
--   TO authenticated;
-- ===========================================================================

begin;

do $$
begin
  if to_regprocedure(
       'public.fn_seat_club_for_user_membership_unchecked(uuid, uuid, uuid)'
     ) is null then
    raise exception
      'PRE-FLIGHT: fn_seat_club_for_user_membership_unchecked(uuid, uuid, uuid) does not exist';
  end if;

  if to_regprocedure('public.fn_seat_club_for_user(uuid, uuid, uuid)') is null then
    raise exception
      'PRE-FLIGHT: the wrapper fn_seat_club_for_user is gone, so this clone may no longer be internal';
  end if;

  if not has_function_privilege(
    'authenticated', 'public.fn_seat_club_for_user(uuid, uuid, uuid)', 'EXECUTE'
  ) then
    raise exception
      'PRE-FLIGHT: authenticated cannot execute the wrapper, so seating is already broken';
  end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'fn_seat_club_for_user' and p.prosecdef
  ) then
    raise exception
      'PRE-FLIGHT: the wrapper is not SECURITY DEFINER, so it would call the clone as the caller';
  end if;
end $$;

revoke all on function
  public.fn_seat_club_for_user_membership_unchecked(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function
  public.fn_seat_club_for_user_membership_unchecked(uuid, uuid, uuid)
  to service_role;

do $$
begin
  if has_function_privilege(
    'anon',
    'public.fn_seat_club_for_user_membership_unchecked(uuid, uuid, uuid)',
    'EXECUTE'
  ) then
    raise exception 'VERIFY: a caller with no account can still read any player''s club';
  end if;

  if has_function_privilege(
    'authenticated',
    'public.fn_seat_club_for_user_membership_unchecked(uuid, uuid, uuid)',
    'EXECUTE'
  ) then
    raise exception 'VERIFY: a logged-in player can still read any other player''s club';
  end if;

  if not has_function_privilege(
    'service_role',
    'public.fn_seat_club_for_user_membership_unchecked(uuid, uuid, uuid)',
    'EXECUTE'
  ) then
    raise exception 'VERIFY: the engine lost the grant';
  end if;

  if not has_function_privilege(
    'authenticated', 'public.fn_seat_club_for_user(uuid, uuid, uuid)', 'EXECUTE'
  ) then
    raise exception 'VERIFY: the revoke reached the wrapper and seating is now broken';
  end if;
  if not has_function_privilege(
    'service_role', 'public.fn_seat_club_for_user(uuid, uuid, uuid)', 'EXECUTE'
  ) then
    raise exception 'VERIFY: the engine lost the wrapper grant';
  end if;
end $$;

commit;
