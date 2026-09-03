-- 20260822233000_prune_snapshots_bounded_scan.sql
--
-- INCIDENT (2026-08-22): sp_prune_hand_state_snapshots ran 51s mean / 106s max
-- (pg_stat_statements, 6 calls) pinned in DataFileRead, starving the whole
-- instance. Browser-visible symptom: clubs select 26.7s, /auth/v1/user 14.5s,
-- ClubHomePage 15s watchdog fired -> the intermittent "Still Loading" screen
-- Dan first hit on 2026-08-20.
--
-- ROOT CAUSE: the prune predicate was a bare OR of two age branches:
--   (is_complete AND created_at < now()-'7 days')
--   OR (NOT is_complete AND created_at < now()-'30 days')
-- The planner cannot derive a single created_at range bound from that OR, so
-- the query was "Index Scan Backward ... Filter: (...)" over the ENTIRE
-- created_at index (1.38M rows, 6.3GB relation). With only ~3k prunable rows,
-- LIMIT 5000 was never satisfied and every call scanned the whole table.
--
-- FIX: hoist the common bound - every prunable row is older than 7 days - to a
-- top-level created_at predicate. Plan becomes
--   "Index Cond: (created_at < now()-'7 days')" + cheap residual filter,
-- so the scan stops at the cutoff instead of walking 1.38M young rows.
-- Verified via EXPLAIN on production before applying: cost 1,246,494 -> 118,323
-- and, decisively, bounded by row age rather than table size.
--
-- Retention semantics are UNCHANGED: complete rows kept 7 days, incomplete 30.

create or replace function public.sp_prune_hand_state_snapshots(p_batch integer default 5000)
 returns integer
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_deleted int;
begin
  -- Completed snapshots are crash-recovery state for a hand that has already
  -- finished. The engine reads ONLY is_complete = false (snapshots.ts:143,176),
  -- and only the newest row per table, so a completed snapshot is never read by
  -- anything. 7 days keeps a forensic window well past any plausible
  -- investigation. Incomplete rows are kept 30 days: a hand in flight for a
  -- month does not exist, those are orphans from tables that died mid-hand.
  --
  -- created_at < now()-'7 days' is hoisted out of the OR so the planner gets a
  -- range bound on idx_hand_state_snapshots_created_at. Do NOT fold it back
  -- into the branches: the bare OR forces a full-index scan (2026-08-22
  -- incident, see header).
  with doomed as (
    select id from public.hand_state_snapshots
     where created_at < now() - interval '7 days'
       and (is_complete = true
            or created_at < now() - interval '30 days')
     order by created_at
     limit p_batch
  )
  delete from public.hand_state_snapshots h using doomed d where h.id = d.id;
  get diagnostics v_deleted = row_count;
  return v_deleted;
end
$function$;

-- Post-apply assertion: the function must still exist with the same signature
-- (one integer arg, returns integer), so every existing caller keeps working.
do $$
begin
  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'sp_prune_hand_state_snapshots'
      and p.pronargs = 1
      and p.prorettype = 'integer'::regtype
  ) then
    raise exception 'sp_prune_hand_state_snapshots signature changed - rollback';
  end if;
end $$;
