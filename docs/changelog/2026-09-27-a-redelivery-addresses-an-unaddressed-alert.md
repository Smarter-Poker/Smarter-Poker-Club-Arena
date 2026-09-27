# A Redelivery Addresses An Unaddressed Operational Alert (2026-09-27)

## What Was Wrong

`public.fn_record_operational_alert` keys a row on `(source, event_key)` and its
`ON CONFLICT` branch only bumped `last_received_at` and `delivery_count`. The
payload was fixed forever by the first delivery.

Rows first recorded before their writer added `payload.target_task_id` therefore
stayed unaddressed however many times the (now addressed) alert was delivered
again. Measured on 2026-09-27: alertmanager rows 54934 and 56211 (first recorded
2026-09-17) had 39 and 58 deliveries, and workers.deploy-error-poll row 114454
(first recorded 2026-09-23, before workers #144) had 44, all still naming no
destination. `OperationalAlertMissingTargetTaskId` (production-integrity-audit,
rows 146682 and 157688) fired on exactly these rows. Every row first recorded
after the writers were fixed carries the destination, including the
workers.scraper-watchdog rows since 2026-09-27 02:00 UTC, which proves workers
#144 is running.

## The Fix

Migration `20260927160533_operational_alert_redelivery_addresses_an_unaddressed_row.sql`
(held for the owner to install): a repeat delivery that names a destination adds
it to a stored payload that names none. Evidence is never rewritten and a
destination a row already names is never replaced.

`fn_ca_cash_failed_run_intake()` refuses to deliver unless the recorder's full
definition md5 is the pinned value, so the same transaction rebuilds it from its
own live definition with only that literal changed and proves the result.

## Proof

`scripts/ci/test-operational-alert-redelivery-addressing.py` builds an isolated
PostgreSQL from the exact production preimages (recorder md5 `36601e20...`,
intake md5 `b1b3aa4e...` rebuilt from `supabase/components/cash-failed-run-intake.sql`),
reproduces the defect, applies the migration unchanged and checks the behaviour.
It runs on pull requests touching this path in `operational-alert-addressing.yml`.

## What This Does And Does Not Prove

World Hub #2001 (Alertmanager episode identity) and smarter-poker-workers #150
(no re-report of a superseded ERROR) stop the re-deliveries of 54934, 56211 and
114454, so those rows will not be re-addressed by this function. The fix is the
recorder rule for every row from install onward. It is proven live by
`supabase_migrations.schema_migrations` (version `20260927160533`, or the
migration name if the installer records its own version) together with recorder
md5 `4bab2581b3dff1e09b22d0df46c68df8` and intake md5
`3ef722e8990b508b8741ee2e558f19c1`, never by a detector recovery: the detector
looks back only 2 hours and also recovers when re-deliveries simply stop.

## Every File That Pins The Old Recorder Md5

None is read by production at runtime; the only live pin is
`fn_ca_cash_failed_run_intake()`, re-pinned in the migration.

- One-shot install scripts, already installed, that now refuse (fail closed) if
  re-run until re-reviewed against `4bab2581...`: Club Arena
  `supabase/components/cash-failed-run-intake{,.rollback}.sql`,
  `supabase/components/cash-pot-check-evidence{,.rollback}.sql`,
  `supabase/components/direct-operational-source-intake.authority.sql`,
  `scripts/operational-alerts/cash-pot-failed-run-intake.sql`,
  `supabase/accounting/weekly-v3/components/20260915140000_correction_writer_retains_exact_request_and_journal_intent.sql`,
  `supabase/accounting/correction-writer-v1/guard-function-sources.json`; World
  Hub `supabase/components/owner-operational-notification-destination.sql` (its
  `$guard$` md5 check) and `scripts/qualification/owner-operational-notification-destination.sql`.
  They are not edited: CI qualifies them only on isolated clusters built from
  captured fixtures whose recorder is the old preimage (World Hub's manifest
  pins the component and qualifier by sha256), so the literal can only be
  re-proven from a fixture recaptured after this install.
- Captured-preimage fixtures and probe inputs, correct as records of the
  2026-09-16/17 state: `scripts/ci/probes/production-alert-core/**`,
  `scripts/ci/probes/spin-expiry/provider-check.sql`,
  `scripts/qualification/fixtures/{cash-pot-failed-run-intake,direct-operational-source-intake}/*`,
  `tests/fixtures/union-provider-preimages-20260917/*`, and World Hub
  `scripts/ci/probes/owner-operational-notification/**`.
- History: the qualification records under `scripts/qualification/*.md|json` and
  applied migrations 20260916111614, 20260917054616 and 20260917062322.
