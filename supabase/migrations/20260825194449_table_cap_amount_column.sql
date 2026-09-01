-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260825194449; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- Dan 2026-08-25, table-creation parity: "Cap" has been a toggle on the
-- creation screens with NO NUMBER BEHIND IT. cap_enabled is the only cap
-- column in the schema; the nearby rake_cap_bb is the rake cap and unrelated.
-- A boolean on its own cannot cap anything, so the engine had nothing to
-- enforce even if it had been reading the flag.
--
-- cap_bb is the ceiling in BIG BLINDS, matching how every other limit on this
-- table is authored (min_buyin_bb, max_buyin_bb, rake_cap_bb, ante_bb) so it
-- survives a blind change. NULL and 0 both mean uncapped, which keeps every
-- existing row exactly as it behaves today.

ALTER TABLE public.tables
  ADD COLUMN IF NOT EXISTS cap_bb numeric(10,2);

COMMENT ON COLUMN public.tables.cap_bb IS
  'Per-hand betting cap in big blinds. Enforced only when cap_enabled is true. NULL or 0 means uncapped.';

DO $verify$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'tables' AND column_name = 'cap_bb'
  ) THEN
    RAISE EXCEPTION 'cap_bb was not created';
  END IF;

  -- Nothing may have been given a cap by this migration: it is additive only.
  IF EXISTS (SELECT 1 FROM public.tables WHERE cap_bb IS NOT NULL) THEN
    RAISE EXCEPTION 'cap_bb arrived populated - this migration must not change behaviour';
  END IF;
END
$verify$;

-- ROLLBACK
--   ALTER TABLE public.tables DROP COLUMN IF EXISTS cap_bb;
-- Safe while nothing reads it. Once the engine enforces the cap, dropping it
-- silently uncaps every capped table, so revert the engine first.
