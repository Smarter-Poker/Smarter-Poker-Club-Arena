-- ═══════════════════════════════════════════════════════════════════════════
-- EXACT GAME LANES + MTT OVERLAY GUARD (Dan 2026-08-27)
--
-- 1. LANES. "33% of horses play nothing but tournaments, spins and heads up.
--    33% play nothing but cash. 34% play both." The hash-derived lane shipped
--    earlier that day produced 32.0 / 39.0 / 28.9 measured over the real 584
--    horses - cash over-weighted by six points, and the fleet's tournament
--    capacity correspondingly short. The cause is the one this codebase
--    already documented for horse tempo: a weak hash plus a low-bit modulo
--    clusters on structured ids (UUIDs). A better mix got to 32.5/31.2/36.3,
--    which is honest sampling noise, not a fix - no hash gives an exact split
--    at n=584. So the lane is ASSIGNED and STORED: exact by construction,
--    auditable, and overridable by a human. The hash stays as the fallback
--    for a horse born after the last assignment.
--
-- 2. OVERLAY. "If any Midway Union MTT is going to have an overlay, new
--    horses start entering it so no overlay occurs." Live when this was
--    written: Union PKO Afternoon needed 33 entries for its $600 guarantee
--    and had 11; Afternoon Bounty needed 22 and had 2. The club was covering
--    the difference out of pocket.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. EXACT LANE ASSIGNMENT ───────────────────────────────────────────────
create or replace function public.fn_assign_horse_lanes()
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_events int; v_cash int; v_total int; v_res jsonb;
begin
  select count(*) into v_total from profiles where is_horse;
  if v_total = 0 then return jsonb_build_object('assigned', 0); end if;

  -- 33 / 33 / 34 by construction: floor for the two thirds, remainder to
  -- 'both' so the split is exact rather than probabilistic.
  v_events := floor(v_total * 0.33);
  v_cash := floor(v_total * 0.33);

  with ordered as (
    -- Stable order that is not creation order (which correlates with seeding
    -- batches and would put whole cohorts in one lane), and not random
    -- (which would re-roll every run).
    select id, row_number() over (order by md5(id::text)) rn
    from profiles where is_horse
  ), lanes as (
    select id,
           case when rn <= v_events then 'events'
                when rn <= v_events + v_cash then 'cash'
                else 'both' end as lane
    from ordered
  )
  update profiles p
     set horse_profile = coalesce(p.horse_profile, '{}'::jsonb) || jsonb_build_object('lane', l.lane)
    from lanes l
   where p.id = l.id
     and coalesce(p.horse_profile->>'lane', '') is distinct from l.lane;

  select jsonb_object_agg(lane, n) into v_res from (
    select horse_profile->>'lane' lane, count(*) n
    from profiles where is_horse group by 1
  ) s;
  return jsonb_build_object('total', v_total, 'distribution', v_res);
end $$;
revoke all on function public.fn_assign_horse_lanes() from public;
grant execute on function public.fn_assign_horse_lanes() to service_role;

-- ── 2. OVERLAY RISK ────────────────────────────────────────────────────────
-- A guaranteed MTT overlays when entries x buy-in fails to cover the
-- guarantee. Freerolls are excluded on purpose: their prize is funded by the
-- club by definition, so no number of entrants removes the "overlay", and
-- stuffing horses into a freeroll would only dilute a real player's equity.
create or replace function public.fn_overlay_at_risk(p_union uuid default null)
returns table (
  tournament_id uuid,
  name text,
  club_id uuid,
  status text,
  start_time timestamptz,
  buy_in numeric,
  guaranteed_prize numeric,
  entries_needed int,
  current_players int,
  shortfall int,
  max_players int,
  minutes_to_start numeric
)
language sql security definer set search_path = public stable as $$
  select t.id, t.name, t.club_id, t.status, t.start_time,
         t.buy_in_amount, t.guaranteed_prize,
         ceil(t.guaranteed_prize / nullif(t.buy_in_amount, 0))::int,
         coalesce(t.current_players, 0),
         greatest(
           least(
             ceil(t.guaranteed_prize / nullif(t.buy_in_amount, 0))::int
               - coalesce(t.current_players, 0),
             coalesce(t.max_players, 0) - coalesce(t.current_players, 0)
           ), 0)::int,
         coalesce(t.max_players, 0),
         round(extract(epoch from (t.start_time - now())) / 60.0, 1)
  from tournaments t
  left join clubs c on c.id = t.club_id
  where t.guaranteed_prize > 0
    and t.buy_in_amount > 0
    and upper(t.status) in ('SCHEDULED', 'REGISTERING', 'ANNOUNCED', 'RUNNING')
    and t.start_time > now() - interval '30 minutes'
    and t.start_time < now() + interval '3 hours'
    and (p_union is null or c.union_id = p_union or c.id = p_union)
    and ceil(t.guaranteed_prize / nullif(t.buy_in_amount, 0))::int > coalesce(t.current_players, 0)
  order by t.start_time asc;
