# 2026-10-02 - Every chip store balances with its ledger row

## For Dan

Since 02:31 UTC no chip could move in a player wallet, a club treasury, on the
felt, in a union bank or wallet, or in a jackpot pool unless the same
transaction wrote its ledger row. That still left nine places chips sit
outside that check: promo balances (players', agents', clubs'), agent wallets,
club wallets, insurance banks, Spin reserve pools, tournament prize pools
(escrow), unredeemed tournament tickets, and the two pass-through accounts used
for club openings and leaderboard payouts. This change puts every one of them
under the same rule, read from the database itself rather than from a list. It
went in measuring (observe) so real traffic could show whether any of them
drifts before anything was refused; the six stores already refusing kept
refusing. The flip to refuse, with the measured window, is recorded in the
follow-up entry.

## What changed

- Migration `20261002030942_every_chip_store_balances_with_its_ledger_row`:
  - `ca_ledger_invariant_store_mode`: the mode is now per store. The six proven
    stores are written `refuse` (unchanged); the nine new ones `observe`.
  - `fn_ca_tally_store_move` + `fn_ca_tally_pair` feed the existing
    transaction tally from new triggers `zy_ca_tally_store_move` on
    `club_members` (promo only), `clubs` (promo, insurance), `agents`,
    `club_wallets`, `spin_bonus_pools`, `tournament_escrow`,
    `tournament_tickets`, `unions`, `club_opening_setups`; each also gets the
    deferred check `zz_ca_store_has_its_ledger_row`.
  - `fn_ca_ledger_tally_key` resolves the ledger types `promo_wallet`,
    `agent_wallet`, `club_wallet`, `insurance_bank`, `spin_reserve`,
    `prize_liability` / `bounty_liability` (one account per tournament, Diamond
    events excluded via `fn_ca_tournament_counts`), `escrow` (one ticket
    float), `opening_setup`, `leaderboard_round`. The six existing keys are
    asserted unchanged inside the migration.
  - `fn_ca_balance_has_its_ledger_row` judges each mismatch by its own store's
    mode, falling back to `ca_ledger_invariant_mode`.
  - Nothing dropped; nine ShareRowExclusive locks taken in one statement under a
    250 ms lock_timeout before any DDL.
- `scripts/dev/test-ledger-invariant.sh` applies it after the six-store proof;
  `tests/fixtures/ledger-invariant/stores-bootstrap.sql` and
  `stores-regression.sql` plant eleven regressions and eleven live shapes.
- Law `tests/every-chip-store-balances-with-its-ledger-row.law.test.ts`
  (registry `docs/laws.d/every-chip-store-balances-with-its-ledger-row.md`)
  derives the chip stores from the migrations and goes red for a journalled
  chip column with no tally or a counted ledger store with no key.

## Not chip stores, by design

`public.wallets` (dead pool); Diamond custody; the agents mirror columns
(`business_balance`, `promo_balance`, `player_*`), kept equal by
`sync_agent_wallet_columns` - the agents tally has no column list precisely so
a write through the mirror is still seen; `club_members.held_chips`,
`locked_chips`, `credit_used` (0 on every row, never in the supply basis);
tournament stacks (carried by the event's escrow); journal labels with no
balance column (`settlement_suspense`, issuance and retirement).
