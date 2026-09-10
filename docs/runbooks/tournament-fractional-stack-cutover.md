# Tournament whole-chip cutover runbook

This is the only supported production path for the one-time fractional
tournament-stack normalization. It is a stopped-engine, ledger-recorded schema
cutover, not a repair loop. No cron, redrive, watchlist, direct ledger insert,
or production `psql -f` mutation is permitted.

The cutover is complete only when all six evidence boundaries agree:

1. the six-migration Stage-B forward chain, including the strict manager,
   settlement, DB-first atomic-move, and lease-keyshare authorities, is
   ledgered before any application caller is published;
2. the exact capable engine SHA owns the enforced normalization break;
3. the engine and every host-side restart authority are demonstrably stopped;
4. the private rendered artifact is byte-exact with its receipt and canonical
   migration;
5. Supabase `apply_migration` records those exact normalization bytes in
   `supabase_migrations.schema_migrations`; and
6. the same capable engine SHA restarts, resumes hands, and owns all fresh leases.

## 1. Prepare without changing production

Work from a clean release branch whose server, PostgreSQL 17, integration, and
law suites are green. Before that branch can publish a caller of the atomic move
door, the live database must contain exactly one migration row for each
prerequisite name:

- `hand_settlement_targets_exact_seat_generation`
- `stage_b_current_postimage_contraction`
- `stage_b_lease_keyshare_once`

If exact-seat expansion is absent, abort this runbook and complete its dedicated
stopped-engine rollout first; never begin in the middle of Stage B on a rebuilt
or partially restored database. If **either** Stage-B prerequisite is absent,
use a separate earlier maintenance window on the currently deployed Stage-A
engine and apply the one reviewed `stage_b_forward_authority_expansion` through
`stage_b_lease_keyshare_once` chain. Keep every branch containing the
atomic-move caller unmerged and undeployed, and do not render or apply
normalization in that window. Database publication and source sealing must
finish before that branch can merge. Record the running image as
`STAGE_A_FULL_SHA`/`STAGE_A_SHA8`, prove it is the sole build, scale it to zero
with section 2's host sequence, then apply all six forward migrations in the
exact resolver order through Supabase `apply_migration`. The atomic move inside
the contraction accepts both the current integer roster and its later bigint
shape, while the live Stage-A application has no caller yet. Before each apply,
require a pristine name; afterward, require one globally unique name, one
statement, and byte equality with the reviewed source file:

For this prerequisite window only, set `FULL_SHA="$STAGE_A_FULL_SHA"` and
`SHA8="$STAGE_A_SHA8"` before using sections 2 and 5. Those sections always act
on the exact image named by `FULL_SHA`; never carry these aliases into the later
normalization window.

```sh
scripts/dev/probe-stage-b-forward-chain-pg17.sh --resolve-only
scripts/ops/verify-migration-ledger-artifact.sh \
  stage_b_current_postimage_contraction PREAPPLY
# apply all six resolved stage_b_* files via MCP in the printed order
scripts/ops/verify-migration-ledger-artifact.sh \
  stage_b_current_postimage_contraction \
  "$CONTRACTION_APPLIED_VERSION" "$CONTRACTION_FILE"
scripts/ops/verify-migration-ledger-artifact.sh \
  stage_b_lease_keyshare_once "$KEYSHARE_APPLIED_VERSION" "$KEYSHARE_FILE"
```

Restart and certify the exact same Stage-A image as in section 5. Wait for it to
acquire one fresh protocol-2 tournament lease. Then prove the RPC is callable
through the Data API using that exact tournament/generation in the four manager
headers (`x-smarter-data-actor: tournament-manager`,
`x-smarter-data-protocol: 2`, `x-smarter-tournament-id`, and
`x-smarter-tournament-lease-generation`) and null operation/source arguments. It
must resolve the function and
return `{ "ok": false, "reason": "invalid_request" }`; `PGRST202`, an HTTP 404,
or any other shape keeps the application caller unmerged. The strict request
hook correctly prevents this probe while the engine is stopped because no fresh
lease exists. This is only a schema-publication probe and writes no game row or
receipt.

Then add one source-sealing commit to the same still-unmerged release branch. It
renames all six applied Stage-B files to their real ledger versions and
advances only the still-unapplied normalization reservation after them,
preserving this total order in every tree:

```text
exact-seat expansion < Stage-B #1 < #2 < #3 < #4 < #5 < #6
  < fractional normalization

The atomic seat move < fractional normalization semantic order is therefore
preserved without replaying any archived one-off migration.
```

