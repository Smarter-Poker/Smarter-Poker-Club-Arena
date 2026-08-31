-- ===========================================================================
-- THE ALARM THAT PROVES NO CHIPS VANISHED HAD STOPPED FINISHING (2026-08-31)
--
-- fn_unaccounted_seat_exits() is the only thing on this platform that can say
-- a seat left the felt carrying a non-zero stack and no wallet credit ever
-- landed. reconcile_ledger_nightly files each row it returns as CRITICAL.
--
-- Called at its own 7-day default it now EXCEEDS 60 SECONDS AND IS CANCELLED.
-- Only a hand-narrowed 24-hour window still completes. An alarm that times out
-- does not report zero, it reports nothing, and nothing looks exactly like
-- zero from the outside.
--
-- ---------------------------------------------------------------------------
-- WHERE THE TIME WENT - measured, not guessed
--
-- The two obvious suspects are innocent. EXPLAIN ANALYZE over 6 hours:
--
--   Nested Loop Anti Join ... Execution Time: 120.543 ms
--     Index Scan using idx_wallet_transactions_user_created
--       (actual time=0.043..0.043 rows=1 loops=819)
--
-- and the same anti-join across the full 7 days returns in seconds:
--
--   select count(*) ... 7 days, no matching credit  ->  1037 rows
--
-- The cost is the THIRD clause, the one that forgives an exit already repaid
-- by hand:
--
--   AND NOT EXISTS (SELECT 1 FROM wallet_transactions wt
--     WHERE wt.user_id = e.user_id AND wt.type = 'credit'
--       AND wt.description ILIKE 'Correction: seat exit ' || e.id || '%')
--
-- ILIKE against a concatenation is unindexable, so this is a sequential scan
-- of 2,480,976 wallet_transactions rows, RUN ONCE PER SURVIVING EXIT. There
-- are 1,037 of those. Only 1,040 rows in that table match the prefix at all -
-- the scan throws away 2.48 million rows a thousand times over to find them.
--
-- Fixed by asking the question once: the correction rows are collected in a
-- MATERIALIZED cte and anti-joined on a parsed exit id. Same answer, and it
-- finishes.
--
-- ---------------------------------------------------------------------------
-- A LATENT WRONG ANSWER GOES WITH IT
--
-- `ILIKE 'Correction: seat exit ' || e.id || '%'` is a PREFIX match on a
-- number. A correction written for exit 51 also matches exit 5, so exit 5
-- would be forgiven a repayment it never received - the alarm silently
-- clearing a real loss. Not hit yet (checked: 0 prefix collisions among the
-- 1,040 correction ids today), but it is one busy day away. Parsing the id
-- with a bounded regex cannot make that mistake.
--
-- ---------------------------------------------------------------------------
-- EQUIVALENCE, CHECKED AGAINST PRODUCTION BEFORE THIS WAS WRITTEN
--
--   candidates (7d, cash tables, no matching credit)   1037
--   of those, matched to a hand-written correction     1037
--   unaccounted after the correction clause               0
--   prefix collisions among correction ids                0
--
-- Identical to what the old body returns over the windows where the old body
-- can still be made to finish.
--
-- Signature, volatility, security and search_path are unchanged, so grants
-- survive CREATE OR REPLACE and no caller has to change.
-- ===========================================================================

begin;

-- PRE-FLIGHT
do $$
begin
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'fn_unaccounted_seat_exits'
  ) then
    raise exception 'PRE-FLIGHT: fn_unaccounted_seat_exits does not exist; this migration replaces it, it does not invent it';
  end if;

  if to_regclass('public.ca_seat_stack_exits') is null then
    raise exception 'PRE-FLIGHT: public.ca_seat_stack_exits is missing';
  end if;

  if to_regclass('public.wallet_transactions') is null then
    raise exception 'PRE-FLIGHT: public.wallet_transactions is missing';
  end if;
end $$;

