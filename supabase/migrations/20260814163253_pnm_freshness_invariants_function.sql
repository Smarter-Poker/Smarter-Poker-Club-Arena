-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260814163253 "pnm_freshness_invariants_function"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 a26bf1dac8ad33ed0f003d1bdb714000 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- One-call health check for every Poker Near Me data domain, mirroring
-- economy_invariants(). Each row: (check_name, ok, detail). A false here means
-- a pipeline stopped writing — the silent-failure shape behind both the 8-week
-- tournament outage and the 11-day PokerAtlas freeze.
create or replace function public.pnm_freshness_invariants()
returns table(check_name text, ok boolean, detail text)
language sql
security definer
set search_path to 'public'
as $$
  -- Daily tournaments: the Mac daemon runs a 24h cycle; anything beyond 36h
  -- means a full missed cycle.
  select 'daily_tournaments_written_36h'::text,
         coalesce(max(scrape_timestamp) >= now() - interval '36 hours', false),
         'venue_daily_tournaments newest scrape: ' || coalesce(max(scrape_timestamp)::text,'never')
  from venue_daily_tournaments
  union all
  -- Coverage breadth: a healthy cycle touches many venues, not a trickle.
  select 'daily_tournaments_breadth_36h',
         count(distinct venue_id) >= 25,
         count(distinct venue_id)::text || ' distinct venues scraped in last 36h (floor 25)'
  from venue_daily_tournaments where scrape_timestamp >= now() - interval '36 hours'
  union all
  -- Charity rides the same table; its venues must also keep refreshing.
  select 'charity_rows_written_8d',
         coalesce(max(d.scrape_timestamp) >= now() - interval '8 days', false),
         'newest charity-venue scrape: ' || coalesce(max(d.scrape_timestamp)::text,'never')
  from venue_daily_tournaments d
  join poker_venues v on v.id = d.venue_id
  where lower(coalesce(v.venue_type,'')) like '%charity%'
  union all
  -- Tours: launchd runs the stealth scraper every 3 days.
  select 'tour_stops_scraped_4d',
         coalesce(max(scrape_timestamp) >= now() - interval '4 days', false),
         'tour_stop_events newest scrape: ' || coalesce(max(scrape_timestamp)::text,'never')
  from tour_stop_events
  union all
  select 'series_scraped_4d',
         coalesce(max(scrape_timestamp) >= now() - interval '4 days', false),
         'poker_series newest scrape: ' || coalesce(max(scrape_timestamp)::text,'never')
  from poker_series
  union all
  -- Live tables: real scrapes or simulator swaps, either way rows must be <3h old.
  select 'live_tables_written_3h',
         coalesce(max(scrape_timestamp) >= now() - interval '3 hours', false),
         'venue_live_tables newest: ' || coalesce(max(scrape_timestamp)::text,'never')
  from venue_live_tables
  union all
  -- User-facing floor: the calendar must have a real inventory of upcoming,
  -- visible-quality tournaments. Collapse below 1000 means a delisting bug.
  select 'calendar_inventory_floor',
         count(*) >= 1000,
         count(*)::text || ' active future visible-quality daily rows (floor 1000)'
  from venue_daily_tournaments
  where is_active and event_date >= current_date
    and data_quality in ('scraped_verified','scraped_inferred')
  union all
  -- Provenance sanity: simulated rows must never claim to be scrapes.
  select 'no_sim_rows_claiming_scraped',
         count(*) = 0,
         count(*)::text || ' sim-batch rows labeled scraped_verified'
  from venue_live_tables
  where scrape_batch_id like 'sim-%' and data_quality = 'scraped_verified';
$$;
revoke all on function public.pnm_freshness_invariants() from public, anon, authenticated;
