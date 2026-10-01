-- 20260930181616_close_the_horse_tag_ev_console_to_the_browser.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY
--
-- Telemetry Exposure had been red for 14 consecutive runs (~6.8 days) and
-- Production Integrity Audit for ~19 days reporting anon_definers=1. Both were
-- telling the truth. Read on 2026-09-30, fn_ca_browser_reachable_telemetry()
-- returned five routines; the anon-definer manifest diff returned exactly one
-- unaccounted signature. Each was read in full before anything was changed.
--
-- 1. THE ONE THAT IS ACTUALLY OPEN
--
-- fn_horse_tag_ev_significance(date) is horse-brain analytics: it reads
-- horse_review_rollup and returns, per situation tag, the hand count, big
-- blinds per hand, the spread and a z score. That is the platform's own read
-- of where its horses are losing and winning EV by situation, and its ACL was
-- "=X/postgres" (PUBLIC) plus explicit anon and authenticated - so a logged-out
-- visitor could ask for it. Horses are players (10.5), and this is per-
-- situation win-rate analytics about them published to anyone who asks.
--
-- It has no caller. Searched on origin/main in BOTH repositories
-- (Smarter-Poker-Club-Arena 7119d5722, Smarter-Poker-World-Hub 1ccf3907c):
-- zero references in src/, server/, pages/, scripts/ or lib/. The only
-- reference anywhere is a frozen historical-schema fixture under
-- scripts/ci/probes/. The only database caller is fn_run_horse_daily_audit,
-- which is SECURITY DEFINER, so its inner call runs as the owner and needs no
-- browser grant. Its sibling that the horse pages DO read is ca_horse_tag_trends,
-- which is allowlisted and untouched.
--
-- Revoking PUBLIC alone would have looked like a fix and would not have been
-- one: Supabase grants anon and authenticated directly, so all three go.
--
-- 2. THE FOUR THAT ARE NOT OPEN, AND WHY EACH STAYS
--
-- fn_capability_available(text) MUST keep EXECUTE for authenticated. The
-- SECURITY INVOKER trigger zz_tables_kill_pot_guard on public.tables calls it,
-- and a SECURITY INVOKER trigger runs as the role doing the write. authenticated
-- holds INSERT and UPDATE on public.tables, so revoking would fail every
-- logged-in Kill Pot table create with "permission denied for function" rather
-- than close a console. This is the same shape already recorded for
-- fn_ca_new_tournament_is_unlimited, and the same class of trap as the RLS
-- policy helpers of 2026-09-06 - one level over, in a trigger.
--
-- fn_diamond_arena_leaderboard_period is the Diamond Arena leaderboard, read
-- by src/services/LeaderboardService.ts. A leaderboard shows every player by
-- definition; it excludes fixture accounts and explicitly does NOT exclude
-- horses (fn_ca_is_fixture_account tests is_horse first). Its sibling
-- fn_global_leaderboard_period is already allowlisted for the same reason.
--
-- fn_platform_capabilities() is the capability registry every client reads
-- before it offers a product surface, including before login, which is why it
-- is anon. It is already accounted for by two other guards
-- (docs/security/anon-executable-definers.json and
-- scripts/ci/definer-authorization.allowlist.json); only this table had no row.
--
-- fn_ca_diamond_staff_books(text) is handled in section 3: it is not open at
-- all, and the check could not see that.
--
-- 3. THE CRITERION COULD NOT SEE A GATE BEHIND A HELPER
--
-- fn_ca_browser_reachable_telemetry() tests "asks nothing about who is calling"
-- with prosrc NOT ILIKE '%auth.uid()%' and three siblings - against the
-- function's OWN text only. fn_ca_diamond_staff_books refuses a stranger on its
-- first statement, but through a helper: fn_is_platform_admin(), which is what
-- calls auth.uid(), followed by fn_caller_session_is_live(). The gate is real
-- and the check is blind to it.
--
-- This has already cost ten hand-written allowlist rows. Measured before this
-- change: eleven browser-reachable definers gate themselves through
-- fn_is_horse_admin() or fn_is_platform_admin() without naming auth.uid()
-- themselves, and ten of them already carry an allowlist row added by hand -
-- two of which say in their own reason that the owning migration should have
-- carried it. fn_ca_diamond_staff_books is the eleventh. Adding a row is the
-- workaround; teaching the criterion to follow one level is the fix (10.11).
--
-- So the criterion now also clears a routine whose body calls a public function
-- that itself consults auth.uid(), auth.role(), auth.jwt() or the request
-- claims. Nothing else about the criterion moves. Verified read-only before
-- writing this: with the clause, the five become one, and the one is
-- fn_horse_tag_ev_significance - which section 1 then closes, so the healthy
-- answer is zero rows.
--
-- No RLS policy calls any of the five (checked: pg_policy polqual and
-- polwithcheck against all five names returned nothing).
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).
-- GRANT and REVOKE do not reload; the one CREATE OR REPLACE below does, once.

BEGIN;

