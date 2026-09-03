-- Dan 2026-08-25, table-creation parity: "Cap" has been a toggle on the
-- creation screens with NO NUMBER BEHIND IT. cap_enabled is the only cap
-- column in the schema; the nearby rake_cap_bb is the rake cap and unrelated.
-- A boolean on its own cannot cap anything, so the engine had nothing to
-- enforce even if it had been reading the flag.
--
-- cap_bb is the ceiling in BIG BLINDS, matching how every other limit on this
-- table is authored (min_buyin_bb, max_buyin_bb, rake_cap_bb, ante_bb) so it
-- survives a blind change. NULL and 0 both mean uncapped, which keeps every
-- existing row behaving exactly as it does today.
--
-- APPLIED to production 2026-08-25 via the Supabase MCP.

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
END
$verify$;

-- ROLLBACK
--   ALTER TABLE public.tables DROP COLUMN IF EXISTS cap_bb;
-- Safe while nothing reads it. Once the engine enforces the cap, dropping it
-- silently uncaps every capped table, so revert the engine first.
