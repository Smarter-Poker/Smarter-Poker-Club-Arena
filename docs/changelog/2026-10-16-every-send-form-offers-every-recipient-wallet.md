# Every Send Form Offers Every Recipient Wallet (2026-10-16)

## What Dan Asked For

Dan, 2026-10-15, on chip sends: the sender decides which of the recipient's
wallets the chips go into, "SELECTABLE TO SEND TO ANY WALLET I WANT THAT THE
USER HAS (PLAYER WALLET, AGENT WALLET, PROMO WALLET ETC)", and "IT SHOULD HAVE
THERE CURRENT CHIP BALANCES AS WELL".

## What Was Still Wrong After #7058, #7062 And #7059

The Send Out screen (`CashierTradePage`) met both rules. Four other send forms
did not:

| Form | Before | After |
| --- | --- | --- |
| Chip Transfer modal (Member and Agent Management) | Agent or Player only, no balances on the choice | Agent, Promo, Player, each with its balance |
| Classic Cashier distribute | Agent or Player only, no balances | Agent, Promo, Player, each with its balance |
| Super Agent dashboard Transfers | Agent or Player only, no balances | Agent, Promo, Player, each with its balance |
| Agent Dashboard transfer | Always Agent Wallet, no choice | Agent, Promo or Player, Agent by default (no balances; see below) |

All four read their choices from `clubBankRecipientWallets`, which left out the
Promo Wallet every agent-capable member holds. Both RPCs behind them
(`fn_agent_wallet_send`, `fn_club_bank_send`) already credit it.

## A Second Defect Found On The Way

`AgentService.reversibleDistributions` treated any reversible send whose
destination was not Player or Agent as a malformed payload. Since
`20261016024912` an Agent Wallet send into a Promo Wallet is reversible and
`fn_agent_wallet_reversible` returns `promo_wallet`, so a single such send would
have made the whole claim-back list fail to load. It now accepts it.

## What Changed

- `clubBankRecipientWallets` lists Agent, Promo, Player (the Send Out order).
- `src/hooks/useRecipientWalletBalances.ts` reads the recipient's balances from
  `fn_cashier_recipient_wallet_balances`, the same authorized read the Send Out
  screen uses. An unread balance prints the wallet name alone, never a zero.
- `AgentWalletIntent` takes a Promo destination. The retry key adds the
  destination only when it is not the Player Wallet, so every existing Player
  and Agent key is byte-identical and a Promo send never shares a Player key.
- The Agent Dashboard's owner-only "Send Prepaid Chips" control is unchanged:
  it funds the agent float by the prepaid-agents rule.
- The Agent Dashboard transfer form takes a raw member ID and does not read
  balances: its durable-transfer fixture is pinned by the weekly accounting
  source binding, and a balance read would change that pinned file. The
  server still refuses a wallet the recipient does not hold.

## Tests

Updated in the same change: the two helper pins and the one-money-path key pin. New: Promo key identity and receipt checks,
a reversible Promo row, and the Chip Transfer modal offering all three wallets
with balances and sending into the Promo Wallet.
