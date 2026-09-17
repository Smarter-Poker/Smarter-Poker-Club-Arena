# Hand-stat writer concurrency

The existing GitHub-hosted `accounting_postgres` job invokes this driver with its
installed PostgreSQL17 tools. Its command contract is:

```sh
PG_BIN=/usr/lib/postgresql/17/bin python3 scripts/ci/test-hand-stat-writer-order.py \
  --migration supabase/migrations/20260914212802_hand_stat_writers_share_a_canonical_order.sql \
  --output /tmp/hand-stat-proof-unique
```

The output directory must not exist. The runner uses a private Unix socket,
disables TCP, bounds memory and connections, requires 2 GiB of free disk and
removes its cluster on success or failure. It makes no production connection.
The result records the actual PostgreSQL and OS versions and binds the runner
and migration SHA-256 hashes.

`baseline.json` contains the four captured production stat writers, with the
two live projectors advanced through the required index-order predecessor
`20260914194928`. The stat migration refuses the unmodified live projectors;
its predecessor must be installed first. The two bulk definitions were
independently read from production on September 14 at 21:28 UTC.

The original September 13 04:15:09.807 log identifies a real conflict between
the forward rollup and post-commit projector on `ca_hand_player_stat`.
Explicit fixture facts return two legal, opposite SETOF orders. Native
transactions reproduce that unique-index deadlock using the captured writer
bodies. The candidate orders inserts in all four writers, and the two bulk
writers share a nonblocking transaction lock before reading any cursor.

The 57 checks cover both execution orders, both bulk entry points, the legacy
trigger, nonblocking bulk deferral without cursor advancement, subsequent
progress, exact facts, outbox replay, rollback, the unchanged 1,000-row
retention limit, atomic-hand exclusion, permissions, repeated migration and
atomic refusal of body/grant drift or a missing predecessor.

This small fixture uses the Diamond branch to avoid unrelated financial
aggregates. The legacy function uses a private UPDATE trigger binding. The
facts helpers are explicit inputs, not the real production helpers. These
checks are not complete financial, Linux, release or production proof.

Supplemental local evidence is retained in the operational-alert task at
`evidence/stat-full-schema-v2/RESULT.json`. Its 110 overlapping checks use a
private copy of the existing cold schema fixture and actual facts helpers
verified against production. Baseline and candidate cash, tournament and
Diamond projections match. The real zero-charge obligation finalizer and
outbox replay are exercised; seeded inputs are synthetic and rolled back.
This does not qualify accepted-hand RPCs, nonzero rake/BBJ/addon/insurance,
every current dependency, Linux, installation or historical repair. Do not
add the two check counts together as independent full financial coverage.

Release remains with the root delivery owner through the existing protected
GitHub checks and migration controls. The historical local pass is not hosted
qualification or installed production evidence. No retired local pipeline is used.
