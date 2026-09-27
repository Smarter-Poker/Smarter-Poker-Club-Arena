-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260724030839 "horse_hand_results_window_fn_rewrite"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 95c42ce8c09d31621cf9fbb798f81e82 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- V7 telemetry fix (2026-07-24): the invested_second CTE used correlated
-- subqueries (O(n^2) over per-hand contributors) which began timing out as
-- hand volume grew. Rewritten with row_number()/lead() window functions —
-- identical uncalled-bet cap semantics (unique top contributor capped to the
-- second-highest investment), O(n log n).
create or replace view horse_hand_results as
with hand_actions as (
  select h.id as hand_id, h.created_at, h.game_variant, h.big_blind,
         a.e->>'userId' as user_id, a.e->>'stage' as stage, a.e->>'action' as action,
         (a.e->>'amount')::numeric as amount, a.i as idx
  from hand_history h
  cross join lateral jsonb_array_elements(h.actions) with ordinality a(e,i)
  where h.tournament_id is null and h.created_at > now() - interval '24 hours'
), last_aggr as (
  select distinct on (hand_id, user_id, stage) hand_id, user_id, stage, amount as aggr_total, idx as aggr_idx
  from hand_actions where action in ('bet','raise','all_in')
  order by hand_id, user_id, stage, idx desc
), calls_after as (
  select c.hand_id, c.user_id, c.stage, sum(c.amount) as call_sum
  from hand_actions c
  left join last_aggr la on la.hand_id=c.hand_id and la.user_id=c.user_id and la.stage=c.stage
  where c.action='call' and c.idx > coalesce(la.aggr_idx, 0)
  group by c.hand_id, c.user_id, c.stage
), street_keys as (
  select distinct hand_id, user_id, stage from hand_actions
  where action in ('bet','raise','all_in','call')
), invested_raw as (
  select sk.hand_id, sk.user_id,
         sum(coalesce(la.aggr_total,0)+coalesce(ca.call_sum,0)) as invested
  from street_keys sk
  left join last_aggr la on la.hand_id=sk.hand_id and la.user_id=sk.user_id and la.stage=sk.stage
  left join calls_after ca on ca.hand_id=sk.hand_id and ca.user_id=sk.user_id and ca.stage=sk.stage
  group by sk.hand_id, sk.user_id
), invested_ranked as (
  select hand_id, user_id, invested,
         row_number() over (partition by hand_id order by invested desc, user_id) as rn,
         lead(invested) over (partition by hand_id order by invested desc, user_id) as next_inv
  from invested_raw
), invested as (
  select hand_id, user_id,
         case when rn=1 and next_inv is not null and next_inv < invested then next_inv else invested end as invested
  from invested_ranked
), won as (
  select h.id as hand_id, w.e->>'userId' as user_id, sum((w.e->>'amount')::numeric) as won
  from hand_history h cross join lateral jsonb_array_elements(h.winners) w(e)
  where h.tournament_id is null and h.created_at > now() - interval '24 hours'
  group by h.id, w.e->>'userId'
)
select i.hand_id, i.user_id, h.created_at, h.game_variant, h.big_blind,
       coalesce(w.won,0) - i.invested as net,
       (coalesce(w.won,0) - i.invested) / nullif(h.big_blind,0) as net_bb
from invested i
join hand_history h on h.id = i.hand_id
left join won w on w.hand_id = i.hand_id and w.user_id = i.user_id;
