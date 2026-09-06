-- ═══════════════════════════════════════════════════════════════════════════
-- RESTORE THE SEAT CLOCK, AND APPEND THE BREATHER (2026-09-06)
--
-- I rewrote fn_audit_seat_clock from memory instead of reading it, and the
-- rewrite referenced table_seats.last_action_at - a column that does not
-- exist, so the step threw on its first call. The real check reads
-- ca_horse_fleet_state, and it asks a sharper question than mine did: are
-- there 50+ seated horses and 100,000+ decisions on the day with NOT ONE
-- last_action_at inside two hours? That is the shape that means the
-- seat-touch write is dead, and it is deliberately silent otherwise.
--
-- The body below is restored VERBATIM from
-- 20260905212733_the_audit_reads_the_tag_registry_the_tuner_and_the_seat_clock.sql.
-- The only change is the last line: the breather check appended, because "a
-- horse holding a seat it will never act from" is the same question a reader
-- is already asking here.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.fn_audit_seat_clock(p_day date)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v jsonb := '[]'::jsonb;
  v_seated int;
  v_touched int;
  v_decides bigint;
begin
  select count(*) filter (where state = 'seated'),
         count(*) filter (where state = 'seated' and last_action_at >= now() - interval '2 hours')
    into v_seated, v_touched
    from ca_horse_fleet_state;
  select coalesce(sum(fires), 0) into v_decides
    from horse_brain_telemetry where day = p_day and feature = 'decide';
  if v_seated >= 50 and v_decides >= 100000 and v_touched = 0 then
    v := v || jsonb_build_object('severity','critical','category','schema','code','seat_clock_dead',
      'title', v_seated || ' seated horses and none has a last_action_at in the last two hours, against ' || v_decides || ' decisions on ' || p_day,
      'evidence', jsonb_build_object('seated', v_seated, 'touched_2h', v_touched, 'decides', v_decides),
      'recommendation','fn_ca_fleet_seat_touch is not being called (HorseHandReview.touchHorseSeats, HORSE_SEAT_TOUCH_ENABLED) or the fleet upsert is overwriting it again (fn_ca_fleet_state_upsert must coalesce last_action_at). The panel cannot tell a playing horse from a stuck one without it.');
  end if;

  -- 2026-09-06: a breather that never ends holds a seat the horse will never
  -- act from, which is the same question this step exists to ask.
  v := v || fn_audit_breather_returns(p_day);
  return v;
end $$;

revoke all on function public.fn_audit_seat_clock(date) from public, authenticated, anon;
grant execute on function public.fn_audit_seat_clock(date) to service_role;
