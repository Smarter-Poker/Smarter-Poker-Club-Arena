-- ============================================================================
--  THE GTO AGGREGATION CURSOR SEEKS INSTEAD OF RE-READING ITS OWN PROGRESS
--
--  fn_aggregate_gto_v31_next folds solved_spots_gold's second solver export
--  into gto_postflop_v31, 25 rows a tick, since 2026-08-30. It was 655,130 of
--  1,891,817 rows done after nine days, and getting slower, because its
--  keyset pagination was written as
--
--      s.solved_v2_at > last_at
--      OR (s.solved_v2_at = last_at AND s.id > last_id)
--
--  which Postgres cannot use as an index start point. Measured on production
--  (EXPLAIN ANALYZE at the live cursor, 2026-09-08 03:40 UTC):
--
--      Index Scan using idx_solved_spots_gold_solved_v2_at
--        Rows Removed by Filter: 655130
--        Buffers: shared hit=611591          (~4.8 GB)
--        Execution Time: 761 ms
--
--  Every batch re-read the entire prefix it had already processed, to return
--  25 rows - O(n^2) in the work done, on the largest table in the database
--  (80 GB, 75 GB of it TOAST), every tick, forever. That index alone shows
--  21.7 BILLION tuples fetched across 66,083 scans.
--
--  THE FIX is the row-wise comparison, which IS sargable, plus a composite
--  index in exactly the cursor's order. Same rows, same order, same cursor
--  semantics - a batch is now a seek:
--
--      Index Only Scan using idx_ssg_v2_cursor
--        Index Cond: ROW(solved_v2_at, id) > ROW(last_at, last_id)
--        Buffers: shared hit=9 read=3
--        Execution Time: 0.082 ms
--
--  761 ms -> 0.082 ms, 611,591 buffers -> 12, and the cost stops growing with
--  progress. Nothing else in the function changes: same batch size, same
--  cursor row, same aggregation, same restart safety.
--
--  The index is built CONCURRENTLY outside this file (it cannot run inside a
--  transaction); this migration records it and carries the function.
--    CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ssg_v2_cursor
--      ON public.solved_spots_gold (solved_v2_at, id)
--      WHERE solved_v2_at IS NOT NULL;
-- ============================================================================
BEGIN;

CREATE OR REPLACE FUNCTION public.fn_aggregate_gto_v31_next(p_batch integer DEFAULT 25)
 RETURNS TABLE(processed integer, last_at timestamp with time zone, last_id uuid, is_done boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
    on commit delete rows;
  delete from tmp_agg31 where true;

  with batch as materialized (
    select s.id, s.solved_v2_at, s.street, s.game_type, s.strategy_matrix_v2 as m
    from public.solved_spots_gold s
    where s.solved_v2_at is not null
      /* A SEEK, NOT A SCAN (2026-09-08). The OR-form of this keyset was not
         sargable: Postgres started at the beginning of
         idx_solved_spots_gold_solved_v2_at and filtered out every row already
         processed, so a 25-row batch removed 655,130 rows by filter, touched
         611,591 buffers (~4.8 GB) and took 761 ms - and got worse with every
         batch, because the discarded prefix is the work already done. The
         row-comparison below is a single index seek on
         idx_ssg_v2_cursor (solved_v2_at, id): same rows, same order, same
         cursor semantics, measured 0.082 ms and 12 buffers. */
      and (v_cur.last_at is null
           or (s.solved_v2_at, s.id) > (v_cur.last_at, v_cur.last_id))
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
$function$;


COMMENT ON FUNCTION public.fn_aggregate_gto_v31_next(integer) IS
  'Folds the next batch of solved_spots_gold.strategy_matrix_v2 into gto_postflop_v31. The keyset is a row-comparison so it seeks on idx_ssg_v2_cursor (solved_v2_at, id) rather than re-reading every already-processed row (761 ms -> 0.082 ms per batch, 2026-09-08).';

REVOKE ALL ON FUNCTION public.fn_aggregate_gto_v31_next(integer) FROM PUBLIC, anon, authenticated;

DO $$
DECLARE v_def text := pg_get_functiondef('public.fn_aggregate_gto_v31_next(integer)'::regprocedure);
BEGIN
  IF position('(s.solved_v2_at, s.id) > (v_cur.last_at, v_cur.last_id)' IN v_def) = 0 THEN
    RAISE EXCEPTION 'the aggregation cursor must be a sargable row comparison, not an OR chain';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'idx_ssg_v2_cursor') THEN
    RAISE EXCEPTION 'idx_ssg_v2_cursor (solved_v2_at, id) must exist for the cursor to seek';
  END IF;
END $$;

COMMIT;
