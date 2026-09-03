-- ═══════════════════════════════════════════════════════════════════════
-- 20260831e_every_definer_view_respects_the_caller.sql
-- ═══════════════════════════════════════════════════════════════════════
-- TIER:        2                              (permission tightening)
-- AUTHOR:      cowork-claude (phase 3 follow-up)
-- AFFECTS:     views: every view in public owned by postgres that lacked
--              security_invoker
-- IRREVERSIBLE: no  (ALTER VIEW ... SET (security_invoker = off) restores)
--
-- WHY:
--   20260831d named two SECURITY DEFINER views. The advisor then reported a
--   THIRD, `v_spin_unfilled_waits`, created earlier the same day by
--   20260831060000_a_seat_that_waits_forever_gets_its_chips_back.sql. Naming
--   views one at a time loses that race by construction: this estate gains
--   views faster than a migration can list them.
--
--   So this sweeps every view we own instead. The house convention is already
--   `security_invoker=true` — over forty views carry it — and these were the
--   stragglers that missed it.
--
--   `v_spin_unfilled_waits` is the one that mattered: it carries three grants
--   to browser roles, so as a DEFINER view it read rows with the OWNER's
--   rights on behalf of whoever asked. That is the RLS bypass the advisor
--   rates ERROR. Neither straggler is referenced anywhere in app code, so
--   nothing legitimate loses access.
--
-- HOW (high level):
--   - ALTER every public view owned by postgres with no security_invoker set
--   - Normalise the two set to `on` by 20260831d so the estate reads uniformly
--   - Assert zero remain
--
-- See .agent/workflows/migration-safety.md for the full protocol.
-- ═══════════════════════════════════════════════════════════════════════

BEGIN;

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

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════
-- ROLLBACK
--   ALTER VIEW public.<name> SET (security_invoker = off);   -- per view
-- ═══════════════════════════════════════════════════════════════════════