-- 1. THE HORSE TAG EV CONSOLE STOPS ANSWERING A BROWSER -----------------------

REVOKE ALL ON FUNCTION public.fn_horse_tag_ev_significance(date)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_horse_tag_ev_significance(date)
  TO service_role;

-- 2. THE THREE THAT BELONG OPEN, EACH WITH ITS REASON -------------------------

INSERT INTO public.ca_browser_definer_allowlist (proname, reason) VALUES
  ('fn_capability_available',
   'Capability readiness predicate. authenticated MUST keep EXECUTE: the SECURITY '
   'INVOKER trigger zz_tables_kill_pot_guard on public.tables calls it, and such a '
   'trigger runs as the role doing the write. authenticated holds INSERT and UPDATE '
   'on public.tables, so a revoke fails every logged-in Kill Pot table create with '
   'permission denied instead of closing a console - the same shape already recorded '
   'for fn_ca_new_tournament_is_unlimited. It takes a capability id the caller already '
   'holds and returns one boolean about whether that capability is deployed: no club, '
   'player, wallet or evidence data, and it writes nothing. The engine calls it as '
   'service_role from server/src/tournament/multiDayStages.ts.'),
  ('fn_diamond_arena_leaderboard_period',
   'The Diamond Arena leaderboard, read from the browser by '
   'src/services/LeaderboardService.ts and documented as signed-in players and the '
   'service role may call it, a visitor may not. A leaderboard answers about every '
   'player because that is what it is for, which is why fn_global_leaderboard_period '
   'is already allowlisted on the same ground. Fixture accounts are left out and '
   'horses are not - fn_ca_is_fixture_account tests is_horse first, so a horse is '
   'never a fixture account (10.5). STABLE, writes nothing, returns the chip board '
   'columns and no wallet, seat or hole-card data.'),
  ('fn_platform_capabilities',
   'The platform capability registry, read by every client before it offers a product '
   'surface, including on pages that render before login - which is why it is anon by '
   'design and not by accident. Already accounted for by two other guards '
   '(docs/security/anon-executable-definers.json and '
   'scripts/ci/definer-authorization.allowlist.json); this table was the only one '
   'without a row, which is the whole reason Telemetry Exposure still named it. '
   'Returns capability id, rule version, title, scope, variants, compatibility, '
   'readiness and the derived available flag. No actor, evidence, club, player or '
   'wallet data; STABLE, writes nothing.')
ON CONFLICT (proname) DO NOTHING;

-- 3. THE CHECK LEARNS TO SEE A GATE BEHIND A HELPER ---------------------------

CREATE OR REPLACE FUNCTION public.fn_ca_browser_reachable_telemetry()
 RETURNS TABLE(proname text, args text, reached_by text, volatility text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog', 'pg_temp'
AS $function$
  with identity_fn as (
    -- Every public function that reads who is calling. A routine that calls one
    -- of these is gated even though its own text never names auth.uid().
    select p.oid, p.proname
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and (p.prosrc ilike '%auth.uid()%'
         or p.prosrc ilike '%auth.role()%'
         or p.prosrc ilike '%auth.jwt()%'
         or p.prosrc ilike '%current_setting%request%')
  )
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
     -- and asks nothing about who is calling, itself ...
     and p.prosrc not ilike '%auth.uid()%'
     and p.prosrc not ilike '%auth.role()%'
     and p.prosrc not ilike '%auth.jwt()%'
     and p.prosrc not ilike '%current_setting%request%'
     -- ... nor through a helper that does. fn_ca_diamond_staff_books refuses a
     -- stranger on its first statement, but the refusal is fn_is_platform_admin(),
     -- so the four tests above cannot see it. Ten allowlist rows had already been
     -- written by hand for exactly this blind spot before the clause existed.
     and not exists (select 1 from identity_fn i
                      where i.oid <> p.oid
                        and p.prosrc ~ ('\m' || i.proname || '\M'))
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

-- 4. THE CLOSURE IS TRUE, OR THIS MIGRATION DOES NOT LAND ---------------------

DO $$
DECLARE
  v_oid oid := 'public.fn_horse_tag_ev_significance(date)'::regprocedure;
  v_open int;
BEGIN
  IF has_function_privilege('anon', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'fn_horse_tag_ev_significance is still anon-executable';
  END IF;
  IF has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'fn_horse_tag_ev_significance is still authenticated-executable';
  END IF;
  IF NOT has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role lost EXECUTE on fn_horse_tag_ev_significance';
  END IF;

  -- The engine still reaches fn_capability_available, and so does the trigger.
  IF NOT has_function_privilege('authenticated', 'public.fn_capability_available(text)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'fn_capability_available lost EXECUTE for authenticated; Kill Pot table writes would fail';
  END IF;

  SELECT count(*) INTO v_open FROM public.fn_ca_browser_reachable_telemetry();
  IF v_open <> 0 THEN
    RAISE EXCEPTION 'still % unscoped definer(s) reachable from a browser', v_open;
  END IF;
END $$;

COMMIT;
