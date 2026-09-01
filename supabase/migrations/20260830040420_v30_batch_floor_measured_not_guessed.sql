-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260830040420; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

create or replace function public.fn_aggregate_gto_street_next(
  p_street text,
  p_batch  integer default 1500
) returns table (processed integer, new_last_id uuid, street_done boolean)
language plpgsql
security definer
set search_path = public
as $$
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
  -- which refuses an unqualified DELETE (error 21000). See the header.
  truncate table tmp_agg30;

  with batch as (
    select s.id, s.game_type, s.stack_depth, s.scenario_hash, s.strategy_matrix
    from public.solved_spots_gold s
    where s.street = p_street
      and (v_cur.last_id is null or s.id > v_cur.last_id)
    order by s.id
    limit v_batch
  ),
  -- max(uuid) has no built-in aggregate; an ordered pick does the same job
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
  -- ROOT actions only: the labels proven trustworthy
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
  -- per-hand validation: root values must BE a strategy before they are used
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

  -- weighted merge across batches (same fold as V29's flop merge)
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
$$;


comment on function public.fn_aggregate_gto_street_next(text, integer) is
  'V30 cursor-driven batch aggregator for turn/river OPEN cells. Root-node actions only (tree_lines r:0:X); per-hand validated and renormalized. Clears its temp table with TRUNCATE, never DELETE - PostgREST roles refuse an unqualified DELETE (21000). Paced by the engine''s GtoAggregationDriver. p_batch is clamped to [25, 5000]: the API roles'' statement_timeout is 8s and a 200-row batch measured ~8s on 2026-08-30, so the caller must be free to ask for LESS than 200 - a batch that lands is worth more than a bigger one that rolls back.';

revoke all on function public.fn_aggregate_gto_street_next(text, integer) from public, anon, authenticated;
grant execute on function public.fn_aggregate_gto_street_next(text, integer) to service_role;
