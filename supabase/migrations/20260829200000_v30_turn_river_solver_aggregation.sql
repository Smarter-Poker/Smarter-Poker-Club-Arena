-- ════════════════════════════════════════════════════════════════════════
-- V30 — the turn and (most importantly) the river play from the solver
-- (Dan 2026-08-29: "...MOVE ONTO FLOP, TURN AND MOST IMPORTANTLY RIVER.")
-- ════════════════════════════════════════════════════════════════════════
--
-- The flop pass (V29) covered 66,416 rows in 24 interactive batches. The
-- turn is 3,184,083 rows and the river 5,587,127 — three orders of magnitude
-- past interactive batching, and the 2026-08-15 incident rules out anything
-- heavy on this table. So V30 is CURSOR-DRIVEN: fn_aggregate_gto_street_next
-- processes the next N rows by primary-key order for one street, folds them
-- into gto_postflop_compact with the same weighted merge V29 shipped, records
-- its position in gto_agg_progress, and returns. The ENGINE paces it — a
-- background service calls it every ~20s with a small batch, off the deal
-- path, restart-safe (the cursor survives), finished in roughly a day of
-- ordinary uptime, and silent forever once done.
--
-- ── WHAT LATER PROBING PROVED (see 20260829213000) ──────────────────────
--
-- The "facing node" reading of the actions array was WRONG: every solved
-- tree's ROOT is {c, b16} — the warehouse holds only open nodes, and the
-- deep-tree labels (f, b45) carry contaminated non-frequency values. The
-- aggregation spec in this file was superseded accordingly.
--
-- ── TEXTURE ON 4 AND 5 CARDS ────────────────────────────────────────────
--
-- Same four-letter alphabet, street-appropriate semantics (cells are keyed
-- by street, so per-street meaning is sound):
--   high    A / B / M / L of ALL board cards
--   suits   m = flush board is 4+ suited; t = exactly 3 suited (flush
--           possible); r = no three of a suit
--   paired  any board pair
--   conn    any 3 distinct ranks inside a 5-rank window (straights live),
--           wheel ace counted low
-- fn_gto_texture_class (3 cards, V29) is UNTOUCHED — the flop cells stay
-- byte-identical. fn_gto_texture_class_any dispatches by length and is
-- mirrored by textureClass() in engine/GtoPostflop.ts (shared-example pins).
-- ════════════════════════════════════════════════════════════════════════

-- NOTE (as-applied history, 2026-08-29): this file first shipped last_id as
-- bigint and an aggregator using max(id). solved_spots_gold.id is a UUID, so
-- both were corrected in follow-up MCP migrations the same hour; this file
-- records the corrected shape. The aggregator defined below was then
-- SUPERSEDED ENTIRELY by 20260829213000_v30_root_only_open_cells.sql after
-- the facing-cell contamination was proven — read that file before touching
-- any of this.

create table if not exists public.gto_agg_progress (
  street     text primary key,
  last_id    uuid,
  rows_done  bigint not null default 0,
  done       boolean not null default false,
  updated_at timestamptz not null default now()
);

comment on table public.gto_agg_progress is
  'V30 cursor for the background turn/river solver aggregation. One row per street; the engine''s GtoAggregationDriver advances it in small batches. done=true is permanent until a human resets it for a re-aggregation.';

alter table public.gto_agg_progress enable row level security;

insert into public.gto_agg_progress (street) values ('turn'), ('river')
on conflict (street) do nothing;

-- ── texture for any board length ────────────────────────────────────────
create or replace function public.fn_gto_texture_class_any(p_board text)
returns text
language plpgsql
immutable
as $$
declare
  v_n integer;
  v_ranks integer[] := '{}';
  v_suits text[] := '{}';
  v_ch text; v_r integer; v_i integer;
  v_hi integer := 0; v_high text; v_suitkind text; v_paired boolean := false;
  v_conn boolean := false;
  v_maxsuit integer := 0;
  v_cnt integer;
  v_distinct integer[];
  v_win integer;
