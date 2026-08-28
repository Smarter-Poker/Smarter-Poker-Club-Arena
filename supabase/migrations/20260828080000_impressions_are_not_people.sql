-- 412 IMPRESSIONS ACROSS 9 PEOPLE IS NOT 412 PEOPLE
--
-- `fn_ad_stats` counts EVENTS. That is the right unit for "how often was this
-- shown" and the wrong one for almost every question an operator actually
-- asks, because the two numbers can differ by two orders of magnitude and
-- nothing on the panel says which one you are looking at.
--
-- The lobby strip logs one impression per advert per PAGE LOAD. A player who
-- reloads the lobby thirty times in an evening produces thirty impressions of
-- the same advert and is one person who has seen it. Today's own numbers:
--
--     spins_jackpot on lobby_strip    48 impressions
--
-- Read as reach, that is a campaign doing well. It is five people, one of whom
-- was a test account refreshing the page. A click-through rate computed
-- against 48 says 2%; against the people who actually saw it, it says
-- something completely different - and the second number is the one that
-- decides whether a campaign is working.
--
-- Neither number is wrong. Showing only one of them, unlabelled, is.
--
-- ── WHAT THIS ADDS ─────────────────────────────────────────────────────────
--
--   viewers   distinct players who saw it on this surface
--   clickers  distinct players who clicked it on this surface
--
-- Both alongside the event counts already there, not instead of them. An
-- operator wants "48 views, 5 people" - frequency is the ratio between them,
-- and a campaign with a high one is either working hard or nagging, which is a
-- judgement the panel should let somebody make rather than make for them.
--
-- A signed-out viewer has no user_id and cannot log at all (RLS demands
-- `user_id = auth.uid()`), so there is no anonymous bucket to explain away
-- here: every row already belongs to somebody.
--
-- ROLLBACK
--   Re-create fn_ad_stats from 20260828050000, which is identical but for the
--   two count(DISTINCT ...) columns.

-- DROP first: this adds two columns to the RETURNS TABLE, and Postgres refuses
-- to change a function's return type with CREATE OR REPLACE. Dropping and
-- creating inside one transaction is atomic, so no caller ever finds it
-- missing. Without this line the file would fail on replay with "cannot change
-- return type of existing function" - which is what the live database was
-- given and the committed file was not, until it was checked.
drop function if exists public.fn_ad_stats();

create or replace function public.fn_ad_stats()
returns table(
  ad_id uuid,
  slot text,
  impressions bigint,
  clicks bigint,
  dismisses bigint,
  viewers bigint,
  clickers bigint,
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
         -- People, not events. The panel shows both because the ratio between
         -- them is frequency, and frequency is the difference between a
         -- campaign working and a campaign nagging.
         count(DISTINCT e.user_id) FILTER (WHERE e.event_type = 'impression') AS viewers,
         count(DISTINCT e.user_id) FILTER (WHERE e.event_type = 'click')      AS clickers,
         max(e.created_at)                                   AS last_event_at
    FROM public.ad_event e
   GROUP BY e.ad_id, e.slot;
$function$;

revoke all on function public.fn_ad_stats() from public, anon, authenticated;
grant execute on function public.fn_ad_stats() to service_role;

-- Assertions. Abort rather than half-apply.
do $$
declare
  v_acl  text;
  v_bad  int;
  v_rows int;
begin
  select array_to_string(proacl, ' | ') into v_acl from pg_proc where proname = 'fn_ad_stats';
  if v_acl like '%authenticated=X%' or v_acl like '%anon=X%' then
    raise exception 'fn_ad_stats is executable by players; ad_event has no select policy for a reason';
  end if;

  -- Reach can never exceed frequency. If it does, the DISTINCT is on the wrong
  -- column and every ratio built on it is wrong in a way nobody would spot.
  select count(*) into v_bad
    from public.fn_ad_stats()
   where viewers > impressions or clickers > clicks;
  if v_bad > 0 then
    raise exception '% row(s) report more people than events; the distinct count is wrong', v_bad;
  end if;

  -- And the event totals must not have moved while adding the new columns.
  select count(*) into v_rows from public.fn_ad_stats();
  if v_rows <> (select count(*) from (select 1 from public.ad_event group by ad_id, slot) g) then
    raise exception 'fn_ad_stats returned % groups; ad_event has a different number', v_rows;
  end if;
end $$;
