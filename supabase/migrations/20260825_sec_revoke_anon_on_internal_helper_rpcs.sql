-- 2026-08-25  SECURITY part 2: internal helper and operations RPCs that
-- unauthenticated `anon` could call over /rest/v1/rpc.
--
-- These are SECURITY DEFINER (RLS-bypassing) and take caller-supplied ids, so
-- anon could use them to enumerate org structure and player identity:
--   fn_club_role / role lookups, fn_player_display_name (uuid -> real display
--   name), fn_player_home_club, fn_club_scope_ids, fn_club_union_context,
--   fn_batch_club_member_counts, fn_live_table_count.
-- And three are pure internal operations surfaces:
--   fn_detect_double_dealing (anti-cheat internals), fn_snapshot_health,
--   fn_leaderboard_snapshot_gaps.
--
-- SAFETY GATES CHECKED BEFORE REVOKING, because getting this wrong breaks
-- reads for logged-out visitors rather than just tightening them:
--
--  1. RLS POLICIES. A policy is evaluated as the INVOKING role, so revoking a
--     function a policy calls would make that policy ERROR for anon. Every
--     function below was checked against pg_policy polqual and polwithcheck:
--     ALL ZERO references. The seven helpers that ARE used in policies -
--     fn_is_any_union_overseer (16 policies), fn_union_oversees_club (16),
--     fn_home_is_group_staff (15), fn_is_union_overseer (3),
--     fn_can_create_games (1), fn_has_club_role (1), fn_is_agent_of_player (1)
--     - are deliberately NOT in this list and keep anon EXECUTE.
--
--  2. VIEWS. Checked against pg_get_viewdef for every view and matview in
--     public: all zero, except fn_spin_reserve_owner (2 views), which is
--     therefore also deliberately excluded.
--
--  3. VOLATILITY. All are STABLE, so none of them write. This is an
--     information-disclosure fix, not a write-protection fix.
--
-- Calls from inside other SECURITY DEFINER functions are unaffected: those run
-- as the function owner, not as anon.
--
-- VERIFIED after applying, as anon: clubs / tables / tournaments / unions /
-- union_clubs all still readable with no policy errors, so RLS for logged-out
-- visitors is intact.

do $$
declare
  r record;
  v_sig text;
  v_names text[] := array[
    'fn_audit_actor_role',
    'fn_batch_club_member_counts',
    'fn_can_manage_tournament_schedule',
    'fn_club_role',
    'fn_club_scope_ids',
    'fn_club_union_context',
    'fn_detect_double_dealing',
    'fn_home_is_approved_member',
    'fn_leaderboard_snapshot_gaps',
    'fn_live_table_count',
    'fn_player_display_name',
    'fn_player_home_club',
    'fn_resolve_player_club_for_agent',
    'fn_seat_club_for_user',
    'fn_snapshot_health',
    'fn_spin_owner_kind',
    'fn_spin_owner_state',
    'fn_tournament_club_for_user'
  ];
begin
  for r in
    select n.nspname, p.proname, p.prokind,
           pg_get_function_identity_arguments(p.oid) as args
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname = any(v_names)
       and p.prorettype <> 'trigger'::regtype
  loop
    v_sig := format('%I.%I(%s)', r.nspname, r.proname, r.args);
    if r.prokind = 'p' then
      execute format('revoke execute on procedure %s from public, anon', v_sig);
      execute format('grant  execute on procedure %s to authenticated, service_role', v_sig);
    else
      execute format('revoke execute on function %s from public, anon', v_sig);
      execute format('grant  execute on function %s to authenticated, service_role', v_sig);
    end if;
    raise notice 'locked down %', v_sig;
  end loop;
end $$;
