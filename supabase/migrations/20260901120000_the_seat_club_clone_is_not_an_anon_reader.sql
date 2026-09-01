-- ===========================================================================
-- THE CLONE NOBODY REVOKED (2026-09-01)
--
-- `fn_seat_club_for_user_membership_unchecked(p_user_id, p_table_id,
-- p_preferred_club)` decides which club a player is seated under. Found by the
-- estate's daily live definer audit, hours after it shipped:
--
--   [definer-exposure] A NEW FUNCTION ANSWERS A CALLER WITH NO ACCOUNT.
--     fn_seat_club_for_user_membership_unchecked(uuid, uuid, uuid)
--       executable by anon, and never asks who is asking
--
-- Read from pg_proc, never by calling it:
--
--   prosecdef ......... true, owner postgres, so it runs past RLS
--   proacl ............ =X/postgres | postgres=X | anon=X | authenticated=X
--                       | service_role=X   (the leading =X is PUBLIC)
--   auth.uid() ........ ABSENT from all 2,779 characters of the body
--   auth.role() ....... ABSENT
--
-- WHAT AN UNAUTHENTICATED CALLER COULD LEARN. The body reads `table_seats`,
-- `club_members`, `union_clubs` and `profiles` as the owner. Handed any user id
-- and any table id it answers, for a stranger with no account: which club that
-- player is currently seated under in this union, which clubs they are an
-- active member of, and the order they joined them. That is membership and live
-- seating for an arbitrary player, and RLS is not standing behind any of it.
--
-- HOW IT GOT THERE, because the shape matters more than this one function.
-- 20260901090000_club_card_human_realtime_stats.sql clones three existing
-- functions into new names by rewriting `pg_get_functiondef` output and
-- EXECUTEing it:
--
--   fn_join_club_membership_impl .............. revoked from PUBLIC, anon,
--   fn_create_club_atomic_membership_impl ..... authenticated. Correct.
--   fn_seat_club_for_user_membership_unchecked  no REVOKE at all.
--
-- CREATE FUNCTION grants EXECUTE to PUBLIC by default, so silence is not
-- neutral, it is open. Two of three clones were closed and the third was
-- forgotten, and the wrapper it was cloned from - fn_seat_club_for_user - was
-- itself revoked from PUBLIC and anon four lines earlier. The author knew the
-- rule. The clone simply is not spelled `CREATE FUNCTION`, so
-- scripts/ci/check-definer-authorization.mjs never saw a declaration to judge.
-- That gate learns to read a clone in the same commit as this migration.
--
-- WHY REVOKING IS SAFE, CHECKED RATHER THAN ASSUMED:
--
--   * The only caller anywhere is public.fn_seat_club_for_user, established
--     from pg_proc.prosrc across the whole schema. It is itself SECURITY
--     DEFINER owned by postgres, so it calls this one AS postgres and is
--     unaffected by what anon and authenticated hold.
--   * No RLS policy, constraint or index expression references it - pg_policy,
--     pg_constraint and pg_index all return nothing. A revoked policy helper
--     would deny every SELECT on the tables whose policies call it; this is
--     not one.
--   * No file in the repository calls it by name. Every browser seating path
--     goes through the wrapper, which keeps its `authenticated` grant.
--
-- ROLLBACK, if it is ever needed:
--   GRANT EXECUTE ON FUNCTION
--     public.fn_seat_club_for_user_membership_unchecked(uuid, uuid, uuid)
--     TO authenticated;
-- ===========================================================================

begin;

-- PRE-FLIGHT
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

  -- The wrapper is the seating path a browser is allowed to use. If it had
  -- lost its own grant, revoking the clone would leave nothing able to seat.
  if not has_function_privilege(
    'authenticated', 'public.fn_seat_club_for_user(uuid, uuid, uuid)', 'EXECUTE'
  ) then
    raise exception
      'PRE-FLIGHT: authenticated cannot execute the wrapper, so seating is already broken';
  end if;

  -- The wrapper must really be SECURITY DEFINER, otherwise it would call the
  -- clone as the browser role and this revoke would break seating.
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'fn_seat_club_for_user' and p.prosecdef
  ) then
    raise exception
      'PRE-FLIGHT: the wrapper is not SECURITY DEFINER, so it would call the clone as the caller';
  end if;
end $$;

-- THE CHANGE. PUBLIC is named as well as the roles: anon inherits whatever
-- PUBLIC holds, so revoking anon alone reads as a fix and does nothing. This is
-- the same treatment its two sibling clones were given in the migration that
-- created all three.
revoke all on function
  public.fn_seat_club_for_user_membership_unchecked(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function
  public.fn_seat_club_for_user_membership_unchecked(uuid, uuid, uuid)
  to service_role;

-- VERIFICATION
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

  -- The seating path a player actually uses must be untouched.
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
