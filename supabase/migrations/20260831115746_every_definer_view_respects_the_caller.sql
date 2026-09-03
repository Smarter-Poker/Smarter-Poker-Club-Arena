-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260831115746; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- Phase 3 follow-up. The first pass named two views; the advisor then reported
-- a THIRD (v_spin_unfilled_waits) that had been created earlier the same day by
-- 20260831060000_a_seat_that_waits_forever_gets_its_chips_back.sql. Naming views
-- one at a time loses that race by design, so this sweeps every view we own.
--
-- The house convention is already `security_invoker=true` - 40+ views carry it.
-- These were the stragglers, and v_spin_unfilled_waits is the one that matters:
-- it is granted to browser roles (3 grants), so as a DEFINER view it read rows
-- with the owner's rights on behalf of whoever asked. That is the RLS bypass
-- the advisor calls an ERROR. Neither view is referenced by app code, so
-- nothing legitimate loses access.

DO $$
DECLARE r record; n int := 0;
BEGIN
  FOR r IN
    SELECT c.relname
    FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
    WHERE ns.nspname = 'public'
      AND c.relkind = 'v'
      AND c.relowner = 'postgres'::regrole
      AND coalesce(array_to_string(c.reloptions, ','), '') NOT LIKE '%security_invoker=%'
  LOOP
    EXECUTE format('ALTER VIEW public.%I SET (security_invoker = true)', r.relname);
    n := n + 1;
  END LOOP;
  RAISE NOTICE 'converted % view(s) to security_invoker', n;
END $$;

-- Normalise the two set to `on` in the previous migration so the whole estate
-- reads the same way.
ALTER VIEW public.v_spin_unpaid_settlements SET (security_invoker = true);
ALTER VIEW public.v_spin_draw_booking_gaps  SET (security_invoker = true);

DO $$
DECLARE v_left int;
BEGIN
  SELECT count(*) INTO v_left
  FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
  WHERE ns.nspname = 'public' AND c.relkind = 'v'
    AND c.relowner = 'postgres'::regrole
    AND coalesce(array_to_string(c.reloptions, ','), '') NOT LIKE '%security_invoker=%';
  IF v_left <> 0 THEN
    RAISE EXCEPTION 'post-apply failed: % view(s) we own still lack security_invoker', v_left;
  END IF;
  RAISE NOTICE 'post-apply OK: every view we own respects the caller';
END $$;
