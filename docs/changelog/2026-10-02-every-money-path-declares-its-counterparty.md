# 2026-10-02 - Every money path declares its counterparty

Launch plan phase 1b. Migration `20261002140203_every_money_path_declares_its_counterparty.sql`,
law `tests/every-money-path-declares-its-counterparty.law.test.ts`.

## Why this was a live hazard

Since `20261002073930` (08:36:58 UTC) a transaction that writes a `chip_ledger`
leg against `settlement_suspense` and moves a covered balance does not commit.
The journal triggers (`fn_ca_autoledger`, `fn_club_members_ledger_writer`) fall
to `settlement_suspense` whenever the writer named no counterparty. So every
money path that does not declare its counterparty fails the first time it runs.
`fn_ca_ratchet_watch` raised incident `36991212` when
`fn_ca_undeclared_money_paths()` rose from 80 to 86 rows: 52 functions.

## What the rows said

- No live door has written a `settlement_suspense` leg since 2026-09-14 06:27
  (the weekly close), and `postgres_logs` show no live refusal since 07:36, only
  rolled-back probes. The 86 rows were rare doors and dead doors.
- `track_functions` is `none`; call counts come from `pg_stat_statements`
  (top-level, reset 2026-09-28 16:36). Every one of the 52 had 0 to 4 top-level
  calls in that window.
- **The producer miscounted.** It matched `UPDATE <table>` anywhere in a body
  and the column name anywhere, so a function that read `chip_balance` and
  updated `club_members.role` counted. It also did not know the second
  declaration contract, which its sibling `fn_ca_undeclared_leg_check` names in
  its own message: stand the table's journal down with
  `app.ledger_autoskip_<table>` and write the named leg yourself. 15 of the 52
  were one of those two miscounts.

## The 52 functions (86 rows)

Runs = top-level `pg_stat_statements` calls since 2026-09-28 (DB-internal calls
are not counted there; "callers" are the live callers found by reading
`pg_proc`, `cron.job`, `server/`, `src/` and the World Hub `pages/api`, `src`).

