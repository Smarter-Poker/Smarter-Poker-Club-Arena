# A legacy-checkpoint protocol refusal says which one

**Date:** 2026-10-30. **Scope:** `server/scripts/legacy-engine-checkpoint.mjs`
(the inspector client that runs from the control checkout on the host, so it
takes effect on the next release attempt without an engine cutover),
`tests/operations/legacy-checkpoint-transport.mjs`,
`tests/legacyEngineCheckpointTransport.test.ts`.

## What happened

Owner-window release 82f1e5632 (run 41071578166, window
`2026-10-30-horse-river-model-and-heap-fix-next-55`) did everything the
previous attempt against this EED predecessor could not: the inspector
absence was proved on the fresh process (instance 1-a474c9ca, after the
13:38 UTC heap-exhaustion restart), the :53 announcement was accepted, the
:55 break certified, the legacy entry locked, rollback readiness proved in
1.1 s, and the one-shot guard was invoked on the predecessor. The whole
outcome was then one word:

```
{"ok":false,"reason":"inspector protocol refused","censusMemory":{...,"ok":true},
 "retryAllowed":false,"checkpointInvoked":true,"inspectorClosed":true,"cleanupConnections":0}
```

Three different events shared that word: an inspector response over the
64 KiB carrier, a CDP `error` object answering the request in flight, and an
unparseable frame. Nothing recorded which request it answered or what the
inspector said, so the release ended, the break thawed with EED still
serving, and the next attempt (048c7b868, in flight) can only repeat the
experiment blind. CLAUDE.md 10.86 rule 1: "I could not tell" needs its own
name - and here it needs its own detail.

## What changed

Observability only, built the way `lost()` already describes a timed-out
request: `reason` stays exactly `inspector protocol refused`, the refusal is
still a refusal and `retryAllowed` is still false. The pending-request table
now remembers each request's operation and CDP method; a CDP error answer
rejects with `transportDetail`
`op=<operation>,cause=cdp_error,method=<method>,code=<n>,message=<inspector text>`
(sanitised to the same 512-character carrier class the guard's details use),
an oversize frame with `op=<operation>,cause=oversize_response,bytes=<n>`, and
`transportDetail` is emitted for this reason as it already is for
`inspector operation outcome unknown`. `fail()` delivers a ready-made
detailed error as it is and wraps a bare reason exactly as before.

New transport scenario `protocol_error`: the fixture target returns a value
the inspector cannot return by value (a BigInt), the real CDP answer is an
error object, and the result carries
`op=guardCall,cause=cdp_error,method=Runtime.callFunctionOn,code=...` with no
private field leaked. All 19 transport scenarios and the 7 root suites that
read the client pass.

## What this does not do

It does not make the refused checkpoint retryable, does not change any
budget, and does not say why 41071578166's guard call was refused - the next
attempt will.
