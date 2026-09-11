# Rakeback source-accrual production cutover

This is the only supported production path for
`rakeback_accrues_atomically_with_its_source`. It is a stopped-engine,
ledger-recorded cutover. No cron, redrive, watchlist, direct ledger insert,
`execute_sql`, migration repair, or production `psql -f` mutation is allowed.

Completion requires one continuous chain of evidence:

1. one reviewed staged-or-promoted source artifact and a pristine semantic
   migration name;
2. green server/static tests and the full PostgreSQL 17 rehearsal;
3. an exact, healthy production engine build with no deployment running or
   queued;
4. an enforced maintenance break owned by that build;
5. the supervisor, engine, all fresh distributed authority, and the
   `RakebackSettlerService` lifecycle scaled to zero under the host lock;
6. a green live read-only preapply receipt from the stopped-writer snapshot;
7. one Supabase-assigned ledger version whose sole statement is byte-identical
   to the reviewed artifact;
8. a green postapply reconstruction probe;
9. the same exact engine image restarted with fresh leases and advancing hands;
   and
10. source sealed to the assigned ledger version, committed, merged, deployed,
    and verified by exact SHA.

## 1. Prepare and rehearse without changing production

Work from the still-unmerged release branch. Resolve the migration by semantic
name; do not assume the held-back timestamp will be the live ledger version:

```sh
source scripts/ops/lib/resolve-staged-or-promoted-migration.sh
RAKEBACK_FILE="$(resolve_staged_or_promoted_migration \
  "$PWD/supabase/migrations" \
  rakeback_accrues_atomically_with_its_source)"
test -f "$RAKEBACK_FILE" && test ! -L "$RAKEBACK_FILE"
shasum -a 256 "$RAKEBACK_FILE"
```

Before booking a window, require the focused guard, the full server suite, the
server typecheck, and the real PostgreSQL 17 probe to pass:

```sh
cd server
npx vitest run src/services/rakebackSourceAccrual.guard.test.ts
npm test -- --run
npx tsc --noEmit
cd ..
scripts/ci/probes/rakeback-source-accrual/run-pg17.sh
bash -n scripts/ops/verify-rakeback-source-accrual-preapply.sh \
  scripts/ci/probes/rakeback-source-accrual/run-pg17.sh
shellcheck scripts/ops/verify-rakeback-source-accrual-preapply.sh \
  scripts/ci/probes/rakeback-source-accrual/run-pg17.sh \
  scripts/ops/lib/resolve-staged-or-promoted-migration.sh
```

Configure libpq with `PGSERVICE` and a mode-`0600` `PGPASSFILE`, or ordinary
`PGHOST`, `PGPORT`, `PGUSER`, `PGDATABASE`, `PGSSLMODE`, and `PGPASSWORD` in the
operator shell. Never place a password-bearing URI in argv and do not export
`DATABASE_URL`; the checked-in verifiers refuse it.

Run the semantic-name gate before stopping the engine:

```sh
scripts/ops/verify-migration-ledger-artifact.sh \
  rakeback_accrues_atomically_with_its_source PREAPPLY
```

Identify the sole currently running production image. Record its full image
SHA as `FULL_SHA`, the public and local `/health.version` as `SHA8`, its image
ID, container start time, restart count, and the supervisor timer state. Require
`SHA8` to equal the first eight characters of `FULL_SHA`. Also require the
deployment workflow for that SHA to have concluded successfully and no engine
deployment to be running or queued. A concurrent deploy owns the host lock and
the maintenance break; defer this cutover instead of racing it.

## 2. Enter the break and hold the engine at zero

Start at the natural `:55` break. The public and local health snapshots must
report `active=true`, `phase=counting_down`, `readyForRestart=true`,
`unparkedTables=0`, and at least 290 seconds remaining. Independently query the
singleton `engine_maintenance_break` row and require `enforce_freeze=true`, a
non-null `break_started_at`, a live `break_ends_at`, `declared_by=SHA8`, and
`fn_platform_frozen()=true`.

Open one persistent root shell on the engine host and keep it open throughout
stop, apply, verification, and restart. Acquire the canonical lock before
touching the supervisor:

```sh
set -euo pipefail
exec 9>/var/lock/club-arena-engine-up.lock
flock -n 9 || { echo 'engine-up lock is already owned; aborting' >&2; exit 1; }
STOP_STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
systemctl stop club-arena-supervisor.timer
systemctl stop club-arena-supervisor.service || true
docker stop -t 45 club-arena-engine
```

