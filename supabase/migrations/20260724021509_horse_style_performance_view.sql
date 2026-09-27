-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260724021509 "horse_style_performance_view"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 ca61c955596792a4844f2a9d599ead15 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- V7 (2026-07-24): Horse performance telemetry.
-- Per-player per-hand net results reconstructed from the recorded action
-- stream (aggressive amounts are street totals; call amounts are increments;
-- a player's street contribution = total at their last aggressive action plus
-- call increments after it). Blinds are not in the action stream, so absolute
-- bb/100 carries a small systematic offset; RELATIVE comparisons across
-- styles/variants (the purpose of this view) are unaffected.

create or replace view horse_hand_results as
with hand_actions as (
  select h.id as hand_id, h.created_at, h.game_variant, h.big_blind,
         a.e ->> 'userId' as user_id,
         a.e ->> 'stage' as stage,
         a.e ->> 'action' as action,
         (a.e ->> 'amount')::numeric as amount,
         a.i as idx
  from hand_history h
  cross join lateral jsonb_array_elements(h.actions) with ordinality a(e, i)
  where h.tournament_id is null
    and h.created_at > now() - interval '7 days'
),
street_contrib as (
  select hand_id, user_id, stage,
    coalesce((
      select ha2.amount from hand_actions ha2
      where ha2.hand_id = ha.hand_id and ha2.user_id = ha.user_id and ha2.stage = ha.stage
        and ha2.action in ('bet','raise','all_in')
      order by ha2.idx desc limit 1
    ), 0)
    + coalesce((
      select sum(ha3.amount) from hand_actions ha3
      where ha3.hand_id = ha.hand_id and ha3.user_id = ha.user_id and ha3.stage = ha.stage
        and ha3.action = 'call'
        and ha3.idx > coalesce((
          select max(ha4.idx) from hand_actions ha4
          where ha4.hand_id = ha.hand_id and ha4.user_id = ha.user_id and ha4.stage = ha.stage
            and ha4.action in ('bet','raise','all_in')
        ), 0)
    ), 0) as contributed
  from hand_actions ha
  group by hand_id, user_id, stage
),
invested as (
  select hand_id, user_id, sum(contributed) as invested
  from street_contrib group by hand_id, user_id
),
won as (
  select h.id as hand_id, w.e ->> 'userId' as user_id, sum((w.e ->> 'amount')::numeric) as won
  from hand_history h
  cross join lateral jsonb_array_elements(h.winners) w(e)
  where h.tournament_id is null and h.created_at > now() - interval '7 days'
  group by h.id, w.e ->> 'userId'
)
select i.hand_id, i.user_id, h.created_at, h.game_variant, h.big_blind,
       coalesce(w.won, 0) - i.invested as net,
       (coalesce(w.won, 0) - i.invested) / nullif(h.big_blind, 0) as net_bb
from invested i
join hand_history h on h.id = i.hand_id
left join won w on w.hand_id = i.hand_id and w.user_id = i.user_id;

create or replace view horse_style_performance as
select p.horse_profile ->> 'style' as style,
       r.game_variant,
       count(*) as hands,
       round(sum(r.net)::numeric, 2) as net_chips,
       round((sum(r.net_bb) / nullif(count(*), 0) * 100)::numeric, 2) as bb_per_100
from horse_hand_results r
join profiles p on p.id = r.user_id::uuid and p.is_horse = true
group by 1, 2;
