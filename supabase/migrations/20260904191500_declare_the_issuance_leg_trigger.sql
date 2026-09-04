-- The undeclared-trigger guard shipped ~19:00 on 2026-09-04 and caught its
-- first real change within the hour: zz_ca_issuance_leg_is_registered, a
-- DEFERRABLE CONSTRAINT TRIGGER on chip_ledger that fires on any mint, burn,
-- issuance_reserve or chip_retirement leg.
--
-- It is legitimate. It arrived with PR #2984, "feat(chip-std): Phase 3 - one
-- Mint, no negatives, the legacy doors nobody calls are closed", which merged
-- to main minutes before the baseline in
-- 20260904182847_every_trigger_on_a_money_table_is_declared was seeded from
-- live - so it was created through a reviewed migration and simply missed the
-- snapshot by a few minutes.
--
-- Declaring it here rather than re-seeding the whole baseline, because that is
-- the workflow the guard exists to enforce: a trigger on a money table is
-- named by a human in a migration, once, with provenance. Re-snapshotting from
-- live would bless whatever happens to be there, which is exactly what the
-- guard is meant to prevent.

INSERT INTO public.ca_declared_money_triggers (table_name, trigger_name, note)
VALUES (
  'chip_ledger',
  'zz_ca_issuance_leg_is_registered',
  'Declared 2026-09-04. Arrived via PR #2984 (chip-std Phase 3, one Mint / no negatives), minutes after the baseline snapshot was taken. Constraint trigger requiring every system_mint / system_burn / issuance_reserve / chip_retirement leg on chip_ledger to be registered.'
)
ON CONFLICT (table_name, trigger_name) DO NOTHING;

DO $$
DECLARE v_undecl int;
BEGIN
  SELECT count(*) INTO v_undecl FROM public.fn_undeclared_money_triggers();
  IF v_undecl <> 0 THEN
    RAISE EXCEPTION
      'post-condition failed: % money-table trigger(s) still undeclared after this migration.',
      v_undecl;
  END IF;
  RAISE NOTICE 'all money-table triggers declared.';
END $$;
