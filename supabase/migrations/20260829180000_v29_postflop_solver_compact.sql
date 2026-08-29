-- ════════════════════════════════════════════════════════════════════════
-- V29 — the postflop solver warehouse becomes a preloadable table
-- (Dan 2026-08-29: "PROCEED TO THE NEXT PHASE ... FOR THE HORSE BRAIN")
-- ════════════════════════════════════════════════════════════════════════
--
-- Stage 2 of the solver integration V27 promised. solved_spots_gold holds
-- 8.8M PioSolver CFR solutions (79 GB) that the live brain cannot touch:
-- decide() is synchronous with zero I/O, and the 2026-08-15 incident proved
-- that even COUNTING rows in that table can starve the platform. So the
-- warehouse is aggregated OFFLINE, in index-driven batches of at most ~6k
-- rows (one game_type at a time via idx_ssg_street/idx_ssg_game), into a
-- compact table small enough to preload exactly like the V27 charts.
--
-- ── WHY TEXTURE CLASSES ─────────────────────────────────────────────────
--
-- The solved boards are a canonical subset (~186 flops per position). A live
-- random flop essentially never exact-matches one, so solutions are grouped
-- by the four properties that drive flop strategy — high card, suit
-- distribution, pairing, connectivity — and the live board maps onto the
-- same class. 4 x 3 x 2 x 2 = 48 classes; the aggregate is the mean solver
-- frequency per 169-hand class per action bucket across every solved board
-- in the class. That is a real approximation, stated plainly: within a
-- class the solver's boards vary, and the mean is what the fleet plays.
-- It replaces hand-tuned literals with solver-derived numbers; it does not
-- claim to be an exact solve of the live board.
--
-- ── SHAPE ───────────────────────────────────────────────────────────────
--
-- Two node families exist in the flop data, verified against production:
--   'open'   node r:0 / r:0:c, actions [bBig, bSmall, c]  (42,367 rows)
--   'facing' node null, actions [bSmall, c, bBig, f]      (29,970 rows)
-- They become action buckets {check, bet_small, bet_big} and
-- {fold, call, raise_small, raise_big}.
--
-- game_family collapses the 24 game_type values into the four the brain can
-- actually distinguish at decision time: cash, tourney_ev, tourney_icm, spin.
-- ════════════════════════════════════════════════════════════════════════

create table if not exists public.gto_postflop_compact (
  street        text not null,
  game_family   text not null,
  position      text not null,
  depth_bucket  integer not null,
  texture_class text not null,
  facing        text not null,          -- 'open' | 'facing'
  hand_matrix   jsonb not null,         -- { "AKs": {"check":0.4,"bet_small":...}, ... }
  source_rows   integer not null,
  built_at      timestamptz not null default now(),
  primary key (street, game_family, position, depth_bucket, texture_class, facing)
);

comment on table public.gto_postflop_compact is
  'V29: offline texture-classed aggregation of solved_spots_gold, preloaded by the engine (GtoPostflopLoader) so the synchronous horse decision reads solver frequencies at zero I/O. Built in per-game_type batches via fn_aggregate_gto_flop; NEVER read the 79GB warehouse on a hot path (2026-08-15 incident).';

alter table public.gto_postflop_compact enable row level security;

-- ── the texture classifier (mirrored EXACTLY in engine/GtoPostflop.ts) ──
create or replace function public.fn_gto_texture_class(p_board text)
returns text
language plpgsql
immutable
as $$
declare
  v_ranks integer[] := '{}';
  v_suits text[] := '{}';
  v_ch text; v_r integer; v_i integer;
  v_hi integer; v_high text; v_suitkind text; v_paired boolean;
  v_conn boolean := false;
  v_distinct integer[];
  v_span integer;
