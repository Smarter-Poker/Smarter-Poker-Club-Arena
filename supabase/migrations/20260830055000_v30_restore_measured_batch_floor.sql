-- ════════════════════════════════════════════════════════════════════════
-- V30 — restore the measured batch floor that a full-body replace clobbered
-- (Dan 2026-08-30)
-- ════════════════════════════════════════════════════════════════════════
--
-- WHAT HAPPENED. At 05:36 UTC I reverted an optimization of
-- fn_aggregate_gto_street_next that had proven slower in production. The
-- revert was a full CREATE OR REPLACE built from a copy of the body fetched
-- BEFORE migration 20260830040000 landed, so it silently restored
-- `greatest(200, ...)` over that migration's measured `greatest(25, ...)`.
--
-- The deployed driver passes p_batch = 100. My clamp raised it back to 200,
-- which is precisely the timeout cliff 20260830040000 existed to get off:
-- cost is super-linear in batch size because a populated
-- gto_postflop_compact sends nearly every batch down the ON CONFLICT merge
-- path (measured: 100 rows ~0.9s / 111 rows per second; 200 rows ~8s with
-- one call in three cancelled, 57014).
--
-- Nothing caught it. The migration gate checks that declared objects EXIST,
-- not that a later migration did not overwrite an earlier one's tuning, and
-- both migrations were legitimately applied. It surfaced only because the
-- throughput was re-measured afterwards.
--
-- THE FIX, AND THE PATTERN. Patch the clamp surgically against the LIVE
-- catalog and refuse to guess if the text is not what is expected. Never
-- re-assert a whole function body from a stale copy while other agents are
-- shipping to the same object.
--
-- Idempotent: if the floor is already 25 this migration does nothing.
--
-- VERIFIED AFTER APPLYING, by rate rather than by absence of error:
--   170,750 rows @ 05:40:37  ->  173,550 @ 05:41:43  =  ~42 rows/second.

do $$
declare
  v_src text;
begin
  select prosrc into v_src
    from pg_proc
   where proname = 'fn_aggregate_gto_street_next'
     and pronamespace = 'public'::regnamespace;

  if v_src is null then
    raise exception 'fn_aggregate_gto_street_next is missing - nothing to patch';
  end if;

  if position('greatest(25, least(5000' in v_src) > 0 then
    raise notice 'batch floor already 25 - nothing to do';
    return;
  end if;

  if position('greatest(200, least(5000' in v_src) = 0 then
    raise exception
      'clamp is neither greatest(25,...) nor greatest(200,...) - aborting rather than guessing';
  end if;

  execute format(
    'create or replace function public.fn_aggregate_gto_street_next('
    'p_street text, p_batch integer default 1500) '
    'returns table (processed integer, new_last_id uuid, street_done boolean) '
    'language plpgsql security definer set search_path = public as %L',
    replace(v_src, 'greatest(200, least(5000', 'greatest(25, least(5000'));
end $$;

comment on function public.fn_aggregate_gto_street_next(text, integer) is
'V30 cursor-driven batch aggregator for turn/river OPEN cells. Root-node actions only (tree_lines r:0:X); per-hand validated and renormalized; TRUNCATE not DELETE (PostgREST roles refuse an unqualified DELETE, 21000).
BATCH FLOOR IS 25 AND WAS MEASURED, NOT GUESSED (20260830040000): cost is super-linear in batch size because a populated gto_postflop_compact sends nearly every batch down the ON CONFLICT merge path - 100 rows ~0.9s (111 rows/s), 200 rows ~8s and one call in three cancelled. The engine driver passes 100.
DO NOT CREATE OR REPLACE THIS FUNCTION FROM A COPY YOU FETCHED EARLIER. On 2026-08-30 a full-body replace silently reverted that floor to 200 and put the aggregation back on the timeout cliff; the cursor froze for ~4 minutes until it was patched back. Read prosrc first and patch surgically, or re-derive from the newest migration on main.';

-- assertion: the floor is what the driver needs
do $$
declare v_clamp text;
begin
  select substring(prosrc from 'v_batch integer :=[^;]+;') into v_clamp
    from pg_proc
   where proname = 'fn_aggregate_gto_street_next'
     and pronamespace = 'public'::regnamespace;
  if v_clamp not like '%greatest(25,%' then
    raise exception 'batch floor is not 25 after patching: %', v_clamp;
  end if;
end $$;
