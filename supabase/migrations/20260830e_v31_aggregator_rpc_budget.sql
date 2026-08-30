-- ═══════════════════════════════════════════════════════════════════════════
-- V31 AGGREGATOR — fit the engine's real budget, and fix a latent averaging
-- bug found while measuring it. (2026-08-30)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHY: 20260830d was measured only from a privileged SQL session (~657ms for
-- 25 rows). Measured through the path the ENGINE actually uses — POST
-- /rest/v1/rpc as service_role — the same batch took **20.5 seconds**, 31x
-- worse, and a batch of 50 exceeded a 30s client timeout. That is the exact
-- trap this repo has hit before: a privileged session hides what PostgREST
-- does. `authenticator` carries `statement_timeout=8s`, so no batch that
-- takes 20s can ever be driven by the engine.
--
-- Three changes, each proven separately before being combined.
--
-- 1. ONE ARRAY CAST INSTEAD OF 1,326 ELEMENT CASTS.
--    `jsonb_array_elements(arr) ... (val)::text::numeric` converts every one
--    of the ~2,652 slots per solve individually. Casting the whole array once
--    — `translate(arr::text,'[]','{}')::numeric[]` then `unnest ... with
--    ordinality` — does it in a single conversion.
--      per-element : 1,089ms / 5,564ms
--      array cast  :   692ms / 1,252ms      (over 267,852 values)
--    Identical output: same row count AND same checksum (21743.0000) on both
--    runs. Note it is not just faster, it is far less VARIABLE, and variance
--    is what breaks an 8s budget.
--
-- 2. AGGREGATE BEFORE KEYING, NOT AFTER.
--    The old form built the `CLASS:suitcount` text key for all ~69,000
--    expanded rows, sorted them wide through a window function, and only
--    then discarded ~85% at the validity filter. Now the per-combo totals
--    come from filtered aggregates in one GROUP BY, the ~15% that survive are
--    joined to gto_combo_map, and the key is built for those alone. The old
--    form's timing swung 3,190ms -> 42,281ms on identical input; the new one
--    held 5,453ms / 5,756ms. Same output, proven by EXCEPT in both directions
--    on two independent windows (5,377 and 5,736 rows, zero difference).
--
-- 3. A LATENT AVERAGING BUG, FIXED.
--    The old shape grouped by (id, handkey, bucket) and took avg(f). That is
--    right across COMBOS sharing a hand key, but wrong across two ACTIONS
--    landing in the same size bucket: two bets that are both under 60% of pot
--    are two ways to do one thing, so their frequencies must be SUMMED, not
--    averaged. Averaging would have produced a mix that does not sum to 1 —
--    quietly breaking the very invariant the table is verified by. V30's
--    aggregator sums here; V31's did not.
--    It has never fired: 4,000 sampled rows have one action per bucket
--    (turn 2 actions/2 buckets, flop 3/3), so no shipped cell is affected.
--    But the bucket boundaries are arbitrary and a future export could put
--    two bets in one bucket without anyone noticing. `sum(f) FILTER (WHERE
--    bucket = ...)` makes it structurally impossible.
--
-- 4. A GUARD FOR THE ARRAY CAST. The whole-array cast fails loudly if a slot
--    is ever a JSON string rather than a number, where the per-element form
--    silently skipped it. A stalled cursor is better than silent corruption,
--    but best is neither: the vocabulary check below skips such an action
--    instead. `translate(text, allowed, '') = ''` is true only when the array
--    contains nothing but digits, sign, decimal point, exponent, comma,
--    brackets, whitespace and the literal `null`.
--
-- TIER 2: replaces one function body. No table, column or data is altered,
-- and the cursor is untouched, so the build resumes exactly where it stopped.

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
  -- MATERIALIZED is load-bearing: fn_gto_texture_class_any is PL/pgSQL and
  -- cannot be inlined, so without it the planner re-evaluates it once per
  -- expanded combo row instead of once per solve, and the batch times out.
  src as materialized (
    select b.id, b.street,
      case
        when b.game_type like '%cash%' then 'cash'
        when b.game_type like '%icm%'  then 'tourney_icm'
        when b.game_type like 'spin%'  then 'spin'
        else 'tourney_ev' end as fam,
      -- v2 names seats the engine collapses (HJ, UTG1/2, MP1/2). V30's
      -- regexp over scenario_hash matched only the engine's six and silently
      -- dropped ~5.8% of rows; these are mapped the way classifyPosition()
      -- collapses early and middle seats, rather than discarded.
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
    -- actions/frequencies/position. 0.085% of v2, confined to sng_hu. They
    -- are skipped here but still advance the cursor.
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
      -- vocabulary guard for the whole-array cast below: true only when the
      -- array holds nothing but numbers, punctuation and the literal `null`.
      and translate((s.freqs -> (a->>'code'))::text,
                    '0123456789.,+-eE[] ' || chr(9) || chr(10) || chr(13) || 'nul', '') = ''
  ),
  -- ONE cast per action array, not one per slot.
  raw as materialized (
    select a.id, a.street, a.fam, a.pos, a.depth_bucket, a.tex, a.fs,
           (e.ord - 1)::int as combo_idx, a.bucket, e.f
    from acted a
    cross join lateral unnest(
      translate((a.freqs -> a.code)::text, '[]', '{}')::numeric[]
    ) with ordinality e(f, ord)
    where e.f is not null
  ),
  -- Per-combo distribution in ONE aggregation. SUM within a bucket (two
  -- actions in the same size band are two ways to do one thing); the HAVING
  -- keeps only combos whose frequencies form a probability distribution,
  -- which drops board-blocked combos and combos outside hero's range at the
  -- node (together ~68% of the 1,326 slots).
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
  -- Only now — on the ~15% that survived — decode the combo and build the key.
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
  -- AVERAGE across the combos that share a hand key (that is what a class
  -- cell means), having already SUMMED within a bucket per combo above.
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

  -- Weighted merge: a cell is the mean across every solve that reached it,
  -- so the batch size cannot change the answer.
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
  'Folds the next batch of strategy_matrix_v2 rows into gto_postflop_v31, walking the solved_v2_at partial index. Cursor in gto_agg_progress_v31, so restart-safe. One whole-array numeric cast per action, per-combo distribution via filtered aggregates, hand key built only for surviving combos.';

revoke all on function public.fn_aggregate_gto_v31_next(integer) from public;
revoke execute on function public.fn_aggregate_gto_v31_next(integer) from anon, authenticated;
grant execute on function public.fn_aggregate_gto_v31_next(integer) to service_role;

do $$
declare v_n integer;
begin
  -- the aggregator must not be reachable by a logged-in user
  select count(*) into v_n from information_schema.routine_privileges rp
    join pg_proc p on rp.specific_name = p.proname || '_' || p.oid
   where p.proname = 'fn_aggregate_gto_v31_next'
     and rp.grantee in ('anon', 'authenticated');
  if v_n <> 0 then
    raise exception 'fn_aggregate_gto_v31_next is executable by anon/authenticated';
  end if;

  select count(*) into v_n from public.gto_combo_map;
  if v_n <> 1326 then
    raise exception 'gto_combo_map has % rows, expected 1326', v_n;
  end if;
end $$;

-- ROLLBACK: re-apply the function body from 20260830d_v31_aggregator.sql.
-- No schema or data changes here, so nothing else needs undoing.
