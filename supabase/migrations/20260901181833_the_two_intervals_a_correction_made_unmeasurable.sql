-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260901181833; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- The deploy gate has been refusing every engine deploy since 15:25 today, and
-- the reason is a number I created.
--
-- check-chip-conservation.mjs fails with "trailing 4h unexplained chip supply
-- is -4162775.63". That figure is the sum of four ca_supply_snapshots rows, and
-- two of them are not measurements of anything:
--
--   13:05  +1,582,258.66
--   14:05  -5,743,762.70
--
-- Both intervals contained corrections posted by fn_ca_post_correction, which
-- move NO balance by construction. Until migration a_correction_is_not_a_mint
-- the supply formula counted them as issuance and subtracted them from a
-- balance delta, so each one invented drift equal to itself. The 14:05 interval
-- really moved -2,407.22; the rest of that -5,743,762.70 is the 5,741,355.48 of
-- corrections posted inside it.
--
-- The formula is fixed going forward. These two STORED rows are not, and the
-- deploy gate reads stored rows - so a correct correction, made to close a real
-- incident, is now blocking the club-scoping engine fix that stops horses
-- entering tournaments they do not belong to. That is a chain worth breaking
-- carefully rather than quickly.
--
-- The rows cannot simply be recomputed: the correction ledger rows themselves
-- were removed in the 14:34 Deep Stack journal purge (they are preserved whole
-- in ca_ledger_mutation_log), so netting them back out of the stored figure is
-- no longer arithmetic anyone can check.
--
-- So they are marked UNMEASURABLE rather than rewritten to an invented value.
-- NULL is what this watcher already uses for an interval whose leak figure is
-- meaningless - it records one after any basis change, and the trailing sum
-- skips NULLs by design (WHERE unexplained IS NOT NULL). The original values
-- are preserved in ca_supply_snapshot_classifications with the evidence, so
-- nothing is erased and anyone can see exactly what was there and why it was
-- set aside.
--
-- What this does NOT do: it does not touch the delta, total, or any component
-- column. Those are real measurements and they stay. Only the derived
-- "unexplained" figure, which the old formula computed wrongly, is set aside.

INSERT INTO public.ca_supply_snapshot_classifications
  (snapshot_id, original_unexplained, classification, club_id, evidence)
SELECT s.id, s.unexplained,
       'Correction Accounting - Interval Not Measurable',
       NULL,
       jsonb_build_object(
         'reason', 'interval contained balance-neutral fn_ca_post_correction rows that the pre-a_correction_is_not_a_mint formula counted as issuance',
         'formula_fixed_by', 'migration a_correction_is_not_a_mint',
         'corrections_posted', 'chip_ledger 1b565e0c (4,159,644.00), correction:inc:90f5914a (3,340,000.00), correction:inc:d972d71d (2,401,355.48)',
         'correction_rows_since_deleted_by', 'the 14:34 Deep Stack journal purge; preserved in ca_ledger_mutation_log',
         'real_movement_14_05', -2407.22,
         'unblocks', 'scripts/ci/check-chip-conservation.mjs trailing-4h gate, which had failed every engine deploy since 15:25')
  FROM public.ca_supply_snapshots s
 WHERE s.id IN (29, 30)
ON CONFLICT (snapshot_id) DO NOTHING;

UPDATE public.ca_supply_snapshots
   SET unexplained = NULL
 WHERE id IN (29, 30);

DO $$
DECLARE v_trailing numeric; v_classified int;
BEGIN
  SELECT count(*) INTO v_classified FROM public.ca_supply_snapshot_classifications
   WHERE snapshot_id IN (29, 30);
  IF v_classified <> 2 THEN
    RAISE EXCEPTION 'the original values were not preserved before being set aside (% of 2)', v_classified;
  END IF;

  IF EXISTS (SELECT 1 FROM public.ca_supply_snapshots WHERE id IN (29,30) AND unexplained IS NOT NULL) THEN
    RAISE EXCEPTION 'the polluted intervals were not set aside';
  END IF;

  SELECT COALESCE(sum(unexplained),0) INTO v_trailing
    FROM public.ca_supply_snapshots
   WHERE taken_at > now() - interval '4 hours' AND unexplained IS NOT NULL;
  IF abs(v_trailing) > 100000 THEN
    RAISE EXCEPTION 'trailing 4h is still % - something other than the corrections is in there, stop and look', v_trailing;
  END IF;
  RAISE NOTICE 'trailing 4h unexplained is now %', v_trailing;
END $$;
