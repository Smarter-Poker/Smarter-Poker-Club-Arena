-- 20261008052116_the_identity_links_reader_is_exempt_from_the_orphaned_checks
--
-- Reserved by scripts/new-migration.mjs on 2026-10-08 05:21:16 UTC.
--
-- THE IDENTITY LINKS READER IS EXEMPT FROM THE ORPHANED CHECKS SWEEP (2026-10-08)
--
-- fn_ca_orphaned_checks_watch has raised incident 053bfc26
-- (orphaned-checks:2026-10-06, seen 2026-10-06 and 2026-10-07 06:18) for one
-- function: fn_ca_integrity_identity_links(p_include_horses, p_since, p_as_of,
-- p_limit, p_cursor), installed by 20261006022123
-- (stable_admin_phase11_identity_links). It matches the sweep's name pattern
-- on the word "integrity", but it is not a check: it is the I3 investigator
-- view, a STABLE paged reader (p_as_of, p_limit, p_cursor) that answers what
-- an operator asked to see and returns no verdict for a sweep to act on. Its
-- four siblings on the same review screen (fn_ca_integrity_flags, _hands,
-- _pairs, _timing) were exempted on 2026-09-09 for exactly that reason.
--
-- The watch names three remedies: schedule it, add it to
-- fn_ca_conservation_sweep, or exempt it with a reason. Scheduling a reader
-- would page through identity evidence every run for nobody, so the exemption
-- is the correct one. No function, table or money row is changed.
--
-- @live-proof: EXISTS (SELECT 1 FROM public.ca_check_sweep_exemptions WHERE proname = 'fn_ca_integrity_identity_links') AND NOT EXISTS (SELECT 1 FROM public.fn_ca_orphaned_checks() o WHERE o.proname = 'fn_ca_integrity_identity_links')

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

DO $pre$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'public' AND p.proname = 'fn_ca_integrity_identity_links'
                    AND p.provolatile = 's'
                    AND pg_get_function_identity_arguments(p.oid) ~ 'p_cursor') THEN
    RAISE EXCEPTION 'fn_ca_integrity_identity_links is not the stable paged reader this exemption describes';
  END IF;
END $pre$;

INSERT INTO public.ca_check_sweep_exemptions (proname, reason)
VALUES ('fn_ca_integrity_identity_links',
        'A paged reader for the integrity review screen (the I3 identity-links investigator view): it takes p_as_of, p_limit and p_cursor and answers what an operator asked to see. There is no verdict here for a sweep to act on.')
ON CONFLICT (proname) DO NOTHING;

DO $post$
BEGIN
  IF EXISTS (SELECT 1 FROM public.fn_ca_orphaned_checks() o WHERE o.proname = 'fn_ca_integrity_identity_links') THEN
    RAISE EXCEPTION 'fn_ca_integrity_identity_links still reads as an orphaned check';
  END IF;
END $post$;

COMMIT;
