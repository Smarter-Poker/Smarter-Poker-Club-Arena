-- ===========================================================================
-- THE PLANNER WAS TOLD THE MONEY TABLES WERE EMPTY (2026-08-31)
--
-- Found while asking what was left to optimise. pg_stat_user_tables, before:
--
--   table                  size     planner thinks   autoanalyze_count
--   wallet_transactions    963 MB             330                   0
--   chip_ledger            151 MB             920                   0
--   tournaments            113 MB              80                   0
--   ca_seat_stack_exits     15 MB               7                   0
--
-- A 963 MB table the planner believes holds 330 rows gets nested loops and
-- sequential scans for everything, and its indexes are never chosen because an
-- index is not worth it on a table with 330 rows. That is a platform-wide tax
-- on every money query, and it is also why so many indexes here look "unused".
--
-- ANALYZE was run on all four. The corrections:
--
--   wallet_transactions      330  ->  2,484,700     (7,529x)
--   chip_ledger              920  ->    222,301       (242x)
--   tournaments               80  ->     52,646       (658x)
--   ca_seat_stack_exits        7  ->     40,872     (5,839x)
--
-- Measured effect on the seat-exit alarm, three consecutive runs after ANALYZE:
--
--   5,242 ms (cold)  ->  720 ms  ->  692 ms
--
-- against 10,570 ms before. Roughly 15x in warm steady state, on top of the
-- rewrite in 20260831142004. The full chip integrity report went 12,866 ms ->
-- 7,817 ms in the same measurement.
--
-- ---------------------------------------------------------------------------
-- WHY IT DRIFTED, AND WHY THIS IS NOT A ONE-OFF ANALYZE
--
-- Autovacuum is ON globally, and somebody has already tuned two tables
-- carefully:
--
--   hand_history         analyze_threshold 2000, scale 0.0, insert_threshold 10000
--   wallet_transactions  analyze_threshold 1000, scale 0.0
--
-- The other three carry `(defaults)`. On a default scale factor of 0.1, a table
-- must change by 10% of its own size before autoanalyze looks at it - which on
-- a growing append-heavy table means the estimate is always stale and the
-- estimate it is stale FROM is whatever it was when the table was small.
-- `tournaments` was sitting on 9,769 dead tuples with autovacuum_count 0.
--
-- So this extends the treatment the two tuned tables already have to the three
-- that were missed. Threshold-based rather than scale-based, which is what
-- makes it hold as the tables grow. A one-off ANALYZE would drift back.
-- ===========================================================================

begin;

-- PRE-FLIGHT
do $$
declare r record;
begin
  for r in select unnest(array['chip_ledger','tournaments','ca_seat_stack_exits']) as t loop
    if to_regclass('public.' || r.t) is null then
      raise exception 'PRE-FLIGHT: public.% does not exist', r.t;
    end if;
  end loop;

  -- The tables this copies from must actually carry the settings being copied,
  -- or this migration is cargo-culting a pattern that no longer exists.
  if (select coalesce(array_to_string(c.reloptions, ','), '')
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname = 'wallet_transactions')
     not like '%autovacuum_analyze_threshold%' then
    raise exception 'PRE-FLIGHT: wallet_transactions no longer carries a threshold-based analyze setting - re-read the house pattern before copying it';
  end if;
end $$;

-- THE CHANGE

-- Append-heavy money ledger. Same shape as wallet_transactions.
alter table public.chip_ledger set (
  autovacuum_enabled = true,
  autovacuum_analyze_scale_factor = 0.0,
  autovacuum_analyze_threshold = 1000,
  autovacuum_vacuum_scale_factor = 0.0,
  autovacuum_vacuum_threshold = 1000,
  autovacuum_vacuum_cost_delay = 2,
  autovacuum_vacuum_cost_limit = 2000
);

