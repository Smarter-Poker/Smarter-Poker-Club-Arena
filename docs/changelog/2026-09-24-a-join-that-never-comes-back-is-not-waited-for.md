# A join that never comes back is not waited for, and an unknown outcome says how far it got (2026-09-24)

Run 36041108119, the 17:55 UTC break. It is the first engine release whose
legacy checkpoint admitted or deferred every table in the capture walk and
whose join named its members (#5198, #5201, #5202, #5203), and it ended as:

```
{"ok":false,"reason":"inspector operation outcome unknown","retryAllowed":false,
 "checkpointInvoked":true,"inspectorClosed":true,"cleanupConnections":0}
```

The guard's call outlived the publisher's 20000 ms work budget. Because the
guard's summary travels only as the call's return value, the one fact that
decides the next fix - which stage was running, how many tables it had
written, for how long - reached nobody. The engine stayed on `8825af51`;
this was the thirteenth consecutive refused release since 2026-09-22.

## Two fixes, both at source

**1. The previous-work join is bounded.** Between the capture walk and the
row proofs the guard awaits `Promise.allSettled` over every captured engine's
park write and every stopped engine's teardown - up to ~700 promises on the
live fleet. A promise that will settle does so on the next tick: a park write
that finished at the :53 announcement, a teardown that finished when the table
broke. One still pending seconds later is either a Supabase write the engine's
client is retrying (`persistPresenceForRestart` waits 5 s and tries once more)
or a teardown a dead process will never finish, and waiting does not change
which; it only turns a refusal the guard could NAME into an outcome nobody can
read. Every join is now raced against one shared 5000 ms budget (of the
20000 ms the publisher pays), and a join that has not settled by then is
reported exactly like a rejection, with its table and its kind:

- a pending `presenceSave` refuses `previous_native_work_unconfirmed`,
  `failedCheck previousNativeWork.presenceSave`, member `r.PendingJoin(none)`
  - the engine's own write may still land, and the guard's must queue behind
    it;
- a pending `teardown` on a stopped engine that has already released process
  ownership (the only shape `captureEngine` admits as stopped) is dead work in
  exactly the sense #5201 defined for a failed one, and takes the same
  rows-proved deferral: `deferredUnresolvableCustody` label `pendingTeardown`,
  proved quiet from `hand_state_snapshots` before anything is written.

**2. An unknown outcome says how far it got.** The guard keeps a small record
of its own progress on the predecessor's global object
(`__legacyEngineCheckpointProgress`: stage, the sub-step it is on, elapsed ms,
tables attempted/written/verified, the reason if it refused), stamped at every
stage change and every table it writes or verifies. When the call's result
never comes back, the transport reads that record with one `Runtime.evaluate`
on the cleanup connection it already holds and carries it as `progress` in the
refusal. Held to a fixed set of keys and shapes; nothing else on that object
travels. Observability only: no outcome moves.

If the 18:55 break refuses again, its receipt will say where the twenty
seconds went, and the budget can then be sized from a measurement instead of
a guess (the law in `tests/the-release-enters-the-break-with-time-to-finish.law.test.ts`
insists on exactly that).

## Pinned

- `tests/legacyEngineCheckpointGuard.test.ts`: a stopped engine whose teardown
  never settles is deferred and proved from rows, nothing written; a park
  write that never settles refuses and names its table and join; the guard
  leaves its progress record with `stage: complete` after a clean run.
- `tests/operations/legacy-checkpoint-transport.mjs` (`timeout` scenario): a
  guard that hangs leaves a record on the target, and the unknown outcome
  carries exactly its shaped fields and none of the secret that sat beside
  them.