The static guard enforces that order. Merge the caller only after all four live
prerequisites resolve, deploy it, record that immutable image as `FULL_SHA` and
`SHA8`, and use that exact newly deployed build for the later normalization
window. Confirm no deployment workflow is running or queued for that interval,
the image is present on the host, and `/health.version` is `SHA8`. Do not forge
a prerequisite with a manual ledger row or retain a source filename that
disagrees with its ledger version.

Create a private operator directory owned by the operator and mode `0700`.
Configure libpq with `PGSERVICE` plus a mode-`0600` `PGPASSFILE`, or ordinary
`PGHOST`, `PGPORT`, `PGUSER`, and `PGDATABASE` plus `PGPASSFILE`. Never put a
password-bearing URI on a command line and do not export `DATABASE_URL`; the
renderer and verifier deliberately refuse it.

## 2. Prove the fleet is scaled to zero

Start during the natural `:55` maintenance break. The `/health` maintenance
snapshot must report `active=true`, `phase=counting_down`,
`readyForRestart=true`, `unparkedTables=0`, and at least 290 seconds in
`remainingMs`. Health deliberately does not expose the break's write-authority
fields, so prove those independently with a read-only PostgreSQL query: the
singleton `engine_maintenance_break` row must have `phase='counting_down'`,
`enforce_freeze=true`, non-null `break_started_at`, a live `break_ends_at`, and
`declared_by=SHA8`. Record that exact row and `fn_platform_frozen()=true`; do
not infer either value from health. Keep one root shell on the engine host for
the entire stop/apply/restart sequence.

In that shell, take `/var/lock/club-arena-engine-up.lock` on file descriptor 9.
The lock must be acquired non-blocking before continuing; it prevents a deploy
or supervisor tick from recreating the engine underneath the cutover. Then:

```sh
exec 9>/var/lock/club-arena-engine-up.lock
if ! flock -n 9; then
  echo 'engine-up lock is already owned; aborting before any authority is stopped' >&2
  exec 9>&-
  exit 1
fi
systemctl stop club-arena-supervisor.timer
systemctl stop club-arena-supervisor.service || true
docker stop -t 15 sp-autoheal
docker stop -t 45 club-arena-engine
```

All of these readbacks must pass in the same shell:

```sh
test "$(systemctl is-active club-arena-supervisor.timer)" = inactive
test "$(systemctl is-active club-arena-supervisor.service)" = inactive
test "$(docker inspect -f '{{.State.Status}}' sp-autoheal)" = exited
test "$(docker ps -q --filter label=sp.role=engine | wc -l)" -eq 0
test "$(docker inspect -f '{{.State.Running}}' club-arena-engine)" = false
! curl -sf --max-time 3 http://127.0.0.1:8080/health
! pgrep -af 'node.*club-arena.*server|node.*dist/index' | grep -v pgrep
```

After 30 seconds, run the checked-in read-only proof. It validates the exact
maintenance owner, enforced freeze, remaining budget, platform freeze, and zero
fresh leader/table/tournament authorities, while printing the latest heartbeat
of each authority relation:

```sh
scripts/ops/verify-tournament-fractional-stack-zero-authority.sh "$SHA8"
```

Record that output, the host command output, UTC time, and SHA8.
Any fresh lease, another `sp.role=engine` container, a running supervisor, a
running `sp-autoheal` sidecar, a live local health endpoint, or an active
deployment aborts the cutover. Recheck the deployment queue and the held host
lock immediately before every `apply_migration` call; neither proof may be
inferred from the start of the window.

## 3. Render and verify one immutable artifact

After the engine has been absent for at least 30 seconds, require at least 210
seconds to remain in the same enforced break and run:

```sh
scripts/ops/render-tournament-fractional-stack-cutover.sh "$SHA8" \
  /private/operator/tournament-fractional-stack-cutover.sql

scripts/ops/verify-tournament-fractional-stack-cutover-artifact.sh "$SHA8" \
  /private/operator/tournament-fractional-stack-cutover.sql

scripts/ops/verify-tournament-fractional-stack-cutover-artifact.sh "$SHA8" \
  /private/operator/tournament-fractional-stack-cutover.sql PREAPPLY
```

