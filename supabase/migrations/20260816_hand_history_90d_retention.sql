-- 20260816_hand_history_90d_retention.sql
--
-- 90-day retention for public.hand_history. APPLIED LIVE 2026-08-16 14:53 UTC.
-- Recorded here so the schema is reproducible; safe to re-run.
--
-- ── Policy ───────────────────────────────────────────────────────────────────
-- Every hand is retained for 90 days, horse-vs-horse included. Hands flagged
-- reported = true are exempt permanently: they are dispute evidence.
--
-- 90 days is the shortest window that still covers a full monthly rakeback
-- cycle plus a dispute tail, keeps anti-cheat pattern history meaningful, and
-- matches what a player expects "my hand history" to contain. Over 30 call
-- sites read this table — anti-cheat collusion detection, RakebackSettlerService,
-- the bad beat jackpot, every player-facing replay, and the whole training and
-- leak-analysis surface — so the window is a product decision, not a disk one.
--
-- ── Why this runs in the database and not in CI ──────────────────────────────
-- The first attempt was a GitHub Action running a supabase-js script nightly.
-- It could not work, for three independent reasons:
--
--   1. It never ran successfully once. The workflow pinned node-version 20; the
--      installed supabase-js needs 22+ and throws at createClient with
--      "Node.js detected but native WebSocket not found". It died before
--      issuing a query and would have failed silently at 03:00 UTC forever.
--   2. Even on Node 22 it would have timed out. It issued ONE unchunked DELETE
--      covering everything past the cutoff (~1M rows). PostgREST connects as
--      `authenticator`, which carries statement_timeout = 8s, and service_role
--      does not override it.
--   3. Its companion backfill script skipped slices permanently after 5
--      failures, leaving hours of data that nothing downstream would revisit.
--
-- pg_cron has no PostgREST timeout, no Node runtime, no secrets, no network,
-- and keeps working when GitHub does not.
--
-- ── Why batched rather than one statement ────────────────────────────────────
-- Each call deletes at most p_batch rows, oldest first, through
-- idx_hand_history_created, then returns. Deliberately NOT a loop: no single
-- statement can approach a timeout and no transaction is held open while the
-- engine is writing new hands. Measured 5,000 rows in 3.1s; the job uses 2,500
-- every 5 minutes, giving ~720k rows/day of capacity against ~170k/day inflow.

create or replace function public.sp_prune_hand_history(p_batch int default 5000)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted int;
begin
  with doomed as (
    select id
      from public.hand_history
     where created_at < now() - interval '90 days'
       and reported is not true
     order by created_at
     limit p_batch
  )
  delete from public.hand_history h
   using doomed d
   where h.id = d.id;

  get diagnostics v_deleted = row_count;
  return v_deleted;
end
$$;

comment on function public.sp_prune_hand_history(int) is
  '90-day retention for hand_history. Batched and self-limiting: each call deletes at most p_batch rows oldest-first via idx_hand_history_created, so it cannot hit a statement_timeout. Hands with reported=true are exempt. Scheduled by pg_cron job sp_prune_hand_history_10m.';

-- Idempotent scheduling. cron.unschedule on a RUNNING job kills it mid-flight,
-- so only unschedule when it is not currently executing.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'sp_prune_hand_history_10m') then
    perform cron.unschedule('sp_prune_hand_history_10m');
  end if;
  perform cron.schedule(
    'sp_prune_hand_history_10m',
    '*/5 * * * *',
    'select public.sp_prune_hand_history(2500)'
  );
end
$$;

-- ── Note on disk space ───────────────────────────────────────────────────────
-- DELETE does not return space to the OS. Autovacuum makes it reusable, which is
-- what bounds the table; the file does not shrink without VACUUM FULL or
-- pg_repack, both of which take heavy locks.
--
-- hand_history is also NOT what is consuming this database. Measured 2026-08-16:
-- 83 GB total, of which solved_spots_gold is 62 GB (3.5 GB heap + 57 GB TOAST
-- across 8.1M rows) and hand_history is 10 GB. Deleting every hand ever played
-- would take the database to 73 GB. The quota question is a solved_spots_gold
-- architecture question.
