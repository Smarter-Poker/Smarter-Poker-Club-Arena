# PostgREST Never Reruns A Refusal

## What Was Wrong

PostgREST 14 re-runs a request whose transaction ends in SQLSTATE 40001 (serialization_failure) on the same pooled connection, immediately, with no backoff and no limit. Supabase documents this as fixed only in PostgREST 16. Production runs PostgREST 14.5 and 14.18 (read from `pg_stat_activity.application_name`).

So a function that raises its own 40001 for a condition the same request meets again never answers. The request holds a pool connection until something outside it changes, and if the caller gives up, the backend keeps going:

- 2026-10-06 to 2026-10-07: one settlement refusal looped for ten and a half hours from 457 backends (#6326, fixed for twelve sites by 20261007071300).
- 2026-10-11 06:04 to 06:08 UTC: an idempotency conflict ran 26,264 times (its lane moved it to PT409).
- 2026-10-11 17:50 to 18:53 UTC: the ticket door refusal ran 22,401 times from 10 backends and pushed the F06 lane refusals to about 6,000 a minute (fixed by 20261011185301 and 20261012031813).

After those fixes the catalog still held 186 custom 40001 raise sites in 99 functions (87 in public, 12 in smarter_private). 58 of the functions are executable by anon, authenticated or service_role, 6 are triggers, and 173 of the 186 sites can reach PostgREST without being caught.

## How Each Site Was Judged

For every site: what condition raises it, which PostgREST entry points reach it (call graph four levels up, with every enclosing exception handler read), which callers in SQL, the engine and the client match on the code or the message, and whether running the same request again can ever take a different path.

- A busy lane, a try-lock, a lease held by another live owner or a request still in flight can clear, but PostgREST spins on it with no backoff while every lock the request took before that point is taken again on each run. That is how the ticket door kept the event lane held for 40 minutes. These move to 55P03, the code 20261011185301 gave F06_RETRY_CANONICAL_LANE. Every caller that treated them as transient already lists 55P03 (`isTransientDatabaseError`, `isLaneContention`, `abandonedGenerationDoor`, the retained hand door, the SQL retryable lists).
- A refusal the same request will meet again (a stale expected version from the caller, a replay with different input, a compare-and-set on rows this transaction already locked, a lost claim, an invariant checked after the transaction's own write, a time fence) moves to 55000, the code 20261007071300 and 20261011185301 chose. The engine reads any five character SQLSTATE as a rolled back answer and takes its next pass; the client shows "something changed, try again".
- Fifteen sites keep 40001, each for a written reason (below).

## What Changed

Migration `20261012061427_postgrest_never_reruns_a_refusal` changes only the SQLSTATE literal of 171 RAISE statements in 90 functions (33 to 55P03, 138 to 55000) and one exception handler:

- `fn_park_stopped_time_bank_custody` waited for `F06_RETIRED_CLAIM_BUSY` by catching SQLSTATE 40001 up to 40 times, 25 ms apart. It now catches 55P03, the code that raise carries.

Every message text is unchanged, so every caller that matches a message reads the same words. Predicates, locks, money, owner, security, configuration and ACL are identical and re-checked per function; an unknown preimage refuses before anything changes. It ran first as a rolled back trial (all 91 functions replaced and proven), then once at 06:14 UTC, in one transaction with a 5 second lock timeout.

Tournament, seat, hand and settlement paths among them: tournament cancel (chip and Diamond), unregistration, chip purchases and rebuys, seat assignment and moves, stage bagging and resume, launch receipt adoption and completion, finish and final table claims, eliminations and bounty claims, satellite settlement and outcome, terminal completion, place settlement by ruling, refunds, blind publication, the maintenance break save and thaw credit, retained hand dispatch, disposal and resume, and every F06 abort and custody door.

## The Fifteen Sites That Keep 40001

| Function                                                         | Sites | Why it may stay                                                                                                                                                                                                        |
| ---------------------------------------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| fn_settle_final_table_deal_atomic                                | 4     | Caught by its own handler and returned as `retryable`                                                                                                                                                                  |
| fn_settle_tournament_places_atomic                               | 2     | Caught by its own handler and returned as `retryable`                                                                                                                                                                  |
| fn_settle_satellite_finish_atomic_before_maintenance_gate        | 3     | Caught by its own handler and returned as `retryable`                                                                                                                                                                  |
| fn_lightning_form_hand                                           | 1     | Caught by its formation sub-block and returned as a matcher retry                                                                                                                                                      |
| fn_ca_settle_hand_stacks_absolute                                | 1     | Only reached inside the hand commit envelope, which returns it as `atomic_hand_rolled_back`; the engine retries that envelope with bounded delays only for 40001 or 40P01                                              |
| fn_lock_tournament_launch_proof_parents                          | 1     | NOWAIT on launch receipt rows held only by the one short launch transaction, raised from triggers on engine table inserts that have no retry of their own; 8 to 50 re-runs a day, each burst cleared within one second |
| fn_refuse_new_entries_while_frozen, fn_serialize_entry_statement | 2     | Shared try-lock on the entry boundary, held exclusively only by the short maintenance claim, save, clear and thaw transactions; 107 re-runs on 2026-10-08 and none since                                               |
| fn_union_pnl_original_frame                                      | 1     | Needs the clock to cross two union week boundaries inside one call; an immediate re-run cannot                                                                                                                         |

Once the deterministic refusals stopped re-running, nothing that holds those two locks re-runs itself, which is what kept them short.

## Proof

- Recorded as version 20261012061427, md5 of the recorded statement `46475e9b54f85098853e3057075f7c43`, byte-exact with the repository file.
- Live catalog after apply: 9 functions and 15 sites with a custom 40001, exactly the kept set; both `@live-proof` lines read true.
- Postgres errors in the two minutes after apply: only the usual F06 lane 55P03 and unrelated application refusals; no schema cache failures.
- The full inventory with every site, its roles, whether it reaches PostgREST uncaught, and its decision is `tests/fixtures/postgrest-never-reruns-a-refusal/inventory.json`.
- `tests/postgrest-never-reruns-a-refusal.law.test.ts` pins the bytes, the inventory and its counts, the kept set the migration proves, and the handler change. `tests/a-late-ticket-entry-expects-the-running-count.law.test.ts` already refuses any later migration that raises a custom 40001.

## Noted For Other Lanes

- `fn_ca_guard_mtt_admission_contract` pins definition md5s of nine of the changed functions (and 42 of its 149 pins had already drifted before this change). It only fires on writes to `ca_mtt_admission_contract`; an operator changing that contract will need fresh pins.
- The engine's hand commit rollback retry (`handHistory.ts`) retries the `atomic_hand_rolled_back` envelope only for 40001 or 40P01, not 55P03. Since 20261011185301 a lane-busy hand commit (F06_RETRY_CANONICAL_LANE, now 55P03) no longer takes that bounded loop; the hand path lane may want to add 55P03 there.
