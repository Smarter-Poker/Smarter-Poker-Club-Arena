# Accepted elimination preserves source custody

An accepted zero-stack hand could leave its player in `playing` while a table
break remained `park_requested`. The ordinary and bounty elimination callers
validated the accepted hand, but their roster update was rejected with
`F06_SOURCE_EXCLUDED`: the source guard recognized hand and move dispatches,
while this later elimination was neither operation.

The private elimination cores now authorize their exact next roster and zero-seat
updates inside the same transaction. The source guard consumes that authorization
only for the same candidate, transaction and complete OLD/NEW row images, before
any manifest or custody exists. API roles cannot mint it. Reused seats, changed
candidates, unrelated writes and post-manifest operations remain refused. The
existing source lanes, accepted-hand checks, money terms, public signatures and
source park records are preserved; this does not withdraw a park or invent a hand
dispatch.

The existing accounting job directly runs the maintained private PostgreSQL 17
qualification and retains its result. All four original public callers reproduce
the refusal before the repair. The final local packet passes 98 assertions, three
installation-drift refusals, and four actual concurrent ordinary/PKO claim
commit/rollback permutations with observed database waits. It covers missing and
exact zero seats, changed seat generations and candidates, earlier-trigger image
changes, failed CAS, rollback and authorization reuse. Real standard bounty, PKO
and Mystery settlement retain their booked amounts, exact completion markers and
idempotent replay. Full fixture data/catalog rollback and owned-cluster cleanup
pass. Ten result-validator tests, 437 CI-routing contracts and six directly
affected Cash input-manifest checks pass.

This packet qualifies the database correction in isolation. Production
installation, fresh catalog readback and natural affected-player progress are
separate acceptance steps owned by the coordinating task. The independent PKO
watermark correction has separate source and qualification; this change does not
relax its admission proof or certify a recovery operation.
