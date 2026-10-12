# Cashier screens: the launch residuals still open on main

The round-2 and round-3 cashier fixes of 2026-10-09/10 were never merged. This
change re-checks every client finding from that record against main as it stands
after the cashier redesign (#6643 to #6665) and lands only the ones still open,
on the redesigned code. The redesign is untouched: no page layout, directory or
workspace styling changed. No database, engine or migration change; the server
side of the horse presentation and the statement belong to the database lanes.

## Money and misleading text

- **A Club Bank, Agent Wallet or Promo send that got no answer said nothing.**
  The toast door silences connection errors, so a send, claim, claim back or
  reversal whose response was lost left the form as if untouched. It now says,
  inside the frame, that the move got no answer and may have gone through,
  re-reads the balances, and keeps the same key so a repeat can only replay.
  A refusal, or an error the database answered with a SQLSTATE, is not an
  unknown outcome. (`WalletCashierModal.tsx`)
- **A refused cashout also printed "The Outcome Is Unconfirmed".** A definitive
  refusal (nothing written) no longer retains a receipt check; a lost answer
  still does. (`CashoutReceiptChecks.tsx`, `AgentCashoutPanel.tsx`,
  `CashoutRequestModal.tsx`, `AgentDashboardPage.tsx`)
- **A committed cashout could read as refused.** The server raises 23514 while
  re-reading the receipt of an operation that already committed; only the named
  pre-write tokens count as a refusal now, everything else stays unknown and
  keeps its id. A refused request re-prepares a fresh id for the next attempt.
  (`CashoutService.ts`, `CashoutOperation.ts`)
- **A union send whose response was lost retired its id**, so the retry of a
  send the server had made went out under a new id and could pay twice. Only a
  SQL refusal on a 4xx is definitive now. (`UnionWalletModal.tsx`,
  `classifyCashierRpcFailure` in `CashierResilience.ts`)
- **Horses are indistinguishable (decision 2).** The Trade record printed
  "Horse Treasury Funding" and named the operator of other people's Club Bank
  sends; a treasury-funded seat now reads exactly like a human send, "Club Bank
  To <alias>" and "The Club Bank Sent N To <alias>'s Player Wallet", before
  the database migration installs. The horse-only labels are gone from every
  ledger map: "Treasury Funding" reads "Club Bank Send", "Table Funding" reads
  "Chips From The Club", "Auto Refill" reads as a transfer (label, ink and mark).
  (`describeChipTransaction.ts`, `CashierTradePage.tsx`, `PlayerWalletModal.tsx`,
  `ChipStatement.tsx`, `TransactionHistory.tsx`, `CashierStatementsPage.tsx`,
  `CashierPage.tsx`)
- **Wallet narration named the wrong direction.** A claim back said the claimer
  claimed from their own wallet, an admin removal sent chips to an agent wallet
  they never reached, and a real Club Bank claim (`club_bank_claim`) got no
  sentence. Each writer's from and to are now read the way it writes them.
- **Stale and invented balances.** The lobby wallet no longer counts from the
  last club's figures into the next club's, a player no longer sees the club's
  Backup BBJ, and Retry keeps "Unavailable" until a read lands
  (`DynamicWallet.tsx`). The agent transfer sheet ignores a slower read for an
  earlier club and prints "Unknown" instead of "0 to 0" (`ChipTransferModal.tsx`).
  A statement that did not load no longer says "Up To Date" (`ChipStatement.tsx`).
- **Wrong account named.** An agent's confirmation said "N Percent Of The Club
  Bank"; it names the account being spent. A failed member list said "No Members
  In This Club Yet"; it says the list could not be loaded, with Retry.
- **Credit agents could not send.** The Agent Wallet cashier capped a send at the
  float alone; the server lends the open credit line, so the cap is float plus
  line and a send that borrows always asks first. (`cashierBalanceRead.ts`)
- **Cashout amounts typed as "1e3", "+5" or "0x10"** are refused; only plain
  digits with at most two decimals pass. (`cashoutAmount.ts`)

## Broken flows

- The in-table top-up sheet had no Retry for an unread balance: the table now
  passes it (`TableModalsLayer.tsx`), the sheet offers it on the money plate,
  never shows a negative "Available To Add", and says when the stack is already
  at the table maximum (`CashierModal.tsx`). A spectator is no longer offered
  Top Up (`TablePage.tsx`).
- Editing only the reason after a refused send is a new operation with a new key.
- With the Chip Mint stacked on top, no close path of the cashier behind it works.
- The club switcher recognises a club named by its slug.

## Layout

- `/wallet` at 375 and 393: the five tabs share the strip, every tab is on
  screen at 44px tall. (`PlayerWalletPage.css`)
- 44px across on the union wallet tabs, kind switch and inputs, the cashout
  presets, the directory Retry and the in-table close.

## Already fixed on main (no change)

Role-read failure messaging (P-01, #6609 and #6624), Escape in a stacked Chip
Mint (D-01, #6624 G-05), two-decimal Trade amounts and the hardened Trade parser
(P-04, G-08), the club-read failure wording (G-04).

## Not done here, on purpose

Cosmetic items the redesign replaced (toast restyle, launcher art reveal),
performance de-duplication of the profile read, dead-code removal in the wallet
service and store, the clubs money-column read (Program C, C-1), the `/dev`
route gate, and the cashout preparation storage clean-up (B-4 item 2, a service
change with its own tests).

## Tests

New: `tests/cashier-screens-residuals.test.ts`,
`tests/cashier-screens-trade-record-horse.test.tsx`; ported from the round-2
branch: `tests/components/cashier-dialogs-merge.test.tsx`,
`tests/cashier-c2-wallet-modal.test.tsx`, `tests/cashier-c2-table-and-routes.test.tsx`,
`tests/components/surfaces-dynamic-wallet.test.tsx`,
`tests/components/surfaces-agent-cashout-figures.test.tsx`,
`tests/surfaces-union-wallet-transport.test.tsx`,
`tests/unit/surfaces-chip-statement-plates.test.tsx`,
`tests/unit/surfaces-cashout-request-figures.test.tsx`,
`tests/unit/cashier-balance-read-dialogs-merge.test.ts`,
`tests/components/services-club-money-reads.test.tsx`,
`tests/cashier-c1-switcher-slug.test.tsx`, `tests/cashier-dialogs-merge.law.test.ts`,
and the round-2 additions to `CashoutOperation`, `CashoutService`,
`cashierBalanceRead`, `describeChipTransaction`, `cashier-cashout-generations`
and `a-horse-is-never-named`. `cashoutAmount.test.ts` now refuses "29e-2",
which it used to accept, by the owner's decision on amount spelling.
