-- 20260928152619_bust_sweep_lag_ages_a_decided_tournament_from_its_last_hand.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- fn_audit_fleet_health's bust_sweep_lag reported `oldest_decided_minutes` as
-- now() - tournaments.started_at: the tournament's AGE, not how long it had
-- been decided. On 2026-09-27 that read 10,207 minutes and the audit panel
-- said "oldest decided-but-unpaid for 7 days". The tournament in question
-- (Sunday Funday Six-Card Closer) started on 2026-09-21; its last hand was
-- dealt at 01:10 UTC on 2026-09-28. Measured the same way on 2026-09-28 at
-- ~15:10 UTC: 342 decided tournaments, 245 of them decided 10-60 minutes
-- earlier and one decided more than an hour earlier - a real lag, but
-- minutes, not days.
--
-- The age is now measured from each decided tournament's LAST HAND (falling
-- back to started_at only when it has dealt none), and the recommendation
-- names what the engine was actually logging on 2026-09-28: the seat-first
-- finish sweep refused by fn_f06_assert_drained_manager_custody with
-- F06_DRAINED_CUSTODY_EVENT_CHANGED (262 refusals in 20 minutes).
--
-- Every other line of the function is byte-identical to production as read
-- on 2026-09-28.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

SET LOCAL lock_timeout = '5s';

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

  -- DECIDED SINCE THE LAST HAND, NOT SINCE THE START (2026-09-28). The age a
  -- reader needs is how long a decided event has waited, which starts at its
  -- final hand. idx_hand_history_tournament_created serves each lookup.
  select count(*),
         coalesce(max(extract(epoch from (now() - coalesce(d.last_hand, d.started_at)))/60), 0)
    into v_decided_unfinished, v_decided_max_min
    from (
      select tr.id, tr.started_at,
             (select max(h.created_at) from hand_history h
               where h.tournament_id = tr.id) as last_hand
        from tournaments tr
       where tr.status = 'RUNNING'
         and tr.started_at < now() - interval '5 minutes'
         and (select count(*) from tournament_players tp
               where tp.tournament_id = tr.id
                 and tp.status = 'playing'
                 and coalesce(tp.chips, 0) > 0) <= 1
    ) d;

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
        'metric_note', 'oldest_decided_minutes is measured from the decided tournament''s LAST HAND (its start time only when it dealt none) - how long a winner has been waiting. Before 2026-09-28 it was measured from started_at and read as days. oldest_seat_tenure_minutes is how long the player has been SEATED, not how long the bust has gone unswept - there is no bust timestamp in the schema. Escalation uses decided_unfinished, which is unambiguous.'),
      'recommendation','Decided tournaments are waiting for the finish path. Read the engine log before assuming capacity: on 2026-09-28 the seat-first finish sweep was refused 262 times in 20 minutes by fn_f06_assert_drained_manager_custody with F06_DRAINED_CUSTODY_EVENT_CHANGED (the event had left RUNNING by the time the sweep asked), while decided events took ~40 minutes to complete. On 2026-09-02 the cause was a starved event loop (2,621 elimination_sweep_overrunning in 5.5 hours). Do not change the bust predicate, the zero-chip guard or the lock thresholds; each of those is guarding a documented money incident.');
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

-- Operator telemetry: the audit runs as service_role, nobody else calls it.
REVOKE ALL ON FUNCTION public.fn_audit_fleet_health(date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_audit_fleet_health(date) TO service_role;

COMMIT;
