# Checkpoint final receipt margin

The c05 release exhausted its existing absolute 40-second checkpoint budget and
its outer client was killed before emitting a JSON outcome. That establishes a
lost receipt, not which native census, guard await or cleanup operation stalled.
The operation remains nonretryable; this change does not repair or certify the
underlying production checkpoint hang.

The checkpoint client now reserves 1,000 ms inside a supplied absolute deadline
for its bounded final receipt and exit. Work pays this reserve before its
unchanged cleanup allowance, and cleanup ends before the receipt reserve begins.
A supplied deadline without positive work time after cleanup and receipt reserves
is refused before Inspector access. Standalone work budgets retain their current
behavior. The shell's 40 seconds, cleanup's 5-second ceiling, 245-second cutover
reserve and 135-second rollback reserve are unchanged.

The original guard Promise remains rooted and awaited once. Lost work keeps its
original transport detail even when native cleanup is unknown. There is no new
guard call, retry, competing client close, progress producer or engine action.
The final margin avoids the demonstrated equal-deadline race; it cannot guarantee
receipt delivery during an arbitrary client CPU stall or transport failure.

Regression protection uses an owned synthetic target and actual V8 Inspector.
A pending guard queues ordinary busy JavaScript, allowing Inspector interrupts
and the native close ACK while delaying the fixed setImmediate(close). Both work
and cleanup exhaust their slices. The old client returned with -1 ms remaining;
the corrected client returned UNKNOWN with 999 ms remaining, one guard call,
one await, one native close request, no client close, and eventual same-process
liveness, listener absence and normal fixture exit on local Node 26.3.0.
The existing exact-production Node 22.23.2 isolated Linux container qualification
also includes this case; its local Mac skip is not a Linux execution result.

The actual CLI also awaits the original summary stream write callback before
exit, bounded by the reserved second and original absolute deadline. Real pipe
backpressure tests verify complete bytes before failure exit and a permanently
blocked pipe remains a bounded publication failure with exit1, never exit75.

A necessary delivery dependency uses the maintained owner-window route: one new
18:30-22:30 UTC October 30 continuation and an exact new activation-floor witness.
All 54 old entries retain their exact bytes and relative order; database
windows, witnesses and expiries remain unchanged. The new entry precedes old
entries because the producer treats an active obsolete floor witness as invalid
before reaching a later selected floor; no producer guard is relaxed.
It requires the qualified protected receipt fix, minute53 notice/minute55 cutover
and all existing ownership, drain, freeze, certificate and rollback predicates.
It grants no replay of c05 or assurance of native eligibility or live recovery.

Local qualification also passed both receipt scenarios on Node22.23.3; this is
not the pinned22.23.2 Linux result. The existing floor native tests passed22/22
using an owned byte copy of previously installed external GNUcoreutils9.12 timeout
(SHA256 4c2e0a7bcc0c1bb309df86b9874a40db43f3f8c501b308e1899116f02e10cb46,
only libSystem dependency); the absent-PATH prerequisite failure was retained.
The38 existing native recovery-window tests passed without changing production
transaction or seal logic. Required hosted checks and live delivery remain open.

The real closed-reader pipe case also exposed Node's write-callback/error-event
ordering: removing the error listener on a failed callback allowed a later EPIPE
to terminate before its bounded status returned. The corrected publisher retains
its one-shot error listener on failed or timed-out writes until the event or CLI
exit, without logging the native error or sending a second receipt. The prior
ordering failed the owned subprocess regression; the corrected26.3.0 and22.23.3
runs preserve normal exit1 on closed-reader failure.

The publication wait itself stops at the earlier of900ms or100ms before the
original deadline. That leaves exit/forwarding headroom even for a blocked pipe.
An owned child enforces the actual original deadline with SIGKILL: the previous
publication wait was killed there; the split returns a bounded failure with
positive remaining time and exits1 normally before that same guard. No overall
budget increases, receipt replacement or additional engine operation is added.

The normal pre-push source-contract gate caught its old single-exit count. The
existing law now pins exactly two exits: awaited publication first, publication
failure only exit1, then the unchanged sole native deferral predicate for75/1.
Its negative permutations, original shell intent rules and245-second reserve
remain unchanged. The failed first push did not publish the branch.

Protected main later added bounded native census counts in#8766, intersecting
the same client and transport fixture. Integration preserves that complete
change, every incoming migration and qualification binding, and both sets of
fixture scenarios and assertions. The two fixture conflicts are resolved by
selecting census refusals before the existing hang modes and retaining both
independent receipt and census assertion blocks. No migration is replayed.
