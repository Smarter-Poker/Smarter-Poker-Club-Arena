# Atomic Terminal Tournament Settlement

Non-satellite tournament completion now has one service-only database
transaction. It selects exactly one existing cash authority, settles active
mystery bounties, closes the funded bounty pool, requires durable successful
rake attribution, drains all three escrow banks, releases every active seat,
closes every tournament table, clears break state, marks the event `COMPLETED`,
and stores one immutable receipt. A malformed or partial result raises and
rolls the complete transaction back.

The stored receipt is also the replay boundary. A repeated call verifies the
cash payouts, wallet keys, obligations, bounty ledger, mystery inventory, rake
settlement, escrow, exact table and seat identities, and lifecycle against
immutable receipt values. It invokes no money authority and creates no new
ledger row.

Long-running mystery events can cross the obligation cutover without a repair
or second payment. One owner-only verifier partitions every completed chest
and champion residual between exact pre-cutover `mb:` / `mb-residual:` wallet
keys and exact post-cutover obligation-key intervals. It proves that partition
per recipient, requires the two eras to equal the frozen inventory cent for
cent, and stores the evidence inside the immutable mystery receipt. Missing,
overlapping, malformed, or unproved evidence aborts both first completion and
replay.

Guarantee overlay money is now journaled into `tournament_escrow.overlay_in`
and `prize_balance` in the same transaction and under the same immutable
overlay identity as the club or union bank debit. Tournament hand persistence
also mirrors the final seat stacks to the playing roster and vacates named
zero-stack seats before it returns; its receipt names the exact users, stacks,
seat IDs, counts, and remaining live-seat count. A terminal completion can
therefore price only a fully persisted hand boundary.

All rolling component finish doors and the live multi-claimant bounty door
take the same global transaction lock before any row lock. Satellite and
non-satellite terminal settlement use that identical first lock, eliminating
cross-event bank and recipient lock inversions during the server rollout.

`tables.terminal_closed_at` records the receipt's completion time on every
closed tournament table. Its database guard rejects reopening, reassociation,
replacement, or deletion of terminal tournament tables. A deferred tournament
constraint also rejects any non-satellite `COMPLETED` state that lacks its
verified terminal receipt.

If an HTTP response is lost, `fn_resolve_tournament_terminal_outcome` takes the
same global settlement lock and tournament lock as the money authority. It
waits behind any in-flight terminal transaction, then returns either the
verified committed receipt or a proven `RUNNING` or `COMPLETING` miss. A plain
status read is never treated as proof of rollback.

The separate stage-two migration is held under `supabase/staged-migrations/`
and is intentionally not part of the auto-applied stage-one batch. It refuses
to retire bounty recovery until the
database holds a real post-cutover receipt from a `RUNNING` event, every stored
receipt still verifies, no non-satellite event is `COMPLETING`, every completed
bounty pool has exact zero residual and no open obligation or chest, stable
locks are held, and no matching cron invocation is running. Only then does it
unschedule `ca-bounty-backpay-hourly` and drop
`fn_backpay_unfinalised_bounty_pools` with `RESTRICT`.

The terminal RPC receipt has these top-level fields:

`ok`, `fully_settled`, `status`, `tournament_id`, `winner_id`, `mode`,
`settlement_mode`, `payouts`, `deal_shares`, `winner_amount`,
`bubble_protection`, `cash`, `mystery_bounty`, `bounty`, `closed_table_count`,
`released_seat_count`, `table_closure`, `rake`, `escrow`,
`cash_payout_total`, `bounty_payout_total`, `receipt_version`, and
`settled_at`.

`payouts` is the complete durable cash payout ledger for the event.
`deal_shares` contains only the live final-table chop recipients and is empty
for place settlement. `table_closure` contains sorted table and seat UUIDs plus
their exact counts. The top-level closure counts repeat those values so the
consumer can reject a mismatched receipt before presentation cleanup.

For a funded mystery event, `mystery_bounty.payment_evidence` contains
`evidence_version`, `evidence_mode`, `pool_cents`, `inventory_cents`,
`completed_award_cents`, `void_chest_cents`,
`legacy_award_credit_cents`, `legacy_residual_credit_cents`,
`legacy_credit_cents`, and `obligation_cents`. `evidence_mode` is exactly one
of `legacy_wallet_keys`, `obligations`, or `mixed`.
