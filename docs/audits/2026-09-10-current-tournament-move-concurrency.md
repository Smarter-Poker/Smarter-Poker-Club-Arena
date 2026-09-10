# Current tournament movement concurrency evidence

The current seven-argument move function passed three real, committed, two-session PostgreSQL races on the owned local `full_stage1` database. The runner observed the second backend waiting on a lock held by the first backend before committing the first operation. No production database was modified.

| Race                              | Observed result                                                                                              |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| One entry, two destinations       | First move committed; the waiting contender refused because its source roster was no longer exact.           |
| Two entries, one destination slot | First move committed; the waiting contender refused because the destination seat was occupied.               |
| Same request submitted twice      | First move committed; the waiting retry returned the exact original immutable receipt with `replayed: true`. |

Each race proved that the rival left the owner's complete committed player, seat, table and receipt state unchanged. Both entrants had exactly one live seat, their roster coordinates and stacks matched those seats, the 2,000 synthetic play chips were conserved, and the tournament level and break clock fields were unchanged. All deferred constraints were forced immediate. Three genuine move receipts were committed; none was pre-seeded. The real service request hook validated protocol 2 and the fixture's current lease generation.

The exact move body was `466c39065b59cf7922a5859df9f26bd3`, taken from `20260910051125_the_seat_move_door_the_engine_calls_exists.sql`. The settlement lane body was `2bc939035496d764ff9d6c14b52fa1e7`. That same migration supplied the current receipt reader and the missing `source_mode text NOT NULL` column with its two-value check. All existing native guards remained enabled.

The older native database initially lacked that receipt column. The first real move transaction rolled back at the missing-column error; the fixture itself was retained. After the exact current column and reader composition, all races passed. The initial restoration command omitted the semicolon following `pg_get_functiondef`; its restoration transaction rolled back. The corrected restoration then passed an exact comparison of all public/private function definitions, owners and ACLs and all noninternal trigger definitions and enabled states. The final runner includes that correction and emits its success marker after restoration.

The fixture and the new receipt column intentionally remain in the owned local database. The event count increased from 11 to 12 when the fixture was created. One synthetic event, three tables, two entries and three immutable real move receipts are retained. This is not a claim of full data or schema rollback. Function and trigger restoration was exact, and handoff verified zero other sessions and zero seat authority rows. No existing ACL was broadened and no receipt was deleted.

`2026-09-10-current-tournament-move-concurrency.json` records the exact source hashes, race outcomes, state fingerprints and restoration evidence. `scripts/ci/rehearse-current-tournament-move-concurrency.py` is the bounded one-time proof runner and refuses a used fixture.

At the merged checkout, the nine existing movement, consolidation, heads-up, lease-boundary and clock suites also passed: 87 assertions, nine test files, zero failures, with at most two workers. The JSON evidence lists each file, its source hash and result. These suites mix dynamic behavior with source assertions.

This closes the previously missing real concurrent-move proof for the narrow CA-03-09 acceptance of one seat per entry and clock preservation. It does not alone establish complete integrated heads-up hand behavior, synchronized break/restart behavior, cross-table blind adoption, or every broader table-merge audit scenario. Existing TypeScript behavior tests and the current clock and table-blind evidence address parts of those topics separately; source checks must not be reported as end-to-end control acceptance.
