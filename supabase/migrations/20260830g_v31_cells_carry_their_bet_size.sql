-- ═══════════════════════════════════════════════════════════════════════════
-- V31 cells must carry the SIZE, not just the bucket. (2026-08-30)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `hand_matrix` says how often each holding takes each bucket. It does not
-- say what the bucket IS in chips, and the buckets are wide: `bet_big` means
-- ">=110% of pot" and the turn's actual mean is 246.8% (range 117-263,
-- sd 36.6). A reader guessing the midpoint of that bucket would size the
-- solver's overbet at roughly a THIRD of what it is — which throws away the
-- entire reason V31 exists, because the v1 warehouse offers exactly one bet
-- size everywhere (b16, 16% of pot) and therefore cannot express a large
-- turn bet at all.
--
-- Sizes are near-deterministic per tree, so a per-cell mean is faithful
-- rather than a fudge: flop bet_small is exactly 33 (sd 0.0) and flop
-- bet_mid exactly 75 (sd 0.0), measured over 4,000 sampled rows.
--
-- Size is CELL-level, not per hand: the solver offers one size per action to
-- every holding in the range, so storing it per hand key would be 500-odd
-- copies of the same number.
--
-- THE CURSOR IS RESET AND THE TABLE TRUNCATED. Only 1,350 of ~1.89M rows had
-- been folded (77 cells), so redoing them costs minutes — and a table where
-- some cells know their size and others do not is worse than an empty one,
-- because the reader cannot tell which is which.
--
-- NOTE FOR THE RECORD: the aggregator body shipped in this migration used
-- `max(z.size_map)` to carry the size through the `cells` CTE, and there is
-- no `max(jsonb)` in Postgres. The DDL applied cleanly and the function
-- failed on its first CALL — DDL succeeding is not the same as the code
-- working. It is corrected in 20260830h_v31_size_aggregate_fix.sql, which
-- carries the working body; the schema change and the reset below are
-- exactly as applied.
--
-- TIER 2: adds a defaulted column, resets a one-time build cursor. No
-- existing behaviour is altered and nothing read the table at the time.

alter table public.gto_postflop_v31
  add column if not exists size_pct jsonb not null default '{}'::jsonb;

comment on column public.gto_postflop_v31.size_pct is
  'Mean solver bet size as a percentage of pot, per action bucket, e.g. {"bet_big": 246.8}. Cell-level because the solver offers one size per action to the whole range. Read by the engine to size a bet from data instead of a bucket midpoint.';

-- start clean so no cell is left without a size
truncate table public.gto_postflop_v31;
update public.gto_agg_progress_v31
   set last_at = null, last_id = null, rows_done = 0, done = false, updated_at = now()
 where only_row;

do $$
declare v_n integer;
begin
  select count(*) into v_n from information_schema.columns
   where table_schema='public' and table_name='gto_postflop_v31' and column_name='size_pct';
  if v_n <> 1 then raise exception 'gto_postflop_v31.size_pct missing'; end if;

  select count(*) into v_n from public.gto_postflop_v31;
  if v_n <> 0 then raise exception 'gto_postflop_v31 not truncated (% rows)', v_n; end if;

  select rows_done into v_n from public.gto_agg_progress_v31;
  if v_n <> 0 then raise exception 'cursor not reset (rows_done=%)', v_n; end if;
end $$;

-- ROLLBACK:
--   alter table public.gto_postflop_v31 drop column if exists size_pct;
--   then re-apply the aggregator body from 20260830e_v31_aggregator_rpc_budget.sql
