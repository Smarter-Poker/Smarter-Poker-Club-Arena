-- Phase 9 natural evidence: the S2/S3 reconciliation, Horse verdict and
-- insurance queries, exactly as run read-only through the Supabase MCP
-- execute_sql (SELECT only) on 2026-10-03 between 03:30Z and 03:45Z.

-- Q1. Population S1 count by variant/feature/tournament/has_human.
select coalesce(bomb_pot->>'variant', game_variant) v,
  case when rit_boards is not null and jsonb_typeof(rit_boards)='array' and jsonb_array_length(rit_boards)>0 then 'rit_'||(1+jsonb_array_length(rit_boards)) else 'bomb_'||(case when community_cards3 is not null and cardinality(community_cards3)>0 then 3 else 2 end) end feat,
  (tournament_id is not null) tour, has_human, count(*), min(created_at), max(created_at)
from hand_history
where created_at >= '2026-09-03T00:00:00Z' and created_at < '2026-10-03T03:00:00Z'
  and ((rit_boards is not null and jsonb_typeof(rit_boards)='array' and jsonb_array_length(rit_boards)>0) or (community_cards2 is not null and cardinality(community_cards2)>0))
group by 1,2,3,4 order by 1,2,3,4;

-- Q2. Offer -> consent -> outcome -> completed hand reconciliation (all variants).
with ev as (
  select action_type t, user_id u, created_at at, details->>'table_id' tid, nullif(details->>'hand_number','')::int hn, details d
  from action_audit_logs
  where created_at >= '2026-10-03T00:00:00Z' and created_at < '2026-10-03T03:05:00Z' and action_type like 'engine\_rit\_%'
), off as (
  select * , lead(at) over (partition by tid order by at) next_at from ev where t='engine_rit_offer' and at < '2026-10-03T03:00:00Z'
), j as (
  select o.tid, o.hn, o.at, o.u chooser, (o.d->>'max_runs')::int max_runs, jsonb_array_length(o.d->'all_players') n_players,
    (select array_agg((e.d->>'chosen_runs')::int) from ev e where e.t='engine_rit_chooser_decided' and e.tid=o.tid and e.at>=o.at and (o.next_at is null or e.at<o.next_at) and e.at < o.at + interval '60 seconds') chosen,
    (select array_agg(e.u) from ev e where e.t='engine_rit_chooser_decided' and e.tid=o.tid and e.at>=o.at and (o.next_at is null or e.at<o.next_at) and e.at < o.at + interval '60 seconds') chooser_dec_user,
    (select count(*) from ev e where e.t='engine_rit_all_accepted' and e.tid=o.tid and e.hn=o.hn) n_all,
    (select count(*) from ev e where e.t='engine_rit_result' and e.tid=o.tid and e.hn=o.hn) n_result,
    (select count(*) from ev e where e.t='engine_rit_response_update' and e.tid=o.tid and e.hn=o.hn) n_resp,
    (select array_agg(e.u) from ev e where e.t='engine_rit_single_run' and e.tid=o.tid and e.hn=o.hn) single_users
  from off o
), h as (
  select j.*, hh.id hid, coalesce(hh.bomb_pot->>'variant', hh.game_variant) variant, hh.has_human,
    case when hh.rit_boards is not null and jsonb_typeof(hh.rit_boards)='array' then 1+jsonb_array_length(hh.rit_boards) else 1 end runs_recorded,
    (hh.community_cards2 is not null and cardinality(hh.community_cards2)>0) bomb
  from j left join hand_history hh on hh.table_id::text=j.tid and hh.hand_number=j.hn and hh.created_at >= '2026-10-02T23:50:00Z' and hh.created_at < '2026-10-03T03:30:00Z'
)
select coalesce(variant,'(no hand row)') variant, has_human,
  case when n_all>0 and single_users is null then 'agreed_'||coalesce(chosen[1]::text,'?')
       when single_users is not null and n_all=0 then case when single_users[1]=chooser then 'once_by_chooser' else 'declined_by_responder' end
       when single_users is null and n_all=0 then 'no_outcome_record' else 'conflicting' end outcome,
  runs_recorded, count(*) offers, count(hid) with_hand, sum(n_result) results, sum(case when cardinality(chosen)>1 then 1 else 0 end) multi_chooser_dec,
  sum(case when chooser_dec_user is not null and chooser_dec_user[1]<>chooser then 1 else 0 end) chooser_dec_other_user,
  max(max_runs) max_runs_max, min(max_runs) max_runs_min, sum(n_players) players, sum(n_resp) resp
