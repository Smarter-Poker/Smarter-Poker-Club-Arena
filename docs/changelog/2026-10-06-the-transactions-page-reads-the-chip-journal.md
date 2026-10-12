# The transactions page reads the chip journal

Launch audit, 2026-10-06. Two items: "the /transactions page reads the wrong
ledger" and "the retired mint buttons".

## 1. /transactions read a partial receipt log

`TransactionHistoryPage` listed `chip_transactions` (rows where the player was
`from_user_id` or `to_user_id`). That table is not the record of a player's
chips. Measured on production for the busiest player wallet over the previous
24 hours:

| source              | movements | what it held                                                                  |
| ------------------- | --------- | ----------------------------------------------------------------------------- |
| `chip_ledger`       | 393       | 257 tournament entries out, 121 prizes in, 11 bounties in, 3 add-ons, 1 rebuy |
| `chip_transactions` | 257       | the 257 tournament entries only                                               |

Every prize and bounty was missing, so the page showed a player paying in and
never being paid, and its Inflow / Outflow / Net figures were computed from that
one-sided list.

`chip_ledger` is the authoritative record: since 20261002015339 the database
refuses any transaction that moves a covered balance without its matching leg
(`a-balance-never-moves-without-its-ledger-row`, mode `refuse`), and the
nightly replay reads every wallet against it. The existing per-player read is
`fn_ca_chip_statement_page`, rendered by `ChipStatement` on the wallet page.
Verified live (read only, inside a self-aborting block): signed in as a real
player it returned 50 legs, every one of them that player's own wallet, account
`player_wallet:<caller>:club_members.chip_balance`, audit `reconciles`; the same
session reading `chip_ledger` directly for another player saw 0 rows. The
function takes no player parameter: the account is `auth.uid()`.

The page now renders that statement (100 legs a page): balance now, balance by
club, both directions with signs, plain-word labels ("Tournament Entry",
"Tournament Prize", "Table Cash-Out"...), and the nightly reconciliation line.
It re-reads on tab return and on wallet events, as before. The search box, date
range, type tabs and CSV export are gone: they filtered the wrong table, and a
client-side filter over a statement that pages from the newest leg backwards
would answer "nothing in this range" for movements simply not loaded yet.
`chipTransactionBalanceChange`, which only computed signs for the old list, has
no caller left and is removed with its unit test. No database change.

Regression: `tests/components/TransactionHistoryRefresh.test.tsx` fails on the
old page (all three cases) and passes on the new one.

## 2. The "retired" mint buttons are not retired

Checked against production before removing anything:

- `fn_mint_chips_from_diamonds` (the Club Bank Cashier's Chip Mint, the classic
  Cashier's Mint tab and the admin Mint tab, the last two through World Hub
  `/api/club-arena/mint-chips`) is `approved` in `ca_money_rpc_registry`
  ("Owner bridge"), executable by `authenticated`, and a rolled-back call as a
  standalone club's owner returned `success: true`.
- Only `mint_club_chips`, `fn_mint_club_chips`, `fn_mint_club_chips_zd3core`
  and `mint_club_promo` are retired or closed, and no Club Arena button calls
  any of them.

No visible mint button is backed by a retired path, so none was removed. The
owner's rule is to remove controls that cannot work and nothing that still
works.

Found while checking, not changed here (outside this item, needs a decision):
the classic Cashier's Mint tab and the admin Mint tab type CHIPS, and the World
Hub route converts them with the pre-2026-09-07 rate (1 diamond per 100 chips).
The live rate is 100 diamonds per chip, so a rolled-back "mint 100 chips" from
that route spent 1 diamond and created 0.01 chips. The Club Bank Cashier's Chip
Mint takes diamonds and is charged correctly by the server, but its preview
still prints the old rate ("100 Diamonds = 10K Chips"; the server credits 1).
