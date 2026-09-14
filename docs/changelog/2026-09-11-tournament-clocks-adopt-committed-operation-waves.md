# Tournament clocks adopt committed operation waves

Operation maintenance now reaches the actual TournamentManager before start or restart. It holds blind, entry-close/reprice and add-on work independently of the tournament's own `on_break` flag. Lease renewal, engine recovery, hand completion and lifecycle shutdown keep their existing ownership paths.

A manager reports the named work already admitted when the operation arrived. A new synchronized own-break cannot enter after that hold. An already-admitted own-break write remains part of the drain, because the retained SQL snapshot excludes tournaments with `on_break=true`. The readiness snapshot cannot race ahead of that accepted write.

After a whole event wave has a committed physical ACK, the manager reads its current level and anchor without writing them, then reads the operation again. Operation, release, generation, ownership, phase and exact ordered wave receipt must still agree. The timer consumes any elapsed time during the reads. A failed read or revoked authority leaves it held. A later global certificate separately releases financial/add-on scheduling from the actual shifted row. A certificate wake arriving during an older read remains pending; repeated wakes do not repeat the completed global redrive. Retained ACKs and prior-generation global receipts remain usable through the current exact operation authority; this change does not invent a recovery freeze for an already-resumed wave.

Ending an existing synchronized break now writes `on_break=false`, `break_ends_at=null` and the exact resumed level anchor in one update. The timer then arms from that anchor without another write. Lost responses require exact row readback; a refusal or ambiguous read keeps the break and its end announcement held. Retrying uses the same anchor, consumes elapsed time and never grants a new full level. A lifecycle stopped during either write or readback cannot clear local clock ownership. If that exact write committed but both its response and initial readback were lost, the existing readiness retry can reconcile it through a fresh row plus operation readback. This path sends no new database write and announces no end or timer while held; an uncommitted or revoked intent continues blocking readiness.

Validation uses the actual manager and Runtime in controlled lifecycle tests, followed by a socket-only PostgreSQL 17 composition using the real Store and the pinned maintenance authority. The native matrix covers a 16-minute hold, committed wave suffix adoption, strict readback revocation, and the real atomic own-break write with a deliberately lost response. The pre-existing break, add-on funding, duration and lifecycle tests retain their checks through the extracted implementation methods. Exact source hashes and final counts are in the adjacent evidence receipt.

This is held source. It does not install or activate policy 2. Database expansion and coordinated runtime/client/host activation are still required. The separate global-certificate COMMIT-visibility gap and the physical PostgREST request-lifetime gap remain unresolved activation prerequisites; these tests do not certify those boundaries or production gameplay.

The reviewed prerequisite snapshot is separate from the manager delta, based on `7867126a0bf1c6d89f4df3eb4e75a09ee3859e43` plus the synchronized-break repair originally committed as `16a96e755802d708a2ea46db2064605e1afbb9bb`. Integration must reconcile its own exact maintenance prerequisites instead of blindly cherry-picking the duplicate snapshot.

Native reproduction, after composing the held authority/provider prerequisites:

```sh
python3 ../codex-pipeline-maintenance-db/tests/maintenance/native.py \
  --fixture ../codex-pipeline-e2/scripts/ci/fixtures/e2-bee519fa-20260911.tar.gz \
  --provider-migration ../codex-pipeline-provider/supabase/migrations/20260911160341_provider_operation_boundary.sql \
  --evidence "$PWD/work/tournament-operation-clock/native" \
  --integration-script "$PWD/tests/maintenance/tournament-manager-composition.mjs"
```

Run this with Node 22 on PATH. The runner creates and stops its own native PostgreSQL cluster, accepts no network database destination, fingerprints all executable composition inputs, and runs the authority matrix before the manager cases. Its explicit fixture-administrator setup is separate from tested service-role calls, which retain the real triggers and ACLs. The sealed E2 loader omits table ACLs, so native setup supplies service-role reads on the local public tables plus auth-schema usage and updates to only the three tested tournament clock columns; this is not production RLS/ACL certification. Table-engine network infrastructure and the abstract prize calculator are test stand-ins; manager lifecycle, timer logic, authority RPCs, Store parsing and persisted clock rows are real.
