# An unknown outcome names its operation, its deadline and the step it was lost in (2026-09-25)

Run 36144233010, the 13:56 UTC break, commit `c3e8d3fe`. It is the deepest
any legacy 8825 checkpoint has reached: past the bank-residue proof, past the
park writes, past the readback, with all 65 tables attempted, completed and
verified - and it ended as:

```
{"ok":false,"reason":"inspector operation outcome unknown",
 "progress":{"elapsedMs":5954,"attemptedTables":65,"completedCalls":65,
             "verifiedTables":65,"stage":"mixed_custody","note":"mixed_custody"},
 "retryAllowed":false,"checkpointInvoked":true,"inspectorClosed":true,
 "cleanupConnections":0}
```

The progress record added on 2026-09-24 did its job and got one gate further,
and then ran out of vocabulary. `cleanupConnections: 0` says the socket was
never lost and `inspectorClosed: true` says cleanup completed, so the guard's
call did not fail - it was still running when the publisher's 20000 ms work
budget ran out. Everything after that is what nobody could say:

- **which operation.** `inspector operation outcome unknown` is produced by
  three different facts: a budget already spent before the call was issued
  (nothing was sent), a call that was issued and outran the slice left for it
  (its answer is genuinely lost), and something that is not a transport
  refusal escaping at all. Only the second leaves work in flight inside the
  predecessor, and only the second is answered by a bigger budget or a
  cheaper call. One word for three facts cannot say which fix it is asking
  for.
- **which deadline.** The per-operation allowance is `min(20000, deadline -
now)`, so the guard's call gets whatever the discovery, the `SIGUSR1` open
  poll, the fourteen dynamic imports, the prototype read and the
  `Runtime.queryObjects` heap walk left behind. That number - the
  milliseconds the operation actually got - was never written down anywhere.
- **which step.** `mixed_custody` is **two** operations,
  `proveAbandonedBoundaries` then `sealAndRetireOriginals`, and the second is
  six RPCs across two managers, one of which inserts an immutable
  `f06_manager_custody_transfers` row. Both opened by stamping the note with
  the _stage's_ name, so the record could not say which of them was in
  flight, which manager, which RPC, or whether a commit had been sent.

`witness` and `noteRefusal` cannot answer any of it: they travel in the
guard's **return value**, and an unknown outcome is precisely the case where
the return value never arrives. The progress record is the only channel, so
the record now carries the step.

## What changed

**The transport names the operation and the deadline.** Every inspector
operation carries a name (`guardCall`, `queryObjects`, `importModules`,
`inspectorOpen`, the cleanup steps), and a lost outcome is emitted as
`transportDetail`, a compact `key=value` string in the same 512-character
carrier class the guard's own details use:

```
op=guardCall,cause=request_timeout,method=Runtime.callFunctionOn,
allowanceMs=13820,waitedMs=13821,budgetMs=20000,spentMs=19998,invoked=yes
```

`cause` tells the three facts apart: `budget_exhausted` (nothing was sent),
`request_timeout` (sent, and its answer is lost), `unexpected_error`.

**The guard names the step.** `note` is now the step's own name, never the
stage's, and a new `detail` holds the page, the manager and the RPC:

- `proveAbandonedBoundaries` / `proveAbandonedBoundariesPage`
  (`page=1/1,ids=1`)
- `sealObserveManagers` / `sealObserveManager` / `sealCommitManagers` /
  `sealRetireOriginals` (`manager=1/2,tournament=<id>`)
- `mixedCustodyRpc` (`rpc=fn_f06_prepare_mixed_manager_custody,phase=commit,
tournament=<id>,commitAttempted=true`) while a call is on the wire, and
  `mixedCustodyRpcAnswered` the moment the answer is in hand - because an
  outcome lost with a custody commit in flight and an outcome lost while
  checking a reply already received are not the same fact, and only the
  second is safe to describe as "nothing was written".

A bare `progress()` refreshes the counters and keeps both; a named step
replaces both, so a detail can never outlive the step that wrote it.

## What did NOT change

Nothing. `reason` is byte-identical for every existing parser, `retryAllowed`
stays false, and a lost outcome still refuses. That is deliberate and it is
correct: the guard's call was still executing inside the predecessor, possibly
between the two phases of a custody transfer, and whether a commit landed is
genuinely unknowable from the client. CLAUDE.md 10.86 rule 2 - a non-answer is
never folded into a quiet answer. The fix for the refusal itself is either a
larger work budget or a cheaper `mixed_custody`, and **the number that decides
which** (`allowanceMs`, and the step it was spent in) did not exist until now.
Choosing between them before the next run reports those numbers would be a
guess against the 285000/245000/40000 ms break arithmetic in
`engine-release-transaction.sh`, which has already been got wrong once.

## Proof

- `tests/legacyEngineCheckpointGuard.test.ts` - 265 tests. Six new ones prove
  the page, the RPC, its phase, its manager and `commitAttempted` are named;
  that a call on the wire is told from an answer in hand; that no stale detail
  survives a later step; that a refusal inside a named step still refuses with
  its original code; and that a global object which refuses the record moves
  no outcome at all.
- `tests/legacyEngineCheckpointTransport.test.ts` - 12 scenarios against a
  real Node inspector. The `timeout` scenario now asserts the exact
  `transportDetail` shape, that the allowance is the _remaining_ slice of the
  work budget rather than the whole of it, that the operation waited it out,
  and that `reason`, `retryAllowed` and `checkpointInvoked` are unchanged.
