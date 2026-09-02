-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260830055157; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- rake_attributions is NOT deprecated any more (Dan 2026-08-29/30).
--
-- It earned its place on this list honestly: declared with a unique guard on
-- (hand_id, player_id) and never written by any live path — 0 rows.
--
-- The weighted contributed rake migration made it the AUTHORITATIVE
-- per-player rake ledger. atomic_distribute_rake writes one row per
-- contributor per hand inside the banking transaction (gross / returned /
-- eligible contribution, weight, weighted_rake_credit,
-- bbj_attributed_contribution, rake_method); fn_rake_shares_for_record serves
-- it to every SQL consumer; the settler reads it via
-- sharesForRakeRecordWithLedger; fn_hand_rake_breakdown and
-- ca_player_hand_rake_share answer disputes from it.
--
-- Leaving it listed would tell the next reader to go back to recomputing from
-- player_contributions — the dual-implementation shape that produced the
-- equal-dealt bug, the missing pot-overage clamp and the 49%-underfunded
-- jackpot. scripts/ci/check-deprecated-tables.mjs mirrors this table, and is
-- corrected in the same commit.
DELETE FROM public.deprecated_tables WHERE table_name = 'rake_attributions';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.deprecated_tables WHERE table_name = 'rake_attributions') THEN
    RAISE EXCEPTION 'rake_attributions still listed as deprecated';
  END IF;
  RAISE NOTICE 'rake_attributions removed from deprecated_tables — it is the live per-player rake ledger';
END $$;
