-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260825020931; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- 2026-08-25  SECURITY, part 2. The first pass only revoked `anon` and that
-- was not enough for seven of the twelve functions.
--
-- WHY: Postgres grants EXECUTE on every new function to PUBLIC by default.
-- `anon` therefore held EXECUTE *through PUBLIC*, not through a grant of its
-- own, so `REVOKE ... FROM anon` silently changed nothing -
-- has_function_privilege('anon', ...) stayed true. Verified after the first
-- migration: ca_player_nemesis, ca_player_ev_curve, ca_player_hand_grid,
-- ca_player_class_hands, fn_club_member_daily_profit_exact,
-- fn_club_profit_drift and sp_backfill_member_fee_rollup were all still
-- anon-executable.
--
-- The correct removal is REVOKE FROM PUBLIC, then grant back explicitly to the
-- roles that should have it. Doing it in that order leaves no window where a
-- legitimate caller loses access.
--
-- ca_player_* take an arbitrary p_user uuid and return that player's hand
-- history, EV curve, hand grid and head-to-head record. fn_club_profit_drift
-- and fn_club_member_daily_profit_exact return club financials.
-- sp_backfill_member_fee_rollup runs an unbounded backfill loop and is a
-- denial-of-service surface on its own.

do $$
declare
  r record;
  v_sig text;
  v_names text[] := array[
    'ca_player_class_hands',
    'ca_player_ev_curve',
    'ca_player_hand_grid',
    'ca_player_nemesis',
    'fn_club_member_daily_profit_exact',
    'fn_club_profit_drift',
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
