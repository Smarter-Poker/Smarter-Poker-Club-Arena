# Native committed game-seat ownership — Phase 2, in progress

## Defect and change

The inspected production fn_cash_cluster_tick had two duplicate-chair repair loops. One could cash out a positive stack whenever a table row said waiting, and the breaking-table loop could cash out a second chair directly. Neither call carried an occupancy UUID or the live engine's hand-boundary ownership. This is a confirmed control-path defect, not proof of the cause of a particular historical incident.

Migration 20260909052547 derives table/cluster ownership scopes and installs a native DEFERRABLE INITIALLY DEFERRED unique constraint on (user_id, active_game_scope). The composite parent foreign key cascades table-to-cluster and cluster-to-cluster changes. Standalone and cluster UUIDs have different namespaces. Active scopes cannot be cleared or forged through ordinary writes. Historical closed seats have NULL scopes.

A legitimate move can insert its destination before closing its source within one transaction. A second committed seat fails the transaction, including its wallet debit. The move GUC does not bypass this constraint. These are transaction rules; no watcher, reconciler or compensating payout is added.

Only occupied old parents are backfilled. An old empty parent is initialized inside its first admission transaction. This avoids updating 203,451 historical table rows. A transaction-local before/after proof rejects the migration if an existing trigger changes seat data or game data other than the normal updated_at stamp. The migration has a 2-second lock-acquisition bound and 30-second statement bound.

The internal seat_game_scope field is excluded from the managed-game contract projection, so initialization does not manufacture an operator rule revision. Actual rule changes remain in that document.

Migration 20260909054702 removes only the two reviewed planner repair blocks. It requires the installed native ownership constraint and rejects an unknown function fingerprint. All remaining planner statements are preserved.

## Evidence

- Read-only production preflight: zero duplicate active ownership groups, zero active seats missing their table/player, 1,678 active seats; no tables in retired clubs at that read.
- Production table inventory: 203,451 rows. Seat estimate: 471,876 rows. The scale fixture uses synthetic data, not copied customer data.
- Final isolated PostgreSQL suite: 88 tests passed in phase-two-native-ownership-contract-compatible.log.
- Cluster controller, metrics and wiring suites: 137 tests passed in phase-two-native-ownership-cluster-wiring.log.
- Server TypeScript passed before the final test-only additions; final combined gate remains required.
- Synthetic scale run passed with 203,451 parents / 471,876 seats. This proves the local algorithm at those row counts, not production hardware latency or a complete production trigger rehearsal.
- Injected pre-existing trigger changed a stack during backfill: migration refused; both new schema and stack change rolled back.
- Tests cover destination-first movement, duplicate admission with move GUC, losing debit rollback, revive/reassignment, forged scope, standalone/cluster namespace separation, concurrent admissions, concurrent cluster reassignment, old empty parent initialization, same-named wrong constraint rejection, planner migration prerequisite/fingerprint rejection, planner early responses and unchanged permissions.
- Planner active-game policy branches were not all executed in the isolated planner fixture. Existing controller/law tests passed; removed blocks are fingerprint-bound and remaining statements unchanged.

Reviewed fingerprints (pg_get_functiondef MD5):

- fn_cash_cluster_tick: a2ad5aea846e31affa53fa187be8773b -> 2303b31672ff35201d2a310d821c0cd4.
- fn_managed_game_contract_document: 13df6027a54258c61e6e41275fbf0dd6 -> 154901c4d25f28060e81bc06619e788a.

References: PostgreSQL 17 CREATE TABLE documentation (deferrable unique and foreign-key constraints), https://www.postgresql.org/docs/17/sql-createtable.html.

## Still open

These two migrations are LOCAL and UNAPPLIED. They are not a Phase 2 completion or deployed-version claim. Publication must use the authorized private-repository/Hetzner path.

Remaining Phase 2 gates include native close/admission ownership, unused legacy departure aliases, administrative replay/classification/bulk identity, stale user-keyed cleanup, the poker-rule acceptance matrix, a required isolated PostgreSQL CI gate, combined regressions, occupancy schema/client/engine adoption and final legacy retirement.

The inspected existing managed-game contract capture function also contains fail-open exception handling that can lose a contract version and file an incident. This batch prevents derived ownership metadata from entering that path; it does not certify or repair the broader configuration capture mechanism. Carry that confirmed gap into the configuration/effective-date audit.
