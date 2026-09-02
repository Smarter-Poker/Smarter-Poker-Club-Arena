-- THE PANEL COULD NOT TELL YOU WHICH SURFACE WORKS, AND THE COUNT COULD LIE
--
-- Two gaps found auditing the ad system on 2026-08-28, hours after the second,
-- third and fourth surfaces went live. Neither is a crash; both are the same
-- species as everything else this system was built to end - a number that
-- looks confident and is not.
--
-- ── 1. THE ROLLUP IS SLOT-BLIND ────────────────────────────────────────────
--
-- `/api/club-arena/house-ads` aggregates `ad_event` by `ad_id` alone:
--
--     const row = (stats[e.ad_id] ||= { impressions: 0, clicks: 0, dismisses: 0 });
--
-- That was correct when one slot existed. `bbj_running` now runs on FOUR
-- surfaces - the Club Arena lobby, the World Hub home strip, the Hub
-- promotions rail and the empty lobby - and the panel reports one blended
-- number for all of them. An operator reading "412 impressions, 3 clicks"
-- cannot tell whether the lobby is carrying the campaign or dragging it down,
-- and the obvious action (turn the campaign off) may be exactly wrong.
--
-- The whole justification for this system is being able to answer "did anyone
-- look at it". Answering it for four surfaces at once is a different, weaker
-- question that nobody asked.
--
-- ── 2. THE COUNT HAD A CEILING, AND NO WAY TO SAY SO ───────────────────────
--
-- The same route reads `.limit(50000)` and counts in JavaScript. At 50,000
-- events - which this system will reach, since it logs an impression per ad
-- per page load - PostgREST returns the first 50,000 and the route reports the
-- total with complete confidence. It would under-report forever, silently, and
-- get worse every day.
--
-- Counting in the database has no ceiling and no truncation to detect.
--
-- ── 3. `ad_event.slot` ACCEPTED ANY STRING AT ALL ──────────────────────────
--
-- `ad_placement.slot` has a CHECK naming the five legal surfaces.
-- `ad_event.slot`, which is what every report reads, had NONE. Three separate
-- clients across two repos write that column by hand:
--
--     AdService.logEvent(adId, slot, ...)          Club Arena
--     logHubAdEvent(adId, eventType)               World Hub strip
--     logEvent(adId, slot, eventType)              World Hub rail
--
-- One typo - 'lobby-strip', 'hubPromotions', a stale constant - and the writes
-- keep succeeding while the rollup for that surface silently splits in two.
-- Nothing would ever go red; the numbers would just quietly stop adding up.
-- The placement table has been guarded against this since Phase 1. The event
-- table, which is the one that matters, was not.
--
-- ── WHAT THIS DOES ─────────────────────────────────────────────────────────
--
--   1. `fn_ad_stats()` - per ad AND per slot, counted in Postgres, plus the
--      last event time so a surface that has stopped reporting is visible as
--      well as one that never started.
--   2. A CHECK on `ad_event.slot` naming the same five surfaces as
--      `ad_placement.slot`. Verified first: every existing row is already
--      valid, so nothing is rejected retroactively.
--
-- ── WHY service_role AND NOT authenticated ─────────────────────────────────
--
-- `ad_event` deliberately has NO select policy: one player must never be able
-- to enumerate another's viewing history. A SECURITY DEFINER function granted
-- to `authenticated` would hand back exactly that in aggregate. This is read
-- by the admin API, which authorises itself against
-- `profiles.role IN ('admin','super_admin')` and holds the service role, so
-- that is the only grantee. `fn_ad_cap_status` stays player-callable because
-- it only ever reports on the caller's own impressions.
--
-- ROLLBACK
--   drop function if exists public.fn_ad_stats();
--   alter table public.ad_event drop constraint if exists ad_event_slot_check;

-- 1. Per ad, per slot, counted where the rows are.
create or replace function public.fn_ad_stats()
returns table(
  ad_id uuid,
  slot text,
  impressions bigint,
  clicks bigint,
  dismisses bigint,
  last_event_at timestamptz
)
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  SELECT e.ad_id,
         e.slot,
         count(*) FILTER (WHERE e.event_type = 'impression') AS impressions,
         count(*) FILTER (WHERE e.event_type = 'click')      AS clicks,
         count(*) FILTER (WHERE e.event_type = 'dismiss')    AS dismisses,
         max(e.created_at)                                   AS last_event_at
    FROM public.ad_event e
   GROUP BY e.ad_id, e.slot;
$function$;

revoke all on function public.fn_ad_stats() from public, anon, authenticated;
grant execute on function public.fn_ad_stats() to service_role;

-- 2. A slot in the event log must be a slot that exists.
do $$
declare v_bad int;
begin
  -- Never add a constraint that would reject data already written. If this
  -- ever finds rows, the right answer is to look at them, not to widen the
  -- constraint until they fit.
  select count(*) into v_bad
    from public.ad_event
   where slot is null
      or slot not in ('lobby_strip','session_summary','empty_state','hub_promotions','table_between_hands');
  if v_bad > 0 then
    raise exception
      '% ad_event row(s) carry a slot that is not one of the five declared surfaces; inspect them before constraining', v_bad;
  end if;
end $$;

alter table public.ad_event
  add constraint ad_event_slot_check
  check (slot = any (array['lobby_strip','session_summary','empty_state','hub_promotions','table_between_hands']));

-- 3. Assertions. Abort rather than half-apply.
do $$
declare
  v_rows int;
  v_acl  text;
begin
  if not exists (select 1 from pg_proc where proname = 'fn_ad_stats') then
    raise exception 'fn_ad_stats was not created';
  end if;

  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.ad_event'::regclass and conname = 'ad_event_slot_check'
  ) then
    raise exception 'ad_event_slot_check was not created';
  end if;

  -- The function must actually return the breakdown, not an empty shape.
  select count(*) into v_rows from public.fn_ad_stats();
  if v_rows = 0 and exists (select 1 from public.ad_event) then
    raise exception 'fn_ad_stats returned nothing while ad_event has rows';
  end if;

  -- And it must NOT be reachable by a player.
  select array_to_string(proacl, ' | ') into v_acl from pg_proc where proname = 'fn_ad_stats';
  if v_acl like '%authenticated=X%' or v_acl like '%anon=X%' then
    raise exception 'fn_ad_stats is executable by players; ad_event has no select policy for a reason';
  end if;
end $$;