from h group by 1,2,3,4 order by 1,2,3,4;

-- Q3. Horse verdicts: recorded chooser/responder answers on Omaha offer hands
-- vs the engine's stated deterministic horseRitVerdict (h = fold(h*31+code) mod
-- 100000 over the player id; once iff (h + hand*7) mod 10 < 3) and chooser run
-- rule (1 if once, else 3 when hand mod 3 = 0 else 2, clamped to max_runs).
with ev as (
  select action_type t, user_id u, created_at at, details->>'table_id' tid, nullif(details->>'hand_number','')::int hn, details d
  from action_audit_logs
  where created_at >= '2026-10-02T23:59:00Z' and created_at < '2026-10-03T03:05:00Z' and action_type like 'engine\_rit\_%'
), off as (
  select * from ev where t='engine_rit_offer' and at >= '2026-10-03T00:00:00Z' and at < '2026-10-03T03:00:00Z'
), hh as (
  select o.*, h.id hid, coalesce(h.bomb_pot->>'variant', h.game_variant) variant, h.has_human,
    case when h.rit_boards is not null and jsonb_typeof(h.rit_boards)='array' then 1+jsonb_array_length(h.rit_boards) else 1 end runs_recorded
  from off o join hand_history h on h.table_id::text=o.tid and h.hand_number=o.hn and h.created_at >= '2026-10-02T23:50:00Z' and h.created_at < '2026-10-03T03:30:00Z'
  where coalesce(h.bomb_pot->>'variant', h.game_variant) in ('plo4','plo5','plo6','plo8','flo8')
), pl as (
  select hh.tid, hh.hn, p.pid, p.ord,
    ((select sum(ascii(substr(p.pid, i, 1)) * mod(power(31::numeric, length(p.pid)-i), 100000)) from generate_series(1, length(p.pid)) i) % 100000 + hh.hn*7) % 10 < 3 as once,
    2500 + ((ascii(substr(p.pid,1,1)) + hh.hn) % 4) * 400 delay
  from hh cross join lateral jsonb_array_elements_text(hh.d->'all_players') with ordinality p(pid, ord)
), pred as (
  select hh.tid, hh.hn, hh.variant, hh.has_human, hh.runs_recorded, (hh.d->>'max_runs')::int max_runs, hh.u chooser,
    (select once from pl where pl.tid=hh.tid and pl.hn=hh.hn and pl.pid=hh.u::text) chooser_once,
    (select pid from pl where pl.tid=hh.tid and pl.hn=hh.hn and pl.pid<>hh.u::text and once order by delay, ord limit 1) first_decliner,
    (select array_agg(e.u::text) from ev e where e.t='engine_rit_single_run' and e.tid=hh.tid and e.hn=hh.hn) single_users,
    (select count(*) from ev e where e.t='engine_rit_all_accepted' and e.tid=hh.tid and e.hn=hh.hn) n_all,
    (select array_agg((e.d->>'chosen_runs')::int) from ev e where e.t='engine_rit_chooser_decided' and e.tid=hh.tid and e.u=hh.u and e.at between hh.at - interval '5 seconds' and hh.at + interval '45 seconds') chosen
  from hh
), cls as (
  select *,
    case when chooser_once then 'once_by_chooser' when first_decliner is not null then 'declined_by_responder' else 'agreed_'||least(case when hn%3=0 then 3 else 2 end, max_runs) end predicted,
    case when n_all>0 and single_users is null then 'agreed_'||coalesce(chosen[1]::text,'?')
         when single_users is not null and n_all=0 then case when single_users[1]=chooser::text then 'once_by_chooser' else 'declined_by_responder' end
         else 'unknown' end recorded
  from pred
)
select variant, has_human, predicted, recorded, count(*) n,
  count(*) filter (where recorded='declined_by_responder' and single_users[1]=first_decliner) decliner_identity_match,
  count(*) filter (where recorded like 'agreed_%' and runs_recorded::text = substr(recorded,8)) runs_match,
  count(*) filter (where recorded in ('once_by_chooser','declined_by_responder') and runs_recorded=1) single_match,
  count(*) filter (where cardinality(chosen)>1) multi_chosen
