-- ═══════════════════════════════════════════════════════════════════════════
-- THE DROP IDENTITY COSTS ONE SMALL TABLE (2026-09-06)
--
-- The first cut of fn_audit_fleet_drop_identity summed rake_amount and
-- bbj_amount over a whole day of hand_history to compare "drop taken" against
-- "drop attributed". It TIMED OUT on the first call - the same 700,000-row
-- day scan that made fn_run_horse_daily_audit unable to finish on 2026-09-04
-- and had to be rewritten out of capture_coverage_gap. Adding it back one
-- step later would have re-broken the nightly job.
--
-- It is also unnecessary. The fleet is a closed system, so
--
--     sum(net_bb) + sum(rake_bb) + sum(bbj_bb)  ==  0
--
-- and the RESIDUAL IS THE SHORTFALL. Any drop nobody attributed shows up in
-- it by construction; no second source is needed to detect one. What the
-- second source added was only a hint about WHICH half is missing, and the
-- free version of that hint is better anyway: a day with rake attributed and
-- bbj_bb still flat zero names the missing half exactly.
--
-- horse_daily_nets is a few thousand narrow rows per day. This runs in
-- milliseconds.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.fn_audit_fleet_drop_identity(p_day date)
returns jsonb
language plpgsql security definer set search_path = public as $function$
declare
  v jsonb := '[]'::jsonb;
  v_net numeric; v_rake numeric; v_bbj numeric; v_hands bigint;
  v_residual numeric; v_resid_bb100 numeric; v_raw_bb100 numeric;
begin
  select coalesce(sum(net_bb),0), coalesce(sum(rake_bb),0), coalesce(sum(bbj_bb),0), coalesce(sum(hands),0)
    into v_net, v_rake, v_bbj, v_hands
    from horse_daily_nets where day = p_day and format in ('cash','hu_cash');
  if v_hands < 10000 then
    -- Too little play for the identity to mean anything; say so rather than
    -- report a number nobody should act on.
    return v;
  end if;

  v_residual := v_net + v_rake + v_bbj;
  v_resid_bb100 := round(v_residual / v_hands * 100, 2);
  v_raw_bb100 := round(v_net / v_hands * 100, 2);

  -- THE FREE DIAGNOSIS. rake_bb landed on 2026-09-05 and bbj_bb on
  -- 2026-09-06; a day where one is flowing and the other is flat zero names
  -- the missing half without reading a second table.
  if v_rake <> 0 and v_bbj = 0 then
    v := v || jsonb_build_object('severity','warn','category','schema','code','drop_half_missing',
      'title','The rake is attributed and the jackpot drop is not - ' || v_resid_bb100 || ' bb/100 unexplained',
      'evidence', jsonb_build_object('day', p_day, 'hands', v_hands, 'rake_bb', round(v_rake,0),
                                     'bbj_bb', round(v_bbj,0), 'residual_bb100', v_resid_bb100),
      'recommendation','horse_daily_nets.bbj_bb is written by HorseHandReview.accumulateHorseNets from ServerTableEngineSettlement''s bbjAmount, allocated by allocateWeightedShareCents exactly as rake_bb is. A zero here means the engine is serving a build from before that shipped, or bbjAmount is not reaching logHandHistory. Until it flows, the regression rule is judging the jackpot drop as a leak.');
  end if;

  if abs(v_resid_bb100) > 5 then
    v := v || jsonb_build_object('severity','warn','category','logic','code','fleet_residual_unexplained',
      'title','The fleet is ' || v_resid_bb100 || ' bb/100 after the whole drop, and it plays itself',
      'evidence', jsonb_build_object('day', p_day, 'hands', v_hands, 'net_bb', round(v_net,0),
                                     'rake_bb', round(v_rake,0), 'bbj_bb', round(v_bbj,0),
                                     'raw_bb100', v_raw_bb100, 'residual_bb100', v_resid_bb100),
      'recommendation','A closed system nets to zero minus the drop, so a residual this size is a drop nobody attributed, chips leaving to human players (hand_history.has_human - there were 29 human hands in 143,795 on 2026-09-05), or a settlement path that does not balance. Find it before letting the regression rule judge anyone: it reads the whole residual as a leak.');
  else
    v := v || jsonb_build_object('severity','info','category','logic','code','fleet_drop_identity_holds',
      'title','The fleet nets to ' || v_resid_bb100 || ' bb/100 once the rake and the jackpot are counted',
      'evidence', jsonb_build_object('day', p_day, 'hands', v_hands, 'net_bb', round(v_net,0),
                                     'rake_bb', round(v_rake,0), 'bbj_bb', round(v_bbj,0),
                                     'raw_bb100', v_raw_bb100, 'residual_bb100', v_resid_bb100),
      'recommendation','This is the fleet''s true result, and the raw ' || v_raw_bb100 || ' bb/100 on the same day is the house take rather than a leak. Nothing may tune on the raw number.');
  end if;

  return v;
end $function$;

revoke all on function public.fn_audit_fleet_drop_identity(date) from public, authenticated, anon;
grant execute on function public.fn_audit_fleet_drop_identity(date) to service_role;
