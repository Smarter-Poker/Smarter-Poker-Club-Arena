-- 20260816_hand_state_snapshots_retention.sql
--
-- Retention for public.hand_state_snapshots. APPLIED LIVE 2026-08-16 16:29 UTC.
-- Safe to re-run.
--
-- ── What this table is ───────────────────────────────────────────────────────
-- Crash-recovery state: the engine writes a snapshot of an in-progress hand so
-- a restarted process can resume it. It is not a historical record — hand
-- outcomes live in hand_history.
--
-- ── Why 97% of it was garbage ────────────────────────────────────────────────
-- The engine reads snapshots in exactly two places, and BOTH filter on
-- is_complete = false (server/src/services/supabase/snapshots.ts:143 and :176),
-- with the second taking only the newest row per table:
--
--     .eq('table_id', tableId).eq('is_complete', false)
--     .order('updated_at', { ascending: false }).limit(1)
--
-- A snapshot with is_complete = true is therefore never read by anything, ever.
-- Measured before this migration: 1,386,048 of 1,424,382 rows (97.3%) were
-- complete, across 43,833 distinct table_ids, oldest 2026-04-13, with the table
-- at 5.4 GB and growing without bound.
--
-- ── Policy ───────────────────────────────────────────────────────────────────
--   is_complete = true   -> keep 7 days   (nothing reads these; 7d is a
--                                          forensic window, not a requirement)
--   is_complete = false  -> keep 30 days  (a hand in flight for a month does
--                                          not exist; these are orphans from
--                                          tables that died mid-hand)
--
-- Deleting only OLD rows cannot remove the newest incomplete snapshot for a live
-- table, so engine recovery is unaffected.
--
-- ── Shape ────────────────────────────────────────────────────────────────────
-- Same as sp_prune_hand_history: batched and self-limiting, one bounded
-- statement per call, ordered oldest-first through idx_hand_state_snapshots_created_at.
-- Measured 2,500 rows in 2.44s. Scheduled every 2 minutes at 5,000 while the
-- ~1.0M backlog burns down; drop to a lower rate afterwards if desired.
--
-- EXECUTE is revoked from anon/authenticated: it is SECURITY DEFINER and
-- deletes rows, which is exactly the combination that made sp_prune_hand_history
-- callable from a browser earlier today.

create or replace function public.sp_prune_hand_state_snapshots(p_batch int default 5000)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted int;
begin
  with doomed as (
    select id from public.hand_state_snapshots
     where (is_complete = true  and created_at < now() - interval '7 days')
        or (is_complete = false and created_at < now() - interval '30 days')
     order by created_at
     limit p_batch
  )
  delete from public.hand_state_snapshots h using doomed d where h.id = d.id;
  get diagnostics v_deleted = row_count;
  return v_deleted;
end
$$;

comment on function public.sp_prune_hand_state_snapshots(int) is
  'Retention for hand_state_snapshots. Completed snapshots are never read by the engine (snapshots.ts filters is_complete=false) and are kept 7 days; incomplete ones 30 days. Batched and self-limiting so it cannot hit a statement_timeout.';

revoke execute on function public.sp_prune_hand_state_snapshots(int)
  from public, anon, authenticated;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'sp_prune_hand_state_snapshots_2m') then
    perform cron.unschedule('sp_prune_hand_state_snapshots_2m');
  end if;
  perform cron.schedule(
    'sp_prune_hand_state_snapshots_2m',
    '*/2 * * * *',
    'select public.sp_prune_hand_state_snapshots(5000)'
  );
end
$$;

-- Note: DELETE does not return space to the OS. This bounds the table; it does
-- not shrink the file. A VACUUM FULL during a maintenance window would reclaim
-- the ~3.8 GB, at the cost of an ACCESS EXCLUSIVE lock for its duration.
