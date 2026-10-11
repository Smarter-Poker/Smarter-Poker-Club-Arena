# Cashier enhancement Phase 1 of 7: deletion waits for chip custody

The normal Close Account operation already refuses live seats, tournament entries,
pending cashouts and held escrow. A direct staff/service status update bypassed
those checks. Its automatic bank-return hook could then drain a later escrow refund
before the canonical cashout writer verified its wallet post-image, aborting the
refund transaction. Live inspection found no remaining deleted-player seats,
held/locked chips or pending cashouts; no historical settlement is required.

The profile status transition now enforces that existing custody prerequisite.
It leaves active hands, tournament rights, holds and request receipts intact.
Once custody settles, deletion remains eligible and free chip wallets return to
the club bank through the existing ledger-conserved, once-only writer. Later
credits to already-deleted accounts retain the existing bank-return protection.
A completed cashout approval (approved plus completed_at, with released escrow)
no longer blocks the normal Close Account operation forever. An open approval
still refuses. The patch checks exact installed source before and after changing
only that predicate.

Horses and humans use the same rule; no scheduled repair or engine restart is added.

The trigger uses the existing user table-cap lock, then locks club banks and
wallet rows NOWAIT in that order.
A concurrent custody operation refuses deletion atomically rather than waiting
behind its inverse profile/wallet lock order. The caller may retry deletion after
that operation settles; no financial request is replayed by the guard.

Regression qualification extends the existing mandatory native deleted-account
CI lane. It reproduces direct deletion with a live seat before installation,
then checks every protected custody status, unchanged balances on refusal,
settled custody and exact-cent bank return/replay, browser ACL refusal and a
real two-session credit/deletion and bank/deletion conflicts. The busy-bank
regression reproduces a waiting deletion before the lock refinement, then
requires immediate row-lock refusal and unchanged custody after it. Ordinary profile edits are unaffected.
Production financial fault tests are excluded; installation and readback are
recorded separately in the task checkpoint.
