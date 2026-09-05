-- ============================================================================
-- bust_sweep_lag NAMES WHAT IT MEASURES (2026-09-04)
-- ============================================================================
-- `oldest_minutes` was measured from table_seats.joined_at - how long the
-- player had been SEATED, not how long the bust had gone unswept - and it
-- drove the critical escalation at > 45. Proof from 2026-09-02: a flagged
-- seat had joined_at 14:28:45 in a tournament whose started_at was 14:31:36,
-- so the reported "lag" predated the tournament by three minutes.
--
-- There is no bust timestamp to use instead: neither table_seats nor
-- tournament_players carries one, and eliminated_at is stamped only once
-- elimination SUCCEEDS, which is exactly what has not happened. So the number
-- is renamed to what it is, and the escalation moves to a signal that cannot
-- be confused with anything: RUNNING tournaments that are already decided
-- (at most one player left with chips) and have not paid.
--
-- The underlying cause is NOT fixed here and is not a predicate mismatch.
-- Measured 2026-09-02: the engine carries 1,300+ table engines in one Node
-- process at 60-98% CPU with 2,621 elimination_sweep_overrunning events in
-- 5.5 hours of logs - the 5s sweep cannot be SCHEDULED. Relieving that is a
-- capacity change and gets its own PR.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_audit_fleet_health(p_day date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v jsonb := '[]'::jsonb;
  v_fleet int;
  v_played int;
  v_idle int;
  v_over int;
  v_over_max int;
  v_ghosts int;
  v_ghost_max_min numeric;
  v_decided_unfinished int;
  v_decided_max_min numeric;
  v_open_seats int;
  v_seat_total int;
  v_seat_filled int;
  v_avail_horses int;
begin
  select count(*) into v_fleet from profiles
    where is_horse = true
      and coalesce(horse_status, 'available') <> 'disabled';
  select count(distinct horse_user_id) into v_played
    from horse_daily_nets where day = p_day;
  v_idle := greatest(0, v_fleet - v_played);

  if v_fleet > 0 and v_idle::numeric / v_fleet > 0.20 then
    v := v || jsonb_build_object(
      'severity', case when v_idle::numeric / v_fleet > 0.40 then 'critical' else 'warn' end,
      'category','logic','code','fleet_idle_share',
      'title', v_idle || ' of ' || v_fleet || ' horses dealt no hands',
      'evidence', jsonb_build_object('fleet', v_fleet, 'played', v_played, 'idle', v_idle),
      'recommendation','Activity windows legitimately idle ~40% at any instant, but across a WHOLE day nearly every horse should deal. Check HorseFleetManager seeding cycles and the overlay guard candidate pools.');
  end if;

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

  -- ── Ghost seats: busted, still holding a chair ──────────────────────────
  -- 2026-09-04: this used to report the age of the SEAT as though it were the
  -- age of the BUST, and escalate to critical on it. It is seat tenure. Proof
  -- from 2026-09-02: a flagged seat had joined_at 14:28:45 in a tournament
  -- whose started_at was 14:31:36, so the reported "lag" predated the
  -- tournament by three minutes. A player who busted two seconds ago but has
  -- been sitting for eleven minutes was counted instantly and at full age.
  -- There is no bust timestamp to use instead: neither table_seats nor
  -- tournament_players carries one, and eliminated_at is written only once
  -- elimination SUCCEEDS, which is precisely what has not happened. So the
  -- number is named for what it measures, and the escalation moves to a
  -- signal that is unambiguous and needs no new column.
  select count(*), coalesce(max(extract(epoch from (now() - ts.joined_at))/60), 0)
    into v_ghosts, v_ghost_max_min
    from table_seats ts
    join tables t on t.id = ts.table_id
    join tournaments tr on tr.id = t.tournament_id
    join tournament_players tp
      on tp.tournament_id = t.tournament_id and tp.user_id = ts.user_id
   where ts.left_at is null
     and tr.status = 'RUNNING'
     and tp.status = 'playing'
     and coalesce(ts.stack, 0) <= 0
     and ts.joined_at < now() - interval '10 minutes';

  -- A RUNNING tournament with at most one player who still has chips is
  -- DECIDED and has not paid. That is the outcome the ghost seats actually
  -- cost, it cannot be confused with seat tenure, and it is measured from
  -- the tournament's own clock.
  select count(*), coalesce(max(extract(epoch from (now() - tr.started_at))/60), 0)
    into v_decided_unfinished, v_decided_max_min
    from tournaments tr
   where tr.status = 'RUNNING'
     and tr.started_at < now() - interval '5 minutes'
     and (select count(*) from tournament_players tp
           where tp.tournament_id = tr.id
             and tp.status = 'playing'
             and coalesce(tp.chips, 0) > 0) <= 1;

  if v_ghosts > 0 or v_decided_unfinished > 0 then
    v := v || jsonb_build_object(
      'severity', case when v_decided_unfinished > 5 or v_ghosts > 10 then 'critical' else 'warn' end,
      'category','logic','code','bust_sweep_lag',
      'title', v_ghosts || ' busted entrants still hold seats, and ' ||
               v_decided_unfinished || ' running tournament(s) are already decided but unpaid',
      'evidence', jsonb_build_object(
        'ghost_seats', v_ghosts,
        'oldest_seat_tenure_minutes', round(v_ghost_max_min),
        'decided_unfinished', v_decided_unfinished,
        'oldest_decided_minutes', round(v_decided_max_min),
        'measured_at', now(),
        'metric_note', 'oldest_seat_tenure_minutes is how long the player has been SEATED, not how long the bust has gone unswept - there is no bust timestamp in the schema. Escalation uses decided_unfinished, which is unambiguous.'),
      'recommendation','The 5s elimination sweep is lagging. Measured 2026-09-02: the engine carries 1,300+ table engines in ONE Node process at 60-98% CPU, with 2,621 elimination_sweep_overrunning events in 5.5 hours of logs, so the sweep cannot be SCHEDULED - it is not a predicate mismatch and not the bustingArmedAt hold. Relieving it is a capacity change (one process-wide scheduler with bounded concurrency instead of a 5s interval per tournament, and then sharding the engine across cores). Do not change the bust predicate, the zero-chip guard or the lock thresholds; each of those is guarding a documented money incident.');
  end if;

  select count(*) into v_avail_horses from profiles
    where is_horse = true
      and coalesce(horse_status, 'available') <> 'disabled';
  select coalesce(sum(t.max_players), 0), coalesce(sum(coalesce(s.n, 0)), 0),
         coalesce(sum(t.max_players) - sum(coalesce(s.n, 0)), 0)
    into v_seat_total, v_seat_filled, v_open_seats
    from tables t
    left join (select table_id, count(*) n from table_seats where left_at is null group by 1) s
      on s.table_id = t.id
   where t.tournament_id is null and t.status in ('running','waiting');
  if v_seat_total > 0 and v_open_seats::numeric / v_seat_total > 0.45 then
    v := v || jsonb_build_object(
      'severity','warn','category','logic','code','fleet_seat_starvation',
      'title', v_open_seats || ' of ' || v_seat_total || ' cash seats are empty (' ||
        round(100.0 * v_seat_filled / nullif(v_seat_total, 0), 1) || '% full)',
      'evidence', jsonb_build_object('open_seats', v_open_seats, 'seats', v_seat_total,
        'filled', v_seat_filled,
        'pct_full', round(100.0 * v_seat_filled / nullif(v_seat_total, 0), 1),
        'available_horses', v_avail_horses),
      'recommendation','Some open seats are deliberate (V14 table occupancy keeps the lobby lopsided and human-looking). This many means the seeder is not keeping up - check HorseFleetManager seeding cycles and the horse candidate pool.');
  end if;

  return v;
end
$function$;

COMMIT;
