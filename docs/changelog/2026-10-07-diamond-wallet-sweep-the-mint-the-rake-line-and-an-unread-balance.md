# 2026-10-07 - Diamond wallet sweep: the Mint, the rake line and an unread balance

A deep-dive regression sweep of the diamond wallet (Club Arena and World Hub),
two weeks after the 8-phase programme shipped (2026-09-14 to 2026-10-01).

## Fixed here

1. **The Mint reached players' screens.** `player_line` printed
   "The Mint: signup grant" on 832 human wallets and "The Mint: Lifetime VIP
   Monthly Diamond Benefit" on 21. Dan, 2026-09-05, binding: the Mint is
   internal (`tests/the-mint-is-internal.law.test.ts`). `fn_ca_mint` writes
   `'The Mint: ' || reason` into the append-only journal, so the fix is in the
   one place the ledger speaks to the player: migration `20261007102421`
   redefines `fn_diamond_ledger_line` to drop the prefix and Title Case a
   lower-case Mint reason ("Signup Grant").
2. **The Diamond cash rake sweep's operator sentence reached players.** Every
   `cash_rake` row printed "Diamond cash-game rake: attributed to this player's
   contributions (from the arena to the house)". It now prints its row label,
   "Diamond Arena Rake". Same migration.
3. **A quoted owner instruction** ("(Dan 2026-10-06 10:25 CT)") on three horse
   wallets is treated as an operator note (horses are players, 10.5).
4. **`DiamondService.getBalance` turned an unread balance into 0.** It reported
   a refused owner-door read and resolved `{ balance: 0 }`, so the wallet
   store's keep-the-last-figure catch never ran. It now throws on an error and
   on a missing row; `ProfilePage` catches and keeps its figure.
5. **`mint` in the diamond modal's label map read "Chip Mint".** A diamond grant
   is not chips. It now reads "Bonus Diamonds" (fallback label only;
   `player_line` is printed first).

The migration was proved before it was written: the new body ran as a
`pg_temp` function over all 250 distinct production (kind, sign, description)
shapes beside the live one; exactly the four shapes above changed.

Pins: `tests/the-ledger-speaks-to-the-player.law.test.ts` (new case, goes red
without the migration), `tests/unit/diamondBalanceIsReadOrUnknown.test.ts`
(3 of 5 red before the fix).

## Found and reported, not started

- **The Diamond cash rake sweep writes wallet-journal rows that move no
  wallet.** `fn_ca_diamond_sweep_cash_rake` inserts one negative `cash_rake`
  row per payer into `diamond_transactions` and, by its own comment, does not
  touch `profiles.diamonds` (the rake was already taken from the arena stack,
  so the player's smaller cash-out already reflects it). Since the hourly cron
  started (#6366, first sweep 05:14 UTC today) every payer's journal sum is
  below their balance by exactly their attributed rake: at 10:10 UTC, 13
  horse wallets, 4,245 diamonds, and it grows every hour. The wallet's
  lifetime Spent figure counts that rake twice. The fix belongs to the rake
  lane (the custody-to-house movement belongs in the arena's own records, not
  the player's wallet journal) and is not a display change.
- **`fn_diamond_kind_bucket` files `mint` as "Diamonds You Bought".** Every
  `mint` row in production is promotional or seeded (signup grants, Lifetime
  VIP monthly benefits, the horse bankroll: 1,857 rows, 2,758,000 diamonds);
  no purchase is journalled as `mint` (purchases write `purchase`). The kind
  belongs in `bonuses`. Not changed here because the live kind map is pinned
  by file path in five rake-lane tests and fixtures
  (`the-diamond-arena-is-diamonds-only`, `whereTheDiamondsGo`,
  `tests/sql/run-diamond-cash-rake.py` and others) that would all need
  repointing in the same change.
