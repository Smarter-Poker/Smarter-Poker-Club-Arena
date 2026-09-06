-- ═══════════════════════════════════════════════════════════════════════════
-- THE DROP IS THE RAKE AND THE JACKPOT (2026-09-06)
--
-- The third instance of one defect: an incomplete drop accounting judged
-- against a band that assumes no drop.
--
-- Measured on 2026-09-06, the first day the rake attribution ran for a whole
-- day, over 11,687 cash hands and 31,186 horse seat-hands:
--
--   horse net                     -10,797 bb
--   attributed rake                 +9,020 bb   (99.1% of the 9,103 bb taken)
--   ─────────────────────────────────────────
--   residual after rake             -1,778 bb
--   bad-beat-jackpot drop at table  +1,761 bb   <- a 1.0% match
--   ─────────────────────────────────────────
--   TRUE SKILL RESULT                    ~0 bb
--
-- The fleet plays itself, so its aggregate result MUST be zero minus the
-- drop. It is. Every chip the fleet loses is the house taking one, and the
-- fleet's real bb/100 is 0.0, not -34.5.
--
-- HorseHandReview already carried the note "the fleet's -32 bb/100 was the
-- day's rake PLUS BBJ DROP to within one percent" - and then implemented
-- only the rake half. This finishes it, with the same weighted-contributed
-- allocator (allocateWeightedShareCents), so bbj_bb agrees with the money
-- pipeline the way rake_bb already does.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.horse_daily_nets
  add column if not exists bbj_bb numeric not null default 0;

comment on column public.horse_daily_nets.bbj_bb is
  'Bad-beat-jackpot drop this horse contributed, in bb, allocated by weighted contribution exactly as rake_bb is. net_bb + rake_bb + bbj_bb is the horse result BEFORE the house took anything - the only number a winning-player band may judge.';

create or replace function public.fn_horse_daily_nets_add(p_rows jsonb)
returns int
language plpgsql security definer set search_path = public as $$
declare r jsonb; n int := 0;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then return 0; end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    insert into horse_daily_nets as t (horse_user_id, day, game_variant, format, hands, net_bb, rake_bb, bbj_bb)
    values (
      (r->>'horse_user_id')::uuid,
      (r->>'day')::date,
      coalesce(r->>'game_variant', 'nlh'),
      coalesce(r->>'format', 'cash'),
      coalesce((r->>'hands')::int, 0),
      coalesce((r->>'net_bb')::numeric, 0),
      coalesce((r->>'rake_bb')::numeric, 0),
      coalesce((r->>'bbj_bb')::numeric, 0)
    )
    on conflict (horse_user_id, day, game_variant, format) do update set
      hands = t.hands + excluded.hands,
      net_bb = t.net_bb + excluded.net_bb,
      rake_bb = t.rake_bb + excluded.rake_bb,
      bbj_bb = t.bbj_bb + excluded.bbj_bb,
      updated_at = now();
    n := n + 1;
  end loop;
  return n;
end $$;

revoke all on function public.fn_horse_daily_nets_add(jsonb) from public, authenticated, anon;
grant execute on function public.fn_horse_daily_nets_add(jsonb) to service_role;

-- The closed-system identity as an audit. NOTE: the first cut of this
-- function summed a whole day of hand_history to compare drop taken against
-- drop attributed, and TIMED OUT - see 20260906022655, which replaces the
-- body with a version that reads horse_daily_nets alone. The definition below
-- is kept as it was applied so this file reproduces the real history.
create or replace function public.fn_audit_fleet_drop_identity(p_day date)
returns jsonb
language plpgsql security definer set search_path = public as $function$
declare
  v jsonb := '[]'::jsonb;
  v_net numeric; v_rake numeric; v_bbj numeric; v_hands bigint;
  v_table_rake numeric; v_table_bbj numeric;
  v_residual numeric; v_resid_bb100 numeric; v_share numeric;
begin
  select coalesce(sum(net_bb),0), coalesce(sum(rake_bb),0), coalesce(sum(bbj_bb),0), coalesce(sum(hands),0)
    into v_net, v_rake, v_bbj, v_hands
    from horse_daily_nets where day = p_day and format in ('cash','hu_cash');
  if v_hands = 0 then
    return v;
  end if;

  select coalesce(sum(rake_amount / nullif(big_blind,0)),0),
         coalesce(sum(coalesce(bbj_amount,0) / nullif(big_blind,0)),0)
    into v_table_rake, v_table_bbj
    from hand_history
   where created_at >= p_day::timestamptz and created_at < (p_day + 1)::timestamptz
     and tournament_id is null;

  v_residual := v_net + v_rake + v_bbj;
  v_resid_bb100 := round(v_residual / v_hands * 100, 2);
  v_share := case when (v_table_rake + v_table_bbj) > 0
                  then round((v_rake + v_bbj) / (v_table_rake + v_table_bbj), 3) else null end;

  if v_share is not null and v_share < 0.90 then
    v := v || jsonb_build_object('severity','critical','category','schema','code','drop_attribution_short',
      'title', (v_share * 100)::int || '% of the drop taken from the fleet''s pots reached a horse row',
      'evidence', jsonb_build_object('day', p_day, 'attributed_rake_bb', round(v_rake,0), 'attributed_bbj_bb', round(v_bbj,0),
                                     'table_rake_bb', round(v_table_rake,0), 'table_bbj_bb', round(v_table_bbj,0), 'share', v_share),
      'recommendation','Every bb of drop the tuner cannot see reads as a horse leak. Check HorseHandReview.accumulateHorseNets (allocateWeightedShareCents over contributions) and that settlement passes both rakeAmount and bbjAmount. This is the defect that regressed 221 of 383 horses on 2026-09-04.');
  end if;

  if abs(v_resid_bb100) > 5 then
    v := v || jsonb_build_object('severity','warn','category','logic','code','fleet_residual_unexplained',
      'title','The fleet is ' || v_resid_bb100 || ' bb/100 after rake and the jackpot, and it plays itself',
      'evidence', jsonb_build_object('day', p_day, 'hands', v_hands, 'net_bb', round(v_net,0),
                                     'rake_bb', round(v_rake,0), 'bbj_bb', round(v_bbj,0),
                                     'residual_bb', round(v_residual,0), 'residual_bb100', v_resid_bb100),
      'recommendation','A closed system nets to zero minus the drop. A residual this size is either a drop nobody attributed, chips leaving to human players (check hand_history.has_human), or a settlement path that does not balance. Find it before letting the regression rule judge anyone: it will read the whole residual as a leak.');
  else
    v := v || jsonb_build_object('severity','info','category','logic','code','fleet_drop_identity_holds',
      'title','The fleet nets to ' || v_resid_bb100 || ' bb/100 once the rake and the jackpot are counted',
      'evidence', jsonb_build_object('day', p_day, 'hands', v_hands, 'net_bb', round(v_net,0),
                                     'rake_bb', round(v_rake,0), 'bbj_bb', round(v_bbj,0),
                                     'raw_bb100', round(v_net / v_hands * 100, 2), 'residual_bb100', v_resid_bb100),
      'recommendation','This is the fleet''s true result. The raw bb/100 on the same day is the house take, not a leak - do not tune on it.');
  end if;

  return v;
end $function$;

revoke all on function public.fn_audit_fleet_drop_identity(date) from public, authenticated, anon;
grant execute on function public.fn_audit_fleet_drop_identity(date) to service_role;
