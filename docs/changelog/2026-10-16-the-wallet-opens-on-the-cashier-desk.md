# The Wallet Opens On The Cashier Desk

**Date:** 2026-10-16
**Surface:** `/wallet` (the Club Arena global header wallet), `src/pages/PlayerWalletPage.tsx` and `.css`

## What Dan Asked

"When you click the wallet (in the global header) inside the club arena, it
needs a complete upgrade and enhancement to be like what you created with the
pages within this chat. Its currently sloppy and a hot mess, things are basic
boring and broken, balances aren't centered or font sized correctly inside
there frames and there are too many flat basic and boring button's frames and
fonts."

## What Changed

- The page prints on the routed Cashier's own `CashierWorkspace` (Secure
  Wallet / Wallet) instead of the Rewards Circuit console and the vault room.
- All Wallets Combined is one centred figure with Playable Now and Diamonds
  centred under it; the vault render sits faintly behind it.
- The seven flat buttons became the painted Cashier action dock: its line
  prints what the ledger read returned (Synced, Reading, Unavailable,
  Offline), and its doors are Add Chips, Cash Out, History and Dispute. Send,
  Receive and Earn are the tabs directly below, so they are not printed twice.
- The tabs are lit words, the chosen one white.
- Each wallet is a hairline desk row: its emblem (cut from its own approved
  square plate, `public/assets/club-buttons/wallets/emblems/`), its name and
  purpose, and its balance right-aligned at the row's own size, exactly as the
  Cashier prints chips. Available and Locked sit on an engraved rule under it.
- Every primary action (Buy Diamonds, the Diamond Arena door, Send Diamonds,
  Open Club Cashier, Claim Daily Diamonds) is the painted plate the Cashier's
  Request Cash Out uses. Every secondary control is a lit word. Inputs are the
  Cashier's hairline wells, ledger rows are desk rows, credits blue and debits
  red.
- No `border-radius`, no gradient and no hover state paint a control.

## Laws Moved With It

- `tests/wallet-casino-realism.test.ts` pins the desk (inks, dock art, the
  emblems, centred page balance, right-aligned row balances) in place of the
  plate-bay insets, which no longer exist.
- `tests/unit/cinematicRouteFamilies.test.ts` takes the wallet off the Rewards
  Circuit list and pins it to the Cashier workspace.
- `tests/unit/cashier-trade-launch-audit.test.tsx` reads the ledger state from
  the dock line.

Every handler, guard, read, idempotency key and test-pinned literal on the page
is unchanged.
