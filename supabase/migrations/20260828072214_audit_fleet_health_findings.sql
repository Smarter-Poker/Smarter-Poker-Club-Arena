-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260828072214; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- FLEET HEALTH IN THE NIGHTLY AUDIT (2026-08-28)
-- ═══════════════════════════════════════════════════════════════════════════
-- "How many horses aren't working?" took a 1 AM hand-investigation across six
-- ad-hoc queries, and two of my own three attempts got the arithmetic wrong
-- (double-counting RUNNING tournament bookings against their own seats). The
-- authority is fn_concurrent_game_load; nothing was asking it on a schedule.
--
-- This asks, every night, the four questions that investigation needed:
--   fleet_idle_share        - horses with no hands at all today
--   fleet_over_cap          - load above HORSE_MAX_CONCURRENT_TABLES (4).
--                             Write-time triggers make this near-impossible on
--                             INSERT; it appears when a tournament's STATUS
--                             changes and retroactively counts a booking, so a
--                             handful is normal and a spike is a real defect.
--   bust_sweep_lag          - zero-chip 'playing' rows in a RUNNING tournament
--                             older than 10 minutes: the elimination sweep is
--                             lagging and those seats are ghosts (they hold a
--                             chair and count toward the cap).
--   fleet_seat_starvation   - open cash seats while in-window horses sit idle,
--                             beyond what the V14 occupancy design intends.

create or replace function fn_audit_fleet_health(p_day date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $function$
declare
  v jsonb := '[]'::jsonb;
  v_fleet int;
  v_played int;
  v_idle int;
  v_over int;
  v_over_max int;
  v_ghosts int;
  v_ghost_max_min numeric;
  v_open_seats int;
begin
  select count(*) into v_fleet from profiles where is_horse = true;
  select count(distinct horse_user_id) into v_played
    from horse_daily_nets where day = p_day;
  v_idle := greatest(0, v_fleet - v_played);

  -- Idle share: a fleet where a fifth never deals is a seeding problem.
  if v_fleet > 0 and v_idle::numeric / v_fleet > 0.20 then
    v := v || jsonb_build_object(
      'severity', case when v_idle::numeric / v_fleet > 0.40 then 'critical' else 'warn' end,
      'category','logic','code','fleet_idle_share',
      'title', v_idle || ' of ' || v_fleet || ' horses dealt no hands',
      'evidence', jsonb_build_object('fleet', v_fleet, 'played', v_played, 'idle', v_idle),
      'recommendation','Activity windows legitimately idle ~40% at any instant, but across a WHOLE day nearly every horse should deal. Check HorseFleetManager seeding cycles and the overlay guard candidate pools.');
  end if;

  -- Concurrency cap, asked of the authoritative function.
  select count(*), coalesce(max(l), 0) into v_over, v_over_max
    from (select fn_concurrent_game_load(id) l from profiles where is_horse = true) q
   where l > 4;
  if v_over > 5 then
    v := v || jsonb_build_object(
      'severity', case when v_over > 25 then 'critical' else 'warn' end,
      'category','logic','code','fleet_over_cap',
      'title', v_over || ' horses are above the four-game cap (max ' || v_over_max || ')',
      'evidence', jsonb_build_object('over_cap', v_over, 'max_load', v_over_max),
      'recommendation','trg_enforce_four_table_limit and trg_enforce_booking_game_cap hold this at write time with an advisory lock, so a few are expected from tournament STATUS transitions that retroactively count a booking. Many means a write path is bypassing the triggers - find it.');
  end if;

  -- Ghost seats: busted but never eliminated.
  select count(*), coalesce(max(extract(epoch from (now() - tp.updated_at))/60), 0)
    into v_ghosts, v_ghost_max_min
    from tournament_players tp
    join tournaments tr on tr.id = tp.tournament_id
   where tr.status = 'RUNNING' and tp.status = 'playing' and coalesce(tp.chips, 0) <= 0
     and tp.updated_at < now() - interval '10 minutes';
  if v_ghosts > 0 then
    v := v || jsonb_build_object(
      'severity', case when v_ghosts > 10 or v_ghost_max_min > 45 then 'critical' else 'warn' end,
      'category','logic','code','bust_sweep_lag',
      'title', v_ghosts || ' busted entrants still marked playing (oldest ' || round(v_ghost_max_min) || ' min)',
      'evidence', jsonb_build_object('ghost_rows', v_ghosts, 'oldest_minutes', round(v_ghost_max_min)),
      'recommendation','The 5s elimination sweep is lagging. Each row is a ghost seat: it holds a chair and counts toward the four-game cap. Check TournamentManagerEliminations logs for held sweeps (bustingArmedAt) or a zero-chip-field guard refusing to bust.');
  end if;

  -- Seat starvation: lots of empty cash chairs is a lobby that looks dead.
  select coalesce(sum(t.max_players) - sum(coalesce(s.n, 0)), 0) into v_open_seats
    from tables t
    left join (select table_id, count(*) n from table_seats where left_at is null group by 1) s
      on s.table_id = t.id
   where t.tournament_id is null and t.status in ('running','waiting');
  if v_open_seats > 150 then
    v := v || jsonb_build_object(
      'severity','warn','category','logic','code','fleet_seat_starvation',
      'title', v_open_seats || ' open cash seats across the fleet',
      'evidence', jsonb_build_object('open_seats', v_open_seats),
      'recommendation','Some open seats are deliberate (V14 table occupancy keeps the lobby lopsided and human-looking). This many means the seeder is not keeping up - check HorseFleetManager seeding cycles and the horse candidate pool.');
  end if;

  return v;
end
$function$;

revoke all on function fn_audit_fleet_health(date) from public, anon, authenticated;
grant execute on function fn_audit_fleet_health(date) to service_role;