The renderer and the PostgreSQL 17 rehearsal resolve exactly one normalization
source in either staged `.sql.pending` form or ledger-promoted `.sql` form. Both
forms existing at once is ambiguous and aborts. The pending source is a reviewed
template only: Supabase assigns the durable version during application, and
section 6 replaces the pending filename with that exact receipt version.

Retain both output files at mode `0600`. The renderer takes the same NOWAIT lock
order as the migration, observes one dynamic cohort, rolls its transaction
back, and installs the artifact and receipt with create-if-absent filesystem
operations. The cohort contains a tournament only when an active seat is
fractional or its exact active roster mirror carries the one-chip-low residue
left by the prior seat-only half-chip conversion. It may therefore contain
whole seats with `CUTOVER_FRACTIONAL_SEAT_COUNT=0`; unchanged and broader
roster mismatches are refused. If neither condition exists, the renderer emits
the canonical zero-row receipt while the migration still installs the schema
and ingress hardening. The verifier requires a ten-field canonical receipt,
validates all counts/UUIDs/hashes, recomputes the SQL from the reviewed
migration with the shared materializer, compares every byte, and proves that
the one-shot ledger name has zero rows before application.

If either output path already exists, a symlink is present, the verifier does
not print `RENDERED_ARTIFACT_VERIFIED`, or the break has less than 210 seconds
remaining, abort. Never edit, reformat, concatenate, or copy/paste pieces of the
rendered SQL.

## 4. Apply only through the migration ledger

Call the Supabase MCP `apply_migration` tool for project
`kuklfnapbkmacvwxktbh` with:

- name: `tournament_fractional_stacks_are_normalized_once`
- query: the exact complete bytes of the verified rendered artifact

Do not use `execute_sql`, `psql -f`, `supabase migration repair`, or a manual
insert into `schema_migrations`. `apply_migration` assigns a 14-digit wall-clock
version. Capture that version as `APPLIED_VERSION` immediately from the unique
ledger row with the exact name, then run the artifact verifier in ledger mode:

```sh
scripts/ops/verify-tournament-fractional-stack-cutover-artifact.sh "$SHA8" \
  /private/operator/tournament-fractional-stack-cutover.sql \
  "$APPLIED_VERSION"
```

This second pass is read-only. It requires one ledger statement and proves
`sha256(schema_migrations.statements[1])` equals the receipt and local artifact.
It must print both `RENDERED_ARTIFACT_VERIFIED` and
`LEDGER_ARTIFACT_VERIFIED`. A timeout or lost MCP response is an unknown
outcome: query the ledger and run this verifier before considering a retry.
The migration's exact-postimage branch is the only permitted replay path.

The complete Stage-B chain containing the DB-first atomic seat-move authority
is already a uniquely ledgered prerequisite and its application caller is
already the exact running build; it must not be submitted again here. A timeout
from the normalization apply is an unknown outcome. Re-read the global name
count and exact ledger bytes before any retry; never submit a second named
migration speculatively. Repeat section 2's timer/service/autoheal/container/process
readbacks and the checked-in zero-authority verifier immediately before the MCP
apply. The same host lock remains held throughout; a changing or stale proof
aborts.

Before restarting, run the checked-in read-only postcondition verifier:

```sh
scripts/ops/verify-tournament-fractional-stack-cutover-postconditions.sh \
  /private/operator/tournament-fractional-stack-cutover.sql
```

It fails unless all of the following are true:

- `tournament_players.chips` and `tournament_flights.bagged_chips` are `bigint`;
- every active seat in the exact artifact cohort has a finite nonnegative whole
  stack in the `0..9,999,999,999,999` domain;
- every such seat has exactly one exact table/seat roster mirror with the same
  whole chips (`registered`/`playing`, or the already-claimed `winner` while
  the tournament is `COMPLETING`);
- every relevant pointed roster row in the artifact cohort maps back to exactly
  one active seat generation;
- the four `a1_require_whole_tournament_chips` triggers are enabled; and
- the cohort aggregate equals the receipt's `CUTOVER_TOTAL_CHIPS`.

Any cohort mismatch keeps the engine stopped. Unrelated seatless elimination
backlog and terminal-completion incidents remain owned by their respective
atomic tournament lifecycles; this cutover never bulk-infers or rewrites them.

## 5. Restart the exact build and resume recovery authority

Still holding file descriptor 9, start the exact image named in the receipt via
the one canonical run specification:

```sh
ENGINE_UP_LOCK_HELD=1 \
IMAGE="club-arena-engine:$FULL_SHA" \
CONTAINER=club-arena-engine \
ENV_FILE=/opt/club-arena/server/.env \
/usr/local/lib/club-arena/engine-control/engine-up.sh
```

