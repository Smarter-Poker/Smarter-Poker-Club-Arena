# Six Full-Pool Obligations Retired As Metadata

## What Was Wrong

Six completed tournaments had already distributed every chip in their locked
prize pools, but six legacy place obligations still claimed more was owed than
each finisher received. Three were cent-level rounding tails, one was a normal
ladder row superseded by a chip-proportional final-table deal, and two added a
Bubble Protection buy-in to first place after that buy-in and the rest of the
pool had already been allocated.

Paying those rows would create a second prize or debit a house bank for money
that the tournament prize pool had already exhausted.

## Evidence-Gated Retirement

Migration
`20260908065302_six_full_pool_events_retire_only_their_stale_obligation_metadata`
creates an append-only `tournament_obligation_retirements` receipt and handles
only the six named obligation UUIDs.

For each event that exists, the migration locks the completed tournament and
requires its exact prize pool, payout total, wallet prize-credit total,
finisher payout total, zero prize escrow, and original obligation shape. It
stores that evidence before changing the obligation. The retirement row is
valid only when both durable payout totals equal the locked pool and the
retired amount equals the exact old owed-minus-paid difference.

After the proof exists, the obligation is normalized to `amount_owed =
amount_paid`, stamped with
`accepted_historical_full_pool_no_second_payment`, and marked settled. Only
financial alerts that name that exact obligation UUID are resolved. Unrelated
event alerts stay visible.

## Money Safety

This migration never writes a wallet, tournament payout, escrow, chip ledger,
rake row, or bank balance. It verifies that the complete payout and wallet
totals remain unchanged after all six metadata retirements. A missing event is
safe on a clean database, but a partial historical shape or changed evidence
raises and rolls back the complete migration.
