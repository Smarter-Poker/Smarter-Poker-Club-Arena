-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260724021820 "horse_hand_results_uncalled_cap"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 070b8b3595d5323f64259dae26f39988 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- V7 rev 3: mirror the engine's uncalled-bet refund. The action stream
-- records the full final bet, but the engine returns the uncalled excess to
-- the bettor before forming pots — so the unique top contributor's invested
-- is capped at the second-highest contribution, exactly like
-- HandController.returnUncalledBet().

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
invested_raw as (
  select sk.hand_id, sk.user_id,
         sum(coalesce(la.aggr_total, 0) + coalesce(ca.call_sum, 0)) as invested
  from street_keys sk
  left join last_aggr la on la.hand_id = sk.hand_id and la.user_id = sk.user_id and la.stage = sk.stage
  left join calls_after ca on ca.hand_id = sk.hand_id and ca.user_id = sk.user_id and ca.stage = sk.stage
  group by sk.hand_id, sk.user_id
),
invested_ranked as (
  select hand_id, user_id, invested,
         max(invested) over (partition by hand_id) as max_inv,
         count(*) over (partition by hand_id) as contributors
  from invested_raw
),
invested_second as (
  select ir.*,
         (select max(x.invested) from invested_raw x
          where x.hand_id = ir.hand_id and x.invested < ir.max_inv) as second_inv,
         (select count(*) from invested_raw y
          where y.hand_id = ir.hand_id and y.invested = ir.max_inv) as max_ties
  from invested_ranked ir
),
invested as (
  select hand_id, user_id,
    case
      when invested = max_inv and max_ties = 1 and second_inv is not null
      then second_inv
      else invested
    end as invested
  from invested_second
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