-- THE CHANGE
create or replace function public.fn_unaccounted_seat_exits(
  p_since interval default '7 days'::interval,
  p_grace interval default '00:10:00'::interval
)
returns table(
  exit_id bigint, occurred_at timestamp with time zone, user_id uuid,
  table_id uuid, club_id uuid, stack numeric, exit_kind text,
  db_role text, app_name text
)
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  -- MATERIALIZED on purpose. Inlined, the planner is free to re-run this once
  -- per candidate row, which is the sequential scan this migration exists to
  -- delete. There are ~1,040 rows in here; collecting them once is the point.
  with corrected as materialized (
    select distinct
           nullif(substring(wt.description from 'Correction: seat exit ([0-9]+)'), '')::bigint as exit_id
      from public.wallet_transactions wt
     where wt.type = 'credit'
       and wt.description like 'Correction: seat exit %'
  )
  SELECT e.id, e.occurred_at, e.user_id, e.table_id, e.club_id,
         e.stack, e.exit_kind, e.db_role, e.app_name
  FROM public.ca_seat_stack_exits e
  WHERE e.occurred_at >= now() - p_since
    AND e.occurred_at <= now() - p_grace
    AND NOT EXISTS (
      SELECT 1 FROM public.tables t
       WHERE t.id = e.table_id AND t.tournament_id IS NOT NULL
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.wallet_transactions wt
       WHERE wt.user_id = e.user_id
         AND wt.type = 'credit'
         AND wt.created_at BETWEEN e.occurred_at - GREATEST(p_grace, interval '15 minutes')
                               AND e.occurred_at + p_grace
         AND wt.amount >= e.stack - 0.01
    )
    -- Was an unindexable per-row ILIKE on a concatenated prefix. Same
    -- intention, asked once, and it cannot forgive exit 5 for a correction
    -- written to exit 51.
    AND NOT EXISTS (
      SELECT 1 FROM corrected c WHERE c.exit_id = e.id
    )
  ORDER BY e.occurred_at DESC;
$function$;

-- POST-APPLY: BOTH HALVES
do $$
declare
  v_started timestamptz := clock_timestamp();
  v_rows    bigint;
  v_ms      numeric;
begin
  -- HALF ONE: the thing this migration promises - the 7-day DEFAULT finishes.
  select count(*) into v_rows from public.fn_unaccounted_seat_exits();
  v_ms := extract(epoch from (clock_timestamp() - v_started)) * 1000;

  if v_ms > 30000 then
    raise exception 'POST-APPLY: the 7-day default still took % ms; the rewrite did not fix it', round(v_ms);
  end if;
  raise notice 'POST-APPLY: 7-day default returned % row(s) in % ms', v_rows, round(v_ms);

  if v_rows < (select count(*) from public.fn_unaccounted_seat_exits('24 hours'::interval)) then
    raise exception 'POST-APPLY: the 7-day window reports FEWER unaccounted exits than the 24-hour window; the filter is wrong';
  end if;

  -- HALF TWO: the promise NOT to break anything.
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'fn_wallet_claim_back'
  ) then
    raise exception 'POST-APPLY: fn_wallet_claim_back has gone missing';
  end if;

  if not has_function_privilege('service_role', 'public.fn_unaccounted_seat_exits(interval, interval)', 'EXECUTE') then
    raise exception 'POST-APPLY: service_role lost EXECUTE on fn_unaccounted_seat_exits; reconcile_ledger_nightly could not call it';
  end if;
end $$;

commit;

-- ===========================================================================
-- ROLLBACK
--
-- Restores the previous body verbatim. It is correct, merely too slow to
-- finish at its own default - so rolling back returns the alarm to reporting
-- nothing, and that is a decision, not a repair.
--
--   CREATE OR REPLACE FUNCTION public.fn_unaccounted_seat_exits(
--     p_since interval DEFAULT '7 days'::interval,
--     p_grace interval DEFAULT '00:10:00'::interval)
--   RETURNS TABLE(exit_id bigint, occurred_at timestamptz, user_id uuid,
--                 table_id uuid, club_id uuid, stack numeric, exit_kind text,
--                 db_role text, app_name text)
--   LANGUAGE sql STABLE SECURITY DEFINER
--   SET search_path TO 'public', 'pg_temp'
--   AS $function$
--     SELECT e.id, e.occurred_at, e.user_id, e.table_id, e.club_id,
--            e.stack, e.exit_kind, e.db_role, e.app_name
--     FROM public.ca_seat_stack_exits e
--     WHERE e.occurred_at >= now() - p_since
--       AND e.occurred_at <= now() - p_grace
--       AND NOT EXISTS (SELECT 1 FROM public.tables t
--                        WHERE t.id = e.table_id AND t.tournament_id IS NOT NULL)
--       AND NOT EXISTS (SELECT 1 FROM public.wallet_transactions wt
--                        WHERE wt.user_id = e.user_id AND wt.type = 'credit'
--                          AND wt.created_at BETWEEN e.occurred_at - GREATEST(p_grace, interval '15 minutes')
--                                                AND e.occurred_at + p_grace
--                          AND wt.amount >= e.stack - 0.01)
--       AND NOT EXISTS (SELECT 1 FROM public.wallet_transactions wt
--                        WHERE wt.user_id = e.user_id AND wt.type = 'credit'
--                          AND wt.description ILIKE 'Correction: seat exit ' || e.id || '%')
--     ORDER BY e.occurred_at DESC;
--   $function$;
-- ===========================================================================