begin
  -- Board arrives as concatenated cards: 'QhJdTh'. Three cards = the flop.
  if p_board is null or length(p_board) < 6 then return null; end if;
  for v_i in 0..2 loop
    v_ch := substr(p_board, v_i * 2 + 1, 1);
    v_r := case v_ch
      when 'A' then 14 when 'K' then 13 when 'Q' then 12 when 'J' then 11
      when 'T' then 10 else nullif(v_ch, '')::integer end;
    if v_r is null then return null; end if;
    v_ranks := v_ranks || v_r;
    v_suits := v_suits || substr(p_board, v_i * 2 + 2, 1);
  end loop;

  v_hi := greatest(v_ranks[1], v_ranks[2], v_ranks[3]);
  v_high := case
    when v_hi = 14 then 'A'
    when v_hi >= 12 then 'B'    -- K or Q high
    when v_hi >= 9  then 'M'    -- J, T, 9 high
    else 'L' end;

  v_suitkind := case
    when v_suits[1] = v_suits[2] and v_suits[2] = v_suits[3] then 'm'
    when v_suits[1] = v_suits[2] or v_suits[2] = v_suits[3] or v_suits[1] = v_suits[3] then 't'
    else 'r' end;

  v_paired := v_ranks[1] = v_ranks[2] or v_ranks[2] = v_ranks[3] or v_ranks[1] = v_ranks[3];

  -- Connectivity: the distinct ranks fit inside a 4-rank span (straighty),
  -- with the wheel ace counted low as well as high.
  select array_agg(distinct r order by r) into v_distinct from unnest(v_ranks) r;
  if array_length(v_distinct, 1) >= 2 then
    v_span := v_distinct[array_length(v_distinct, 1)] - v_distinct[1];
    if v_span <= 4 then v_conn := true; end if;
    -- wheel: treat the ace as 1
    if not v_conn and v_distinct[array_length(v_distinct, 1)] = 14 then
      if (v_distinct[array_length(v_distinct, 1) - 1] <= 5) then v_conn := true; end if;
    end if;
  end if;

  return v_high || v_suitkind || case when v_paired then 'p' else 'u' end
         || case when v_conn then 'c' else 'd' end;
end;
$$;

comment on function public.fn_gto_texture_class(text) is
  'V29 flop texture class: high card (A/B/M/L) + suits (m/t/r) + paired (p/u) + connectivity (c/d). MIRRORED in server/src/engine/GtoPostflop.ts textureClass() - the two must classify identically or live lookups land in the wrong cell.';

