# Native maintenance runtime composition

`runtime-composition.mjs` runs the unchanged 17-case authority suite first, then
clones its `maintenance_template` for independent runtime cases. It does not
replace the earlier authority receipt or modify its source.

Run from this worktree with the production Node version (22.23.2) on `PATH`.
The receipt records the actual Node and TypeScript versions:

```sh
python3 tests/maintenance/native.py \
  --fixture ../codex-pipeline-e2/scripts/ci/fixtures/e2-bee519fa-20260911.tar.gz \
  --provider-migration ../codex-pipeline-provider/supabase/migrations/20260911160341_provider_operation_boundary.sql \
  --evidence work/maintenance-db/runtime-composition-review \
  --integration-script "$PWD/tests/maintenance/runtime-composition.mjs"
```

The runtime source defaults to the sibling `codex-pipeline-maintenance` tree;
`CA_MAINTENANCE_RUNTIME_SOURCE` can select an explicitly prepared checkout.
Seven TypeScript/JSON files are read, hashed, snapshotted and transpiled without
rewriting their bodies. Their hashes must still match when the run finishes.
The server's installed TypeScript compiler is used. No production environment
or credentials are loaded.

The real operation store forwards its existing named RPC arguments to a
dedicated native PostgreSQL connection with the service role and service JWT.
The runtime's subscription adapter listens to actual database maintenance
wakeups. This proves the wakeup/read/claim sequence, but does not certify the
Supabase Realtime or PostgREST transports. Database reads remain authoritative.

Physical pause/resume uses explicit synchronous instrumented engine stand-ins.
The actual runtime, store, v3 thaw client, operation clock, reconnect clock and
per-table/global freeze modules execute unchanged. This fixture does not run
the whole GameServer or a real deal loop. The separate authority suite proves a
new canonical accepted hand during an acknowledged first wave.

Historical 16- and 30-minute holds are administrative fixture setup, inserted
atomically with their compatibility row. The 30-minute fixture has an existing
readiness/wave plan from before its deadline; the runtime cannot manufacture
that evidence after the deadline. Every subsequent adoption, permission,
target credit and acknowledgment uses the actual installed SQL authority.

Results include raw microsecond database timestamps, named RPC requests,
committed responses, physical resume counts, notifications, client frames and
clock target receipts. A failed or lost transport response never stands in for
a successful database acknowledgment. Injected transaction failures are local
fixture faults, not replacement implementations of the production functions.

The final global-tail cases retain the real v3 base reservation (501 targets
require roughly a minute before wave execution). They test fixed checkpoints
across multiple worker installments, missed endpoints, lost committed replies,
no-success time passage, old-owner refusal, all fourteen clock classes in the
global scope, and cold readback. Final receipts bind target identities and
amounts; database release is effective at its certified endpoint without a
subsequent timer or read RPC. Informed local predicates use the same boundary.
A process without the certificate remains locally fail-closed until readback;
this is a connectivity limit, not authority to extend the maintenance clock.

The final matrix contains 17 database-authority cases and 14 runtime/store cases.
The induced future-ACK case uses a deliberate clock skew and delays delivery of
the actual database pre-write refusal until that same captured timestamp; it
proves one physical action and an unchanged retry, not a production clock skew.
A delayed certificate insert must fail the deferred finalization check and roll
back both release projections and the uncommitted clock suffix. See the authority
document for the remaining commit/WAL visibility limitation.
