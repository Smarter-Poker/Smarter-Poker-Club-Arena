# Diamond release manifest: rollback and compatibility

Written 2026-09-20. This file answers one question: if a Diamond Arena release has to be rolled back, how far back can each component go before something a player owns stops being reachable.

It is a compatibility record, not a runbook. The owner actions this session could not perform are in [the owner steps runbook](../runbooks/diamond-launch-owner-steps-2026-09-20.md).

## 1. The Diamond migrations that are live

Read from production `supabase_migrations.schema_migrations` on 2026-09-20 (project `kuklfnapbkmacvwxktbh`, read-only). These are the Diamond Arena migrations proper, in version order. The wider Diamond economy set (the Mint, the journal, the rule modes, Diamond Spins) is older and is not repeated here.

| Version                                   | Name                                                                                                            | What it opened                           |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| 20260908034530                            | the_diamond_arena_accounting_foundation                                                                         | The arena's accounting objects           |
| 20260908114501                            | the_arena_gets_its_club                                                                                         | The platform club row                    |
| 20260908114517                            | the_books_learn_the_arena                                                                                       | Reporting learns the asset               |
| 20260908114533                            | a_horse_may_play_in_the_arena                                                                                   | Horse parity in the arena                |
| 20260908132937                            | the_books_survive_the_arena                                                                                     | Conservation across the arena            |
| 20260908152822 to 20260908153052          | poker_arena_identity_and_access, identity_guards, table_access, tournament_access, seat_guard, hierarchy_guards | Identity, access and seat guards         |
| 20260909065458                            | poker_diamond_custody                                                                                           | `poker_diamond_custody`, the custody row |
| 20260909164740 / 164847 / 165003 / 165102 | custody retry doors sealed, atomic release, internal writers service-only, writer ACL explicit                  | Custody hardening                        |
| 20260909193244                            | anyone_with_diamonds_may_play                                                                                   | Automatic membership                     |
| 20260909200327                            | atomic_wallet_diamond_transfers                                                                                 | The platform transfer door               |
| 20260910015108                            | diamond_wallet_transfers_require_a_live_session                                                                 | Session binding on the transfer          |
| 20260910050142 / 050156 / 050209          | cash custody settles exact seat generations, admission binds purchase receipts, accepted hands retain history   | Phase 6 cash custody                     |
| 20260911151623                            | a*diamond_transfer_names_both_sides_and_never_burns_what_it*                                                    | Transfer journal both sides              |
| 20260911222904 / 230657 / 230759          | staff open a plain cash table, table governed by the boundary, the door names its format                        | Table admission                          |
| 20260912004350                            | a_diamond_seat_tops_up_from_the_custody_it_sat_with                                                             | `fn_poker_diamond_top_up`                |
| 20260912012431 / 022313 / 041224 / 041739 | straddle, run it twice, bomb hand award units, bomb pots                                                        | Phase 7 table features                   |
| 20260912043644                            | restrict_diamond_credit_execute                                                                                 | Grant tightening                         |
| 20260912060917                            | one_rule_says_what_a_plain_diamond_cash_table_is                                                                | `fn_poker_diamond_plain_cash_table`      |
| 20260912070403                            | the_diamond_arena_deals_the_games_the_estate_deals                                                              | The nine games                           |
| 20260913162854                            | the_diamond_guards_are_watched                                                                                  | `ca_guard_defs` baseline                 |
| 20260913172013                            | the_diamond_ledger_sums_itself                                                                                  | Ledger summation                         |
| 20260914004611                            | the_diamond_seat_guards_know_a_tournament_seat                                                                  | Seat guards P0810 to P0815               |
| 20260914020333                            | the_wallet_learns_the_diamond_arena                                                                             | `fn_diamond_wallet_summary`              |
| 20260914024241                            | a_diamond_tournament_entry_is_custody                                                                           | Tournament entry as custody              |
| 20260914032315                            | a_diamond_tournament_pays_from_its_own_custody                                                                  | Tournament payout                        |
| 20260914034708                            | a_diamond_tournament_door_answers_the_client                                                                    | Client-facing tournament doors           |
| 20260914040416 / 041258                   | doors state their grants, money doors are watched                                                               | Grants and the guard watchlist           |
| 20260914043752                            | the_diamond_tournament_ledger_indexes_its_arena                                                                 | The arena foreign key index              |
| 20260914063002                            | diamond_health_requires_known_comparisons                                                                       | Health comparison coverage               |
| 20260914101922                            | the_wallet_knows_the_cheapest_seat_in_the_diamond_arena                                                         | Cheapest seat read                       |
| 20260914103833                            | the_diamond_arena_reconciles                                                                                    | `fn_diamond_arena_reconciliation`        |
| 20260914103912                            | a_diamond_seat_exit_goes_home_through_its_own_door                                                              | Seat exit routing                        |
| 20260914111215                            | where_the_diamonds_go                                                                                           | Flow reporting                           |
| 20260914111558 / 111709 / 113514          | rebuy proves its generation, bounty paid from its own bank, mystery chest holds whole Diamonds                  | Phase 9 bounties                         |
| 20260914114052                            | the_diamond_kind_map_names_every_writer                                                                         | Writer classification                    |

