-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260901165657; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- =============================================================================
-- deep_stack_fee_and_rake_residue_wipe
--
-- Dan, 2026-09-01: "WIPE AWAY ANY CURRENT PLAYER FEES THAT WERE PREVIOUSLY
-- GENERATED, AS WELL AS ALL RAKE BBJ ETC. KEEP JUST THE CHIPS IN PLAY."
--
-- Clears the last fee/rake residue of the pre-green-light play: agent rake
-- counters (57.44), the club's lifetime rake tally (868.24), 558
-- rake_records rows, 112 tournament rake settlements — and re-clamps two
-- wallets that caught straggler backpays at 16:11:08 UTC (novavoss +9.51,
-- bishopthackeray +6.80) from old games whose history is wiped; the unpaid
-- settlement queue was verified EMPTY before this run, so no more arrive.
-- Chips in play asserted at exactly 4,160,000 / 3,340,000 on exit.
--
-- Mechanics: DELETE on rake_records fires the per-change reporting-repair
-- trigger (platform-wide rollup rebuild each time; 558 of them timed out
-- attempt one). Triggers are disabled around the delete and the rollup
-- repair runs ONCE for the affected window — the same net effect the
-- trigger guarantees.
-- =============================================================================
SET LOCAL statement_timeout = '600s';

ALTER TABLE public.rake_records DISABLE TRIGGER USER;
ALTER TABLE public.tournament_rake_settlements DISABLE TRIGGER USER;

DO $$
DECLARE
  v_club uuid := '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3';
  v_left int;
BEGIN
  UPDATE agents
     SET weekly_rake_generated = 0, lifetime_rake_generated = 0,
         lifetime_earnings = 0, updated_at = now()
   WHERE club_id = v_club
     AND (weekly_rake_generated <> 0 OR lifetime_rake_generated <> 0 OR lifetime_earnings <> 0);

  UPDATE clubs SET total_rake = 0 WHERE id = v_club AND total_rake <> 0;

  DELETE FROM rake_records WHERE club_id = v_club;
  DELETE FROM tournament_rake_settlements
   WHERE tournament_id IN (SELECT id FROM tournaments WHERE club_id = v_club);

  -- straggler backpays from wiped-history games: back to the clean 10,000
  UPDATE club_members SET chip_balance = 10000
   WHERE club_id = v_club AND is_bot AND chip_balance <> 10000;

  SELECT (SELECT count(*) FROM rake_records WHERE club_id=v_club)
       + (SELECT count(*) FROM tournament_rake_settlements trs
            JOIN tournaments t ON t.id=trs.tournament_id WHERE t.club_id=v_club)
    INTO v_left;
  IF v_left <> 0 THEN RAISE EXCEPTION '% residue rows remain', v_left; END IF;

  IF (SELECT coalesce(sum(weekly_rake_generated)+sum(lifetime_rake_generated)+sum(lifetime_earnings),0)
        FROM agents WHERE club_id=v_club) <> 0
     OR (SELECT total_rake FROM clubs WHERE id=v_club) <> 0 THEN
    RAISE EXCEPTION 'counters not zero';
  END IF;

  IF (SELECT sum(chip_balance) FROM club_members WHERE club_id=v_club AND is_bot) <> 4160000
     OR (SELECT sum(agent_wallet_balance) FROM agents WHERE club_id=v_club) <> 3340000 THEN
    RAISE EXCEPTION 'chips in play changed - refusing';
  END IF;
END $$;

ALTER TABLE public.rake_records ENABLE TRIGGER USER;
ALTER TABLE public.tournament_rake_settlements ENABLE TRIGGER USER;

SELECT public.ca_refresh_reporting_rollups('2026-08-31'::date, '2026-09-02'::date);
