# Stage B exact refund-origin contract

Stage B hardens one cancellation and pre-start unregistration rule without a
reconciler or delayed repair:

- `wallet_charge` returns the exact paid amount to the exact recorded source
  wallet;
- `satellite_seat` and `tournament_ticket` return only a tournament ticket and
  create zero wallet chips; and
- missing, unknown, ambiguous, or post-start funding evidence refuses the
  transaction atomically.

The six-boundary PostgreSQL 17 rehearsal executes the cash-wallet,
satellite-seat, redeemed-ticket, replay, durable-start, launch-receipt, and
persisted-hand cases against the final postimage. Every probe is rollback-only.
