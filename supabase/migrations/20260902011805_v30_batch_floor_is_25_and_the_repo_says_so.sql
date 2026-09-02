-- V30 BATCH FLOOR IS 25, AND THE REPO SAYS SO (2026-09-02).
--
-- Main went red tonight on GtoAggregationFloor.test.ts and blocked every
-- engine deploy (force included): the unrecorded-migration backfill added
-- 20260830053658 (lateral optimization, floor 200) and 20260830053917 (its
-- same-day revert, also floor 200) to the repo, making 053917 the NEWEST
-- migration to declare the aggregator batch clamp. Production is NOT on
-- 200: a later surgical prosrc patch (the safe way to touch this function,
-- which the guard deliberately does not count as a declaration) restored
-- greatest(25, ...) and the LIVE floor reads 25 today. So the guard was
-- telling the truth about the repo and a lie about production.
--
-- This migration is the live definition, byte-for-byte from
-- pg_get_functiondef on 2026-09-02 - applying it is a no-op re-assert, and
-- it becomes the newest declaring migration with the floor the driver can
-- actually live with (driver sends 100; 25 <= 100).

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
$function$

;

-- The aggregator is a service sweep; nobody in a browser calls it.
REVOKE ALL ON FUNCTION public.fn_aggregate_gto_street_next(text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_aggregate_gto_street_next(text, integer) TO service_role;

DO $$
DECLARE v_floor int;
BEGIN
  SELECT (regexp_match(prosrc, 'v_batch\s+integer\s*:=\s*greatest\(\s*(\d+)\s*,'))[1]::int
    INTO v_floor FROM pg_proc WHERE proname = 'fn_aggregate_gto_street_next';
  IF v_floor IS DISTINCT FROM 25 THEN
    RAISE EXCEPTION 'batch floor is %, expected 25', v_floor;
  END IF;
END $$;

COMMIT;
