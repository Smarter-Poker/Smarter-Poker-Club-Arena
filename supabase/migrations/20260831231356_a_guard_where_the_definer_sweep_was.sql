-- ===========================================================================
-- A GUARD WHERE THE DEFINER SWEEP WAS (2026-08-31)
--
-- The two migrations before this one closed thirty-eight browser-reachable
-- SECURITY DEFINER routines. That is a sweep, and this estate has now been
-- bitten four times by the same shape:
--
--   * definer views reopened within eight hours of being swept
--   * v_system_health_cron watching three job-name prefixes out of seventy-five
--   * check-ui-text exempting four whole files, held safe by a hand audit
--   * and now thirty-eight definers nobody had looked at since they were written
--
-- A closure that nothing re-checks is a closure with a date on it.
--
-- ---------------------------------------------------------------------------
-- WHAT COUNTS AS AN OPERATOR CONSOLE
--
-- Not every definer a browser can call is wrong. Most of this schema's RPCs are
-- definer ON PURPOSE and are scoped by an argument: give ca_club_revenue a club
-- id and it answers for that club. Those are the application.
--
-- The dangerous shape has NO SCOPE AT ALL: it answers about the whole platform,
-- it never consults the caller, and a browser can reach it.
-- fn_chip_integrity_report() took no arguments and returned the total chip
-- supply. fn_ungated_money_rpcs() took no arguments and listed which money RPCs
-- have no gate.
--
-- TRIGGER FUNCTIONS ARE EXCLUDED BY SHAPE, not by name. A function returning
-- `trigger` cannot be invoked through PostgREST at all - Postgres refuses with
-- "trigger functions can only be called as triggers" - so its EXECUTE grant is
-- untidy, not exposure. Seven of them were in the first sweep's results and
-- listing them by name would have been a list that rots; the return type does
-- not rot.
--
-- ---------------------------------------------------------------------------
-- AND WHY THERE IS AN ALLOWLIST, GIVEN THE ABOVE
--
-- Nineteen routines legitimately have this shape: public leaderboards, the club
-- name availability check the signup form calls on every keystroke, the nearby
-- live games map, support search, and the member-fee rollup the roster page
-- nudges. They must stay open.
--
-- An allowlist is the very thing criticised above, so this one is built to
-- differ in the ways that matter: every row carries a REASON in the database
-- rather than in somebody's head, adding a row is a migration that shows up in
-- review, and the guard reports what is NOT on it rather than trusting that
-- somebody re-read the list. It is a record of decisions, not a list of files
-- somebody happened to check.
-- ===========================================================================

begin;

-- PRE-FLIGHT
do $$
declare v_still_open int;
begin
  select count(*) into v_still_open
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prosecdef
     and p.proname in ('fn_chip_integrity_report', 'fn_ungated_money_rpcs',
                       'sum_anti_farming_ips', 'sp_backfill_member_fee_rollup')
     and has_function_privilege('authenticated', p.oid, 'EXECUTE');
  if v_still_open > 0 then
    raise exception 'PRE-FLIGHT: the sweep migrations have not been applied - % still open', v_still_open;
  end if;
end $$;

-- THE CHANGE: the record of decisions...
create table if not exists public.ca_browser_definer_allowlist (
  proname     text primary key,
  reason      text not null check (length(btrim(reason)) >= 20),
  recorded_at timestamptz not null default now()
);

alter table public.ca_browser_definer_allowlist enable row level security;
revoke all on table public.ca_browser_definer_allowlist from public, anon, authenticated;
grant select on table public.ca_browser_definer_allowlist to service_role;

comment on table public.ca_browser_definer_allowlist is
  'Unscoped SECURITY DEFINER routines a browser is deliberately allowed to execute. A row here is a decision with a reason; fn_ca_browser_reachable_telemetry reports everything that is NOT here.';

