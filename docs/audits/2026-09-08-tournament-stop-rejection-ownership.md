# A table teardown rejection restarted the whole engine

At 17:28:38 UTC on engine 064d1864, table 4e88ad4d-4ce1-4e88-b8ef-abe7267a67f9 rejected teardown because hand 8251500 had no proven authoritative commit. The process logged `Unhandled_rejection`, then began fatal shutdown. Docker restarted it at 17:28:40, without an OOM event. This was a different entry point from the elimination scheduler callback fixed in PR 3820.

`TournamentManagerBase.stop()` starts table stop promises, then awaits scheduler, startup and lifecycle drains before attaching `Promise.allSettled` to those promises. A quick table failure is therefore unobserved while a slow manager job is still unwinding. The intended change attaches both promise outcomes immediately, retaining the results and the existing ownership-release checks. A failed table stays quarantined when its process ownership is not released. The process-wide fatal handler remains intact.

PR 3837 separately restores bootstrap authority for process-wide shutdown and is already on main; it was absent from engine 064d1864. It must be included in the next scheduled engine deployment.

## Regression proof

Two behavioral tests against the real manager stop method failed before the change and passed afterward. Each holds scheduler work open while a table rejects teardown. They assert that a rejection handler exists before any drain wait, retain the same stop promise for concurrent callers, refuse unregister when ownership remains, and still report a cleanup error when ownership was released. The fake engine uses a plain stop method because Vitest mock functions observe returned promises and would mask this bug.

All 27 focused lifecycle, table retirement, ownership and lease tests passed; server TypeScript passed. The fix changes when the existing all-settled observer attaches, without discarding the original rejection or weakening ownership checks.
