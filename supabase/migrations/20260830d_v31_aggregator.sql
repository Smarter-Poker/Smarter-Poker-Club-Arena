-- ═══════════════════════════════════════════════════════════════════════════
-- V31 AGGREGATOR — fold strategy_matrix_v2 into suit-aware cells (2026-08-30)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- V29/V30 read `strategy_matrix` (v1). This reads `strategy_matrix_v2`, and
-- the two are DISJOINT: of 9,584 sampled turn rows, 3,936 carry v1
-- `tree_lines`, 5,648 carry v2 `actions`, and ZERO carry both. So this is not
-- a replacement for gto_postflop_compact and there is no equivalence to
-- prove against it — V31 covers the 59% of turn rows V30 structurally walks
-- past. Both tables are read; neither supersedes the other.
--
-- WHAT V2 BUYS, MEASURED (2026-08-30):
--
--  1. REAL BET SIZES. Every solved tree in v1 offers exactly ONE root bet,
--     `b16` (16% pot), identically across all three streets and stack depths
--     8bb to 150bb. So the v1-derived brain can express only "check, or bet
--     16% of pot" — V30's bet_big branch is unreachable on turn and river
--     (bet_big appears in 0 of 444,020 turn hand entries). v2 carries an
--     explicit `size_pct` per action: flop 33-75 (p50 54), turn 64-263
--     (p50 262). This is the largest gain, ahead of suit granularity.
--  2. SUIT AWARENESS. 1,326 exact combos instead of 169 classes. Grouping to
--     169 loses an average within-class spread of 0.238; one dimension —
--     how many of the board's flush suit the combo holds — recovers 67%
--     (worst 39%, best 89%, n=83) for ~31 MB against ~110 MB for all combos.
--     Hence hand keys of the form `AKs:2`, 169 x 3.
--  3. eff_stack_bb (6.0-197.5) instead of stack_depth for the depth bucket.
--
-- NOT built, on measurement: an `exploitability_pct` quality filter. The
-- distribution is 0.108 / 0.376 / 0.499 (min/median/max) — one narrow band
-- with no bad tail, so a filter either excludes nothing or excludes
-- arbitrarily.
--
-- NO `facing` COLUMN, BY CONSTRUCTION. Every v2 action set sampled (1,006
-- rows) is bet/check only; not one contains fold or call. V29's contaminated
-- facing cells were purged on 2026-08-29 and the column is simply absent
-- here, so this table has nowhere to put a facing cell even by accident.
--
-- THE CURSOR. v2 rows carry `solved_v2_at`, which has a partial index
-- (idx_solved_spots_gold_solved_v2_at WHERE solved_v2_at IS NOT NULL) over
-- exactly this population. Walking it costs no wasted rows, unlike V30's id
-- order which reads ~541 rows to find 200 usable ones. Street comes from the
-- data rather than a parameter, so one cursor covers everything. There is no
-- river to build: river has 8 v2 rows against 5,636,032 without.
--
-- MEASURED COST: 25 rows in 657ms (~38 rows/s) via the single-pass window
-- form below. A two-pass form (GROUP BY ... HAVING, then join back) produced
-- byte-identical output — verified with EXCEPT in both directions, 2,030
-- rows each, zero difference — and took 2,615ms, so the window form is 4x
-- faster for provably the same answer.
--
-- CTEs ARE MATERIALIZED DELIBERATELY. Without it, `fn_gto_texture_class_any`
-- (PL/pgSQL, not inlinable) is re-evaluated for every one of the ~2,652
-- expanded combo rows per solve instead of once, and the batch times out at
-- 25 rows. This is not decoration; removing `materialized` breaks it.
--
-- NOTHING DRIVES THIS YET, DELIBERATELY. V30's aggregation is still running
-- against the same 79 GB table; a second walker would contend with it for
-- the same buffers. The driver is a separate change, to start when
-- gto_agg_progress reports both streets done.
--
-- TIER 2: new objects only. Nothing existing is altered and nothing reads
-- these yet.

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
  -- TRUNCATE, not DELETE: PostgREST roles run with the safe-update guard,
  -- which refuses an unqualified DELETE (error 21000).
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
      -- v2 carries `position` explicitly, including seats the engine collapses
      -- (HJ, UTG1/2, MP1/2). V30's regexp over scenario_hash matched only the
      -- engine's six and silently dropped the rest (5.8% of sampled rows), so
      -- they are mapped here the same way classifyPosition() collapses early
      -- and middle seats, rather than discarded.
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
    -- shape B rows carry a plural `nodes` array instead, with no top-level
    -- actions/frequencies/position. They are 0.085% of v2 and confined to
    -- sng_hu; they are skipped here but still advance the cursor.
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
  -- One pass. A combo is kept only when its frequencies across the actions
  -- form a probability distribution: each in [0,1] and summing to ~1. This
  -- drops board-blocked combos and combos outside hero's range at the node
  -- (together ~68% of the 1,326 slots), which carry zeros or nothing.
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

  -- Weighted merge, identical in shape to V30's: a cell's value is the mean
  -- across every solve that reached it, so batching cannot change the answer.
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

-- ── post-apply assertions ────────────────────────────────────────────────
do $$
declare
  v_n integer;
begin
  select count(*) into v_n from public.gto_agg_progress_v31;
  if v_n <> 1 then
    raise exception 'gto_agg_progress_v31 has % rows, expected exactly 1', v_n;
  end if;

  -- the table must be incapable of storing a facing cell
  select count(*) into v_n from information_schema.columns
   where table_schema = 'public' and table_name = 'gto_postflop_v31'
     and column_name = 'facing';
  if v_n <> 0 then
    raise exception 'gto_postflop_v31 has a facing column - v2 holds no facing solves';
  end if;

  -- the decode foundation this depends on must be present and whole
  select count(*) into v_n from public.gto_combo_map;
  if v_n <> 1326 then
    raise exception 'gto_combo_map has % rows, expected 1326', v_n;
  end if;
end $$;

-- ROLLBACK:
--   drop function if exists public.fn_aggregate_gto_v31_next(integer);
--   drop table if exists public.gto_postflop_v31;
--   drop table if exists public.gto_agg_progress_v31;