insert into public.ca_browser_definer_allowlist(proname, reason) values
  ('fn_club_name_available',        'The signup form asks on every keystroke whether a club name is taken. Returns one boolean about a name the caller already typed.'),
  ('fn_global_leaderboard_period',  'The public global leaderboard. Its contents are shown to everyone by design.'),
  ('fn_global_leaderboard_by_dates','The public global leaderboard over a date range. Same surface as the period variant.'),
  ('fn_spin_leaderboards',          'The spin leaderboard panel. Public standings, no per-caller data.'),
  ('fn_league_pooled',              'Pooled league standings for a day. Public results, already visible in the league UI.'),
  ('fn_user_rank_global_period',    'A player rank inside the public global leaderboard. Ranks are public by design.'),
  ('find_live_games_nearby',        'The live games map. Takes a latitude and longitude the caller supplies and returns public listings; anon by design so signed-out visitors see games.'),
  ('find_similar_questions',        'Support search. Matches a question the caller typed against the public help corpus.'),
  ('get_public_profile_by_username','A public profile by username. This is the profile page every visitor can already load.'),
  ('check_duplicate_clips',         'Clip upload dedupe. Takes URLs the caller is about to submit and says which already exist.'),
  ('analyze_spots_by_game_type',    'Training spot analysis by game type. Study material, identical for every student.'),
  ('ca_horse_league_card',          'Horse league standings card. Horses are players, and these standings are shown in the UI.'),
  ('ca_horse_review_summary',       'Horse hand-review summary shown on the horse pages.'),
  ('ca_horse_tag_trends',           'Horse review tag trends shown on the horse pages.'),
  ('ca_brain_telemetry',            'Horse brain telemetry shown on the horse pages. Kept because the horse surfaces read it; revisit if those pages move server-side.'),
  ('ca_horse_daily_audit',          'Horse daily audit shown on the horse pages, alongside the two above.'),
  ('fn_are_friends',                'Takes two user ids and answers whether they are friends. Scoped by its arguments; the naming just does not say so.'),
  ('get_max_player_number',         'The highest player number issued, used when allocating the next one at signup.'),
  ('ca_touch_member_fee_rollup',    'The club roster page nudges the member fee rollup on load. Rate limited to once per thirty seconds inside the function itself.'),
  ('get_current_settlement_period', 'SettlementService reads the open settlement period. Creates one only when exactly one union exists, ON CONFLICT DO NOTHING.')
on conflict (proname) do update set reason = excluded.reason;

-- ...and the reader.
create or replace function public.fn_ca_browser_reachable_telemetry()
returns table(
  proname     text,
  args        text,
  reached_by  text,
  volatility  text
)
language sql
stable
security definer
set search_path to 'public', 'pg_catalog', 'pg_temp'
as $function$
  select p.proname::text,
         pg_get_function_identity_arguments(p.oid)::text,
         concat_ws(' + ',
           case when has_function_privilege('anon', p.oid, 'EXECUTE') then 'anon' end,
           case when has_function_privilege('authenticated', p.oid, 'EXECUTE') then 'authenticated' end
         )::text,
         case p.provolatile when 'v' then 'volatile' when 's' then 'stable' else 'immutable' end::text
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prosecdef
     -- reachable from a browser
     and (has_function_privilege('anon', p.oid, 'EXECUTE')
       or has_function_privilege('authenticated', p.oid, 'EXECUTE'))
     -- a trigger function cannot be invoked through PostgREST at all
     and p.prorettype <> 'pg_catalog.trigger'::regtype
     -- and asks nothing about who is calling
     and p.prosrc not ilike '%auth.uid()%'
     and p.prosrc not ilike '%auth.role()%'
     and p.prosrc not ilike '%auth.jwt()%'
     and p.prosrc not ilike '%current_setting%request%'
     -- and takes no identity argument, so it can only be answering about
     -- everything. This is the line between an operator console and an RPC.
     and coalesce(pg_get_function_identity_arguments(p.oid), '') !~*
         '(club|user|union|table|pool|tournament|group|member|owner|horse|author|sender|recipient|agent|payout|promotion|profile|seat|hand)'
     -- PostGIS ships its own definer helpers; they are not ours to re-grant.
     and p.proname !~ '^(st_|_st_|postgis_)'
     -- and it has not been decided, with a reason, that it belongs open.
     and not exists (select 1 from public.ca_browser_definer_allowlist a where a.proname = p.proname)
   order by p.proname;
