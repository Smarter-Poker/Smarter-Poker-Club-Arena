# Wait for the first Players read before confirming manual refresh

When Refresh Club Ledger is pressed during the initial Players load, the shared request guard must return that read's actual result. Returning success immediately can re-enable the button and report Club Ledger Refreshed while the Players requests are still pending.

Join the current bounded cold-read result before the generic single-flight guard. Preserve the existing version ownership for realtime refreshes, deliberate sort changes, and club changes. A stale outgoing club response still cannot clear the incoming club's spinner or rows. First-load failures retain bounded diagnostics for both player RPCs, without changing their assertions or timeouts.

The focused component regression fails on the merged first-paint guard because manual refresh finishes before the deferred Players read. It passes with result ownership, including replacement and stale-club assertions. Incoming first-paint and recovery regressions remain intact. Final compilation, build, protected checks, publication, and complete hosted/live verification remain delivery requirements.
