-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260724021639 "horse_style_performance_view_fast"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 345b39fd0d61c978d15347cda21ec2c7 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- V7 (2026-07-24) rev 2: linear-plan rewrite (hash joins, no correlated
-- subqueries) over a 24h window so the view answers in interactive time.

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
    and h.created_at > now() - interval '24 hours'
),
last_aggr as (
  select distinct on (hand_id, user_id, stage)
         hand_id, user_id, stage, amount as aggr_total, idx as aggr_idx
  from hand_actions
  where action in ('bet','raise','all_in')
  order by hand_id, user_id, stage, idx desc
),
calls_after as (
  select c.hand_id, c.user_id, c.stage, sum(c.amount) as call_sum
  from hand_actions c
  left join last_aggr la
    on la.hand_id = c.hand_id and la.user_id = c.user_id and la.stage = c.stage
  where c.action = 'call' and c.idx > coalesce(la.aggr_idx, 0)
  group by c.hand_id, c.user_id, c.stage
),
street_keys as (
  select distinct hand_id, user_id, stage from hand_actions
  where action in ('bet','raise','all_in','call')
),
invested as (
  select sk.hand_id, sk.user_id,
         sum(coalesce(la.aggr_total, 0) + coalesce(ca.call_sum, 0)) as invested
  from street_keys sk
  left join last_aggr la on la.hand_id = sk.hand_id and la.user_id = sk.user_id and la.stage = sk.stage
  left join calls_after ca on ca.hand_id = sk.hand_id and ca.user_id = sk.user_id and ca.stage = sk.stage
  group by sk.hand_id, sk.user_id
),
won as (
  select h.id as hand_id, w.e ->> 'userId' as user_id, sum((w.e ->> 'amount')::numeric) as won
  from hand_history h
  cross join lateral jsonb_array_elements(h.winners) w(e)
  where h.tournament_id is null and h.created_at > now() - interval '24 hours'
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
