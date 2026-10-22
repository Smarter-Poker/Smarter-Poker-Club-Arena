-- Companion to every_mtt_pays_the_top_twelve_point_five_percent_of_the_fiel. DML only.
BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '120s';

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
       AND t.status IN ('ANNOUNCED','SCHEDULED','PENDING','REGISTERING','RUNNING','COMPLETING','PAUSED')
       AND NOT COALESCE(t.prize_pool_finalized,false)
       AND NOT public.fn_tournament_payout_terms_committed_v1(t.id)
  LOOP
    BEGIN
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