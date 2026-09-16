# Must Move controller wake ownership

A slow per-game wake previously lost its debounce entry before its RPC finished. Another seat change could then start a second RPC for that same game. A stalled full pass could also resume after its replacement and overwrite Main 1 hints or start an obsolete dealer. The per-game wake had the same stale-hint problem when a newer full pass changed the game during its RPC or seated-count read.

The controller now retains each game's wake ownership until the actual request and its seated-count continuation settle. Changes received during that work become one later debounced wake. Different games remain independent. Shutdown discards pending successors and joins admitted work; a rejected request releases its game through the same `finally` path.

Full passes check their serial as well as their lifecycle generation after asynchronous reads. Per-game wakes check that the captured game hint is still the current row. Both checks reach the dealer-wake boundary after the seated-count await. Superseded results cannot overwrite the latest completed summary or start a dealer from an obsolete Main 1 hint. The stalled-pass safeguard does not claim to cancel an outstanding database operation.

This changes controller scheduling and continuation ownership only. SQL planning, wallet-free seat transfers, original-occupancy validation, maintenance checks, the five-second full-pass cadence, and the 500 ms debounce remain in place. A full pass can still overlap a per-game wake under the existing database row locks.

## Verification boundary

The September 14 baseline captured three failing scenarios and three passing controls in `ClusterWakeOwnership.test.ts`, before the protected-pipeline instruction took effect. The failures were overlapping same-game wakes, a superseded pass RPC starting `obsolete-main`, and a superseded seated-count continuation doing the same. Those results describe the original source, not this repair.

The focused file now has ten cases, including rejected transport, stop/restart, and both stale per-game hint continuations. The existing controller and producer shutdown tests were reviewed for compatibility. An independent static review by the owning Must Move audit task identified the wake-hint case; its subsequent review found that the added guards address that case and reported no further actionable issue in this bounded diff.

No tests, typecheck, application build, native fixture, or live execution have run against these changed bytes. The current owner policy requires qualified protected source-job admission, which remains pending. Normal local commit guards and source formatting do not satisfy those application checks. Publication remains explicitly held by the owner.

The next qualified source must run the complete freshly derived Club Arena check catalog, including the new wake cases, existing cluster laws/metrics, producer shutdown, idle move ownership, departure-read overlap, original-occupancy receipts, restart and presence transfer, plus the native transaction fixture and actual installed composition. Final engine installation, clean shutdown, and browser/game behavior require separate release evidence. This change is not a Must Move completion or release-readiness claim.