Prove graceful producer shutdown and zero host authority:

```sh
test "$(systemctl is-active club-arena-supervisor.timer)" = inactive
test "$(systemctl is-active club-arena-supervisor.service)" = inactive
test "$(docker ps -q --filter label=sp.role=engine | wc -l)" -eq 0
test "$(docker inspect -f '{{.State.Running}}' club-arena-engine)" = false
! curl -sf --max-time 3 http://127.0.0.1:8080/health
! pgrep -af 'node.*club-arena.*server|node.*dist/index' | grep -v pgrep
docker logs --since "$STOP_STARTED_AT" club-arena-engine 2>&1 \
  | grep -F '[RakebackSettler] Stopped'
docker logs --since "$STOP_STARTED_AT" club-arena-engine 2>&1 \
  | grep -F '[GameServer] Shutdown complete.'
```

Wait at least 30 seconds, then run the checked-in distributed-authority proof
used by stopped-engine financial cutovers:

```sh
scripts/ops/verify-tournament-fractional-stack-zero-authority.sh "$SHA8"
```

It must show zero leader, table, and tournament leases heartbeated in the last
30 seconds while the enforced break is still owned by `SHA8`. Immediately run
the live rakeback preapply:

```sh
scripts/ops/verify-rakeback-source-accrual-preapply.sh
```

The verifier runs in one repeatable-read, read-only transaction. It proves the
exact audited dependency hashes and trigger state, required index and legacy
constraint, pristine release objects, zero conflicting writers on all five hot
tables, zero pending periods with payout children, every positive source
shape, exact historical-refund linkage or explicit unattributed legacy state,
and cent conservation for every club/day. It must print exactly one
`RAKEBACK_SOURCE_ACCRUAL_PREAPPLY_OK` receipt plus the reviewed artifact hash.

Any forced container kill, missing shutdown log, live process, fresh lease,
conflicting relation lock, dependency drift, data-invariant failure, or active
deployment aborts the cutover. Restart the same exact image as section 5 and
investigate; do not weaken the guard.

## 3. Apply one exact statement through Supabase

Re-run the host/service/container/process readbacks, zero-authority verifier,
and preapply immediately before application. Keep file descriptor 9 locked.
Call Supabase `apply_migration` for project `kuklfnapbkmacvwxktbh` with:

- name: `rakeback_accrues_atomically_with_its_source`
- query: the exact complete bytes of `RAKEBACK_FILE`

Do not use `execute_sql`, `supabase db push`, `psql -f`, a manual
`schema_migrations` insert, or a second migration name. Supabase assigns the
durable 14-digit version. A timeout, transport failure, or lost response is an
unknown outcome: read the ledger name/version/statement bytes before deciding
whether any retry is lawful. Never submit a speculative retry.

Capture the sole assigned version as `APPLIED_VERSION` from
`supabase_migrations.schema_migrations`, require it to match `^[0-9]{14}$`, and
then run:

```sh
scripts/ops/verify-migration-ledger-artifact.sh \
  rakeback_accrues_atomically_with_its_source \
  "$APPLIED_VERSION" "$RAKEBACK_FILE"
```

This must print `MIGRATION_LEDGER_ARTIFACT_VERIFIED` and prove one globally
unique semantic name, the exact version, exactly one stored statement, and a
statement SHA-256 equal to the reviewed file.

The migration sets a 300-second PostgreSQL timeout per statement, not for the
whole transaction. Require at least 210 seconds in the break before starting,
but do not cancel a valid in-flight application merely because the wall clock
crosses `:00`; the continuous safety boundary is the held host lock, disabled
supervisor, absent engine and source writers, and the migration's acquired
write-excluding locks. Never start the apply after the enforced break has ended.

## 4. Verify the committed financial state

Before restarting any caller, run the checked-in read-only production probe:

```sh
psql -X -v ON_ERROR_STOP=1 \
  -f scripts/ci/probes/rakeback-source-accrual/production-readonly.sql
```

It must reconstruct basis from immutable cutover/accrual/reversal/offset/carry
evidence, prove header/line and compensation/link conservation, verify all
source triggers and least-privilege doors, and prove the compatibility RPCs no
longer scan `rake_records`. Re-run the ledger-artifact verifier afterward. A
postcondition failure keeps the engine stopped and requires a reviewed forward
fix; never delete or repair the ledger receipt.

