# A union wallet side always names its column (2026-10-04)

Chip drift, second cut. Migration `20261004133333_a_union_wallet_side_always_names_its_column` (applies after `20261004124640`).
Law: `tests/a-union-wallet-side-always-names-its-column.law.test.ts` (`docs/laws.d/a-union-wallet-side-always-names-its-column.md`).

## Why

`20261004124640` fixed the three payers whose bare `union_wallet` legs (1,489,358.47 of rake payments) the ledger replay read as kill-switch drift on Midway's rake wallet. A `union_wallets` row holds six balances, so a `union_wallet` side without a label cannot be keyed to any of them.

The same bare side was still reachable through the autoledger. A payer declares its counterparty (`fn_ca_declare_ledger` or the settings directly) and the trigger on the table it updates writes one leg per moved balance: its own side carries `table.column`, the counterparty's side carried nothing. Read from production, these payers declare a union wallet whose column the leg could not name:

| payer | what moves on the union side | how the replay read it |
| --- | --- | --- |
| `fn_union_send_to_member_zd3core` | chip_balance, rake_wallet or promo_wallet | unkeyable (unless the member side was a promo float) |
| `fn_union_settle_player_pnl` | chip_balance | unkeyable |
| `fn_spin_settle_game` (seed repayment, union owner) | the owner wallet the seed came from | unkeyable |
| `fn_union_fund_bbj_pool` | chip_balance | unkeyable for main and backup; the promo leg was keyed to the promo wallet, the wrong column |
| `fn_union_bbj_backup_transfer` | promo_wallet | unkeyable |
| `fn_union_promo_send` (to the jackpot) | promo_wallet | unkeyable |
| `fn_bbj_promo_payout_atomic` (union pool) | promo_wallet | unkeyable |
| `fn_promo_disburse` (union to a player) | promo_wallet | unkeyable |

None of them has written a leg in 60 days, which is why the 2026-10-04 reading did not show them. The next one would have.

## Change

1. **The counterparty names its column.** `fn_ca_declare_ledger` clears `app.ledger_counterparty_label`; a payer whose counterparty is a union wallet or a promo bank sets it after declaring; `fn_ca_autoledger` writes it on the counterparty side. A label that cannot belong to the declared counterparty (a union wallet takes `union_wallets.*`, a promo bank one of its three promo columns) is not written, so a stale setting never names the wrong account. `fn_ca_ledger_declaration_save` / `_restore` carry it with the other declaration settings.
2. **Every payer above names the column it moves**, and the club promo bank of a promo rain or a disbursement is named too.
3. **The union bank is one account, whoever names it.** A `union_wallet` side labelled `union_wallets.chip_balance` is the `union_bank` account in all three journal readers. `fn_ca_account_balance` reads both by column, so two keys for one balance would each be judged against half of its legs.
4. **chip_ledger refuses a bare union wallet side**: `chip_ledger_a_union_wallet_side_names_its_column`, unless the other side names a promo bank (the replay's own rule, `20260906011010`) or the leg is a journal-only correction posted by `fn_ca_post_correction`. Every nullable read in the check is coalesced, so a NULL can never satisfy it by accident. `NOT VALID`: the legs already written stay as they are (the journal is append-only); every new leg is held to it.

Before the constraint, every leg of the last 90 days was read against it. The only legs it would have refused are the ones `20261004124640` already fixed at their writers, the Sep 14 weekly close legs from that function's earlier version, and three one-off legs written by migrations.

No chips move, no job is added, nothing is backfilled. Every preimage and result is md5-asserted and every grant is asserted unchanged.

## How to apply

After merge, through **Apply Merged Migration**, after `20261004124640` and `20261004125201`. Avoid minute :50 to :03 UTC.