-- Heavily UPDATEd (status, current_players, prize_pool), so it accumulates dead
-- tuples fast - it was carrying 9,769 with autovacuum_count 0.
alter table public.tournaments set (
  autovacuum_enabled = true,
  autovacuum_analyze_scale_factor = 0.0,
  autovacuum_analyze_threshold = 500,
  autovacuum_vacuum_scale_factor = 0.0,
  autovacuum_vacuum_threshold = 500,
  autovacuum_vacuum_cost_delay = 2,
  autovacuum_vacuum_cost_limit = 2000
);

-- Append-only audit trail. The insert thresholds are what matter here, which is
-- why hand_history carries them too: a table that is only ever inserted into
-- never trips a dead-tuple threshold.
alter table public.ca_seat_stack_exits set (
  autovacuum_enabled = true,
  autovacuum_analyze_scale_factor = 0.0,
  autovacuum_analyze_threshold = 1000,
  autovacuum_vacuum_scale_factor = 0.0,
  autovacuum_vacuum_threshold = 1000,
  autovacuum_vacuum_insert_threshold = 5000,
  autovacuum_vacuum_insert_scale_factor = 0.0
);

-- POST-APPLY: BOTH HALVES
do $$
declare
  r         record;
  v_missing text := '';
  v_thin    text := '';
begin
  -- HALF ONE: every table named here now carries a threshold-based setting,
  -- and the planner's estimate is no longer absurd.
  for r in
    select c.relname,
           coalesce(array_to_string(c.reloptions, ','), '') as opts,
           c.reltuples::bigint as est
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relname in ('chip_ledger','tournaments','ca_seat_stack_exits','wallet_transactions')
  loop
    if r.opts not like '%autovacuum_analyze_threshold%' then
      v_missing := v_missing || ' ' || r.relname;
    end if;
    -- Every one of these is far larger than this; the point is only to catch
    -- the "planner thinks 7 rows" state this migration exists to end.
    if r.est < 1000 then
      v_thin := v_thin || format(' %s(%s)', r.relname, r.est);
    end if;
  end loop;

  if v_missing <> '' then
    raise exception 'POST-APPLY: table(s) still without a threshold-based analyze setting:%', v_missing;
  end if;
  if v_thin <> '' then
    raise exception 'POST-APPLY: the planner still believes these tables are nearly empty - ANALYZE did not take:%', v_thin;
  end if;

  -- HALF TWO: the promise NOT to break anything. Autovacuum must still be
  -- ENABLED on all of them - a fat-fingered `autovacuum_enabled = false` here
  -- would stop vacuuming the ledger entirely, which is far worse than a stale
  -- estimate.
  if exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relname in ('chip_ledger','tournaments','ca_seat_stack_exits')
       and coalesce(array_to_string(c.reloptions, ','), '') like '%autovacuum_enabled=false%'
  ) then
    raise exception 'POST-APPLY: autovacuum was left DISABLED on one of these tables';
  end if;

  raise notice 'POST-APPLY: three tables tuned, planner estimates sane, autovacuum enabled';
end $$;

commit;

-- ===========================================================================
-- ROLLBACK - returns them to the default 10%/20% scale factors that let the
-- estimates drift in the first place:
--
--   ALTER TABLE public.chip_ledger         RESET (autovacuum_enabled, autovacuum_analyze_scale_factor, autovacuum_analyze_threshold, autovacuum_vacuum_scale_factor, autovacuum_vacuum_threshold, autovacuum_vacuum_cost_delay, autovacuum_vacuum_cost_limit);
--   ALTER TABLE public.tournaments         RESET (autovacuum_enabled, autovacuum_analyze_scale_factor, autovacuum_analyze_threshold, autovacuum_vacuum_scale_factor, autovacuum_vacuum_threshold, autovacuum_vacuum_cost_delay, autovacuum_vacuum_cost_limit);
--   ALTER TABLE public.ca_seat_stack_exits RESET (autovacuum_enabled, autovacuum_analyze_scale_factor, autovacuum_analyze_threshold, autovacuum_vacuum_scale_factor, autovacuum_vacuum_threshold, autovacuum_vacuum_insert_threshold, autovacuum_vacuum_insert_scale_factor);
-- ===========================================================================