$$;
revoke all on function public.fn_overlay_at_risk(uuid) from public;
grant execute on function public.fn_overlay_at_risk(uuid) to authenticated, service_role;

-- ── 3. AUDIT: did an overlay actually happen? ──────────────────────────────
-- The guard can only be trusted if its failures are visible. This looks
-- BACKWARD at tournaments that already started and asks whether the club
-- ended up covering a shortfall.
create or replace function public.fn_audit_overlays(p_day date)
returns jsonb
language plpgsql security definer set search_path = public stable as $$
declare v jsonb := '[]'::jsonb; r record; total numeric := 0; n int := 0;
begin
  for r in
    select t.name, t.guaranteed_prize gtd, t.buy_in_amount bi,
           coalesce(t.current_players,0) cur,
           (t.guaranteed_prize - coalesce(t.current_players,0) * t.buy_in_amount) short
    from tournaments t
    where t.guaranteed_prize > 0 and t.buy_in_amount > 0
      and t.started_at >= p_day and t.started_at < p_day + 1
      and (t.guaranteed_prize - coalesce(t.current_players,0) * t.buy_in_amount) > 0
    order by 5 desc limit 10
  loop
    total := total + r.short; n := n + 1;
    v := v || jsonb_build_object(
      'severity', case when r.short >= 200 then 'critical' else 'warn' end,
      'category', 'logic', 'code', 'tournament_overlay',
      'title', r.name || ' started with a ' || round(r.short, 2) || ' overlay',
      'evidence', jsonb_build_object('guarantee', r.gtd, 'buy_in', r.bi,
                                     'entries', r.cur, 'shortfall', r.short),
      'recommendation', 'The overlay guard did not fill this event before it started. Check HorseOverlayGuard logs for that window: it may have been starved of eligible horses (events/both lane, under the four-table cap) or the event may have started sooner than the guard''s cycle.'
    );
  end loop;
  if n > 0 then
    v := v || jsonb_build_object(
      'severity', 'info', 'category', 'logic', 'code', 'overlay_total',
      'title', 'Club covered ' || round(total, 2) || ' in overlays across ' || n || ' event(s)',
      'evidence', jsonb_build_object('events', n, 'total_overlay', round(total, 2)),
      'recommendation', 'Total is the money the guarantee cost beyond what entries funded.'
    );
  end if;
  return v;
end $$;
revoke all on function public.fn_audit_overlays(date) from public;
grant execute on function public.fn_audit_overlays(date) to service_role;

create or replace function public.fn_audit_layer_silence_and_coverage(p_day date)
returns jsonb
language sql security definer set search_path = public stable as $$
  select fn_audit_layer_silence(p_day)
       || fn_audit_league_coverage(p_day)
       || fn_audit_league_pooled_findings(p_day)
       || fn_audit_analysis_watchdog(p_day)
       || fn_audit_overlays(p_day);
$$;
revoke all on function public.fn_audit_layer_silence_and_coverage(date) from public;
grant execute on function public.fn_audit_layer_silence_and_coverage(date) to service_role;