All of the above are recorded as applied. The repository carries a file for each of them again since PR #4941.

**Two F06 migrations are on `main` and are NOT applied**, and they are prerequisites of any engine activation:

- `supabase/migrations/20260918232558_mixed_f06_custody_transfer_retains_original_operations.sql` (PR #4907)
- `supabase/migrations/20260919024039_unresolved_f06_custody_retains_its_lease_evidence.sql`

Neither version appears in `schema_migrations`, verified 2026-09-20.

## 2. Which client or engine SHA introduced each caller

`git log -S<name> -- src server` on the current tree. Where a name shows `ea498c1fab` the restore of September 16 removed it; the re-land of PR #4938 (`ab9e626376`) is what put it back on `main`.

| Door                                                                    | Introduced by                                                                           | Component         |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ----------------- |
| `fn_poker_diamond_reserve`, `fn_poker_diamond_release`                  | `ec5a84f994` (PR #3972, Phase 3 custody)                                                | Engine            |
| `fn_poker_diamond_buyin`                                                | `bf83e6c304` (PR #4363), refined `914761f403` (PR #4413)                                | Client            |
| `fn_poker_diamond_top_up`                                               | `8f42fa1230` (PR #4371), refined `b072c52c41` (PR #4401)                                | Client and engine |
| `fn_poker_diamond_open_cash_table`, `fn_poker_diamond_plain_cash_table` | `d9e3f4a0be` (PR #4553), archived by `ea498c1fab`, re-landed in `ab9e626376` (PR #4938) | Engine            |
| `fn_diamond_wallet_summary`                                             | `6ba372e74b` (PR #4608), archived by `ea498c1fab`, re-landed in `f97c368d10` (PR #4947) | Client            |
| `fn_diamond_arena_reconciliation`                                       | `e619ddd78e` (PR #4613), archived by `ea498c1fab`, re-landed in `f97c368d10` (PR #4947) | Client            |
| `send_wallet_diamond_transfer`                                          | `8e1f11e26b` / `70fd31cf9a` (PR #4014), corrected `33b6100e36`                          | Client            |

## 3. What `check-engine-doors-exist.mjs` covers, and what it does not

`scripts/ci/check-engine-doors-exist.mjs` reads production's `pg_proc` immediately before the break gate and refuses a build that calls a function production does not have.

- It scans `server/src` only (`scripts/ci/check-engine-doors-exist.mjs:51`), excluding test files (`:115` to `:117`). **The client is not covered by this gate at all.**
- It collects two shapes: a literal `.rpc('name')` (`:98`) and any literal assigned to a `...rpcName` variable (`:99` to `:102`).
- A name in `scripts/ci/engine-doors.allowlist.json` is skipped, each with a reason (`:40`, consumed at `:190`).
- Three outcomes, not two. An unreadable database is a warning and exit 0 (`:184` to `:189`); a rollback (`ROLLBACK_REQUESTED=true`) is a warning and exit 0 (`:201` to `:204`); only a genuinely missing door on a forward release exits 1 (`:208`).

**This is the gate that is currently refusing the staged engine.** `server/src/tournament/mixedF06Custody.ts` calls five functions defined only in the uninstalled `20260918232558`, and none of the five exists in production (verified 2026-09-20):

`fn_f06_admit_mixed_manager_custody`, `fn_f06_complete_mixed_manager_custody`, `fn_f06_find_mixed_manager_custody`, `fn_f06_mixed_custody_intent`, `fn_f06_prepare_mixed_manager_custody`.

The gate is behaving exactly as designed. It is not the defect.

## 4. Minimum compatible SHAs

| Component               | Floor                         | Why this is the floor                                                                                                                                                                                                           |
| ----------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Engine                  | `86aab0e6` (Phase 6 cutover)  | Below this the engine has no Diamond custody boundary. A funded Diamond seat's stack is bound to a `poker_diamond_custody` row by a deferred constraint; an engine that cannot read custody cannot settle or release that seat. |
| Engine, for tournaments | `ab9e626376` (PR #4938 merge) | The Diamond tournament boundary re-landed here. Below it the engine deals a Diamond tournament table as a chip table. `tournaments_enabled` is false, so this floor binds only once the switch moves.                           |
| Client                  | `86aab0e6`                    | Below this the client has no Diamond cashier and cannot read a Diamond receipt.                                                                                                                                                 |
| Client, for the wallet  | `f97c368d10` (PR #4947 merge) | `fn_diamond_wallet_summary` and `fn_diamond_arena_reconciliation` are called from here.                                                                                                                                         |

## 5. The forward-only database rule

**A Diamond migration is never rolled back.** The database is forward-only, and three things enforce it in practice:

1. Supabase keys `schema_migrations` on the version; a down-migration would not remove the history row, so the ledger and the schema would disagree in the direction that is hardest to detect (CLAUDE.md section 4.5).
2. Several Diamond migrations edit an existing chip-estate function **in place** with the starting md5 pinned (`20260912041224` is the worked example). Reversing one of those by re-creating an older body would silently drop every later edit another lane made to the same function.
3. Money doors on `fn_ca_guard_watchlist()` carry a `ca_guard_defs` baseline written in the same migration (`20260913162854`). Dropping the door leaves the baseline naming a function that no longer exists.

If a Diamond migration is wrong, the correction is a new forward migration that says what changed and why, never a revert.

## 6. The custody-outstanding rollback rule

**Rolling the engine below `86aab0e6` while any `poker_diamond_custody` row is outstanding strands a funded seat.**

A Diamond seat's stack must EQUAL its custody balance at every commit; that is a deferred constraint, not a convention. The only paths that return those Diamonds are `fn_poker_diamond_release` and the seat-exit routing added by `20260914103912`, and both are called by the engine. An engine without the custody boundary does not call them, cannot settle the hand the seat is in, and leaves the Diamonds reserved with no door that returns them. The player sees a balance that is short and a seat that cannot be left.

So the rule is a precondition, not a preference:

> Before any engine rollback below `86aab0e6`, read `select count(*) from public.poker_diamond_custody`. If it is not zero, the rollback is refused until those rows are released through the live doors.

Measured 2026-09-20: `poker_diamond_custody` holds **0 rows**, and both arena switches are off, so no rollback is blocked by this rule today. It binds from the first funded seat onward.

## 7. The client rollback budget: ten releases

`.github/workflows/publish-club-arena.yml:666` sets `KEEP_RELEASES: '10'`. The origin keeps the ten most recent `releases/<sha>` directories by modification time and deletes the rest (`:1188` to `:1193`), with two exceptions it never deletes: the currently served `CURRENT_SHA` and the SHA being published.

That is the whole client rollback budget. Rolling the client back means repointing the `current` symlink at one of those ten directories, so **a client SHA more than ten releases old is not rollable; it has to be rebuilt and republished.** At the observed cadence of roughly twenty merges a day this window is under a day, which is worth knowing before treating an old client SHA as a safe fallback.

The `pool/` tree is separate and append-only: `/assets/*` and `/fonts/*` are never deleted, so a player holding a previous `index.html` keeps resolving its hashed chunks (CLAUDE.md section 1.1). Do not prune the pool to reclaim space.

## 8. The engine cutover reserve: 285 seconds

`server/scripts/engine-release-transaction.sh` will not begin a cutover unless the durable break still has 285 seconds left:

- `BREAK_CUTOVER_PROOF_SECONDS=150` (`:42`), for candidate proof.
- `BREAK_ROLLBACK_RESERVE_SECONDS=135` (`:43`), held back so a failed cutover can restore the previous engine inside the same break.
- `MIN_BREAK_REMAINING_MS` is the sum times 1000, that is 285000ms (`:50`).

The certificate read at `:414` and `:426` returns the remaining milliseconds and exits 2 when the break is shorter than that budget; the transaction then releases the engine lock and waits for a later certificate (`:1071` to `:1075`) rather than starting work it cannot finish. A legacy checkpoint must also complete with the full certificate and reserve intact or the release dies (`:1069`).

The reserve exists because five to eight minute boots have happened while the database was degraded (`:29` to `:40`). It is not padding, and shortening it converts a recoverable failed cutover into an outage.

## 9. What is true right now

- Production engine: `8825af51817f379c4261658ca29ecc9d8d81932d`, instance `1-3846b8bb`, reported by `https://engine.smarter.poker/health` on 2026-09-20.
- `maintenance.readyForRestart` is `false` with `unparkedTables: 0` and `unparkedReasons: {"f06_preparation_unresolved": 1}`.
- `ca_arena_settings`: `cash_games_enabled` false, `tournaments_enabled` false.
- `poker_diamond_custody`: 0 rows. `diamond_wallet_transfers`: 0 rows.
- The newest engine build is staged and NOT active. See the runbook for why and for the decision that clears it.
