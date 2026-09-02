-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260830193446; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

create table if not exists public.gto_postflop_v31 (
  street        text     not null,
  game_family   text     not null,
  position      text     not null,
  depth_bucket  smallint not null,
  texture_class text     not null,
  hand_matrix   jsonb    not null,
  source_rows   integer  not null default 0,
  built_at      timestamptz not null default now(),
  primary key (street, game_family, position, depth_bucket, texture_class)
);

comment on table public.gto_postflop_v31 is
  'Suit-aware solver cells aggregated from strategy_matrix_v2. hand_matrix keys are CLASS:flushSuitCount (e.g. AKs:2); action buckets are check / bet_small (<60% pot) / bet_mid (60-110) / bet_big (>=110), from the explicit size_pct v2 carries. Open nodes only - v2 has no fold or call actions, and there is deliberately no facing column.';

create table if not exists public.gto_agg_progress_v31 (
  only_row   boolean primary key default true check (only_row),
  last_at    timestamptz,
  last_id    uuid,
  rows_done  bigint      not null default 0,
  done       boolean     not null default false,
  updated_at timestamptz not null default now()
);

insert into public.gto_agg_progress_v31 (only_row) values (true)
on conflict (only_row) do nothing;

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
  ),
  keyed as materialized (
    select a.id, a.street, a.fam, a.pos, a.depth_bucket, a.tex, a.bucket,
           (e.ord - 1)::int as combo_idx,
           (e.val)::text::numeric as f,
           m.hand_class || ':' ||
             ((case when m.suit_a = a.fs then 1 else 0 end)
            + (case when m.suit_b = a.fs then 1 else 0 end))::text as handkey
    from acted a
    cross join lateral jsonb_array_elements(a.freqs -> a.code) with ordinality e(val, ord)
    join public.gto_combo_map m on m.combo_idx = (e.ord - 1)::int
    where jsonb_typeof(e.val) = 'number'
  ),
  scored as materialized (
    select k.*,
      sum(k.f) over w as tot, min(k.f) over w as mn, max(k.f) over w as mx
    from keyed k
    window w as (partition by k.id, k.combo_idx)
  ),
  perrow as materialized (
    select id, street, fam, pos, depth_bucket, tex, handkey, bucket, avg(f) as f
    from scored
    where tot between 0.95 and 1.05 and mn >= -0.001 and mx <= 1.001
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
  cells as (
    select c.street, c.fam, c.pos, c.depth_bucket, c.tex,
           jsonb_object_agg(c.handkey, c.per_hand) as matrix,
           max(r.nrows)::integer as source_rows
    from (
      select street, fam, pos, depth_bucket, tex, handkey,
             jsonb_object_agg(bucket, round(f, 4)) as per_hand
      from cellhand group by 1, 2, 3, 4, 5, 6
    ) c
    join rowcounts r using (street, fam, pos, depth_bucket, tex)
    group by 1, 2, 3, 4, 5
  ),
  ins as (
    insert into tmp_agg31
      (street, game_family, position, depth_bucket, texture_class, hand_matrix, source_rows)
    select street, fam, pos, depth_bucket, tex, matrix, source_rows from cells
    returning 1
  )
  select coalesce((select max_at from marked), v_cur.last_at),
         coalesce((select max_id from marked), v_cur.last_id),
         coalesce((select n from marked), 0)
    into v_max_at, v_max_id, v_processed;

  insert into public.gto_postflop_v31 as g
    (street, game_family, position, depth_bucket, texture_class, hand_matrix, source_rows)
  select street, game_family, position, depth_bucket, texture_class, hand_matrix, source_rows
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

comment on function public.fn_aggregate_gto_v31_next(integer) is
  'Folds the next batch of strategy_matrix_v2 rows into gto_postflop_v31, walking the solved_v2_at partial index. Cursor in gto_agg_progress_v31, so restart-safe. Measured ~38 rows/s at batch 25.';

revoke all on function public.fn_aggregate_gto_v31_next(integer) from public;
grant execute on function public.fn_aggregate_gto_v31_next(integer) to service_role;

do $$
declare
  v_n integer;
begin
  select count(*) into v_n from public.gto_agg_progress_v31;
  if v_n <> 1 then
    raise exception 'gto_agg_progress_v31 has % rows, expected exactly 1', v_n;
  end if;

  select count(*) into v_n from information_schema.columns
   where table_schema = 'public' and table_name = 'gto_postflop_v31'
     and column_name = 'facing';
  if v_n <> 0 then
    raise exception 'gto_postflop_v31 has a facing column - v2 holds no facing solves';
  end if;

  select count(*) into v_n from public.gto_combo_map;
  if v_n <> 1326 then
    raise exception 'gto_combo_map has % rows, expected 1326', v_n;
  end if;
end $$;
