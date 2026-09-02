-- I MEASURED SUPPRESSION IN THE WRONG UNIT, AND THEN SAID IT WAS WIRED
--
-- Two corrections to my own work from earlier today, plus the index the
-- per-surface cap should have come with.
--
-- ── 1. `fn_ad_cap_status` ANSWERED A QUESTION NOBODY ASKS ──────────────────
--
-- Migration 20260828032000 added it so that a suppressed advert would be
-- countable rather than merely absent - Dan, 2026-08-28: "if you add a cap or
-- a hold, make it rotate, and make a suppressed ad countable."
--
-- It reports on the CALLER'S OWN impressions. That is the right unit for a
-- player debugging their own screen and the wrong unit for the only person who
-- will ever ask the question. An operator looking at a silent surface wants to
-- know whether EVERYONE is capped out, not whether they personally are. The
-- admin panel is staff-only, so wiring it there would have answered "is this
-- one staff member capped", which is noise.
--
-- So it was never wired, and I reported it as "now consumed" in the changelog
-- and pull request for 20260828050000. That was wrong, and it is the same
-- failure this system exists to end: a confident claim that nothing checked.
-- The claim is corrected in this migration's own changelog entry.
--
-- Replaced with `fn_ad_suppression()`, which counts PEOPLE:
--
--     served_users_24h   distinct players this placement reached today
--     capped_users_24h   distinct players it can no longer reach today
--
-- A surface that has gone quiet now has three distinguishable causes rather
-- than one silence: no placements (the panel already shows "Not Placed"), no
-- audience match (served and capped both zero while the campaign is live), or
-- everyone capped (capped high, served flat). That is what countable was
-- supposed to mean.
--
-- Dropping the old function is safe: it is called from nowhere. Verified by
-- grep across both repositories before writing this, which is what should have
-- happened before claiming otherwise.
--
-- ── 2. THE CAP INDEX NO LONGER MATCHES THE CAP QUERY ───────────────────────
--
-- `idx_ad_event_cap` is (user_id, ad_id, created_at DESC). It was built for
-- the Phase 1 predicate, which had exactly those columns.
--
-- Migration 20260828032000 added `AND e.slot = pl.slot` - the fix that stopped
-- lobby impressions from spending every other surface's cap - and 20260828050000
-- did nothing about the index. The leading columns still match, so Postgres
-- still uses it, but `slot` and `event_type` are now filtered AFTER the fetch.
--
-- This runs once per candidate advert on every page load of every surface, and
-- `ad_event` only grows. Trivial today at 160 rows; the shape of a problem
-- later, and the cheapest possible moment to fix it is before the table is
-- large enough for anyone to notice.
--
-- Rebuilt as (user_id, ad_id, slot, event_type, created_at DESC), which is the
-- cap predicate exactly. CREATE INDEX rather than CONCURRENTLY because a
-- migration runs in a transaction and this table is small enough that the
-- lock is measured in milliseconds; revisit that if ad_event ever gets large.
--
-- ROLLBACK
--   drop function if exists public.fn_ad_suppression();
--   drop index if exists public.idx_ad_event_cap;
--   create index idx_ad_event_cap on public.ad_event (user_id, ad_id, created_at desc);
--   (fn_ad_cap_status is not restored: it was never called.)

-- 1. Suppression, counted in people rather than in one caller.
drop function if exists public.fn_ad_cap_status(text);

create or replace function public.fn_ad_suppression()
returns table(
  ad_id uuid,
  slot text,
  daily_cap integer,
  served_users_24h bigint,
  capped_users_24h bigint
)
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  WITH per_user AS (
    SELECT e.ad_id, e.slot, e.user_id, count(*) AS impressions
      FROM public.ad_event e
     WHERE e.event_type = 'impression'
       AND e.created_at > now() - interval '24 hours'
       AND e.user_id IS NOT NULL
     GROUP BY e.ad_id, e.slot, e.user_id
  )
  SELECT pl.ad_id,
         pl.slot,
         pl.daily_cap,
         COALESCE(count(pu.user_id), 0) AS served_users_24h,
         COALESCE(count(pu.user_id) FILTER (
           WHERE pl.daily_cap IS NOT NULL AND pu.impressions >= pl.daily_cap
         ), 0) AS capped_users_24h
    FROM public.ad_placement pl
    LEFT JOIN per_user pu
           ON pu.ad_id = pl.ad_id AND pu.slot = pl.slot
   WHERE pl.is_active
   GROUP BY pl.ad_id, pl.slot, pl.daily_cap;
$function$;

-- Same reasoning as fn_ad_stats: ad_event has no select policy because one
-- player must never enumerate another's viewing history, and this aggregates
-- across every player.
revoke all on function public.fn_ad_suppression() from public, anon, authenticated;
grant execute on function public.fn_ad_suppression() to service_role;

-- 2. The index the per-surface cap should have shipped with.
drop index if exists public.idx_ad_event_cap;
create index idx_ad_event_cap
  on public.ad_event (user_id, ad_id, slot, event_type, created_at desc);

comment on index public.idx_ad_event_cap is
  'Exactly the frequency-cap predicate in fn_resolve_ads: user, ad, slot, '
  'event_type, time. Runs once per candidate advert on every page load.';

-- 3. Assertions. Abort rather than half-apply.
do $$
declare
  v_acl  text;
  v_def  text;
  v_rows int;
begin
  if exists (select 1 from pg_proc where proname = 'fn_ad_cap_status') then
    raise exception 'fn_ad_cap_status still exists; it was meant to be replaced, not duplicated';
  end if;

  if not exists (select 1 from pg_proc where proname = 'fn_ad_suppression') then
    raise exception 'fn_ad_suppression was not created';
  end if;

  select array_to_string(proacl, ' | ') into v_acl from pg_proc where proname = 'fn_ad_suppression';
  if v_acl like '%authenticated=X%' or v_acl like '%anon=X%' then
    raise exception 'fn_ad_suppression is executable by players; it aggregates across every player';
  end if;

  -- One row per active placement, or the panel will silently show nothing for
  -- the placements it skipped.
  select count(*) into v_rows from public.fn_ad_suppression();
  if v_rows <> (select count(*) from public.ad_placement where is_active) then
    raise exception 'fn_ad_suppression returned % rows for % active placements',
      v_rows, (select count(*) from public.ad_placement where is_active);
  end if;

  select indexdef into v_def from pg_indexes
   where schemaname = 'public' and indexname = 'idx_ad_event_cap';
  if v_def is null or v_def not like '%slot%' or v_def not like '%event_type%' then
    raise exception 'idx_ad_event_cap does not cover the cap predicate: %', coalesce(v_def, 'MISSING');
  end if;
end $$;
