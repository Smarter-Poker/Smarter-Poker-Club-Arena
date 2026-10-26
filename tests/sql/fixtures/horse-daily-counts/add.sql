CREATE OR REPLACE FUNCTION public.fn_horse_daily_nets_add(p_rows jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
end $function$
;
CREATE OR REPLACE FUNCTION public.fn_horse_daily_play_add(p_rows jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare r jsonb; n int := 0;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then return 0; end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    insert into horse_daily_play as t (
      horse_user_id, day, format, floored, hands, vpip, pfr, three_bets, three_bet_opps,
      open_raises, faced_3bets, fold_to_3bets, saw_flop, won_when_saw_flop,
      post_aggr, post_passive)
    values (
      (r->>'horse_user_id')::uuid,
      (r->>'day')::date,
      coalesce(r->>'format', 'cash'),
      coalesce((r->>'floored')::boolean, false),
      coalesce((r->>'hands')::int, 0),
      coalesce((r->>'vpip')::int, 0),
      coalesce((r->>'pfr')::int, 0),
      coalesce((r->>'three_bets')::int, 0),
      coalesce((r->>'three_bet_opps')::int, 0),
      coalesce((r->>'open_raises')::int, 0),
      coalesce((r->>'faced_3bets')::int, 0),
      coalesce((r->>'fold_to_3bets')::int, 0),
      coalesce((r->>'saw_flop')::int, 0),
      coalesce((r->>'won_when_saw_flop')::int, 0),
      coalesce((r->>'post_aggr')::int, 0),
      coalesce((r->>'post_passive')::int, 0)
    )
    on conflict (horse_user_id, day, format, floored) do update set
      hands = t.hands + excluded.hands,
      vpip = t.vpip + excluded.vpip,
      pfr = t.pfr + excluded.pfr,
      three_bets = t.three_bets + excluded.three_bets,
      three_bet_opps = t.three_bet_opps + excluded.three_bet_opps,
      open_raises = t.open_raises + excluded.open_raises,
      faced_3bets = t.faced_3bets + excluded.faced_3bets,
      fold_to_3bets = t.fold_to_3bets + excluded.fold_to_3bets,
      saw_flop = t.saw_flop + excluded.saw_flop,
      won_when_saw_flop = t.won_when_saw_flop + excluded.won_when_saw_flop,
      post_aggr = t.post_aggr + excluded.post_aggr,
      post_passive = t.post_passive + excluded.post_passive,
      updated_at = now();
    n := n + 1;
  end loop;
  return n;
end $function$
;
