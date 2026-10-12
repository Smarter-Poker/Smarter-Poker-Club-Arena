# Native logical export and its qualification boundary

Use the configured authenticated Supabase CLI to link an owned external worktree
to the explicitly named source project. The native export driver consumes the
CLI's documented `db dump --linked --dry-run` connection exports in memory. It
never executes that shell script or prints, persists, or copies its credentials.
Do not source an environment file or paste a password into a command.

`scripts/dr/native-supabase-export.py` requires `--workdir`, `--project-ref`,
`--output`, and `--mode schema|full`. The linked project reference must match
before connection preparation. Its output must be a new file in an existing
owned directory on a mounted external work or evidence volume. It verifies TLS
and hostname; `--ssl-root-cert` can name the public certificate obtained from
the source project's official Database Settings certificate link. It never
changes the production SSL setting. The default deadline is 300 seconds and
the maximum is 3,600 seconds.

Full mode produces a native custom archive with zstd compression and deliberately
excludes no schemas or tables. Schema mode is only catalogue evidence. Both use
a read-only session and a five-second lock wait limit. A failure or timeout
leaves only a private `.partial` artifact and an explicitly failed result.
Promotion is atomic and refuses an existing destination, including one created
by a competing operation. A completed export reports its bytes, SHA256, source
project reference, elapsed time and `restore_qualified: false`.

The production catalogue can make stock function and sequence metadata reads
too slow. `scripts/dr/build-native-export-client.py --scratch OWNED_DIRECTORY`
builds the exact pinned PostgreSQL 17.11 source with the maintained native
metadata batching transformation. It batches only those catalogue queries;
upstream object selection, archive serialization and restore handling remain
intact. It requires Node, Python, make, a compiler, pkg-config, OpenSSL and zstd,
plus installed PostgreSQL 17 fixture tools. Nothing is installed globally and
it cannot publish, deploy or modify production. The returned client path can
be passed to the export driver's `--pg-dump` argument.

Before issuing `client_qualified: true`, the builder exports and restores a real
isolated PostgreSQL 17 archive. The fixture verifies rows, numeric precision,
partitions, generated columns, identity continuation, foreign keys, function
definitions, 1,000 routines, grants, RLS and atomic duplicate-restore refusal.
The receipt binds upstream source, transformation, binary and test hashes.
Existing CI accounting shard 1 runs the driver boundaries with stock tools;
shard 4 builds and tests the candidate native client. Failed checks fail their
required accounting job. No timer or repair loop supplies correctness.

## Full recovery remains a separate measured operation

The native fixture qualifies the tool, not production recovery. A complete
production recovery drill still needs a consistent full archive, sufficient
isolated destination capacity, pre-execution external-effect containment,
recovered-data comparison, ledger chain and daily attestation, measured recovery
time, and Storage object recovery where applicable. Never run copied cron,
network jobs or integration credentials in the destination. Follow
[RESTORE-RUNBOOK.md](RESTORE-RUNBOOK.md) and record the actual boundary and result
in the owning incident/checkpoint. A schema export, PITR configuration or client
qualification is never permission to clear live balances.
