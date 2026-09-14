# Queued engine releases keep waiting for a complete maintenance window

A queued release can finish building or acquire the engine lock after another
release has used the beginning of the maintenance window. Previously, a valid
certificate with fewer than 285 seconds left permanently failed and retired the
request before it could prepare a candidate.

The pre-prepare queue now rejects that short window and waits for another valid
certificate within the original absolute request deadline. It releases the
engine lock before waiting, continues source-freshness checks, and still requires
the complete 150-second candidate plus 135-second rollback reserve under the
lock. No break deadline is persisted and no candidate is prepared for the short
window. Existing recovery, ownership, cancellation and committed-run behavior
remain in place. Previously retired requests are not revived.

Ten executable controller cases cover initially short and lock-depleted windows,
lost certificates, both deadline bounds, supersession, cancellation, lock release
and an already-serving exact candidate. These are isolated control-flow tests,
not a claim that a production release or full financial qualification succeeded.