-- ── the batched aggregator: one game_type per call, index-driven ────────
create or replace function public.fn_aggregate_gto_flop(p_game_type text)
returns table (cells integer, rows_read integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_family text;
  v_cells integer; v_rows integer;
begin
  v_family := case
    when p_game_type like '%cash%' then 'cash'
    when p_game_type like '%icm%' then 'tourney_icm'
    when p_game_type like 'spin%' then 'spin'
    else 'tourney_ev' end;

  -- Idempotent per batch: rebuild this game_type's contribution by removing
  -- cells whose family it feeds and re-inserting from scratch would clobber
  -- sibling game_types in the same family — so instead aggregate into a temp
  -- and MERGE weighted by source_rows.
  create temp table if not exists tmp_agg (like public.gto_postflop_compact including all) on commit drop;
  delete from tmp_agg;

  with src as (
    select
      substring(s.scenario_hash from '_(UTG|MP|CO|BTN|SB|BB)_') as pos,
      case
        when s.stack_depth <= 12 then 10
        when s.stack_depth <= 30 then 20
        when s.stack_depth <= 60 then 40
        when s.stack_depth <= 110 then 80
        else 150 end as depth_bucket,
      public.fn_gto_texture_class(substring(s.scenario_hash from 'bb_(.*)$')) as tex,
      case when s.strategy_matrix->'actions' @> '["f"]'::jsonb then 'facing' else 'open' end as facing,
      s.strategy_matrix->'frequencies' as freqs,
      s.strategy_matrix->'actions' as actions
    from public.solved_spots_gold s
    where s.street = 'flop'
      and s.game_type = p_game_type
      and s.strategy_matrix ? 'frequencies'
      and s.strategy_matrix ? 'actions'
  ),
  labeled as (
    -- map each concrete action to its bucket, per row
    select pos, depth_bucket, tex, facing, freqs,
      (select jsonb_object_agg(a.act,
        case
          when a.act = 'c' and facing = 'open' then 'check'
          when a.act = 'c' then 'call'
          when a.act = 'f' then 'fold'
          when a.act like 'b%' then
            case when (nullif(substr(a.act, 2), ''))::numeric >= (
              select max((nullif(substr(b.act2, 2), ''))::numeric)
              from jsonb_array_elements_text(actions) b(act2) where b.act2 like 'b%'
            ) then case when facing = 'open' then 'bet_big' else 'raise_big' end
            else case when facing = 'open' then 'bet_small' else 'raise_small' end
          end
          else null end)
       from jsonb_array_elements_text(actions) a(act)) as bucket_of
    from src
    where pos is not null and tex is not null
  ),
  rowcounts as (
    select pos, depth_bucket, tex, facing, count(*) as nrows
    from labeled group by 1,2,3,4
  ),
  expanded as (
    -- frequencies is {action: {hand: freq}}; flatten to (cell, hand, bucket, freq)
    select l.pos, l.depth_bucket, l.tex, l.facing,
           h.key as hand, l.bucket_of->>am.key as bucket, (h.value)::numeric as freq
    from labeled l,
         jsonb_each(l.freqs) am,
         jsonb_each_text(am.value) h
    where l.bucket_of->>am.key is not null
      and h.value ~ '^-?[0-9.eE+]+$'
  ),
  cellhand as (
    select pos, depth_bucket, tex, facing, hand, bucket, avg(freq) as f
    from expanded group by 1,2,3,4,5,6
  ),
  cells as (
    select c.pos, c.depth_bucket, c.tex, c.facing,
           jsonb_object_agg(c.hand, c.per_hand) as matrix,
           max(r.nrows)::integer as source_rows
    from (
      select pos, depth_bucket, tex, facing, hand,
             jsonb_object_agg(bucket, round(f, 4)) as per_hand
      from cellhand group by 1,2,3,4,5
    ) c
    join rowcounts r using (pos, depth_bucket, tex, facing)
    group by 1,2,3,4
  )
  insert into tmp_agg (street, game_family, position, depth_bucket, texture_class, facing,
                       hand_matrix, source_rows)
  select 'flop', v_family, pos, depth_bucket, tex, facing, matrix, source_rows from cells;

  get diagnostics v_cells = row_count;
  select count(*) into v_rows from public.solved_spots_gold
   where street = 'flop' and game_type = p_game_type;

  -- Merge into the compact table, weighting existing vs incoming by rows.
  insert into public.gto_postflop_compact as g
    (street, game_family, position, depth_bucket, texture_class, facing, hand_matrix, source_rows)
  select street, game_family, position, depth_bucket, texture_class, facing, hand_matrix, source_rows
  from tmp_agg
  on conflict (street, game_family, position, depth_bucket, texture_class, facing) do update
     set hand_matrix = (
           -- weighted merge of the two hand matrices, hand by hand
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

  return query select v_cells, v_rows;
end;
$$;

comment on function public.fn_aggregate_gto_flop(text) is
  'V29 batch aggregator: fold ONE game_type''s flop rows (<=6k, index-driven) from solved_spots_gold into gto_postflop_compact. Idempotence contract: rebuilding requires truncating the target first (the merge is additive by design so sibling game_types in one family combine). Run once per game_type, off-peak.';

revoke all on function public.fn_aggregate_gto_flop(text) from public, anon, authenticated;
grant execute on function public.fn_aggregate_gto_flop(text) to service_role;
revoke all on table public.gto_postflop_compact from public, anon, authenticated;
grant select on table public.gto_postflop_compact to service_role;
