# The mint tabs charge the live rate (2026-10-06)

Follows section 2 of `2026-10-06-the-transactions-page-reads-the-chip-journal.md`.

## What was wrong

The chip mint moves at the live rate in `ca_bridge_rate` (read by
`fn_ca_bridge_rate()`, 100 diamonds per chip since 2026-09-07), and
`fn_mint_chips_from_diamonds` charges at exactly that. Three things around it
still used the 2026-08-21 rate (1 diamond per 100 chips):

1. World Hub `/api/club-arena/mint-chips`, behind the classic Cashier's Mint
   tab and the admin Mint tab, converted the typed chips with a literal 1/100.
   A rolled-back "mint 100 chips" spent 1 diamond and created 0.01 chips.
2. The Club Bank Cashier's Chip Mint printed "100 Diamonds = 10K Chips" and
   "You Receive 10,000 Chips" for 100 diamonds; the server credited 1 chip.
3. The classic Cashier's Mint tab quoted "1 Diamonds Required" for 100 chips.

## Why fix the route rather than remove the two buttons

The two chip-denominated tabs are not retired: the earlier section 2 checked
that their RPC is `approved` and works, and the owner's rule is to remove
controls that cannot work and nothing that still works. They also take a
different input (chips, not diamonds) from the Club Bank mint. Fixing one
conversion line at its source is smaller than removing two working surfaces.

## What changed

- World Hub route: reads the rate with `fn_ca_bridge_rate()` as the caller (the
  same function the server charges at), converts `chips x rate`, and refuses
  with 503 before any diamond is spent if the rate cannot be read. It now also
  returns `diamondsPerChip`. Pinned by
  `__tests__/club-arena-mint-chips-live-rate.test.mjs`.
- Club Arena: `src/hooks/useBridgeRate.ts` reads the same function. The Chip
  Mint prints "100 Diamonds = 1 Chip", previews `diamonds / rate`, and keeps
  Mint shut until the rate is read. The classic Cashier's quote is
  `chips x rate` with the rate shown, and it refuses fractional chips (the
  route mints whole chips, so 1.5 used to be minted as 1 and reported as 1.5).
  `WalletService.mintChips` reports the diamonds the route actually spent.
  Pinned by `tests/the-mint-preview-prints-the-live-rate.test.ts`.

No money moved, no migration. Read from production on 2026-10-06: no
`chip_transactions` mint row carrying `diamonds_spent` exists since
2026-09-07, so no player was charged or credited at the wrong rate and nothing
is owed.
