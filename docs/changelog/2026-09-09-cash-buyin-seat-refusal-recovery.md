# Cash Buy-In Seat Refusal Recovery

## Confirmed Defects

Continuing REAL TIME UPGRADES from its September 8 source. A cash join refused
because its selected seat was occupied returned SQLSTATE 23505. The client
classified that known rollback as an unknown financial outcome and retained the
original seat and amount indefinitely. Another click could only review/retry
that same occupied seat. SEAT_RESERVED was also absent from the refusal mapper,
so a waitlist hold followed the same unresolved path.

The insufficient-club-chips message was wrongly attributed to the club treasury.
The production function raises it after a conditional debit of the player's
club_members.chip_balance. It says the player's club wallet is short.

## Repair And Transaction Evidence

The classifier recognizes only SQLSTATE 23505 with the exact reported names
of the two live seat uniqueness constraints: table_seats_table_id_seat_number_key
and idx_unique_active_user_per_table. Other unique violations remain unknown.
The mapper now handles the named waitlist hold and identifies the correct wallet.

On September 9, read-only production catalog checks verified that
atomic_table_buyin claims or replays its exact entry-purchase receipt before
calling atomic_table_buyin_before_maintenance_announcement_gate, which inserts
the seat. A completed same-key predecessor returns before those seat constraints.
The exact seat conflict therefore aborts this attempt, permitting journal cleanup
and a newly reviewed seat/amount. The waitlist exception also follows the claim.
No schema, money, seat or account mutation was performed to verify this patch.

## Verification

The tests execute TablePage's actual onConfirmBuyIn callback, with journal and
executor implementation intact and the external RPC substituted. Against the
previous source, four new cases failed and 15 passed. With the repair, 58 tests
across five files passed: callback recovery, journal identity, refusal wording,
and real buy-in modal confirmation/balance rendering.

Each repaired refusal clears the completed attempt, preserves the unseated state,
keeps the sheet open, and permits an explicit purchase at a new seat/amount with
a new key. Separate cases prove unrelated unique conflicts, mismatched SQLSTATE,
and pre-claim authorization errors retain their unresolved identity without any
automatic repeat purchase. Existing lost-response, exact-receipt, late-success,
account-change and cross-tab tests remain passing.

## Scope And Open Acceptance

This fixes demonstrated refusal paths. It does not establish the cause of the
owner's physical iPad Home Screen connection incident. The supported browser
connection timed out during tab discovery, including its documented recovery
attempt. Physical device, network-switch and paid-join verification remain open.
No paid production join was executed. Fleet hand-delay acceptance also remains
open: the initial fresh health sample had median 3,912ms, p90 11,615ms and max
31,356ms over 2,000 recent gaps.

The previous realtime worktree advanced independently during recovery and
committed its private-card batching fix. This continuation uses an isolated
worktree and does not alter that branch or the other ongoing work.

Publication is not claimed by this file until supported by a subsequent live
build-info and ancestry check.
