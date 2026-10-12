# Inventory seal native qualification

Run `bash scripts/dev/probe-inventory-seal-buckets-pg17.sh` from the repository.
The wrapper creates and removes a private PostgreSQL 17 cluster. On the owner's
Mac every temporary byte goes to SmarterWork; hosted Linux uses RUNNER_TEMP.
No database URL is read and the server accepts only its private Unix socket.

`preimage.sql` is the exact `pg_get_functiondef` capture read from production
project `kuklfnapbkmacvwxktbh` on 2026-10-12. Its native MD5 must be
`6deca79658f44ffb149316167441b2bf`. The migration is loaded from the maintained
protected source file, not copied into the fixture. Its installed function must
match `47b1a3a80eec9fc6a593e99ebef27c27`.

The real preimage and installed function execute against synthetic relational
fixtures with 34,002 rows across five sources and 1,280 source/bucket pairs.
The fixture supplies the directly called week-boundary, layer-input and
population functions; it does not certify production event capture or the
complete accounting economy. Layers return real relational rows with zero to
three updates per row, NULL images and issues. Population reads the actual
checkpoint rows/issues. The no-base delegate intentionally raises because this
probe qualifies the existing-base weekly assembly path changed by the migration.

The probe compares independently executed old and new assembly, including
row/issue JSON serialization digests and all checkpoint fields except measured
`seal_ms`. It proves exact source/postimage, verify, duplicate seal, migration
replay refusal, NULL-only images, staging-loss recovery, installation refusal
mid-seal with atomic rollback, a rolled-back install, input/isolation refusal
and concurrent advisory admission.

Continuation uses a separately identified diagnostic copy changing only the
between-bucket row threshold from 400,000 to 3,000. This fixture takes twelve
calls and proves identical final output and absent checkpoint row at each
partial return. The exact unmodified migration is qualified first. Diagnostic
continuation does not establish a strict 400,000-row ceiling: source checks the
threshold between whole buckets. Nor does this small fixture measure production
WAL volume, elapsed-time limits or qualify arbitrary skewed UUID populations.

Assertions are required to execute through the existing accounting PostgreSQL
CI job. This probe does not install production SQL or replay installed records.