## 5. Restart the exact pre-cutover build

Still holding descriptor 9, restart only the full immutable image captured in
section 1:

```sh
ENGINE_UP_LOCK_HELD=1 \
IMAGE="club-arena-engine:$FULL_SHA" \
CONTAINER=club-arena-engine \
ENV_FILE=/opt/club-arena/server/.env \
/opt/club-arena/server/scripts/engine-up.sh
```

Do not restart the supervisor or release descriptor 9 yet. Poll the
container-local health endpoint until it reports `running=true` and
`version=SHA8`, then require exactly one healthy `sp.role=engine` container:

```sh
for attempt in $(seq 1 24); do
  sleep 5
  BODY="$(curl -sf --max-time 10 http://127.0.0.1:8080/health || true)"
  RUNNING="$(printf '%s' "$BODY" | python3 -c \
    'import json,sys; print(json.load(sys.stdin).get("running"))' 2>/dev/null || true)"
  VERSION="$(printf '%s' "$BODY" | python3 -c \
    'import json,sys; print(json.load(sys.stdin).get("version", ""))' 2>/dev/null || true)"
  test "$RUNNING" = True && test "$VERSION" = "$SHA8" && break
done
test "$RUNNING" = True && test "$VERSION" = "$SHA8" || {
  echo 'exact engine image never became healthy; keep supervisor stopped' >&2
  exit 1
}
test "$(docker ps -q --filter label=sp.role=engine | wc -l)" -eq 1 || {
  echo 'expected exactly one engine container; keep supervisor stopped' >&2
  exit 1
}
test "$(docker inspect -f '{{.State.Health.Status}}' club-arena-engine)" = healthy || {
  echo 'exact engine container is not Docker-healthy; keep supervisor stopped' >&2
  exit 1
}
```

From the operator shell, require `$ENGINE_URL/health` to return the same
`SHA8`, and query fresh leader/table/tournament leases until each authority
owned by the restarted instance is stamped by `SHA8`. Recheck the unique ledger
receipt and production read-only probe. Only after all exact-build and database
proofs are green may the host shell restore recovery authority and unlock:

```sh
systemctl start club-arena-supervisor.timer
systemctl is-active --quiet club-arena-supervisor.timer
flock -u 9
exec 9>&-
```

After unlock, prove current cash, MTT, Sit & Go, and Spin tables complete a hand
and begin the next without reconnect waves, and prove the rakeback high-water
mark and new immutable receipts advance when a new source record is committed.

## 6. Source-seal, publish, and verify exact production provenance

Only after the live ledger and postapply probe are green, rename the sole
artifact without changing its bytes:

```sh
SEALED_FILE="supabase/migrations/${APPLIED_VERSION}_rakeback_accrues_atomically_with_its_source.sql"
test ! -e "$SEALED_FILE"
mv -n "$RAKEBACK_FILE" "$SEALED_FILE"
test -f "$SEALED_FILE" && test ! -L "$SEALED_FILE"
scripts/ops/verify-migration-ledger-artifact.sh \
  rakeback_accrues_atomically_with_its_source \
  "$APPLIED_VERSION" "$SEALED_FILE"
```

Require exactly one staged-or-promoted source, no `.sql.pending` duplicate, and
rerun the focused guard, full PostgreSQL 17 rehearsal, server suite, and
typecheck. Commit the source seal to the same release branch. Push, merge, and
wait for every required workflow to conclude successfully. A local pass, an
open PR, an auto-merge request, or a running deployment is not publication.

After the merged engine deployment completes, require the host image, local
health, public health, fresh leases, and deployment receipt to report the exact
merged engine SHA. If the release also changes the World Hub bundle, require
the served `build-info.json` SHA and final static-deploy workflow conclusion to
match the merge. Re-run the ledger-artifact verifier and production read-only
probe from the merged tree. The cutover is incomplete until repository source,
the one ledger statement, and the served production build all agree.

## Abort and recovery

Before a confirmed database commit, every failure returns to the same exact
pre-cutover image and restarts the supervisor timer while the operator still
owns descriptor 9. The migration is one transaction, so a SQL exception leaves
no partial schema or accounting baseline.

After a confirmed commit, rollback is a reviewed forward migration. Do not
remove immutable receipts, alter `schema_migrations`, or restore the legacy
projection writer. If source sealing, merge, or deployment fails after commit,
keep the verified exact engine live and treat the release as incomplete until
the byte-identical source and exact production SHA are proved.
