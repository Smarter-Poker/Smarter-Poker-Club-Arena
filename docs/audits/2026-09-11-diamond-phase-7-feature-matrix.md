# Diamond Phase 7: Supported Feature Survey

Status: Survey, Not Certification. Read Before Enabling Any Feature; Confirm Each One Against Current Source Before Acting On It.

This is the code survey Phase 7 starts from. It was produced read only against `origin/main` and records where each Phase 7 feature lives today, whether the Phase 6 Diamond admission guard already refuses it, and what chip economy dependency would have to be given a Diamond boundary first. A row here is a starting point for an increment, not evidence that the increment is safe; nothing below has been certified against a Diamond table, because no Diamond table can be created yet.

## The Phase 6 Guard, And What It Refuses

Six places agree, three in TypeScript and three in SQL.

- `server/src/domain/DiamondCashBoundary.ts`, `assertDiamondCashTable`, called from `loadTable` in `server/src/services/supabase/tables.ts`.
- `server/src/engine/HandController.ts`, at hand construction.
- `server/src/domain/DiamondCashBoundary.ts`, `assertDiamondAcceptedHand`, called from `ServerTableEngineSettlement.ts`.
- `fn_poker_diamond_buyin`, `fn_poker_diamond_settle_cash_hand` and the Diamond branch of `fn_ca_commit_hand_settlement`, from the three applied Phase 6 migrations.

Together they refuse a table that is not plain `nlh`, that carries a tournament id or a cluster id, that is a template, or that has insurance, bomb pots, any run it twice flag, any straddle flag, seven deuce, nit game, all in or fold, pineapple, cap, a non zero rake or a non zero BBJ. They refuse fractional amounts everywhere, and they refuse an accepted hand carrying rake, BBJ, inflow, insurance, promo playthrough, pending add ons, daily mission events or bomb award units.

Two soft spots were found in the survey and are not yet repaired:

1. `refreshRakeConfig` in `ServerTableEngineBase.ts` re-reads the table's feature flags roughly every sixty seconds without re-validating them. Bomb pots, run it twice, insurance, rake and BBJ are still caught downstream at hand construction, which parks the table; a straddle flag flipped after admission is not, because straddles are only validated for whole amounts.
2. A Diamond table whose `run_it_twice` and `allow_run_it_twice` columns are NULL is admitted and then refuses every hand, because the engine treats NULL as enabled while both guards only refuse an explicit true. Phase 6 fixtures set the columns to false explicitly, so this has never been hit.

## The Blocker Before Any Row Below

There is no Diamond table creation door. `fn_cash_game_create` opens its first table through `fn_cash_cluster_open_table`, which always writes a cluster id, run it twice true and `rake_percent` -1. Every one of those is refused above. Phase 6 created tables by fixture insert only.

## Survey

| Feature group                                                  | Guard today                                                                                     | Chip dependency                                                          | Assessment                                                                   |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| Variants beyond NLH                                            | Refused at all six points; the arena lobby also filters to `nlh`                                | None intrinsic, but no creation door can produce an admissible row       | Needs a Diamond boundary and a creation door                                 |
| Waitlists and seat offers                                      | Allowed; admission honours notified holds and marks the row seated                              | None                                                                     | Reusable, needs client wiring and one certification                          |
| Rebuys, add ons, top ups                                       | Refused in engine, client and SQL; the deferred custody trigger refuses any direct stack change | `club_members.chip_balance`, `table_pending_addons`, club wallet refunds | Needs a Diamond custody top up writer and a Diamond pending add on lane      |
| Seat change, must move, clusters                               | Refused by the cluster id check and the seat triggers; simultaneous multi table play is allowed | Chip continuity sessions and the ruleset projection                      | Clusters stay unavailable this phase; multi table play is reusable           |
| Bomb pots, boards, straddles, run it twice                     | Refused by flag and at hand construction; bomb award units refused in SQL                       | None for straddles; bomb awards ride the refused units lane              | Needs a Diamond boundary; close the two soft spots first                     |
| Skins, decks, time banks, rabbit hunt, chat, voice, throwables | Allowed                                                                                         | None; every charge is a wallet debit, not a club ledger                  | Reusable, needs certification at a Diamond table                             |
| Feature charges against game stakes                            | Separated by construction: stakes live in custody, features debit the wallet                    | None                                                                     | Reusable; add a regression that neither path touches the other               |
| Insurance, EV cash out, BBJ                                    | Refused everywhere                                                                              | Counterparties are union and club chip treasuries and BBJ pools          | Stays unavailable; the programme assigns Diamond fee destinations to Phase 9 |
| Lifecycle and denomination suites                              | Diamond SQL runners are local only and not wired into CI                                        | Managed close authority is the chip club membership model                | Extend the existing suites rather than adding parallel ones                  |

## Phase 6 Diamond Suites To Extend

Server: `DiamondCashBoundary.test.ts`, `DiamondCashHand.test.ts`, `DiamondAcceptedHandPipeline.test.ts`, `services/DiamondCustody.test.ts`. Client: the Diamond component and unit suites under `tests/`, plus the Diamond law tests. SQL: the `tests/sql/poker-diamond-*` fixtures and their `run-diamond-*.py` runners, which target a local PostgreSQL 17 socket and are not part of CI.

## Order This Suggests

1. A Diamond table creation door, without which nothing else can be exercised in production.
2. Close the two guard soft spots, since both let a table reach a state the guard was written to prevent.
3. Certify what is already allowed: waitlists and seat offers, and the table feature set that charges the wallet rather than a club ledger.
4. Then the boundaries, cheapest first: straddles, run it twice, bomb pots, then variants.
5. Rebuys and add ons need a new custody writer and are their own increment.
6. Insurance and BBJ are Phase 9 and stay closed.
