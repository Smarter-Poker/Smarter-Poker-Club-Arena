# Cashier Conservation Covers Members Who Joined After The Baseline

Read live on 2026-10-15 in the signed-in owner's Advanced Cashier (SHARK CLUB):
the Reconciliation Console reported "Coverage Incomplete, 590 Of 594 Checked,
4 Unverified Player Positions" with zero drift everywhere else.

Cause: `public.ca_chip_baseline` was taken once, 2026-08-27 01:08:13 UTC, and
nothing adds a row for a member who joins later. Every new member was therefore
permanently unverified, and the gap grows with each join (428 members across all
clubs on 2026-10-15).

Fix (`20261015022628`): a member with no baseline row who joined at or after the
club's cutoff is checked from an opening balance of zero at that same cutoff.
`club_members.chip_balance` is `NOT NULL DEFAULT 0`, so membership starts empty
and every chip since is a booked ledger leg. Read before writing the fix: all 428
such members equal their full ledger net from zero, none differ, and none joined
before the cutoff. Reusing the existing cutoff adds no ledger scan. A balance
written without a ledger leg still shows as a mismatch, so the check is wider,
not looser.

Pinned by `tests/cashier-conservation-covers-later-members.test.ts`. The release
contract accepts the installed hash and this replacement.
