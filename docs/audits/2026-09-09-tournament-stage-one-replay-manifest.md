# Tournament Stage-One Current-Baseline Replay Manifest

This release is rehearsed from the supported current production schema baseline, not by pretending every historical incident repair is a general-purpose clean-schema migration.

## Immutable Applied Baseline

| Physical Version | Name                                                    | Live Statement MD5                 | Replay Classification                                                                        |
| ---------------- | ------------------------------------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------- |
| `20260909042455` | `tournament_cash_settlement_has_one_atomic_authority`   | `9037255f6a5c4bfb38718405d2a98673` | Required Installed Authority                                                                 |
| `20260909061222` | `a_finished_satellite_must_be_able_to_settle`           | `5a5716c97be4854e95b1061264f53b50` | Baseline-Only Production Incident Data Repair                                                |
| `20260909065458` | `poker_diamond_custody`                                 | `274f58e8b88872a291df36fbd6f16781` | Required Installed Authority                                                                 |
| `20260909065655` | `the_supply_meter_counts_escrow_until_the_money_leaves` | `ee0faf2aac468f6c20b1c313868366cb` | Required Installed Authority                                                                 |
| `20260909071226` | `the_rebuy_chain_lost_two_links`                        | `9b292605da737a035dc7334e844ce586` | Required Installed Authority; Repository Source Is A Semantically Equivalent Expanded Record |

`20260909061222` deliberately refuses a database without its exact affected production cohort. Its source remains byte-exact to the production ledger. Current-schema rehearsals must begin after this incident history; they must not seed fake incidents or manipulate `supabase_migrations.schema_migrations` to force a false from-zero replay claim.

## Forward Cutover Order

The logical IDs embedded inside these files are immutable. After each production apply, only the physical filename and exact path references are changed to the version assigned by the Supabase migration ledger.

1. Freeze A: `20260909165548_chips_are_two_decimals_on_the_addon_path.sql` (logical ID `20260909062006`)
2. Freeze A, immediately contiguous: `20260909165555_addon_money_is_finite_and_historical_receipts_balance_to_cents.sql` (logical ID `20260909072626`)
3. Freeze A: `20260909165602_the_four_table_limit_is_never_satellite_cash.sql` (logical ID `20260909071500`)
4. Freeze A: `20260909165629_satellite_settlement_has_one_atomic_authority.sql` (logical ID `20260909014421`)
5. Freeze A: `20260909014433_spin_reserve_settlement_commits_its_journal_or_nothing.sql`
6. Thawed: `20260909053000_complete_known_spin_journal_adoption_after_freeze.sql`
7. Thawed: `20260909052000_complete_known_satellite_adoptions_after_freeze.sql`
8. Freeze B: `20260909014444_tournament_cancellation_commits_one_stored_receipt.sql`
9. Freeze B: `20260909014457_four_full_pool_events_retire_only_their_stale_obligation_meta.sql`
10. Freeze B: `20260909014510_every_tournament_payout_names_its_source.sql`
11. Freeze B: `20260909041438_retire_legacy_tournament_hold_refund_door.sql`
12. Freeze B: `20260909014534_non_satellite_terminal_settlement_commits_one_stored_receipt.sql`
13. Freeze B: `20260909014545_tournament_seat_exits_stay_inside_tournament_authority.sql`
14. Freeze B: `20260909043000_tournament_terminal_roots_are_db_first_hardened.sql`

The two add-on definitions are contiguous because the second pins the installed processor and predecessor bodies. The two closeouts refuse a frozen platform and therefore run between the two freeze windows. The terminal migrations remain frozen through their final postconditions.

## Release Receipt

The physical-version mapping, applied statement hashes, candidate commit, merge commit, engine deployment, static deployment, and post-deploy probes are recorded here only after each boundary is observed. A branch push, an open pull request, or a running workflow is not publication evidence.
