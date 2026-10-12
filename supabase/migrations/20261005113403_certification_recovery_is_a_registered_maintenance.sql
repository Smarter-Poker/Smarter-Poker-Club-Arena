-- ===========================================================================
--  CERTIFICATION RECOVERY IS A REGISTERED MAINTENANCE
-- ===========================================================================
--
-- fn_ca_journal_append_only opens a warning drift incident for every
-- append-only bypass whose app.ledger_maintenance kind is not registered as
-- `info` in ca_ledger_maintenance_kinds. Two kinds were never registered, and
-- two incidents have been open since:
--
--   287e7dec  journal-bypass:chip_transactions:DELETE:stale-cert-recovery
--             25 occurrences, 2026-10-02 00:17 to 2026-10-03 07:01
--   b972b82f  journal-bypass:chip_transactions:DELETE:cert-residue-recovery
--             14 occurrences, 2026-10-03 00:46 to 2026-10-05 00:05
--
-- READ FROM ca_ledger_mutation_log, 2026-10-05: all 39 rows are DELETEs of
-- chip_transactions by the certification club retirement door,
-- fn_ca_retire_welcome_certification_club -> fn_ca_retire_certification_club,
-- called by scripts/ci/production-e2e-account.mjs
-- (retireProductionCreateClubFixtures, reason 'stale-cert-recovery') and
-- scripts/ci/certify-club-create.mjs (retireCertificationClubWithRetry,
-- reason 'cert-residue-recovery'). stale-cert-recovery: 25 rows, 25 clubs,
-- each one club_opening_grant of 100,000. cert-residue-recovery: 14 rows, 12
-- clubs, 12 club_opening_grants of 100,000 and one bbj_promo_sweep of 200.
-- Every row is preserved whole in the log. These are the same door, the same
-- validation (a reserved certification identity, a certification-prefixed
-- club, the exact 100,000 conservation assertion) and the same rows as the
-- kind 'ui-cert-cleanup', which was registered `info` on 2026-10-01 after 148
-- runs each opened a board item. Only the reason prefix differs: these two
-- are the recovery calls for runs that died before their own cleanup.
--
-- So both are registered `info`, exactly like ui-cert-cleanup: still recorded
-- whole in ca_ledger_mutation_log on every row, no longer opening an incident.
-- Any OTHER kind still defaults to warning and still raises. Both incidents
-- are then closed through fn_ca_incident_action with that finding.
-- ===========================================================================
-- @live-proof: (SELECT count(*) = 2 FROM public.ca_ledger_maintenance_kinds WHERE kind IN ('stale-cert-recovery', 'cert-residue-recovery') AND severity = 'info')

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

DO $pre$
DECLARE v_n int; v_other int;
BEGIN
  -- The inventory this file's header states, read again.
  SELECT count(*), count(*) FILTER (WHERE NOT (source_table = 'chip_transactions'
                                              AND operation = 'DELETE'
                                              AND (old_row->>'transaction_type') IN ('club_opening_grant', 'bbj_promo_sweep')))
    INTO v_n, v_other
    FROM public.ca_ledger_mutation_log
   WHERE split_part(reason, ':', 1) IN ('stale-cert-recovery', 'cert-residue-recovery');
  IF v_n < 39 OR v_other <> 0 THEN
    RAISE EXCEPTION 'certification recovery inventory moved: % rows, % outside the door', v_n, v_other;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.ca_ledger_maintenance_kinds
                  WHERE kind = 'ui-cert-cleanup' AND severity = 'info') THEN
    RAISE EXCEPTION 'the ui-cert-cleanup precedent is not registered as info';
  END IF;
END $pre$;

INSERT INTO public.ca_ledger_maintenance_kinds (kind, note, severity)
VALUES
  ('stale-cert-recovery',
   'retireProductionCreateClubFixtures (scripts/ci/production-e2e-account.mjs) retiring the Create-A-Club fixtures of a stale post-deploy certification identity whose run died before its own cleanup. Same door as ui-cert-cleanup (fn_ca_retire_welcome_certification_club), same validation and the exact 100,000 conservation assertion. Rows are preserved whole in ca_ledger_mutation_log. Expected and recorded, not alarming. Registered 2026-10-05 (migration 20261005113403).',
   'info'),
  ('cert-residue-recovery',
   'retireCertificationClubWithRetry (scripts/ci/certify-club-create.mjs) retiring a residual certification club left by an earlier Club Create Certification run. Same door as ui-cert-cleanup (fn_ca_retire_welcome_certification_club), same validation and the exact 100,000 conservation assertion. Rows are preserved whole in ca_ledger_mutation_log. Expected and recorded, not alarming. Registered 2026-10-05 (migration 20261005113403).',
   'info')
ON CONFLICT (kind) DO NOTHING;

SELECT public.fn_ca_incident_action(
         i.id, 'resolve',
         'Intended maintenance. Every row this kind deleted is a certification club''s chip_transactions row (club_opening_grant, and one bbj_promo_sweep of 200) removed by fn_ca_retire_welcome_certification_club, the same validated door as ui-cert-cleanup, and every row is preserved whole in ca_ledger_mutation_log. The kind is now registered info, as ui-cert-cleanup was on 2026-10-01.',
         NULL,
         'The certification recovery calls used reason prefixes that were never registered in ca_ledger_maintenance_kinds, so each bypass opened a warning incident.',
         'migration 20261005113403')
  FROM public.ca_drift_incidents i
 WHERE i.source = 'fn_ca_journal_append_only'
   AND i.dedupe_key IN ('journal-bypass:chip_transactions:DELETE:stale-cert-recovery',
                        'journal-bypass:chip_transactions:DELETE:cert-residue-recovery')
   AND i.resolved_at IS NULL;

DO $post$
BEGIN
  IF (SELECT count(*) FROM public.ca_ledger_maintenance_kinds
       WHERE kind IN ('stale-cert-recovery', 'cert-residue-recovery') AND severity = 'info') <> 2 THEN
    RAISE EXCEPTION 'the two kinds are not registered info';
  END IF;
  IF EXISTS (SELECT 1 FROM public.ca_drift_incidents i
              WHERE i.source = 'fn_ca_journal_append_only'
                AND i.dedupe_key IN ('journal-bypass:chip_transactions:DELETE:stale-cert-recovery',
                                     'journal-bypass:chip_transactions:DELETE:cert-residue-recovery')
                AND i.resolved_at IS NULL) THEN
    RAISE EXCEPTION 'a certification recovery incident is still open';
  END IF;
END $post$;

COMMIT;
