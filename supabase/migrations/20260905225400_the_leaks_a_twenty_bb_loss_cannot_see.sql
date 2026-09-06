-- ═══════════════════════════════════════════════════════════════════════════
-- THE LEAKS A TWENTY-BB LOSS CANNOT SEE (2026-09-05, V49)
--
-- All 24 hand tags require |net| >= 20bb and most require a showdown loss.
-- Invisible to every one of them: over-folding to 3-bets, never 3-betting,
-- limping, passive postflop play, surrendering flops - every frequency error
-- that did not end in a stack-off, and every small pot lost quietly. Those
-- are most of what separates a winning regular from a losing one.
--
-- No hand needs to be read to find them. horse_daily_play (2026-09-05) holds
-- VPIP, PFR, 3-bet, fold-to-3-bet, saw-flop, WWSF and postflop aggression per
-- horse per day, compiled at settlement by the self-tuner's own accumulator.
-- A frequency leak is a rate outside a published winning band over a real
-- sample, and that is a query.
--
--   fn_horse_frequency_leaks(p_since)  per horse: the rates and the leaks
--   fn_audit_frequency_leaks(p_day)    the audit's view: a leak shared by a
--                                      THIRD of the studied fleet is a brain
--                                      defect, not a personality; one horse
--                                      with it is a personality
--   ca_horse_frequency_card(p_days)    the panel, admin-gated
--
-- The bands are the same ones HorseSelfTuner.BENCH tunes the dials against
-- (vpip .19-.32, pfr/vpip .55+, fold-to-3bet .35-.62, wwsf .40-.52, AF
-- 1.2-3.5), so the audit and the tuner cannot disagree about what a leak is.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.fn_horse_frequency_leaks(p_since date)
returns table (
  horse_user_id uuid,
  hands bigint,
  vpip numeric,
  pfr_of_vpip numeric,
  three_bet numeric,
  fold_to_3bet numeric,
  wwsf numeric,
  af numeric,
  leaks text[]
)
language sql stable security definer set search_path = public as $$
  with agg as (
    select p.horse_user_id,
           sum(p.hands)::bigint              as hands,
           sum(p.vpip)::bigint               as vpip,
           sum(p.pfr)::bigint                as pfr,
           sum(p.three_bets)::bigint         as three_bets,
           sum(p.three_bet_opps)::bigint     as three_bet_opps,
           sum(p.faced_3bets)::bigint        as faced_3bets,
           sum(p.fold_to_3bets)::bigint      as fold_to_3bets,
           sum(p.saw_flop)::bigint           as saw_flop,
           sum(p.won_when_saw_flop)::bigint  as won_when_saw_flop,
           sum(p.post_aggr)::bigint          as post_aggr,
           sum(p.post_passive)::bigint       as post_passive
      from horse_daily_play p
     where p.day >= p_since and p.format in ('cash', 'hu_cash')
     group by 1
    having sum(p.hands) >= 1000
  ),
  rates as (
    select a.horse_user_id,
           a.hands,
           round(a.vpip::numeric / a.hands, 4) as vpip,
           case when a.vpip > 0 then round(a.pfr::numeric / a.vpip, 4) end as pfr_of_vpip,
           case when a.three_bet_opps >= 100 then round(a.three_bets::numeric / a.three_bet_opps, 4) end as three_bet,
           case when a.faced_3bets >= 30 then round(a.fold_to_3bets::numeric / a.faced_3bets, 4) end as fold_to_3bet,
           case when a.saw_flop >= 150 then round(a.won_when_saw_flop::numeric / a.saw_flop, 4) end as wwsf,
           case when a.post_aggr + a.post_passive >= 100 and a.post_passive >= 25
                then round(a.post_aggr::numeric / a.post_passive, 4) end as af
      from agg a
  )
  select r.horse_user_id, r.hands, r.vpip, r.pfr_of_vpip, r.three_bet, r.fold_to_3bet, r.wwsf, r.af,
         array_remove(array[
           case when r.vpip > 0.32 then 'freq_too_loose' end,
           case when r.vpip < 0.19 then 'freq_too_tight' end,
           case when r.pfr_of_vpip is not null and r.pfr_of_vpip < 0.55 then 'freq_limp' end,
           case when r.three_bet is not null and r.three_bet < 0.03 then 'freq_no_3bet' end,
           case when r.fold_to_3bet is not null and r.fold_to_3bet > 0.62 then 'freq_over_fold_3bet' end,
           case when r.fold_to_3bet is not null and r.fold_to_3bet < 0.35 then 'freq_sticky_vs_3bet' end,
           case when r.wwsf is not null and r.wwsf < 0.40 then 'freq_surrender_flops' end,
           case when r.af is not null and r.af < 1.2 then 'freq_passive_postflop' end,
           case when r.af is not null and r.af > 3.5 then 'freq_spewy_postflop' end
         ], null) as leaks
    from rates r;
$$;

revoke all on function public.fn_horse_frequency_leaks(date) from public, authenticated, anon;
grant execute on function public.fn_horse_frequency_leaks(date) to service_role;

