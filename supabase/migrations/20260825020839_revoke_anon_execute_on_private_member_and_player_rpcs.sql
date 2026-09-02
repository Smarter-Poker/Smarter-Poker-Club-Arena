-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260825020839; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- 2026-08-25  SECURITY: unauthenticated `anon` could read every club member's
-- wallet balances, downline, and hand history over the public REST API.
--
-- These are SECURITY DEFINER functions (they bypass RLS by design) that were
-- ALSO granted EXECUTE to `anon`, and none of them check auth.uid(). The anon
-- key is published in the client bundle, so `POST /rest/v1/rpc/<name>` from
-- anywhere on the internet reached them.
--
-- PROVEN in production before this migration, running as the anon role:
--
--   set role anon;
--   select count(*), max(chip_balance)
--     from public.ca_club_members_overview('<any club id>');
--   -> 584 rows, max chip_balance 442967.95
--
-- ca_club_member_detail is worse: it takes an arbitrary p_user_id and returns
-- that member's chip_balance, player_wallet, agent_wallet, promo_wallet,
-- upline, downline and last_login. A club id and a user id are the only
-- inputs, and both appear in ordinary application traffic.
--
-- FIX: remove `anon` only. `authenticated` and `service_role` keep EXECUTE, so
-- every real caller is unaffected - Club Arena is behind login and these
-- surfaces (club roster, member management, player statistics) are only
-- reachable once signed in. Unauthenticated callers now get 42501.
--
-- Deliberately NOT touched here, because they may be intentionally public and
-- need a product decision rather than a unilateral revoke:
--   get_public_profile_by_username, find_live_games_nearby,
--   find_similar_questions, fn_global_leaderboard_*, fn_club_leaderboard_*,
--   fn_user_rank_*.
-- They are listed in the session audit so the call is made deliberately.

do $$
declare
  v_fn text;
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
    -- expensive maintenance entry points (also a denial-of-service surface:
    -- fn_refresh_member_fee_rollup runs a multi-second batch per call)
    'ca_touch_member_fee_rollup',
    'sp_backfill_member_fee_rollup'
  ];
begin
  for v_fn in
    select format('%I.%I(%s)', n.nspname, p.proname,
                  pg_get_function_identity_arguments(p.oid))
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname = any(v_names)
  loop
    -- procedures and functions need different REVOKE spellings; try both.
    begin
      execute format('revoke execute on function %s from anon', v_fn);
    exception when wrong_object_type or undefined_function then
      execute format('revoke execute on procedure %s from anon', v_fn);
    end;
    raise notice 'revoked anon EXECUTE on %', v_fn;
  end loop;
end $$;
