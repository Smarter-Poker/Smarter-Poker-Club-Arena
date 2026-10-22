-- ═══════════════════════════════════════════════════════════════════════════
-- Companion to 20261022014607 (every MTT pays the top 12.5% of the field).
-- DML only: no DDL, no schema reload, row locks only, so the live tables are
-- never held behind a table lock while ~225 rows are corrected.
--
-- Every live MTT (not a satellite, Spin or Sit & Go) whose prize pool is not
-- finalized and whose payout terms are not committed is set to 12.5: union and
-- Diamond events by law, standalone ones because every one held the old
-- default 10 (read on production 2026-10-22 01:44 UTC: 3 standalone chip
-- freezeouts, all at 10). ca_mtt_payout_depth_guard re-derives the value.
-- Committed and completed events are untouched.
-- ═══════════════════════════════════════════════════════════════════════════
-- @live-proof: (SELECT NOT EXISTS (SELECT 1 FROM public.tournaments t WHERE t.status IN ('ANNOUNCED','REGISTERING') AND upper(COALESCE(t.tournament_type,'')) = 'MTT' AND lower(COALESCE(t.variant,'')) NOT IN ('spin','sng','satellite') AND t.satellite_target_id IS NULL AND NOT COALESCE(t.prize_pool_finalized,false) AND t.payout_depth_percent IS NULL))
BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '120s';

-- ── Correct every live MTT whose payout terms are not yet committed ────
-- Per-row subtransactions: one row refused by an unrelated guard (a retired
-- club) must not block the rest; refusals are counted and named.
DO $backfill$
DECLARE
  r record;
  v_done int := 0;
  v_refused int := 0;
BEGIN
  FOR r IN
    SELECT t.id FROM public.tournaments t
     WHERE upper(COALESCE(t.tournament_type,'')) = 'MTT'
       AND lower(COALESCE(t.variant,'')) NOT IN ('spin','sng','satellite')
       AND t.satellite_target_id IS NULL
       AND NOT COALESCE(t.is_premium_spin,false)
       -- exact-case live statuses so idx_tournaments_status_start_time serves
       -- the scan rather than a sequential pass over 1.25 GB
       AND t.status IN ('ANNOUNCED','SCHEDULED','PENDING','REGISTERING','RUNNING','COMPLETING','PAUSED')
       AND NOT COALESCE(t.prize_pool_finalized,false)
       AND NOT public.fn_tournament_payout_terms_committed_v1(t.id)
  LOOP
    BEGIN
      -- 12.5 is the depth every live event should hold: union and Diamond
      -- events by law, standalone ones because none chose 15/20 (all held the
      -- old default 10). The guard re-derives and enforces either way.
      UPDATE public.tournaments SET payout_depth_percent = 12.5 WHERE id = r.id;
      v_done := v_done + 1;
    EXCEPTION WHEN OTHERS THEN
      v_refused := v_refused + 1;
      RAISE NOTICE 'payout depth backfill refused for %: %', r.id, SQLERRM;
    END;
  END LOOP;
  RAISE NOTICE 'payout depth backfill: % corrected, % refused', v_done, v_refused;
END $backfill$;

COMMIT;
