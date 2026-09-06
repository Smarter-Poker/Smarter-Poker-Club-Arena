-- ═══════════════════════════════════════════════════════════════════════════
-- THE EV RANKING PAIRS EVERY MIRROR (2026-09-06)
--
-- fn_horse_tag_ev ranks every tagged SITUATION by what it is worth across
-- BOTH outcomes, which is the only honest ranking: a loss-only total ranks
-- situations by how often they occur in big pots.
--
-- Two defects in its first cut, both found by reading its own output against
-- the tag inventory rather than by re-reading the code:
--
-- 1. TWO NAMING SHAPES. Almost every situation is `X` (the loss) and `X_won`
--    (the mirror), but river aggression is `river_aggr_lost` / `river_aggr_won`
--    - it was the first tag ever mirrored (2026-09-01) and got a symmetric
--    name; the generalisation two days later did not. Stripping only `_won`
--    left `river_aggr` showing 48,891 hands at a 100% win rate, which is not
--    a measurement, it is one half of a ledger.
--
-- 2. MIRROR STATUS WAS INFERRED FROM THE DATA. `mirrored` was "a _won key
--    exists", so a situation whose mirror is real but RARE read as unmirrored
--    and dropped out of the ranking - and the rarest mirrors are the worst
--    situations. plo_naked_trips_stackoff won 4 of 480; plo_toppair_no_redraw
--    won 3 of 237. Those are the two biggest losers in the fleet and the
--    first cut would have hidden both.
--
--    Mirror status is a fact about the CODE, not about the week's cards.
--    HorseHandReview says it plainly: "THE FOLD FAMILY IS NOT MIRRORED, and
--    cannot be: big_bet_fold, big_fold_river, big_fold_early and
--    bet_fold_line all require hero to have FOLDED, and a folded hand never
--    wins." That list is the definition, so that list is what this uses.
--
-- FIRST RANKING, seven days to 2026-09-06:
--
--   plo_naked_trips_stackoff        -146.91 bb/hand   480 hands   0.8% won
--   plo_toppair_no_redraw_stackoff  -128.59 bb/hand   237 hands   1.3% won
--   coldcall_stackoff                -69.09 bb/hand  5,133 hands
--   top_pair_weak_kicker_stackoff    -67.37 bb/hand  1,220 hands
--   preflop_stackoff                 -66.04 bb/hand  1,146 hands
--   ...
--   river_raise_war                  +12.27 bb/hand  7,858 hands
--   river_aggr                       +12.66 bb/hand 75,811 hands  64.5% won
--
-- River aggression is PROFITABLE over seven days and 75,811 hands, which the
-- loss-only tag could never have established and which the one-day check on
-- 2026-09-05 had only suggested.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.fn_horse_tag_ev(p_since date)
returns table (
  situation text, mirrored boolean, hands bigint, won_hands bigint,
  net_bb numeric, bb_per_hand numeric, win_rate numeric
)
language sql stable security definer set search_path = public as $$
  with flat as (
    select k as tag,
           (r.leak_counts->>k)::bigint               as cnt,
           coalesce((r.leak_net_bb->>k)::numeric, 0) as net
      from horse_review_rollup r, lateral jsonb_object_keys(r.leak_counts) k
     where r.day >= p_since
  ),
  agg as (
    select tag, sum(cnt)::bigint as cnt, sum(net) as net from flat group by tag
  ),
  paired as (
    select
      case
        when a.tag like '%\_won'  then left(a.tag, length(a.tag) - 4)
        when a.tag like '%\_lost' then left(a.tag, length(a.tag) - 5)
        else a.tag
      end                        as situation,
      a.tag like '%\_won'        as is_won,
      a.cnt, a.net
    from agg a
  )
  select p.situation,
         -- The fold family cannot have a mirror. Everything else does,
         -- whether or not it won this week.
         p.situation not in ('big_bet_fold','big_fold_river','big_fold_early','bet_fold_line')
                                                              as mirrored,
         sum(p.cnt)::bigint                                    as hands,
         coalesce(sum(p.cnt) filter (where p.is_won), 0)::bigint as won_hands,
         round(sum(p.net), 1)                                  as net_bb,
         round(sum(p.net) / nullif(sum(p.cnt), 0), 2)          as bb_per_hand,
         round(coalesce(sum(p.cnt) filter (where p.is_won), 0)::numeric
               / nullif(sum(p.cnt), 0), 3)                     as win_rate
    from paired p
   group by p.situation
  having sum(p.cnt) >= 100
   order by 6 asc;
$$;

revoke all on function public.fn_horse_tag_ev(date) from public, authenticated, anon;
grant execute on function public.fn_horse_tag_ev(date) to service_role;

-- The audit step that was 86% of the audit, rewritten onto the rollup and
-- widened from ONE situation to every one that has a mirror.
create or replace function public.fn_audit_river_aggression_ev(p_day date)
returns jsonb
language plpgsql security definer set search_path = public as $function$
declare
  v jsonb := '[]'::jsonb;
  r record;
  v_ranked int := 0;
begin
  for r in
    select * from fn_horse_tag_ev(p_day - 6)
     where mirrored and hands >= 200
     order by bb_per_hand asc
  loop
    v_ranked := v_ranked + 1;
    if r.bb_per_hand < 0 then
      v := v || jsonb_build_object('severity', case when r.net_bb < -20000 then 'warn' else 'info' end,
        'category','gto','code','tag_ev_negative',
        'title', r.situation || ' is losing ' || r.bb_per_hand || 'bb per hand over ' || r.hands || ' hands',
        'evidence', jsonb_build_object('situation', r.situation, 'hands', r.hands,
                                       'won_hands', r.won_hands, 'net_bb', r.net_bb,
                                       'bb_per_hand', r.bb_per_hand, 'win_rate', r.win_rate),
        'recommendation','Both outcomes of this situation are counted, so this is EV and not a damage total. The tag is asymmetric - only the horse in the spot carries it, never its opponent - so this is that horse''s mistake rather than a chip moving between pockets. A cap is worth testing: flag it, add a league matchup, and do not claim an improvement without significance.');
    end if;
  end loop;

  if v_ranked = 0 then
    v := v || jsonb_build_object('severity','info','category','schema','code','tag_ev_unavailable',
      'title','No mirrored situation has 200 hands in the seven-day window',
      'evidence', jsonb_build_object('day', p_day),
      'recommendation','horse_review_rollup.leak_net_bb is written by fn_hhr_rollup_add on every review insert. If counts exist and nets do not, the rollup is running a build from before 2026-09-06.');
  else
    v := v || jsonb_build_object('severity','info','category','gto','code','tag_ev_ranked',
      'title', v_ranked || ' mirrored situations ranked by EV over seven days',
      'evidence', jsonb_build_object('situations', v_ranked, 'since', p_day - 6),
      'recommendation','Ranked by bb per hand across BOTH outcomes. The fold family has no winning mirror and is deliberately excluded - a folded hand never wins, so its total is the fold, not a leak.');
  end if;

  return v;
end $function$;

revoke all on function public.fn_audit_river_aggression_ev(date) from public, authenticated, anon;
grant execute on function public.fn_audit_river_aggression_ev(date) to service_role;