create or replace function public.fn_audit_frequency_leaks(p_day date)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v jsonb := '[]'::jsonb;
  r record;
  v_studied int;
  v_play_days int;
begin
  select count(distinct day) into v_play_days
    from horse_daily_play where day > p_day - 7 and day <= p_day;
  if v_play_days = 0 then
    return v;  -- the compiler has not run here yet; fn_audit_tuner_health says so
  end if;
  select count(*) into v_studied from fn_horse_frequency_leaks(p_day - 7);
  if v_studied = 0 then
    v := v || jsonb_build_object('severity','info','category','logic','code','frequency_sample_thin',
      'title','No horse has 1,000 cash hands in the frequency window yet',
      'evidence', jsonb_build_object('play_days', v_play_days),
      'recommendation','horse_daily_play is young. The frequency detectors report from the day a horse crosses 1,000 hands in seven days.');
    return v;
  end if;
  for r in
    select leak, count(*) as horses
      from fn_horse_frequency_leaks(p_day - 7), lateral unnest(leaks) leak
     group by leak
     order by 2 desc
  loop
    if r.horses::numeric / v_studied >= 0.33 then
      -- A THIRD OF THE FLEET SHARING ONE FREQUENCY IS NOT A PERSONALITY.
      -- The horses are seeded from five styles and tuned individually; a
      -- leak this common is a bar in the brain, not a set of dials.
      v := v || jsonb_build_object('severity','critical','category','gto','code','frequency_leak_fleetwide',
        'title', r.leak || ': ' || r.horses || ' of ' || v_studied || ' studied horses',
        'evidence', jsonb_build_object('leak', r.leak, 'horses', r.horses, 'studied', v_studied,
                                       'share', round(r.horses::numeric / v_studied, 3)),
        'recommendation','A third of the fleet shares this frequency, so it is a threshold in the brain rather than a personality. Find the bar: VPIP and PFR are HorsePreflop open/defend bars, fold-to-3-bet is the facing-raise bar, WWSF and AF are the postflop bluff and value gates. Do not tune dials against it - the dials are already trying and losing.');
    else
      v := v || jsonb_build_object('severity','info','category','gto','code','frequency_leak',
        'title', r.leak || ': ' || r.horses || ' of ' || v_studied || ' studied horses',
        'evidence', jsonb_build_object('leak', r.leak, 'horses', r.horses, 'studied', v_studied,
                                       'share', round(r.horses::numeric / v_studied, 3)),
        'recommendation','Individual horses outside a winning band. The self-tuner moves these dials nightly on the same bands; this line is how to see whether it is working.');
    end if;
  end loop;
  return v;
end $$;

revoke all on function public.fn_audit_frequency_leaks(date) from public, authenticated, anon;
grant execute on function public.fn_audit_frequency_leaks(date) to service_role;

create or replace function public.ca_horse_frequency_card(p_days integer default 7)
returns table (
  horse_user_id uuid, alias text, hands bigint, vpip numeric, pfr_of_vpip numeric,
  three_bet numeric, fold_to_3bet numeric, wwsf numeric, af numeric, leaks text[]
)
language plpgsql stable security definer set search_path = public as $$
begin
  if not fn_is_horse_admin() then
    raise exception 'admin only';
  end if;
  return query
    select f.horse_user_id,
           (select coalesce(p.alias, p.display_name, p.username) from profiles p where p.id = f.horse_user_id),
           f.hands, f.vpip, f.pfr_of_vpip, f.three_bet, f.fold_to_3bet, f.wwsf, f.af, f.leaks
      from fn_horse_frequency_leaks(
             (now() at time zone 'utc')::date - least(greatest(coalesce(p_days, 7), 1), 90)
           ) f
     where cardinality(f.leaks) > 0
     order by cardinality(f.leaks) desc, f.hands desc;
end $$;

revoke all on function public.ca_horse_frequency_card(integer) from public, anon;
grant execute on function public.ca_horse_frequency_card(integer) to authenticated, service_role;

insert into public.ca_browser_definer_allowlist (proname, reason)
values ('ca_horse_frequency_card', 'Horse frequency-leak card, read from the horse pages. Gates itself on fn_is_horse_admin() like the other ca_horse_* console functions.')
on conflict (proname) do nothing;

-- Wire into the nightly audit, patched in place from the live definition.
do $patch$
declare d text;
begin
  select pg_get_functiondef('public.fn_run_horse_daily_audit(date)'::regprocedure) into d;
  if position('fn_audit_frequency_leaks(p_day)' in d) > 0 then
    return;
  end if;
  d := replace(d,
    'v_findings := v_findings || fn_audit_seat_clock(p_day);',
    'v_findings := v_findings || fn_audit_seat_clock(p_day);' || chr(10) ||
    '  -- 2026-09-05 V49: the leaks a 20bb loss cannot see.' || chr(10) ||
    '  v_findings := v_findings || fn_audit_frequency_leaks(p_day);');
  execute d;
end $patch$;