begin
  if p_board is null then return null; end if;
  v_n := length(p_board) / 2;
  if v_n < 3 or length(p_board) % 2 <> 0 then return null; end if;
  if v_n = 3 then
    -- the flop classifier is the shipped V29 contract; delegate, stay identical
    return public.fn_gto_texture_class(p_board);
  end if;
  if v_n > 5 then return null; end if;

  for v_i in 0..(v_n - 1) loop
    v_ch := substr(p_board, v_i * 2 + 1, 1);
    v_r := case v_ch
      when 'A' then 14 when 'K' then 13 when 'Q' then 12 when 'J' then 11
      when 'T' then 10 else nullif(v_ch, '')::integer end;
    if v_r is null then return null; end if;
    v_ranks := v_ranks || v_r;
    v_suits := v_suits || substr(p_board, v_i * 2 + 2, 1);
    if v_r > v_hi then v_hi := v_r; end if;
  end loop;

  v_high := case
    when v_hi = 14 then 'A'
    when v_hi >= 12 then 'B'
    when v_hi >= 9  then 'M'
    else 'L' end;

  select max(c) into v_maxsuit from (
    select count(*) c from unnest(v_suits) s group by s
  ) x;
  v_suitkind := case when v_maxsuit >= 4 then 'm' when v_maxsuit = 3 then 't' else 'r' end;

  select count(*) into v_cnt from (
    select 1 from unnest(v_ranks) r group by r having count(*) >= 2
  ) p;
  v_paired := v_cnt > 0;

  select array_agg(distinct r order by r) into v_distinct from unnest(v_ranks) r;
  -- any 5-rank window holding 3+ distinct board ranks keeps straights live
  for v_win in reverse 14..6 loop
    if (select count(*) from unnest(v_distinct) r
        where r <= v_win and r > v_win - 5
           or (v_win = 5 and r = 14)) >= 3 then
      v_conn := true;
      exit;
    end if;
  end loop;
  -- explicit wheel window (A-2-3-4-5)
  if not v_conn then
    if (select count(*) from unnest(v_distinct) r where r <= 5 or r = 14) >= 3 then
      v_conn := true;
    end if;
  end if;

  return v_high || v_suitkind || case when v_paired then 'p' else 'u' end
         || case when v_conn then 'c' else 'd' end;
end;
$$;

comment on function public.fn_gto_texture_class_any(text) is
  'V30 texture class for 3/4/5-card boards. Three cards delegate to the shipped V29 flop classifier unchanged. MIRRORED by textureClass() in engine/GtoPostflop.ts; shared-example pins guard the contract.';

-- ── the cursor-driven aggregator ────────────────────────────────────────
-- The first version of fn_aggregate_gto_street_next lived here. It was
-- replaced wholesale by 20260829213000_v30_root_only_open_cells.sql (root
-- actions only, per-hand validation, open cells only) once the facing-cell
-- contamination was proven against production samples. The current
-- definition lives in that file; keeping a dead copy here would be a trap.

revoke all on function public.fn_gto_texture_class_any(text) from public, anon, authenticated;
grant execute on function public.fn_gto_texture_class_any(text) to service_role;
grant select, update on table public.gto_agg_progress to service_role;

-- ── assertions ──────────────────────────────────────────────────────────
do $$
declare v text;
begin
  -- 3-card delegation is byte-identical to the shipped flop classifier
  if public.fn_gto_texture_class_any('QhJdTh') is distinct from public.fn_gto_texture_class('QhJdTh') then
    raise exception '3-card texture diverged from the V29 classifier';
  end if;
  -- 4-card: turn pairs the board, two-tone -> flush possible at 3 suited? AhKh Qd Ah? use concrete:
  v := public.fn_gto_texture_class_any('QhJdTh2h'); -- 3 hearts = flush possible -> t
  if v is distinct from 'Btuc' then
    raise exception '4-card texture wrong: QhJdTh2h -> % (expected Btuc)', v;
  end if;
  v := public.fn_gto_texture_class_any('QhJdThAh9h'); -- 4+ hearts -> m, AKQJT... A high, straighty
  if v is distinct from 'Amuc' then
    raise exception '5-card texture wrong: QhJdThAh9h -> % (expected Amuc)', v;
  end if;
  v := public.fn_gto_texture_class_any('KhKd7c2s9d'); -- paired, rainbow-ish, K high, dry
  if v is distinct from 'Brpd' then
    raise exception '5-card texture wrong: KhKd7c2s9d -> % (expected Brpd)', v;
  end if;
end;
$$;
