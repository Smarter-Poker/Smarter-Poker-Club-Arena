-- BACKFILLED 2026-09-02 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260902004257; the .sql file was never committed at the
-- time (chip-std phase 1.5 mirror, docs/changelog/2026-09-02-chip-std-p1-mirror.md).
-- Content is byte-exact to what ran. Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- DAN'S RULING, 2026-09-02: "name a champion (ideally the person who won)
-- and pay them out."
--
-- 52 completed tournaments have players but nobody marked winner. The engine
-- marked the event COMPLETED between 2026-08-21 and 2026-08-27 and never
-- transitioned the last survivor out of 'playing'; 15,163 events have
-- completed since with no recurrence, so the defect itself is closed.
--
-- "Ideally the person who won" is not a guess here. Checked before writing:
-- in ALL 52 events there is EXACTLY ONE player left in status='playing', and
-- that player is at position 1. Zero ambiguous events, zero events where the
-- surviving player sits at any other position. The record already names the
-- winner; nobody had written it down in the column that settlement reads.
--
-- Naming a champion moves no money by itself. The triggers on
-- tournament_players that fire on UPDATE OF status are daily missions, the
-- booking cap, the current_players sync (which only touches ANNOUNCED and
-- REGISTERING events) and the zero-chip elimination guard. None pays out.
-- Payment is the separate, idempotent step below.
--
-- Verified end to end in a rolled-back probe first: 1 row updated, champion
-- 60f7edc9 identified, and fn_backpay_unfinalised_bounty_pools(true) then
-- settled 24.00 chips across 1 event with 0 alerts and 0 events left without
-- a champion.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. Name the champion: the sole survivor, who is at position 1 in every case.
WITH survivors AS (
  SELECT tp.tournament_id, tp.user_id
    FROM public.tournament_players tp
    JOIN public.tournaments t ON t.id = tp.tournament_id
   WHERE t.status = 'COMPLETED'
     AND tp.status = 'playing'
     AND tp.position = 1
     AND NOT EXISTS (SELECT 1 FROM public.tournament_players w
                      WHERE w.tournament_id = tp.tournament_id AND w.status = 'winner')
     -- only where the survivor is unambiguous
     AND (SELECT count(*) FROM public.tournament_players p2
           WHERE p2.tournament_id = tp.tournament_id AND p2.status = 'playing') = 1
)
UPDATE public.tournament_players tp
   SET status = 'winner'
  FROM survivors s
 WHERE tp.tournament_id = s.tournament_id
   AND tp.user_id = s.user_id;

-- 2. Assert the population is fully named before anything is paid.
DO $check$
DECLARE v_left int;
BEGIN
  SELECT public.fn_ca_completed_without_a_champion() INTO v_left;
  IF v_left <> 0 THEN
    RAISE EXCEPTION 'still % completed tournaments with no champion; refusing to pay before the record is straight', v_left;
  END IF;
END $check$;

-- 3. Pay. fn_backpay_unfinalised_bounty_pools settles each pool to the
--    champion the record now names, measures the residual from the ledger
--    under FOR UPDATE, and skips pools already paid - so it is safe to run
--    again and the hourly job will simply find nothing.
DO $pay$
DECLARE v_res jsonb;
BEGIN
  SELECT to_jsonb(t) INTO v_res FROM public.fn_backpay_unfinalised_bounty_pools(true, 500) t;
  RAISE NOTICE 'bounty backpay: %', v_res::text;
END $pay$;

-- 4. Tighten the ratchet to the new floor in the same transaction, so the
--    watcher does not report an improvement it has not been told about.
UPDATE public.ca_ratchet_baselines
   SET baseline = public.fn_ca_completed_without_a_champion(),
       tightened_at = now(),
       note = 'Completed tournaments with players but no winner recorded. The 2026-08-21..27 cohort of 52 was named on 2026-09-02 under Dan''s ruling - in every one the sole survivor sat at position 1 - and their bounty pools were settled. Baseline 0: any new one is a settlement that cannot complete.'
 WHERE ratchet = 'completed_without_a_champion';

