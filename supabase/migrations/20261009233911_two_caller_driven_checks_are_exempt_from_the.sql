-- two_caller_driven_checks_are_exempt_from_the_sweep
--
-- fn_ca_orphaned_checks_watch has warned daily that two check functions are
-- run by nothing. Neither is a sweep. fn_ca_integrity_identity_links is a paged
-- reader for the integrity review screen (p_since, p_as_of, p_limit, p_cursor),
-- exactly like its exempt siblings fn_ca_integrity_pairs, _flags, _timing and
-- _hands. fn_lightning_integrity_report judges the engine's decision-timing
-- aggregates, which the caller passes in as p_signals; a schedule has no
-- signals to pass. Both are recorded with their reasons, as the watch asks.
BEGIN;
INSERT INTO public.ca_check_sweep_exemptions (proname, reason, added_at)
VALUES
  ('fn_ca_integrity_identity_links',
   'A paged reader for the integrity review screen (p_since, p_as_of, p_limit, p_cursor), like fn_ca_integrity_pairs and its siblings. Nothing to schedule: it answers a question an operator asked.',
   now()),
  ('fn_lightning_integrity_report',
   'Judges the engine''s Lightning decision-timing aggregates, which the caller passes as p_signals. A sweep has no signals to pass; the engine calls it with its own window.',
   now())
ON CONFLICT DO NOTHING;
DO $prove$
BEGIN
  IF EXISTS (SELECT 1 FROM public.fn_ca_orphaned_checks()) THEN
    RAISE EXCEPTION 'ORPHANED_CHECKS_REMAIN';
  END IF;
END
$prove$;
COMMIT;
