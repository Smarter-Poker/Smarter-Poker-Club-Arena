-- Tier 2: data repair. 10 tournaments were flipped to COMPLETED by
-- 20260823100000_unstick_the_seatless_spins.sql without stamping ended_at,
-- making them invisible to sweeps that filter on ended_at.
DO $$
DECLARE v_count int;
BEGIN
  UPDATE tournaments
  SET ended_at = COALESCE(ended_at, started_at, updated_at)
  WHERE status = 'COMPLETED' AND ended_at IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RAISE NOTICE 'backfilled ended_at on % tournaments', v_count;
  IF EXISTS (SELECT 1 FROM tournaments WHERE status='COMPLETED' AND ended_at IS NULL) THEN
    RAISE EXCEPTION 'ended_at backfill incomplete';
  END IF;
END $$;
