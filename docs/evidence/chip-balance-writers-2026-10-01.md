# Every chip-balance writer, read from the catalog on 2026-10-01

Snapshot of `public.v_ca_chip_balance_writers` (installed by migration
`20261001160611_a_balance_never_moves_without_its_ledger_row`), read against
production `pg_proc` at 16:10 UTC on 2026-10-01: every function in `public` and
`smarter_private` whose body writes a chip balance column or a `chip_ledger`
row. The view is live; this file is the day's reading, kept beside the law
`tests/a-balance-never-moves-without-its-ledger-row.law.test.ts`.

## How a writer is classified

| class               | what it means                                                                                                                                           | how the invariant covers it                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| ledger-atomic       | writes a covered balance and lets the journal trigger (fn_club_members_ledger_writer / fn_ca_autoledger) write the leg; leg = delta by construction     | checked at commit; cannot disagree                                                                            |
| stand-down          | sets `app.ledger_autoskip_<table>` and promises to write the one leg itself (or lets the OTHER side's autoledger write it with a declared counterparty) | the promise is verified at commit: wrong amount, wrong wallet or no leg is refused                            |
| felt writer         | writes `table_seats.stack` or the pending add-on float; there was never a journal trigger here                                                          | the cash felt is one account; every movement onto or off it needs a `table_stack` leg in the same transaction |
| journal writer only | writes `chip_ledger` legs for stores whose balance is written elsewhere (or is a journal trigger itself)                                                | a leg naming a covered account with no balance movement is refused                                            |
| uncovered store     | writes only promo wallets, agent wallets, club_wallets, spin reserve or the tournament escrow                                                           | keeps its existing autoledger and detectors; the next migration                                               |

Columns: store(s) written, whether it stands the autoledger down, and where its
leg comes from (`autoledger` = the trigger writes it, `via door` = it calls a
door that does, `own INSERT` = it inserts into chip_ledger itself).

Engine and World Hub: `server/src` reaches every balance through these RPCs
(the one direct write, `HorseOnboarding.ensureClubMembership`, INSERTs a
`club_members` row and is journalled by `trg_ca_autoledger_insert`);
`pages/api/club-arena` in the World Hub writes no balance column directly
(grep 2026-10-01: no `.update`/`.insert` on a balance table).

## ledger-atomic (autoledger writes the leg; checked at commit) (84)

| function                                                  | store(s)                                              | stands down | leg from   |
| --------------------------------------------------------- | ----------------------------------------------------- | ----------- | ---------- |
| `atomic_credit_wallet_and_log`                            | player_wallet                                         | no          | via door   |
| `atomic_deduct_wallet_and_log`                            | player_wallet                                         | no          | autoledger |
| `atomic_distribute_rake`                                  | club_treasury, club_wallet (uncovered), union_wallet  | no          | own INSERT |
| `atomic_table_addon_before_maintenance_announcement_gate` | player_wallet, table_stack                            | no          | autoledger |
| `atomic_table_buyin_before_maintenance_announcement_gate` | player_wallet, table_stack                            | no          | autoledger |
| `atomic_table_rebuy_before_maintenance_announcement_gate` | player_wallet, table_stack                            | no          | autoledger |
| `atomic_tournament_register`                              | player_wallet                                         | no          | autoledger |
| `bbj_atomic_payout_v2`                                    | bbj_pool                                              | no          | autoledger |
| `bbj_credit_one_recipient`                                | bbj_pool, player_wallet, table_stack                  | no          | autoledger |
| `bbj_record_contribution`                                 | bbj_pool                                              | no          | autoledger |
| `decrement_club_treasury`                                 | club_treasury                                         | no          | autoledger |
| `deduct_chip_balance`                                     | player_wallet                                         | no          | autoledger |
| `distribute_chips`                                        | club_treasury, player_wallet                          | no          | autoledger |
| `fn_add_chips`                                            | player_wallet                                         | no          | autoledger |
| `fn_agent_attach_player`                                  | player_wallet                                         | no          | autoledger |
| `fn_apply_prize_guarantee_before_atomic_proof`            | club_treasury, union_wallet                           | no          | autoledger |
| `fn_atomic_buyin`                                         | player_wallet                                         | no          | autoledger |
| `fn_bbj_mini_payout`                                      | bbj_pool                                              | no          | autoledger |
| `fn_bbj_move_between_banks`                               | bbj_pool                                              | no          | autoledger |
| `fn_bbj_repair_unbanked`                                  | bbj_pool                                              | no          | autoledger |
| `fn_bbj_selftest_payout_conservation`                     | bbj_pool                                              | no          | autoledger |
| `fn_bbj_set_club_mini_enabled`                            | bbj_pool                                              | no          | autoledger |
| `fn_bbj_set_club_mini_floor`                              | bbj_pool                                              | no          | autoledger |
| `fn_bbj_set_union_mini_enabled`                           | bbj_pool                                              | no          | autoledger |
| `fn_bbj_set_union_mini_floor`                             | bbj_pool                                              | no          | autoledger |
| `fn_ca_burn`                                              | club_treasury, union_wallet                           | no          | autoledger |
| `fn_ca_epoch3_cert_fleet_reset`                           | player_wallet, promo_wallet (uncovered)               | no          | autoledger |
| `fn_ca_execute_epoch3_reset`                              | player_wallet                                         | no          | own INSERT |
| `fn_ca_fund_club`                                         | club_treasury                                         | no          | autoledger |
| `fn_ca_mint`                                              | club_treasury, union_wallet                           | no          | autoledger |
| `fn_ca_process_hand_post_commit_obligations`              | bbj_pool                                              | no          | via door   |
| `fn_ca_process_tournament_chip_purchase_money_v1`         | player_wallet, table_stack                            | no          | autoledger |
| `fn_ca_restore_erased_seat_credit`                        | player_wallet                                         | no          | autoledger |
| `fn_ca_retire_certification_club`                         | club_treasury, promo_wallet (uncovered)               | no          | autoledger |
| `fn_ca_settle_hand_stacks_absolute`                       | player_wallet, table_stack                            | no          | autoledger |
| `fn_cancel_tournament_ticket`                             | player_wallet                                         | no          | autoledger |
| `fn_cashier_claim_back`                                   | player_wallet                                         | no          | autoledger |
| `fn_cashier_send_chips`                                   | player_wallet                                         | no          | autoledger |
| `fn_close_account`                                        | player_wallet, promo_wallet (uncovered)               | no          | autoledger |
| `fn_close_club_wallets_on_union_join`                     | bbj_pool, club_treasury, promo_wallet (uncovered)     | no          | autoledger |
| `fn_club_owner_has_a_player_wallet`                       | player_wallet                                         | no          | autoledger |
| `fn_complete_club_opening_setup`                          | bbj_pool, club_treasury, promo_wallet (uncovered)     | no          | autoledger |
| `fn_credit_chips`                                         | player_wallet                                         | no          | autoledger |
| `fn_credit_player_wallet_once`                            | player_wallet                                         | no          | autoledger |
| `fn_credit_treasury_zd4core`                              | club_treasury                                         | no          | autoledger |
| `fn_debit_chips`                                          | player_wallet                                         | no          | autoledger |
| `fn_debit_treasury`                                       | club_treasury                                         | no          | autoledger |
| `fn_diamond_game_cover_lock`                              | union_wallet                                          | no          | autoledger |
| `fn_diamond_game_fund_promo`                              | club_treasury, promo_wallet (uncovered), union_wallet | no          | autoledger |
| `fn_issue_tournament_ticket_phase2_core_20260831`         | player_wallet                                         | no          | autoledger |
| `fn_leave_club_atomic`                                    | club_treasury, player_wallet                          | no          | autoledger |
| `fn_member_leave_to_treasury`                             | club_treasury                                         | no          | autoledger |
| `fn_mint_chips_from_diamonds`                             | club_treasury, union_wallet                           | no          | autoledger |
| `fn_mint_club_chips_zd3core`                              | club_treasury                                         | no          | autoledger |
| `fn_pay_player_chips`                                     | player_wallet                                         | no          | autoledger |
| `fn_payout_leaderboard`                                   | club_treasury, promo_wallet (uncovered), union_wallet | no          | via door   |
| `fn_redeem_tournament_ticket`                             | player_wallet                                         | no          | autoledger |
| `fn_reject_cashout`                                       | player_wallet                                         | no          | autoledger |
| `fn_remove_settled_club_member`                           | player_wallet, promo_wallet (uncovered)               | no          | autoledger |
| `fn_repay_unaccounted_seat_exits`                         | player_wallet                                         | no          | autoledger |
| `fn_resolve_bbj_pool`                                     | bbj_pool                                              | no          | autoledger |
| `fn_seed_horses_to_floor`                                 | club_treasury, player_wallet                          | no          | autoledger |
| `fn_settle_tournament_refund_exact`                       | player_wallet                                         | no          | autoledger |
| `fn_spin_move_owner_wallet`                               | club_treasury, promo_wallet (uncovered), union_wallet | no          | autoledger |
| `fn_spin_reserve_seed_from_union`                         | spin_reserve (uncovered), union_wallet                | no          | autoledger |
| `fn_spin_reserve_wallet_fund`                             | union_wallet                                          | no          | autoledger |
| `fn_tournament_atomic_register`                           | player_wallet                                         | no          | autoledger |
| `fn_transfer_chips`                                       | player_wallet                                         | no          | autoledger |
| `fn_union_credit_wallet_zd3core`                          | union_wallet                                          | no          | autoledger |
| `fn_union_debit_wallet_zd3core`                           | union_wallet                                          | no          | autoledger |
| `fn_union_deposit_from_wallet`                            | union_wallet                                          | no          | autoledger |
| `fn_union_distribute_promo`                               | promo_wallet (uncovered), union_wallet                | no          | autoledger |
| `fn_union_fund_promo_from_bank`                           | union_wallet                                          | no          | autoledger |
| `fn_wallet_claim_back`                                    | club_treasury, player_wallet                          | no          | autoledger |
| `increment_union_chip_balance`                            | union_wallet                                          | no          | autoledger |
| `increment_union_wallet`                                  | union_wallet                                          | no          | autoledger |
| `lock_chips_for_table`                                    | player_wallet                                         | no          | autoledger |
| `mass_fund_horses`                                        | player_wallet                                         | no          | autoledger |
| `mint_club_chips`                                         | club_treasury                                         | no          | autoledger |
| `record_insurance_transaction`                            | union_wallet                                          | no          | autoledger |
| `record_rake`                                             | bbj_pool, club_wallet (uncovered)                     | no          | via door   |
| `redeem_promo_to_chips`                                   | player_wallet, promo_wallet (uncovered)               | no          | autoledger |
| `transfer_promo_agent_to_player`                          | player_wallet, promo_wallet (uncovered)               | no          | autoledger |
| `unlock_chips_from_table`                                 | player_wallet                                         | no          | autoledger |

## stand-down (self-journalled; promise now verified at commit) (36)

| function                                              | store(s)                                                              | stands down | leg from   |
| ----------------------------------------------------- | --------------------------------------------------------------------- | ----------- | ---------- |
| `credit_club_rake_to_treasury`                        | club_treasury                                                         | yes         | own INSERT |
| `f06_void_retired_mixed_custody_event`                | club_treasury, prize_liability (uncovered), table_stack, union_wallet | yes         | own INSERT |
| `fn_admin_remove_player_chips`                        | club_treasury, player_wallet                                          | yes         | autoledger |
| `fn_agent_wallet_claim_back_phase2_core_20260831`     | player_wallet                                                         | yes         | via door   |
| `fn_agent_wallet_self_stake`                          | player_wallet                                                         | yes         | autoledger |
| `fn_agent_wallet_send_core_20260830`                  | player_wallet                                                         | yes         | via door   |
| `fn_bbj_promo_payout_atomic`                          | player_wallet, promo_wallet (uncovered), union_wallet                 | yes         | autoledger |
| `fn_ca_alarm_drill`                                   | player_wallet                                                         | yes         | own INSERT |
| `fn_ca_backpay_guarantee_shortfalls`                  | club_treasury, union_wallet                                           | yes         | own INSERT |
| `fn_ca_fund_overlay_on_lock`                          | club_treasury, union_wallet                                           | yes         | own INSERT |
| `fn_cashier_cashout_transition`                       | player_wallet                                                         | yes         | autoledger |
| `fn_club_bank_claim_back`                             | club_treasury, player_wallet                                          | yes         | autoledger |
| `fn_club_bank_reverse`                                | club_treasury, player_wallet                                          | yes         | autoledger |
| `fn_club_bank_send`                                   | club_treasury, player_wallet                                          | yes         | autoledger |
| `fn_club_promo_wallet_send`                           | player_wallet, promo_wallet (uncovered)                               | yes         | autoledger |
| `fn_diamond_game_pay_chips`                           | club_treasury, player_wallet, promo_wallet (uncovered), union_wallet  | yes         | via door   |
| `fn_horse_fund_from_treasury_before_maintenance_gate` | club_treasury, table_stack                                            | yes         | own INSERT |
| `fn_horse_seat_from_treasury_before_maintenance_gate` | club_treasury                                                         | yes         | own INSERT |
| `fn_promo_disburse`                                   | player_wallet, promo_wallet (uncovered), union_wallet                 | yes         | autoledger |
| `fn_promo_wallet_send`                                | player_wallet                                                         | yes         | via door   |
| `fn_settle_accounting_commission_stage`               | club_treasury, player_wallet                                          | yes         | own INSERT |
| `fn_settle_accounting_commission_stage_v3`            | club_treasury, player_wallet                                          | yes         | own INSERT |
| `fn_settle_accounting_rakeback_stage`                 | club_treasury, player_wallet                                          | yes         | own INSERT |
| `fn_sweep_bbj_promo`                                  | bbj_pool, promo_wallet (uncovered), union_wallet                      | yes         | autoledger |
| `fn_sweep_bbj_promo_all`                              | bbj_pool, promo_wallet (uncovered), union_wallet                      | yes         | autoledger |
| `fn_union_bbj_backup_transfer`                        | bbj_pool, union_wallet                                                | yes         | autoledger |
| `fn_union_clawback_from_club`                         | club_treasury, union_wallet                                           | yes         | autoledger |
| `fn_union_clawback_promo_from_club`                   | promo_wallet (uncovered), union_wallet                                | yes         | autoledger |
| `fn_union_close_post_rake_debit`                      | union_wallet                                                          | yes         | own INSERT |
| `fn_union_fund_bbj_pool`                              | bbj_pool, union_wallet                                                | yes         | autoledger |
| `fn_union_promo_send`                                 | bbj_pool, club_treasury, promo_wallet (uncovered), union_wallet       | yes         | autoledger |
| `fn_union_send_chips_to_club`                         | player_wallet, union_wallet                                           | yes         | own INSERT |
| `fn_union_send_to_club_atomic`                        | club_treasury, union_wallet                                           | yes         | autoledger |
| `fn_union_send_to_member_zd3core`                     | player_wallet, union_wallet                                           | yes         | autoledger |
| `fn_union_settle_player_pnl`                          | club_treasury, union_wallet                                           | yes         | autoledger |
| `promo_apply_playthrough`                             | player_wallet, promo_wallet (uncovered)                               | yes         | autoledger |

## felt writer (no journal trigger; felt account checked at commit) (27)

| function                                                       | store(s)                                 | stands down | leg from   |
| -------------------------------------------------------------- | ---------------------------------------- | ----------- | ---------- |
| `atomic_seat_cashout_locked`                                   | table_stack                              | no          | via door   |
| `fn_admin_close_table`                                         | table_stack                              | no          | via door   |
| `fn_bag_tournament_stage`                                      | table_stack                              | no          | autoledger |
| `fn_ca_assign_tournament_player_seat_locked`                   | table_stack                              | no          | autoledger |
| `fn_ca_commit_hand_settlement`                                 | table_stack                              | no          | autoledger |
| `fn_ca_release_broke_seats`                                    | table_stack                              | no          | autoledger |
| `fn_ca_settle_hand_stacks`                                     | table_stack                              | no          | autoledger |
| `fn_ca_settle_satellite_cohort`                                | prize_liability (uncovered), table_stack | no          | own INSERT |
| `fn_cash_seat_move_execute_before_maintenance_gate`            | table_stack                              | no          | autoledger |
| `fn_cash_seat_swap_execute_before_maintenance_gate`            | table_stack                              | no          | autoledger |
| `fn_claim_bounty_legacy_candidate_20260907`                    | table_stack                              | no          | autoledger |
| `fn_complete_breakfast_original_witness`                       | table_stack                              | no          | autoledger |
| `fn_eliminate_player_legacy_candidate_20260907`                | table_stack                              | no          | autoledger |
| `fn_move_tournament_player`                                    | table_stack                              | no          | autoledger |
| `fn_on_table_status_change`                                    | table_stack                              | no          | autoledger |
| `fn_poker_diamond_buyin`                                       | table_stack                              | no          | autoledger |
| `fn_poker_diamond_cashout`                                     | table_stack                              | no          | autoledger |
| `fn_poker_diamond_settle_cash_hand`                            | table_stack                              | no          | autoledger |
| `fn_poker_diamond_top_up`                                      | table_stack                              | no          | autoledger |
| `fn_seat_horse_in_seat_first_game_before_maintenance_gate`     | table_stack                              | no          | autoledger |
| `fn_seat_late_registrant_before_maintenance_gate`              | table_stack                              | no          | autoledger |
| `fn_seat_stage_entitlement`                                    | table_stack                              | no          | autoledger |
| `fn_take_seat_and_buy_in_before_maintenance_announcement_gate` | table_stack                              | no          | autoledger |
| `fn_union_close_club_tables_for_join`                          | table_stack                              | no          | via door   |
| `force_close_table_and_refund`                                 | table_stack                              | no          | autoledger |
| `process_tournament_rebuy`                                     | table_stack                              | no          | autoledger |
| `resolve_pending_addon`                                        | table_stack                              | no          | via door   |

## journal writer only (11)

| function                                        | store(s) | stands down | leg from   |
| ----------------------------------------------- | -------- | ----------- | ---------- |
| `fn_award_satellite_seat`                       |          | no          | own INSERT |
| `fn_ca_apply_prize_guarantee_core`              |          | no          | own INSERT |
| `fn_ca_autoledger`                              |          | yes         | own INSERT |
| `fn_ca_autoledger_delete`                       |          | yes         | own INSERT |
| `fn_ca_post_correction`                         |          | no          | own INSERT |
| `fn_ca_post_leg`                                |          | no          | own INSERT |
| `fn_ca_register_for_tournament_with_ticket_for` |          | no          | own INSERT |
| `fn_ca_return_satellite_entitlement_as_ticket`  |          | no          | own INSERT |
| `fn_club_members_ledger_writer`                 |          | yes         | own INSERT |
| `fn_settle_tournament_rake`                     |          | no          | own INSERT |
| `fn_union_weekly_rakeback_close`                |          | yes         | own INSERT |

## uncovered store (next migration) (18)

| function                                             | store(s)                                              | stands down | leg from   |
| ---------------------------------------------------- | ----------------------------------------------------- | ----------- | ---------- |
| `atomic_cancel_tournament`                           | prize_liability (uncovered), spin_reserve (uncovered) | no          | autoledger |
| `credit_club_wallet_rake`                            | club_wallet (uncovered)                               | no          | autoledger |
| `fn_ca_escrow_apply`                                 | prize_liability (uncovered)                           | no          | autoledger |
| `fn_ca_escrow_apply_exact_refund`                    | prize_liability (uncovered)                           | no          | autoledger |
| `fn_ca_escrow_on_close`                              | prize_liability (uncovered)                           | no          | autoledger |
| `fn_ca_return_unawarded_spin_draws`                  | prize_liability (uncovered), spin_reserve (uncovered) | no          | autoledger |
| `fn_complete_tournament_terminal_pre_seat_guard`     | prize_liability (uncovered)                           | no          | autoledger |
| `fn_poker_diamond_tournament_open_shadow`            | prize_liability (uncovered)                           | no          | autoledger |
| `fn_settle_satellite_tournament_pre_money_path_gate` | prize_liability (uncovered)                           | no          | own INSERT |
| `fn_spin_absorb_club_pool_into_union`                | spin_reserve (uncovered)                              | no          | autoledger |
| `fn_spin_activate`                                   | spin_reserve (uncovered)                              | no          | autoledger |
| `fn_spin_book_entry`                                 | spin_reserve (uncovered)                              | no          | via door   |
| `fn_spin_deactivate`                                 | spin_reserve (uncovered)                              | yes         | own INSERT |
| `fn_spin_reserve_pool`                               | spin_reserve (uncovered)                              | no          | autoledger |
| `fn_spin_settle_game`                                | spin_reserve (uncovered)                              | yes         | autoledger |
| `fn_stamp_tournament_terminal_evidence_markers`      | prize_liability (uncovered)                           | no          | autoledger |
| `spin_pool_deposit`                                  | spin_reserve (uncovered)                              | no          | autoledger |
| `spin_pool_draw`                                     | spin_reserve (uncovered)                              | no          | autoledger |

176 writers in all.

## The one split-write this reading found

`promo_apply_playthrough` (stand-down class) released a met promo into
`chip_balance` under `app.ledger_autoskip_club_members = '1'`. Both
club_members journal triggers honour that setting, so the release moved the
wallet with no leg at all. Dormant (0 releases in the 30 days to 2026-10-01,
0.00 promo outstanding); fixed at its line in the same migration, which writes
the one leg (`promo_wallet` -> `player_wallet`, released amount) inside the
stand-down and is pinned to the live body's md5.

## Not in this reading, by design

- `fn_ca_autoledger`, `fn_ca_autoledger_delete`, `fn_club_members_ledger_writer`
  are the journal triggers themselves (journal writer only).
- `public.wallets` is a dead pool (frozen 2026-08-21); nothing reads it.
- Diamond custody (`poker_diamond_custody`, `club_diamond_wallets`,
  `ca_diamond_house`) is not chip money and never carries a `chip_ledger` row.
