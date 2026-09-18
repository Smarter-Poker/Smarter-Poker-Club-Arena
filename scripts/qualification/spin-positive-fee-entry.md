# Genuine positive-fee Spin entry qualification

This is a sixth image in the existing, directly invoked
`scripts/ci/test-spin-expiry-postgres.py` qualification. It retains the five
existing images, their cases and their limits. It adds no allocator, scheduler,
production target or alternative release path.

The previous funded fixture bought two seats. It established actual funding
and expiry but could not exercise the third-seat booking trigger, positive fee
capture or the current fee-source contract. The separate current-terminal
fixtures start from declared synthetic historical rows; they are not a real
paid-entry producer either.

The new image starts with the original three zero synthetic principals and
auth-only cancellation actor, before restoration of the actual triggers. It
restores the captured current accounting and entry authority with guarded
catalog readback. It restores the actual legacy MTT admission contract without
activating a different ABI. Captured configuration rows are separate from
business data and are installed before the real requests.

The fixture issues 100 isolated chips through the real Mint, transfers one chip
to each of three wallets through the actual bank authority, creates a Spin
through its current creator, and buys three seats through distinct live
synthetic sessions and the real public purchase endpoint. The third committed
purchase must produce one 2.76-chip reserve contribution, one 0.24-chip fee,
and three immutable 0.08-chip fee sources tied to their original paid entries.
The expected conservation equation is 100 = 97 treasury + 2.76 reserve + 0.24
open fee liability. Tournament stacks are play chips, not an additional cash
store in that equation.

Assertions inspect committed database rows, original journal identities,
membership-at-charge history, trigger-created inventory and original flows.
An independent strict-JSON/Decimal reader verifies emitted raw evidence.
Explicit duplicates follow only known successful commits: repeating the third
seat and booking must leave the complete restored business estate unchanged.
An error or unknown commit outcome ends that allocation; it is never retried.

The original 240-second work and 30-second cleanup limits still apply. The
same owner seals all source inputs, retains every original output and error
stream, proves client/server cleanup and verifies unchanged staged sources
before removing a successful disposable allocation. Failed evidence remains
failed and is retained. Source and corrupt-evidence controls run through the
existing wrapper; the existing CI classifier routes every new input to the
required accounting job.

This certifies entry only when its actual native run passes. `starts_now` is
not evidence that a game launched. This fixture does not establish a draw,
gameplay, mixed historical settlement, completion, commission-bearing agent
agreements, MTT activation, satellite/restart paths, production installation,
recovery of missing history, or closure of the oldest production alert.

Local PostgreSQL 17.11 execution `a57700f3-1c00-4a19-b15e-87cdc0aa260d`
passed on committed source `62adcacd679965005bd78d442907d031fd65b2db`.
All 121 source inputs, 32 process stages, 64 original streams and disposable
allocation cleanup were verified. The independent reader accepted all three
paid entries, exact conservation and both unchanged replays. Two original
warnings report the absent isolated `realtime` schema; realtime delivery and
connected-service qualification remain false. Required hosted checks,
protected integration and all broader qualification remain separate.
