-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260830205631; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- Corrects 20260830g, which applied cleanly and then failed on its first
-- call: `max(z.size_map)` - there is no max(jsonb) in Postgres.
--
-- sizecells yields exactly one row per (street, fam, pos, depth_bucket, tex),
-- and `cells` groups by those same five columns, so size_map is functionally
-- dependent on the group key and simply belongs IN the GROUP BY. Postgres
-- cannot infer that across a join, which is why it demanded an aggregate.
-- Grouping by it is provably identical, because the value cannot vary within
-- a group.
--
-- Caught by calling the function rather than by reading it: DDL succeeding is
-- not the same as the code working, and this one is invisible until executed.

create or replace function public.fn_aggregate_gto_v31_next(p_batch integer default 25)
returns table (processed integer, last_at timestamptz, last_id uuid, is_done boolean)
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_cur       record;
  v_batch     integer := greatest(5, least(500, coalesce(p_batch, 25)));
  v_max_at    timestamptz;
  v_max_id    uuid;
  v_processed integer := 0;
begin
  select * into v_cur from public.gto_agg_progress_v31 where only_row for update;
  if not found then
    raise exception 'no gto_agg_progress_v31 cursor row';
  end if;
  if v_cur.done then
    return query select 0, v_cur.last_at, v_cur.last_id, true;
    return;
  end if;

  create temp table if not exists tmp_agg31 (like public.gto_postflop_v31 including all)
    on commit drop;
  truncate table tmp_agg31;

  with batch as materialized (
    select s.id, s.solved_v2_at, s.street, s.game_type, s.strategy_matrix_v2 as m
    from public.solved_spots_gold s
    where s.solved_v2_at is not null
      and (v_cur.last_at is null
           or s.solved_v2_at > v_cur.last_at
           or (s.solved_v2_at = v_cur.last_at and s.id > v_cur.last_id))
    order by s.solved_v2_at, s.id
    limit v_batch
  ),
  marked as (
    select (select b2.solved_v2_at from batch b2
             order by b2.solved_v2_at desc, b2.id desc limit 1) as max_at,
           (select b2.id from batch b2
             order by b2.solved_v2_at desc, b2.id desc limit 1) as max_id,
           (select count(*) from batch) as n
  ),
  src as materialized (
    select b.id, b.street,
      case
        when b.game_type like '%cash%' then 'cash'
        when b.game_type like '%icm%'  then 'tourney_icm'
        when b.game_type like 'spin%'  then 'spin'
        else 'tourney_ev' end as fam,
      case upper(b.m->>'position')
        when 'UTG' then 'UTG' when 'UTG1' then 'UTG' when 'UTG2' then 'UTG'
        when 'MP'  then 'MP'  when 'MP1'  then 'MP'  when 'MP2'  then 'MP'
        when 'HJ'  then 'MP'
        when 'CO'  then 'CO'  when 'BTN'  then 'BTN'
        when 'SB'  then 'SB'  when 'BB'   then 'BB'
        else null end as pos,
      case
        when (b.m->>'eff_stack_bb')::numeric <= 12  then 10
        when (b.m->>'eff_stack_bb')::numeric <= 30  then 20
        when (b.m->>'eff_stack_bb')::numeric <= 60  then 40
        when (b.m->>'eff_stack_bb')::numeric <= 110 then 80
        else 150 end as depth_bucket,
      public.fn_gto_texture_class_any(b.m->>'board') as tex,
      public.fn_gto_board_flush_suit(b.m->>'board')  as fs,
      b.m->'actions'     as acts,
      b.m->'frequencies' as freqs
    from batch b
    where b.m ? 'actions' and b.m ? 'frequencies'
      and (b.m->>'eff_stack_bb') is not null
  ),
  acted as materialized (
    select s.id, s.street, s.fam, s.pos, s.depth_bucket, s.tex, s.fs,
      (a->>'code') as code,
      (a->>'size_pct')::numeric as size_pct,
      case
        when (a->>'size_pct')::numeric = 0   then 'check'
        when (a->>'size_pct')::numeric < 60  then 'bet_small'
        when (a->>'size_pct')::numeric < 110 then 'bet_mid'
        else 'bet_big' end as bucket,
      s.freqs
    from src s, jsonb_array_elements(s.acts) a
    where s.pos is not null and s.tex is not null and s.fs is not null
      and (a->>'size_pct') is not null
      and jsonb_typeof(s.freqs -> (a->>'code')) = 'array'
      and translate((s.freqs -> (a->>'code'))::text,
                    '0123456789.,+-eE[] ' || chr(9) || chr(10) || chr(13) || 'nul', '') = ''
  ),
  raw as materialized (
    select a.id, a.street, a.fam, a.pos, a.depth_bucket, a.tex, a.fs,
           (e.ord - 1)::int as combo_idx, a.bucket, e.f
    from acted a
    cross join lateral unnest(
      translate((a.freqs -> a.code)::text, '[]', '{}')::numeric[]
    ) with ordinality e(f, ord)
    where e.f is not null
  ),
  agg as materialized (
    select id, street, fam, pos, depth_bucket, tex, fs, combo_idx,
      sum(f) filter (where bucket = 'check')     as f_check,
      sum(f) filter (where bucket = 'bet_small') as f_small,
      sum(f) filter (where bucket = 'bet_mid')   as f_mid,
      sum(f) filter (where bucket = 'bet_big')   as f_big
    from raw
    group by 1, 2, 3, 4, 5, 6, 7, 8
    having sum(f) between 0.95 and 1.05
       and min(f) >= -0.001 and max(f) <= 1.001
  ),
  keyed as (
    select g.id, g.street, g.fam, g.pos, g.depth_bucket, g.tex,
           m.hand_class || ':' ||
             ((case when m.suit_a = g.fs then 1 else 0 end)
            + (case when m.suit_b = g.fs then 1 else 0 end))::text as handkey,
           v.bucket, v.f
    from agg g
    join public.gto_combo_map m on m.combo_idx = g.combo_idx
    cross join lateral (values
      ('check', g.f_check), ('bet_small', g.f_small),
      ('bet_mid', g.f_mid), ('bet_big', g.f_big)
    ) v(bucket, f)
    where v.f is not null
  ),
  perrow as materialized (
    select id, street, fam, pos, depth_bucket, tex, handkey, bucket, avg(f) as f
    from keyed
    group by 1, 2, 3, 4, 5, 6, 7, 8
  ),
  rowcounts as (
    select street, fam, pos, depth_bucket, tex, count(distinct id) as nrows
    from perrow group by 1, 2, 3, 4, 5
  ),
  cellhand as (
    select street, fam, pos, depth_bucket, tex, handkey, bucket, avg(f) as f
    from perrow group by 1, 2, 3, 4, 5, 6, 7
  ),
  sizecells as (
    select street, fam, pos, depth_bucket, tex,
           jsonb_object_agg(bucket, sz) as size_map
    from (
      select street, fam, pos, depth_bucket, tex, bucket, round(avg(size_pct), 1) as sz
      from acted where bucket <> 'check'
      group by 1, 2, 3, 4, 5, 6
    ) q
    group by 1, 2, 3, 4, 5
  ),
  cells as (
    select c.street, c.fam, c.pos, c.depth_bucket, c.tex,
           jsonb_object_agg(c.handkey, c.per_hand) as matrix,
           max(r.nrows)::integer as source_rows,
           coalesce(z.size_map, '{}'::jsonb) as size_map
    from (
      select street, fam, pos, depth_bucket, tex, handkey,
             jsonb_object_agg(bucket, round(f, 4)) as per_hand
      from cellhand group by 1, 2, 3, 4, 5, 6
    ) c
    join rowcounts r using (street, fam, pos, depth_bucket, tex)
    left join sizecells z using (street, fam, pos, depth_bucket, tex)
    -- size_map is one value per cell key, so grouping by it is identical to
    -- grouping by the key alone; Postgres just cannot infer that across a join
    group by 1, 2, 3, 4, 5, z.size_map
  ),
  ins as (
    insert into tmp_agg31
      (street, game_family, position, depth_bucket, texture_class, hand_matrix, source_rows, size_pct)
    select street, fam, pos, depth_bucket, tex, matrix, source_rows, size_map from cells
    returning 1
  )
  select coalesce((select max_at from marked), v_cur.last_at),
         coalesce((select max_id from marked), v_cur.last_id),
         coalesce((select n from marked), 0)
    into v_max_at, v_max_id, v_processed;

  insert into public.gto_postflop_v31 as g
    (street, game_family, position, depth_bucket, texture_class, hand_matrix, source_rows, size_pct)
  select street, game_family, position, depth_bucket, texture_class, hand_matrix, source_rows, size_pct
  from tmp_agg31
  on conflict (street, game_family, position, depth_bucket, texture_class) do update
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
         size_pct = coalesce((
           select jsonb_object_agg(bk, round(
             (coalesce((g.size_pct->>bk)::numeric, (excluded.size_pct->>bk)::numeric) * g.source_rows
              + coalesce((excluded.size_pct->>bk)::numeric, (g.size_pct->>bk)::numeric) * excluded.source_rows)
             / nullif(g.source_rows + excluded.source_rows, 0), 1))
           from (
             select distinct k as bk from (
               select jsonb_object_keys(g.size_pct) k
               union select jsonb_object_keys(excluded.size_pct) k
             ) kk
           ) bks
         ), g.size_pct),
         source_rows = g.source_rows + excluded.source_rows,
         built_at = now();

  update public.gto_agg_progress_v31
     set last_at    = v_max_at,
         last_id    = v_max_id,
         rows_done  = rows_done + v_processed,
         done       = (v_processed < v_batch),
         updated_at = now()
   where only_row;

  return query select v_processed, v_max_at, v_max_id, (v_processed < v_batch);
end;
$fn$;
