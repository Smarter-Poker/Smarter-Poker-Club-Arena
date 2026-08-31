# The Live Cashier Canary Follows The Redesign

## What the production audit found

The authenticated Cashier canary still required the old `CASHIER` heading.
The premium Cashier redesign replaced that heading with
`Every Chip. Accounted For.` on August 30, so the test could load the correct
Trade surface, balances, tabs, and ledger and still report production as
broken.

## What changed

- The production canary now verifies the redesigned Cashier heading.
- The existing Trade-surface marker, tab semantics, selected-tab state, error
  absence, and console checks remain in place.

This changes no player-facing behavior. It repairs the live certificate so a
green result means the current premium Cashier actually rendered.
