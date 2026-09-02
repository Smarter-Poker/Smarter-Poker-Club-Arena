-- ═══════════════════════════════════════════════════════════════════════════
--  THE NEWEST CLAMP DECLARATION IS THE LIVE ONE
-- ═══════════════════════════════════════════════════════════════════════════
-- Main went red at 2026-09-02 00:45 UTC and every hourly engine deploy since
-- has been refused by its own test gate. #2580's migration BACKFILL added
-- historical files for the 2026-08-30 lateral-optimization incident - and by
-- filename order the incident's REVERT file (batch floor 200, the measured
-- timeout cliff) became the newest migration declaring the aggregator's
-- clamp. GtoAggregationFloor.test.ts exists precisely to refuse a newest
-- declaration above what the driver sends (100), so it failed, correctly,
-- on a repo state whose live truth was never wrong: production's floor is
-- 25 (measured live before this migration; prosrc md5
-- 6e79bb95e39f0e2544eb2a6fbe5e1569).
--
-- This file re-declares the function with the VERBATIM live definition
-- (pg_get_functiondef, no edits) so the newest declaration in the repo says
-- what production says. Applying it is a no-op by construction - proven
-- before apply by executing this exact body in a rolled-back transaction
-- and comparing prosrc md5 against the baseline above.
--
-- #2580's PR merged without running the server tests because its diff was
-- migrations-only and ci.yml's path filter treated that as "server not
-- touched". The companion change to ci.yml in this PR closes that: a
-- migration file can fail a server-side law, so migrations now count as
-- touching the server.

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_aggregate_gto_street_next(p_street text, p_batch integer DEFAULT 1500)
 RETURNS TABLE(processed integer, new_last_id uuid, street_done boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '30s'
AS $function$
declare
  v_cur record;
  v_batch integer := greatest(25, least(5000, coalesce(p_batch, 1500)));
  v_max_id uuid;
  v_processed integer := 0;
begin
  if p_street not in ('turn', 'river') then
    raise exception 'fn_aggregate_gto_street_next handles turn/river only (got %)', p_street;
  end if;

  select * into v_cur from public.gto_agg_progress where street = p_street for update;
  if not found then
    raise exception 'no gto_agg_progress row for %', p_street;
  end if;
  if v_cur.done then
    return query select 0, v_cur.last_id, true;
    return;
  end if;

  create temp table if not exists tmp_agg30 (like public.gto_postflop_compact including all) on commit drop;
  -- TRUNCATE, not DELETE: PostgREST roles run with the safe-update guard,
  -- which refuses an unqualified DELETE (error 21000).
  truncate table tmp_agg30;

  with batch as (
    select s.id, s.game_type, s.stack_depth, s.scenario_hash, s.strategy_matrix
    from public.solved_spots_gold s
    where s.street = p_street
      and (v_cur.last_id is null or s.id > v_cur.last_id)
    order by s.id
    limit v_batch
  ),
  marked as (
    select (select b2.id from batch b2 order by b2.id desc limit 1) as max_id,
           (select count(*) from batch) as n
  ),
  src as (
    select
      b.id,
      case
        when b.game_type like '%cash%' then 'cash'
        when b.game_type like '%icm%' then 'tourney_icm'
        when b.game_type like 'spin%' then 'spin'
        else 'tourney_ev' end as fam,
      substring(b.scenario_hash from '_(UTG|MP|CO|BTN|SB|BB)_') as pos,
      case
        when b.stack_depth <= 12 then 10
        when b.stack_depth <= 30 then 20
        when b.stack_depth <= 60 then 40
        when b.stack_depth <= 110 then 80
        else 150 end as depth_bucket,
      public.fn_gto_texture_class_any(substring(b.scenario_hash from 'bb_(.*)$')) as tex,
      b.strategy_matrix->'frequencies' as freqs,
      b.strategy_matrix->'tree_lines' as tree_lines
    from batch b
    where b.strategy_matrix ? 'frequencies'
      and b.strategy_matrix ? 'tree_lines'
  ),
  roots as (
    select s.id, replace(l.line, 'r:0:', '') as act
    from src s, jsonb_array_elements_text(s.tree_lines) l(line)
    where l.line ~ '^r:0:[^:]+$'
    group by 1, 2
  ),
  rootbets as (
    select id,
           count(*) as nb,
           max((nullif(substr(act, 2), ''))::numeric) as mx
    from roots where act like 'b%' and substr(act, 2) ~ '^[0-9]+$'
    group by id
  ),
  handvals as (
    select s.id, s.fam, s.pos, s.depth_bucket, s.tex, r.act,
           h.key as hand, (h.value)::numeric as v
    from src s
    join roots r on r.id = s.id
    cross join lateral jsonb_each_text(s.freqs -> r.act) h
    where s.pos is not null and s.tex is not null
      and h.value ~ '^-?[0-9.eE+]+$'
  ),
  validated as (
    select id, hand, sum(v) as tot
    from handvals
    group by 1, 2
    having bool_and(v >= 0 and v <= 1.001)
       and sum(v) between 0.95 and 1.05
  ),
  normed as (
    select hv.id, hv.fam, hv.pos, hv.depth_bucket, hv.tex, hv.hand,
      case
        when hv.act = 'c' then 'check'
        when coalesce(rb.nb, 0) = 1 then
          case when (nullif(substr(hv.act, 2), ''))::numeric >= 100
            then 'bet_big' else 'bet_small' end
        when (nullif(substr(hv.act, 2), ''))::numeric >= rb.mx then 'bet_big'
        else 'bet_small'
      end as bucket,
      hv.v / va.tot as freq
    from handvals hv
    join validated va on va.id = hv.id and va.hand = hv.hand
    left join rootbets rb on rb.id = hv.id
  ),
  perhand as (
    select id, fam, pos, depth_bucket, tex, hand, bucket, sum(freq) as f
    from normed group by 1, 2, 3, 4, 5, 6, 7
  ),
  rowcounts as (
    select fam, pos, depth_bucket, tex, count(distinct id) as nrows
    from perhand group by 1, 2, 3, 4
  ),
  cellhand as (
    select fam, pos, depth_bucket, tex, hand, bucket, avg(f) as f
    from perhand group by 1, 2, 3, 4, 5, 6
  ),
  cells as (
    select c.fam, c.pos, c.depth_bucket, c.tex,
           jsonb_object_agg(c.hand, c.per_hand) as matrix,
           max(r.nrows)::integer as source_rows
    from (
      select fam, pos, depth_bucket, tex, hand,
             jsonb_object_agg(bucket, round(f, 4)) as per_hand
      from cellhand group by 1, 2, 3, 4, 5
    ) c
    join rowcounts r using (fam, pos, depth_bucket, tex)
    group by 1, 2, 3, 4
  ),
  ins as (
    insert into tmp_agg30 (street, game_family, position, depth_bucket, texture_class, facing,
                           hand_matrix, source_rows)
    select p_street, fam, pos, depth_bucket, tex, 'open', matrix, source_rows from cells
    returning 1
  )
  select coalesce((select max_id from marked), v_cur.last_id),
         coalesce((select n from marked), 0)
    into v_max_id, v_processed;

  insert into public.gto_postflop_compact as g
    (street, game_family, position, depth_bucket, texture_class, facing, hand_matrix, source_rows)
  select street, game_family, position, depth_bucket, texture_class, facing, hand_matrix, source_rows
  from tmp_agg30
  on conflict (street, game_family, position, depth_bucket, texture_class, facing) do update
     set hand_matrix = (
           select jsonb_object_agg(hand, merged) from (
             select coalesce(a.key, b.key) as hand,
               case
                 when a.value is null then b.value
                 when b.value is null then a.value
                 else (
                   select jsonb_object_agg(bk, round(
                     (coalesce((a.value->>bk)::numeric, 0) * g.source_rows
                      + coalesce((b.value->>bk)::numeric, 0) * excluded.source_rows)
                     / nullif(g.source_rows + excluded.source_rows, 0), 4))
                   from (
                     select distinct k as bk from (
                       select jsonb_object_keys(a.value) k
                       union select jsonb_object_keys(b.value) k
                     ) kk
                   ) bks
                 )
               end as merged
             from jsonb_each(g.hand_matrix) a
             full outer join jsonb_each(excluded.hand_matrix) b on a.key = b.key
           ) m
         ),
         source_rows = g.source_rows + excluded.source_rows,
         built_at = now();

  update public.gto_agg_progress
     set last_id = v_max_id,
         rows_done = rows_done + v_processed,
         done = (v_processed < v_batch),
         updated_at = now()
   where street = p_street;

  return query select v_processed, v_max_id, (v_processed < v_batch);
end;
$function$;

-- The live grants, restated so a fresh apply of this file reproduces them
-- (measured 2026-09-02: anon false, authenticated false, service_role true).
-- Without these lines a from-scratch CREATE would default EXECUTE to PUBLIC
-- on a SECURITY DEFINER writer that never asks who is calling - the exact
-- shape the definer-authorization guard exists to refuse.
REVOKE ALL ON FUNCTION public.fn_aggregate_gto_street_next(text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_aggregate_gto_street_next(text, integer) TO service_role;

COMMIT;
