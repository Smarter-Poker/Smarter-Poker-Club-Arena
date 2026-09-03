-- 2026-08-25  SECURITY: unauthenticated `anon` could read every club member's
-- wallet balances, downline and hand history over the public REST API.
--
-- These are SECURITY DEFINER functions - they bypass RLS by design - that were
-- ALSO executable by `anon`, and none of them check auth.uid(). The anon key is
-- published in the client bundle, so `POST /rest/v1/rpc/<name>` from anywhere
-- on the internet reached them.
--
-- PROVEN IN PRODUCTION before this migration, running as the anon role:
--
--     set role anon;
--     select count(*), max(chip_balance)
--       from public.ca_club_members_overview('<any club id>');
--     -> 584 rows, max chip_balance 442967.95
--
-- ca_club_member_detail is worse: it takes an arbitrary p_user_id and returns
-- that member's chip_balance, player_wallet, agent_wallet, promo_wallet,
-- upline, downline and last_login. A club id and a user id are the only inputs
-- and both appear in ordinary application traffic.
--
-- THE PART THAT MADE THE FIRST ATTEMPT A NO-OP. Postgres grants EXECUTE on
-- every new function to PUBLIC by default, so `anon` mostly held EXECUTE
-- *through PUBLIC* rather than through a grant of its own.
-- `REVOKE ... FROM anon` therefore changed nothing and
-- has_function_privilege('anon', ...) stayed true for 7 of the 12 functions.
-- The correct removal is REVOKE FROM PUBLIC, then grant back explicitly.
--
-- `authenticated` and `service_role` keep EXECUTE, so every real caller is
-- unaffected: Club Arena is behind login and these surfaces (club roster,
-- member management, player statistics) are only reachable once signed in.
-- Unauthenticated callers now get 42501.
--
-- VERIFIED after applying, as anon: 42501 permission denied.
--
-- Deliberately NOT touched, because they may be intentionally public and need
-- a product decision rather than a unilateral revoke:
--   get_public_profile_by_username, find_live_games_nearby,
--   find_similar_questions, fn_global_leaderboard_*, fn_club_leaderboard_*,
--   fn_user_rank_*.

do $$
declare
  r record;
  v_sig text;
  v_names text[] := array[
    -- club member data: wallets, stats, downline
    'ca_club_member_detail',
    'ca_club_member_downline',
    'ca_club_member_statistics',
    'ca_club_members_overview',
    -- per-player hand history and analytics, keyed by arbitrary user id
    'ca_player_class_hands',
    'ca_player_ev_curve',
    'ca_player_hand_grid',
    'ca_player_nemesis',
    -- club financials
    'fn_club_member_daily_profit_exact',
    'fn_club_profit_drift',
    -- expensive maintenance entry points; also a denial-of-service surface,
    -- ca_touch_member_fee_rollup runs a multi-second batch per call
    'ca_touch_member_fee_rollup',
    'sp_backfill_member_fee_rollup'
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
