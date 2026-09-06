-- ═══════════════════════════════════════════════════════════════════════════
-- THE FLOOR IS NOT A LEAK (2026-09-06)
--
-- A floored table stands a seat up after ten hands under its
-- maintain_percent_min, horses included (CLAUDE.md 10.5), so the brain widens
-- toward it (HorseLogic.vpipFloorMul) and a horse there is REQUIRED to play
-- 40-70% of hands. Of the 72 cash tables the fleet played on 2026-09-05, 15
-- were floored at a mean floor of 49.3%.
--
-- Both readers of horse_daily_play judge VPIP against the 19-32% winning
-- player band, and `tightness` is a GLOBAL dial. So a horse obeying a 60%
-- floor was measured "too loose", tightened everywhere, and then re-widened
-- by the floor at that same table - while its play at ORDINARY tables got
-- nittier every night. The loop is in the tuner's own log:
--
--   2026-09-03  104 of 429 tightened for "too loose", fleet VPIP .277
--   2026-09-04  180 of 386                             fleet VPIP .312
--   2026-09-05  216 of 383  (56%)                      fleet VPIP .338
--
-- Same shape as the rake bug: a blended number judged against an unblended
-- band. The fix is the same too - give the measurement the context it was
-- missing rather than move the band.
--
-- `floored` joins the primary key so both kinds of play are recorded and the
-- panel can show either; only the BANDS filter it out.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.horse_daily_play
  add column if not exists floored boolean not null default false;

comment on column public.horse_daily_play.floored is
  'The table carried a VPIP floor (nit_game + maintain_percent_min), so the horse was required to play above it and these frequencies are NOT comparable with the winning-player bands. The self-tuner and fn_horse_frequency_leaks read floored = false only.';

-- The key gains `floored`. Rebuild it rather than adding a second unique
-- index: a row written before today has floored = false, which is what the
-- old key meant in every case the tuner read.
alter table public.horse_daily_play
  drop constraint if exists horse_daily_play_pkey;
alter table public.horse_daily_play
  add constraint horse_daily_play_pkey primary key (horse_user_id, day, format, floored);

create or replace function public.fn_horse_daily_play_add(p_rows jsonb)
returns int
language plpgsql security definer set search_path = public as $$
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
end $$;

revoke all on function public.fn_horse_daily_play_add(jsonb) from public, authenticated, anon;
grant execute on function public.fn_horse_daily_play_add(jsonb) to service_role;

-- The frequency detector reads unfloored play only, for the same reason.
create or replace function public.fn_horse_frequency_leaks(p_since date)
returns table (
  horse_user_id uuid, hands bigint, vpip numeric, pfr_of_vpip numeric,
  three_bet numeric, fold_to_3bet numeric, wwsf numeric, af numeric, leaks text[]
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
       and p.floored = false
     group by 1
    having sum(p.hands) >= 1000
  ),
  rates as (
    select a.horse_user_id, a.hands,
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