Poll the container-local `/health` until `running=true`, `version=SHA8`, and its
maintenance state has adopted the same break. Prove the public health endpoint
also reports SHA8, only one `sp.role=engine` container exists, and all fresh
leader/table/tournament leases report SHA8 with the current protocol. Then
restart the fenced autoheal sidecar and installed recovery timer, prove both
recovery authorities are active, and release the lock:

```sh
docker start sp-autoheal
test "$(docker inspect -f '{{.State.Status}}' sp-autoheal)" = running
systemctl start club-arena-supervisor.timer
systemctl is-active --quiet club-arena-supervisor.timer
flock -u 9
exec 9>&-
```

Watch at least one cash table, tournament table, Sit & Go, and Spin complete a
current hand and begin the next one after the break. Verify accepted-hand,
snapshot, settlement, and realtime event timestamps advance without a new
reconnect wave. These are release checks, not a background repair mechanism.

## 6. Seal source control to the ledger receipt

Before claiming or beginning another phase, replace the unpublished reserved
normalization filename with
`supabase/migrations/${APPLIED_VERSION}_tournament_fractional_stacks_are_normalized_once.sql`,
using the exact rendered bytes, and add its adjacent `.receipt`. Do not retain a
second sentinel migration in `supabase/migrations` and do not reformat the SQL.
The static guard accepts exactly two states: all nine staging sentinels with no
receipt, or zero sentinels with one adjacent receipt whose SHA-256 and literals
match the migration. The already-applied atomic-move source was sealed before
the caller deployment and must sort before this normalization artifact.

Run the full PostgreSQL 17 rehearsal and focused server guard after sealing.
Commit, push, merge, wait for required CI, and verify the merged source contains
the ledger-assigned normalization version and receipt plus the already-sealed
atomic-move source, each byte-equal to its stored ledger statement.

The release receipt must contain: full/short engine SHA, host scale-zero proof,
break row and remaining time, renderer receipt, artifact SHA-256, the applied
normalization version/name/statement SHA-256, the prerequisite atomic-move
version/name/statement SHA-256, postcondition results, restart
health/lease proof, representative hand-resumption evidence, merge SHA, and
final workflow conclusions.

## 7. Activate the immutable tournament chip-supply ledger

The chip-supply implementation remains one staged `.sql.pending` source until
normalization has a unique, byte-verified ledger receipt and that receipt is
source-sealed under its assigned version. Do not promote the reserved activation
filename and do not deploy it through an ordered migration sweep. Apply the
exact staged `tournament_chip_supply_is_an_immutable_conserved_ledger` bytes in
a later stopped-caller maintenance window through Supabase `apply_migration`.

Before application, prove the migration name is pristine, the normalization
receipt is unique, its stored bytes match source, `tournament_players.chips` is
`bigint`, every tournament stack is a nonnegative whole chip, and every capable
caller is stopped. After application, capture the unique ledger-assigned
activation version and byte-verify its sole stored statement before restarting
the caller. The normalization receipt must sort before the activation receipt,
and the earlier RPC-seal receipt must sort before both. A timeout is an unknown
outcome and requires a name/byte readback before any retry.

Source-seal the activation by renaming the sole `.sql.pending` file to
`supabase/migrations/${SUPPLY_APPLIED_VERSION}_tournament_chip_supply_is_an_immutable_conserved_ledger.sql`
without changing its bytes. Require exactly one staged-or-promoted source, rerun
the chip-supply PostgreSQL 17 race probe, commit, merge, deploy, and prove the
served application/engine SHA contains that ledger-assigned activation version.
The release is not complete while the live receipt and source filename disagree.

## Abort and rollback

The cutover migration is one transaction. Any SQL exception means no cohort,
type, trigger, or function write committed. Preserve the error and artifact,
restart the same exact image through section 5's locked engine-up path, then
restart and prove `sp-autoheal` is running before restarting and proving the
supervisor timer active. Release descriptor 9 only after all three recovery
authorities are confirmed. Investigate the failed invariant; never weaken a
guard to fit the window.

After a confirmed commit, rollback means a reviewed forward migration; it does
not mean restoring fractional chips or deleting the ledger row. If source
sealing or publication fails after the database commit, keep the exact engine
build live and treat the release as incomplete until the byte-exact migration
and receipt are merged.
