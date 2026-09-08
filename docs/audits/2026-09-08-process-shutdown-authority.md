# Process Shutdown Authority

Phase 1 release verification found another production failure on September 8, 2026. At 16:41:27 UTC, engine c3821317 logged an uncaught tournament authority-context exception in the elimination scheduler wake timer. It then failed the process-wide ownership drain with the same exception from GameServer.stop. Docker recorded exit code 1 and a restart at 16:41:29. The container restart count had reached ten. The inspected kernel log did not report an OOM kill; do not attribute these exits to memory without evidence.

PR #3820 already repairs the scheduler callback context and is included in staged engine target 04b66f2902d5f6183aa3f993e5f71987336ad845. That does not repair the separate process-wide drain when any future fatal callback originates inside a manager context.

The process shutdown callback now captures bootstrap context once using AsyncResource.bind. A manager-originated fatal error restores the process owner's context before GameServer.stop visits every manager through its own immutable authority binder. No authority guard is relaxed. One shared shutdown promise, failure propagation, ownership barriers and nonzero fatal exits are preserved.

The regression executes the production callback declaration without starting listeners or live financial services. Before the change, it reproduces the exact production authority exception; two other contract tests pass. After the change, all 43 tests across five files pass, including multi-manager drain, context preservation across awaits, continued rejection of cross-manager escalation, one pending drain across callers and persistence of a rejected ownership drain. Server TypeScript passes.

This correction is not evidence that every restart, Spin startup or reconnect problem is resolved. Separate Spin draw read-back failures also appeared in the production log and remain a format-lifecycle audit item. No wallets, production configuration or engine restart were manually changed. Merge, normal scheduled deployment and runtime verification remain required before Phase 1 can close.
