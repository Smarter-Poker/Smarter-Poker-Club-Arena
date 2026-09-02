-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260829210524; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- V30 fix (take 2, after DROP): solved_spots_gold.id is a UUID; the cursor
-- follows suit. UUID btree order is a deterministic total order.

alter table public.gto_agg_progress
  drop column if exists last_id,
  add column if not exists last_id uuid;

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
  v_batch integer := greatest(200, least(5000, coalesce(p_batch, 1500)));
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
  delete from tmp_agg30;

  with batch as (
    select s.id, s.game_type, s.stack_depth, s.scenario_hash, s.strategy_matrix
    from public.solved_spots_gold s
    where s.street = p_street
      and (v_cur.last_id is null or s.id > v_cur.last_id)
    order by s.id
    limit v_batch
  ),
  marked as (select max(id) as max_id, count(*) as n from batch),
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
      case when b.strategy_matrix->'actions' @> '["f"]'::jsonb then 'facing' else 'open' end as facing,
      b.strategy_matrix->'frequencies' as freqs,
      b.strategy_matrix->'actions' as actions
    from batch b
    where b.strategy_matrix ? 'frequencies' and b.strategy_matrix ? 'actions'
  ),
  labeled as (
    select fam, pos, depth_bucket, tex, facing, freqs,
      (select jsonb_object_agg(a.act,
        case
          when a.act = 'c' and facing = 'open' then 'check'
          when a.act = 'c' then 'call'
          when a.act = 'f' then 'fold'
          when a.act like 'b%' then
            case
              when (select count(*) from jsonb_array_elements_text(actions) z(a2) where z.a2 like 'b%') = 1 then
                case when (nullif(substr(a.act, 2), ''))::numeric >= 100
                  then case when facing = 'open' then 'bet_big' else 'raise_big' end
                  else case when facing = 'open' then 'bet_small' else 'raise_small' end
                end
              when (nullif(substr(a.act, 2), ''))::numeric >= (
                select max((nullif(substr(b2.act2, 2), ''))::numeric)
                from jsonb_array_elements_text(actions) b2(act2) where b2.act2 like 'b%'
              ) then case when facing = 'open' then 'bet_big' else 'raise_big' end
              else case when facing = 'open' then 'bet_small' else 'raise_small' end
            end
          else null end)
       from jsonb_array_elements_text(actions) a(act)) as bucket_of
    from src
    where pos is not null and tex is not null
  ),
  rowcounts as (
    select fam, pos, depth_bucket, tex, facing, count(*) as nrows
    from labeled group by 1,2,3,4,5
  ),
  expanded as (
    select l.fam, l.pos, l.depth_bucket, l.tex, l.facing,
           h.key as hand, l.bucket_of->>am.key as bucket, (h.value)::numeric as freq
    from labeled l,
         jsonb_each(l.freqs) am,
         jsonb_each_text(am.value) h
    where l.bucket_of->>am.key is not null
      and h.value ~ '^-?[0-9.eE+]+$'
  ),
  cellhand as (
    select fam, pos, depth_bucket, tex, facing, hand, bucket, avg(freq) as f
    from expanded group by 1,2,3,4,5,6,7
  ),
  cells as (
    select c.fam, c.pos, c.depth_bucket, c.tex, c.facing,
           jsonb_object_agg(c.hand, c.per_hand) as matrix,
           max(r.nrows)::integer as source_rows
    from (
      select fam, pos, depth_bucket, tex, facing, hand,
             jsonb_object_agg(bucket, round(f, 4)) as per_hand
      from cellhand group by 1,2,3,4,5,6
    ) c
    join rowcounts r using (fam, pos, depth_bucket, tex, facing)
    group by 1,2,3,4,5
  ),
  ins as (
    insert into tmp_agg30 (street, game_family, position, depth_bucket, texture_class, facing,
                           hand_matrix, source_rows)
    select p_street, fam, pos, depth_bucket, tex, facing, matrix, source_rows from cells
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
$$;

comment on function public.fn_aggregate_gto_street_next(text, integer) is
  'V30 cursor-driven batch aggregator for turn/river. Processes the next <=p_batch rows by UUID order for one street, folds them into gto_postflop_compact (same weighted merge as V29), advances gto_agg_progress. Paced by the engine''s GtoAggregationDriver every ~20s — bounded, off the deal path, restart-safe, permanently silent once done=true.';

revoke all on function public.fn_aggregate_gto_street_next(text, integer) from public, anon, authenticated;
grant execute on function public.fn_aggregate_gto_street_next(text, integer) to service_role;