$function$;

revoke all on function public.fn_ca_browser_reachable_telemetry() from public, anon, authenticated;
grant execute on function public.fn_ca_browser_reachable_telemetry() to service_role;

comment on function public.fn_ca_browser_reachable_telemetry() is
  'Unscoped SECURITY DEFINER routines a browser can execute that never consult the caller and are not on ca_browser_definer_allowlist. Zero rows is the healthy state. Read by scripts/ci/check-telemetry-exposure.mjs.';

-- POST-APPLY: BOTH HALVES
do $$
declare
  v_rows   bigint;
  v_names  text;
  v_shape  bigint;
begin
  -- HALF ONE: the estate is clean, and the guard says so.
  select count(*), string_agg(proname, ', ')
    into v_rows, v_names
    from public.fn_ca_browser_reachable_telemetry();
  if v_rows > 0 then
    raise exception 'POST-APPLY: % unaccounted browser-reachable operator routine(s): %', v_rows, v_names;
  end if;

  -- HALF TWO, first part: it is not vacuously empty. A guard that can never
  -- fire is not a guard. The thirty-five closed first are still definer and
  -- still unscoped; the ONLY reason they no longer appear is the revoke.
  select count(*) into v_shape
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prosecdef
     and p.proname in ('fn_chip_integrity_report', 'fn_ungated_money_rpcs', 'fn_ledger_liveness')
     and p.prorettype <> 'pg_catalog.trigger'::regtype
     and coalesce(pg_get_function_identity_arguments(p.oid), '') !~* '(club|user|union|table|pool|tournament)';
  if v_shape <> 3 then
    raise exception 'POST-APPLY: expected 3 known unscoped definers to still match the shape, found %', v_shape;
  end if;

  -- HALF TWO, second part: the application is NOT swept up by it. If the guard
  -- flagged the scoped RPCs the browser lives on, somebody would turn it off.
  if exists (select 1 from public.fn_ca_browser_reachable_telemetry()
              where proname in ('ca_club_revenue', 'ca_club_members', 'fn_club_role', 'ca_club_dashboard_stats')) then
    raise exception 'POST-APPLY: the guard flags scoped application RPCs - it would be turned off within a week';
  end if;

  -- ...the allowlist is a record of decisions, not a bare list.
  if exists (select 1 from public.ca_browser_definer_allowlist where length(btrim(reason)) < 20) then
    raise exception 'POST-APPLY: an allowlist row has no real reason on it';
  end if;

  -- ...and no browser can read either the guard or the list of what is allowed.
  if has_function_privilege('anon', 'public.fn_ca_browser_reachable_telemetry()', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.fn_ca_browser_reachable_telemetry()', 'EXECUTE') then
    raise exception 'POST-APPLY: a browser can execute the guard that lists what browsers can execute';
  end if;
  if not has_function_privilege('service_role', 'public.fn_ca_browser_reachable_telemetry()', 'EXECUTE') then
    raise exception 'POST-APPLY: service_role cannot execute it, so CI could not call it';
  end if;

  raise notice 'POST-APPLY: guard live, 0 unaccounted, % allowed with a reason',
    (select count(*) from public.ca_browser_definer_allowlist);
end $$;

commit;

-- ===========================================================================
-- ROLLBACK - removes the reader, leaving the closure with a date on it:
--   DROP FUNCTION IF EXISTS public.fn_ca_browser_reachable_telemetry();
--   DROP TABLE    IF EXISTS public.ca_browser_definer_allowlist;
-- ===========================================================================