| function                                            | balance(s)                                                                   | runs                                              | counterparty                                                      | action            |
| --------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------- | ----------------- |
| atomic_deduct_wallet_and_log                        | club_members.chip_balance                                                    | 0 (DB callers)                                    | the caller's (tournament registrars declare)                      | guarded           |
| atomic_tournament_register                          | club_members.chip_balance                                                    | 0                                                 | none; closed, no caller                                           | retired           |
| credit_club_wallet_rake                             | club_wallets.chip_balance                                                    | 0                                                 | none; only caller is a dead engine export                         | retired           |
| decrement_club_treasury                             | clubs.chip_treasury                                                          | 0                                                 | none; no caller                                                   | retired           |
| deduct_chip_balance                                 | club_members.chip_balance                                                    | 0                                                 | none; closed                                                      | retired           |
| distribute_chips                                    | club_members.chip_balance, clubs.chip_pool                                   | 0                                                 | none; closed                                                      | retired           |
| fn_add_chips                                        | club_members.chip_balance                                                    | 0                                                 | none; no caller                                                   | retired           |
| fn_agent_attach_player                              | club_members.chip_balance (read only)                                        | 0                                                 | moves no balance                                                  | producer fix      |
| fn_bbj_selftest_payout_conservation                 | bbj_pools.main/backup                                                        | 0                                                 | writes only inside an always-rolled-back sub-block                | registry `system` |
| fn_ca_alarm_drill                                   | club_members.chip_balance                                                    | 0 (weekly cron)                                   | autoskip + own leg                                                | producer fix      |
| fn_ca_backpay_guarantee_shortfalls                  | clubs.chip_treasury, union_wallets.chip_balance                              | 0                                                 | autoskip + own leg                                                | producer fix      |
| fn_ca_return_excess_start_overlay_locked            | clubs.chip_treasury, union_wallets.chip_balance                              | 2                                                 | autoskip + own leg                                                | producer fix      |
| fn_cashier_claim_back                               | club_members.chip_balance                                                    | 0                                                 | unreachable (needs auth.uid, granted only to service_role)        | retired           |
| fn_cashier_send_chips                               | club_members.chip_balance                                                    | 0                                                 | unreachable (same)                                                | retired           |
| fn_close_club_wallets_on_union_join                 | bbj_pools.\*, clubs.chip_treasury, clubs.promo_balance                       | 0 (union-join trigger)                            | BBJ pool -> treasury; promo float -> treasury                     | declared          |
| fn_club_owner_has_a_player_wallet                   | club_members.chip_balance (insert at 0)                                      | trigger                                           | moves no balance                                                  | producer fix      |
| fn_club_set_member_role                             | agents.agent_wallet_balance (read only)                                      | 0                                                 | moves no balance                                                  | producer fix      |
| fn_credit_chips                                     | club_members.chip_balance                                                    | 0                                                 | the caller's                                                      | guarded           |
| fn_credit_player_wallet_once                        | club_members.chip_balance                                                    | 0 (fn_credit_and_log declares)                    | the caller's                                                      | guarded           |
| fn_credit_treasury_zd4core                          | clubs.chip_treasury                                                          | 3 (via fn_credit_treasury; weekly close declares) | the caller's                                                      | guarded           |
| fn_debit_chips                                      | club_members.chip_balance                                                    | 0                                                 | none; only a hub route nothing calls                              | retired           |
| fn_debit_treasury                                   | clubs.chip_treasury                                                          | 0                                                 | the caller's                                                      | guarded           |
| fn_horse_fund_from_treasury_before_maintenance_gate | clubs.chip_treasury                                                          | 9,708 via wrapper                                 | autoskip + own leg                                                | producer fix      |
| fn_horse_seat_from_treasury_before_maintenance_gate | clubs.chip_treasury                                                          | via wrapper                                       | autoskip + own leg                                                | producer fix      |
| fn_leave_club_atomic                                | club_members.chip_balance, clubs.chip_treasury                               | 0                                                 | superseded, no caller                                             | retired           |
| fn_member_leave_to_treasury                         | clubs.chip_treasury                                                          | 0 (client ClubsService)                           | player wallet -> club treasury                                    | declared          |
| fn_reject_cashout                                   | club_members.chip_balance                                                    | 0                                                 | `cashout_requests` is empty, no caller                            | retired           |
| fn_remove_settled_club_member                       | club_members.chip_balance (read only)                                        | 0                                                 | moves no balance                                                  | producer fix      |
| fn_resolve_bbj_pool                                 | bbj_pools.\* (insert at 0, update status)                                    | DB                                                | moves no balance                                                  | producer fix      |
| fn_seed_horses_to_floor                             | club_members.chip_balance, clubs.chip_treasury                               | 0                                                 | club treasury -> horse wallets                                    | declared          |
| fn_settle_accounting_commission_stage               | club_members.chip_balance, clubs.chip_treasury                               | 0                                                 | autoskip + own leg                                                | producer fix      |
| fn_settle_accounting_commission_stage_v3            | same                                                                         | 0                                                 | autoskip + own leg                                                | producer fix      |
| fn_settle_accounting_rakeback_stage                 | same                                                                         | 2                                                 | autoskip + own leg                                                | producer fix      |
| fn_spin_absorb_club_pool_into_union                 | spin_bonus_pools.balance                                                     | 0 (union join)                                    | spin pool -> club treasury                                        | declared          |
| fn_spin_activate                                    | spin_bonus_pools.balance                                                     | 4                                                 | owner wallet -> spin pool (a caller's declaration stands)         | declared          |
| fn_spin_deactivate                                  | spin_bonus_pools.balance                                                     | 0                                                 | autoskip + own leg                                                | producer fix      |
| fn_spin_reserve_seed_from_union                     | spin_bonus_pools.balance, union_wallets.\*                                   | 0                                                 | none; no caller                                                   | retired           |
| fn_spin_reserve_wallet_fund                         | union_wallets.\*                                                             | 0 (hub union-wallet)                              | union main bank -> union wallet; sub-wallet moves are one account | declared          |
| fn_tournament_atomic_register                       | club_members.chip_balance                                                    | 0                                                 | none; closed                                                      | retired           |
| fn_union_distribute_promo                           | agents.promo_wallet_balance, clubs.promo_balance, union_wallets.promo_wallet | 0                                                 | none; callers closed or unused                                    | retired           |
| fn_union_fund_promo_from_bank                       | union_wallets.chip_balance/promo_wallet                                      | 0                                                 | none; no caller                                                   | retired           |
| fn_wallet_claim_back                                | agents.\*, club_members.chip_balance, clubs.chip_treasury                    | 0                                                 | only caller retired                                               | retired           |
| increment_union_chip_balance                        | union_wallets.chip_balance, unions.chip_balance                              | 0                                                 | none; closed                                                      | retired           |
| lock_chips_for_table                                | club_members.chip_balance                                                    | 0                                                 | none; hub route nothing calls                                     | retired           |
| mass_fund_horses                                    | club_members.chip_balance                                                    | 0                                                 | none; closed                                                      | retired           |
| mint_club_chips                                     | clubs.chip_pool                                                              | 0                                                 | none; closed                                                      | retired           |
| promo_apply_playthrough                             | club_members.chip_balance/promo_balance                                      | engine                                            | autoskip + own leg                                                | producer fix      |
| record_rake                                         | club_wallets.chip_balance (`= chip_balance`)                                 | 0                                                 | legacy rake recorder, no live caller                              | retired           |
| redeem_promo_to_chips                               | club_members.chip_balance/promo_balance                                      | 0                                                 | none; no caller                                                   | retired           |
| spin_pool_draw                                      | spin_bonus_pools.balance                                                     | 0                                                 | none; closed                                                      | retired           |
| transfer_promo_agent_to_player                      | club_members.promo_balance                                                   | 0                                                 | unreachable (client lacks EXECUTE)                                | retired           |
| unlock_chips_from_table                             | club_members.chip_balance                                                    | 0                                                 | none; hub route nothing calls                                     | retired           |

Totals: 25 retired, 5 guarded, 6 declared, 1 registered `system`, 15 producer
miscounts. Plus `fn_union_credit_wallet_zd3core` (not in the 86): an unmapped
`tx_type` is now refused by name instead of being booked to suspense.

## What changed

- **Retired (25).** Each keeps its signature, moves nothing and answers
  `<name>_retired` (a `RAISE` for the void/numeric/uuid ones), the way
  `fn_clawback_chips_atomic` was retired. Nothing is dropped. Registry status
  `retired`.
- **Guarded (5).** `atomic_deduct_wallet_and_log`, `fn_credit_player_wallet_once`,
  `fn_credit_chips`, `fn_credit_treasury_zd4core`, `fn_debit_treasury` are
  primitives whose counterparty is the caller's. Before the balance moves each
  asks whether `app.ledger_counterparty` is set (or the table's journal is stood
  down for a caller-written leg) and otherwise raises
  `<name>_requires_a_declared_counterparty`. Every live caller already declares;
  an undeclared call was already refused at commit, anonymously.
- **Declared (6).** Each names its inherent counterparty immediately before the
  write and restores whatever declaration it found
  (`fn_ca_ledger_declaration_save` / `_restore`, new, registry `system`).
  `fn_member_leave_to_treasury` now empties the wallet into the treasury before
  deleting the row: previously it credited the treasury from suspense AND the
  delete journal burned the same chips, so the chips were counted out twice and
  in from nowhere once. `fn_spin_reserve_wallet_fund` no longer credits the Spin
  reserve from nowhere when no source wallet is given.
- **The producer** now reports a function only when it ASSIGNS a journalled
  column inside an UPDATE of the table (statement-scoped), and accepts the
  autoskip-plus-own-leg contract. It still reads static UPDATE text only: an
  INSERT of an opening balance or a balance written through dynamic SQL is not
  seen here; the commit-time ledger invariant catches those.

## Probes (all rolled back, live `refuse` mode)

Before the file (patterns, one DO block each): control - an undeclared +0.01
member credit read suspense 0.01; declared patterns read suspense 0 with every
account's balance equal to its legs: seed horses 0.50; member leave 5,000.00
and 72,507.20 (zero-then-delete); spin absorb 200.00; spin activate 50.00;
union join BBJ 100.00 + promo 3.00; spin reserve fund promo 1.00 + main bank
2.00. The first main-bank shape (counterparty = the union wallet row) was
refused by the invoice issuer (`accounting_invoice_recipient_missing`); the
shipped shape names the union on both sides.

After apply: see the PR and the resolution note on incident 36991212.

## Executable negative proof of the producer

On an isolated PostgreSQL 17 with the migration applied and a stub
`fn_ca_autoledger` trigger on `clubs.chip_treasury`, five planted functions:
an undeclared treasury write and an autoskip without its own leg were
reported; a reader that updates `role`, a declared write and an autoskip with
its own leg were not.

## Not done here, and why

- World Hub `pages/api/club-arena/settle-period.js` 'close' pays the union hold
  as two RPCs (`fn_debit_treasury`, then `fn_union_credit_wallet` with
  `settlement_hold`). Two transactions cannot each balance; it has not run in
  30 days and nothing schedules it. Both halves now refuse by name. Making it
  one atomic door is its own change.
- `fn_charge_place_overpays` (engine, hourly) calls `fn_debit_treasury` without
  a declaration. Its queue has been empty since 2026-09-02; if it ever fills,
  the debit refuses by name. It is a repair job (CLAUDE.md 10.12) and belongs
  in the band-aid register, not a new declaration.
- `fn_refund_shop_purchase` (chip refunds; one chip shop purchase ever, on
  2026-08-20) calls `fn_credit_chips` without a declaration and will refuse by
  name.