from cls group by 1,2,3,4 order by 1,2,3,4;

-- Q4. Offers with no hand_history row.
with off as (
  select created_at at, details->>'table_id' tid, (details->>'hand_number')::int hn from action_audit_logs
  where created_at >= '2026-10-03T00:00:00Z' and created_at < '2026-10-03T03:00:00Z' and action_type='engine_rit_offer'
)
select o.at, t.game_variant tv, t.status, t.tournament_id is not null tour, o.hn,
  (select count(*) from hand_history h where h.table_id::text=o.tid and h.hand_number=o.hn) any_row,
  (select string_agg(a.action_type, ',' order by a.created_at) from action_audit_logs a where a.created_at between o.at - interval '1 minute' and o.at + interval '2 minutes' and a.details->>'table_id'=o.tid and a.action_type like 'engine\_rit%') evs
from off o left join tables t on t.id::text=o.tid
where not exists (select 1 from hand_history h where h.table_id::text=o.tid and h.hand_number=o.hn and h.created_at >= '2026-10-02T23:50:00Z' and h.created_at < '2026-10-03T03:30:00Z');

-- Q5. Insurance: offer events and transactions by table variant (current
-- tables.game_variant), and by the variant of the hand row where it survives.
select 'offer_events' src, coalesce(t.game_variant,'(no table)') variant, e.event kind, count(*) n, min(e.created_at), max(e.created_at)
from insurance_offer_events e left join tables t on t.id=e.table_id
where e.created_at >= '2026-09-03T00:00:00Z' and e.created_at < '2026-10-03T03:00:00Z' group by 1,2,3
union all
select 'transactions', coalesce(t.game_variant,'(no table)'), coalesce(x.kind,'(null)'), count(*), min(x.created_at), max(x.created_at)
from insurance_transactions x left join tables t on t.id=x.table_id
where x.created_at >= '2026-09-03T00:00:00Z' and x.created_at < '2026-10-03T03:00:00Z' group by 1,2,3
union all
select 'audit_insurance_offers', coalesce(t.game_variant,'(no table)'), a.action_type, count(*), min(a.created_at), max(a.created_at)
from action_audit_logs a left join tables t on t.id::text=a.details->>'table_id'
where a.created_at >= '2026-09-03T00:00:00Z' and a.created_at < '2026-10-03T03:00:00Z' and a.action_type='engine_insurance_offers' group by 1,2,3
order by 1,2,3;

select coalesce(coalesce(h.bomb_pot->>'variant', h.game_variant), '(no hand row)') hand_variant, e.event, count(*) n, count(distinct (e.table_id::text||':'||e.hand_number)) hands,
  count(*) filter (where h.rit_boards is not null) on_rit_hands, sum(e.premium) premium_sum, min(e.created_at)::date, max(e.created_at)::date
from insurance_offer_events e
left join lateral (select * from hand_history h where h.table_id=e.table_id and h.hand_number=e.hand_number and h.created_at between e.created_at - interval '15 minutes' and e.created_at + interval '15 minutes' limit 1) h on true
where e.created_at >= '2026-09-03T00:00:00Z' and e.created_at < '2026-10-03T03:00:00Z'
group by 1,2
union all
select '(all-time transactions)', coalesce(kind,'(null)'), count(*), null, null, sum(premium), min(created_at)::date, max(created_at)::date from insurance_transactions group by 2
order by 1,2;
