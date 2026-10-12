# A chip request tells its approver (2026-10-06)

## What was wrong

A new member joins a club with 0 chips. The way to get some is a chip request
from the club cashier. `fn_request_chips_core_20261004` inserted the
`chip_requests` row and returned. No notification, no push: the approver (the
member's agent, or the club owner when the member has none) found out only by
opening the cashier. Production held one chip request, ever.

## The fix, at the cause

Migration `20261006022835_a_chip_request_tells_its_approver.sql` rewrites the
function from its installed definition (md5 pinned, so it aborts if the body
moved) and adds one block after the insert: `fn_raise_notification` to the
approver, type `chip_request`, title "Chip Request", message
"<Name> Requested 1,234.50 Chips", link to the club cashier. It runs in the
request's own transaction. A replayed request returns before the block, so a
retry never notifies twice; an approver asking for themselves is not notified.
Nothing is scheduled and nothing sweeps: the request and the word of it are
one write.

## Proof

Executed on a scratch PostgreSQL 16 holding the installed definition
(md5 `236c0cecc1dd32f30f7b50e790f88b63`): first request -> one notification to
the club owner, "Alice Requested 1,234.50 Chips"; the same retry key again ->
`replayed: true`, still one notification; the owner's own request -> none.
Applying the migration a second time is a no-op.

Pinned by `tests/a-chip-request-tells-its-approver.law.test.ts`.
