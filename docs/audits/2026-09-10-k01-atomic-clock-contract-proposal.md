# K01 Atomic Clock Contract Proposal

Status: design for parent review, not implemented or deployed. The short-format resolver corrections are separate commits. K01 remains open.

## Observed Writers And Defects

`TournamentManagerBase.startBlindTimer` detaches a same-level `level_started_at` update after arming a local timer. `advanceBlindLevel` changes local level first, writes tables one request at a time, emits table level-up events even after a write failure, then writes the tournament level and anchor. Those are the two direct Club Arena level/anchor writers found in current production source. The similarly named `sync_tournament_state` and `commander_clock_write` catalog functions update `commander_tournaments` and are outside Club Arena's clock scope.

Resume currently abandons the persisted anchor when it is at least four level durations old and can grant a new full level. Recovery also writes each table independently before dealer admission. The add-on and synchronized-break paths snapshot local remaining time before separately persisting break state. An atomic advance can still cross that local pause snapshot unless pause ownership joins the same durable clock boundary.

`fn_credit_maintenance_thaw_targets` is an existing authorized forward anchor writer. It must remain effective and must not be overwritten by replaying an earlier clock outcome. `smarter_private.fn_smarter_data_api_pre_request` already key-share-locks the exact manager lease, but its validation happens before subsequent application waits. The clock RPC must recheck lease generation and freshness after its own waits.

## Durable State

Use one per-tournament clock publication row carrying a monotonic revision and activation state, plus immutable per-operation receipts. Neither table gets a foreign key to the hot tournament table. Enable RLS and explicitly revoke public, anonymous, authenticated, and direct service writes. Expose only the reviewed service RPCs and required service reads. The tournament row remains the canonical level/anchor source; the publication row must not create a second independent clock.

An operation receipt binds operation UUID, tournament UUID, exact lease generation, operation kind, expected revision, expected level, expected anchor, and relevant durable pause identity to an immutable canonical request and result. Reusing the UUID with different input refuses. A retry of the exact UUID resolves the original outcome. Responses contain both the immutable original result and freshly read canonical current state, so a later thaw or level advance cannot be undone by an old replay.

Activation is per tournament when an exact new manager first adopts the contract. The database-first migration permits untouched old tournaments to continue during normal engine rollout. Once activated, legacy direct clock writers cannot change that tournament's level or anchor. This is a transition of authority, not a client feature flag or a broad platform lock.

## Operations

| Operation  | Required Behavior                                                                                                                                                                                                                                                                                                     |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Adopt      | Lock and return the existing canonical level/anchor, refresh every durable open table from that level, and activate its publication revision atomically. An overdue anchor stays overdue. It is never replaced by the current wall clock.                                                                             |
| Initialize | Only a null anchor may initialize. Validate an actual running launch and its short-format deal hold before recording the first anchor. Existing anchors are adopted.                                                                                                                                                  |
| Advance    | Validate the exact expected publication, compute the next playable level from the persisted structure, skip legacy break rows, use the canonical blind resolver, update every durable open table and tournament level/anchor in one transaction, then record the outcome. No caller-supplied blind amount is trusted. |
| Pause      | Record one durable pause owner and its start against the current publication while holding the same clock lock. If advance committed first, pause measures the new level. If pause committed first, advance cannot pass it.                                                                                           |
| Resume     | Close that exact pause owner and credit only its uncredited overlap with the level, preserving overlapping add-on and synchronized owners. Caller-provided remaining milliseconds cannot move the clock.                                                                                                              |

The exact pause representation must be reviewed against existing `on_break`, synchronized break timestamps, add-on window timestamps, and the global maintenance thaw target receipts before implementation. A single mutable boolean cannot distinguish overlapping owners. Global maintenance continues through its existing thaw authority, with publication revision bumped when it shifts an activated clock. Do not replace it with another periodic repair job.

## Lock Order And Maintenance

1. Acquire the shared maintenance advisory lock `(530090, 1)` and check the persistent freeze state. Ordinary clock operations never set a freeze bypass.
2. Resolve and lock the exact operation receipt and per-tournament publication receipt in a fixed order.
3. Lock the tournament row, then all currently open, nondeleted tournament table rows in deterministic UUID order.
4. Recheck persistent freeze, exact lease generation, protocol, freshness, expected level/anchor/revision, and durable pause state after waits. The existing key-share lease fence blocks takeover while permitting the current heartbeat.
5. Apply all writes and immutable outcome together. Any last-table error rolls back all earlier tables, the tournament clock, and the receipt result.

Capacity creation already holds the tournament row before inserting a table. Its trigger must acquire the publication receipt with `NOWAIT` and translate lock contention into `40001`, rolling back the entire capacity operation. It must not wait in the inverted tournament-to-receipt order. Apply the same rule to reopening and closing paths. An insert or reopen after activation must derive the canonical current blinds while holding this boundary, even when an old caller sent stale values. No live table may be excluded merely because the manager has not admitted it yet.

Existing maintenance thaw also begins from tournament updates. It needs an explicit reviewed clock-write authority marker and a nonblocking publication-lock path, preserving its causal whole-operation retry. Do not broadly trust the service role, and do not introduce a general caller-controlled clock bypass.

## Engine Adoption

Retire the detached anchor write from `startBlindTimer`; that method only schedules from an accepted canonical anchor and duration. Remove the independent table fan-out and direct tournament level write from `advanceBlindLevel`. Resolve an ambiguous response using the same operation UUID. Do not manufacture a new operation after a timeout.

Initial resume adopts the durable anchor and canonical tables before any dealer admission. Remove the four-duration reset and the per-table correction loop. Every post-await continuation checks the exact lifecycle token. Responses are adopted monotonically by revision, then by canonical level/anchor, and cannot move local state backward after a later response. Only a committed accepted transition can emit level-up events, reconcile entry closure, or schedule its next timer. If a pause begins while a transition response is in flight, resolve the durable pause/publication before measuring remaining time.

Keep K02 hand snapshots intact: an in-flight hand uses the blind snapshot it already owns, and the next hand takes the newly committed table state. No forced engine restart, Stage-B cutover change, historical chip rewrite, or platform-wide lock is included.

## Required Execution Evidence

- Actual PG17 function execution: last-table failure rolls back everything; concurrent advance/advance; same UUID retry and conflicting replay; stale expected revision/anchor; stale lease before and after each blocking wait; global freeze begins while waiting; late response after thaw; and capacity create/reopen/close contention.
- Actual manager composition: delayed successful RPC, delayed refusal, unknown response resolved by receipt, local lifecycle retired during await, newer response arriving before an older replay, break before/after advance, and restart with an overdue canonical anchor.
- Actual approved short-format matrix from the resolver lane remains unchanged, and generic MTT duration/acceleration behavior is captured before adding any database due-time calculation.
- Exact database catalog postconditions, normal engine publication/adoption, and observed live table/level/anchor agreement are required before K01 can close.

## Review Addendum: Membership And Restart Boundaries

The current `origin/main` review at `0323423b4` includes `5b7469a5c` and `c50dc3abd`. Its lease contract is transaction-lifetime `FOR KEY SHARE`, claimant `FOR UPDATE`, and heartbeat `FOR NO KEY UPDATE`. The word nonblocking refers to heartbeats, not elimination of the transaction lease fence. The live request hook body `ab227471f29f2944ebd64909622b6af7` was read directly and agrees.

A live catalog scan found table membership writers beyond capacity creation. These need the common table trigger boundary and actual execution coverage; naming the parent tournament lock does not serialize all of them:

| Writer                                                                                                             | Membership Effect                                                                                      |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `fn_create_seat_first_game_atomic`                                                                                 | Inserts a waiting tournament table.                                                                    |
| `fn_ensure_late_registration_capacity`                                                                             | Inserts a running table after locking the tournament.                                                  |
| `fn_seat_late_registrant_before_maintenance_gate`                                                                  | Legacy creation route that can insert another waiting table.                                           |
| `fn_clear_table_seats`                                                                                             | Can reopen a nonclosed table as waiting.                                                               |
| `fn_close_empty_tournament_table`                                                                                  | Closes a specific empty tournament table.                                                              |
| `fn_close_managed_game`                                                                                            | Generic close entry point also needs classification at the actual row.                                 |
| `atomic_cancel_tournament`, `fn_complete_tournament_terminal`                                                      | Close the complete tournament table set.                                                               |
| `fn_settle_final_table_deal_atomic`, `fn_settle_tournament_places_atomic`, `fn_settle_tournament_places_by_ruling` | Settlement closures of tournament tables.                                                              |
| `fn_settle_satellite_tournament_pre_money_path_gate`                                                               | Closes the captured satellite table cohort.                                                            |
| `fn_reconcile_tournament_denormals`                                                                                | Closes duplicate empty tables.                                                                         |
| `fn_table_lifecycle_pass`                                                                                          | Contains waiting/reopen writes; its tournament exclusion must be verified in the actual function body. |
| `TournamentManagerBase.createTablesAndSeatPlayers`                                                                 | Direct server table insertion, including rebuilds.                                                     |

The scan is evidence for these candidates, not an exhaustive dynamic SQL proof. Generic table writers that do not mention `tournament_id` still reach the same schema trigger when their actual row belongs to an activated tournament. `fn_union_close_club_tables_for_join` explicitly limits its close to `tournament_id IS NULL`, so that particular union close path is excluded from this clock contract.

Activation cannot be deleted or downgraded by ordinary service work, manager replacement, or old-engine rollback. A new lease generation adopts the already-active contract; it cannot restore legacy direct writers. Replays of an old generation's operation are resolved through a separate read-only receipt resolver authorized by the current lease generation. Resolving an outcome never re-executes the old write, and the old receipt's generation/payload remain immutable. The old manager cannot use this read path after losing its own lease.

A `40001` from the membership trigger aborts the complete containing operation. Local tests must run actual paid entry/capacity composition and prove that wallet debit, roster, receipt, table, and wake all roll back. The exact originating operation identity must survive the retry. A generic unbounded transport retry is not acceptable.

Finally, add-on and synchronized pause overlap must be composed with already-credited global maintenance intervals. Incrementing the revision when global thaw moves the anchor is necessary but does not alone prevent double credit. The proposed pause/resume function must subtract maintenance credit already applied to the same interval and level, using the existing thaw target receipt for that tournament. A blanket `app.freeze_bypass` exception without the exact maintenance provenance is insufficient. The concrete current maintenance writer integration requires review before any atomic clock SQL is created.

## Activation Barrier Protocol Proof

The disposable PG17 runner is `scripts/dev/probe-clock-boundary-pg17.py`. Its candidate schema is deliberately outside `supabase/migrations`, with no production activation RPC or production change. The proof executes four freshly captured launch and durable-evidence functions without editing their bodies. It installs their three relevant table triggers and checks their source hashes. It does not install the complete financial, terminal, settlement, lease, or table-lock schema.

The captured first table BEFORE ROW trigger is `aa_tournament_table_launch_proof_lock`. Its launch helper takes the existing launch receipt NOWAIT and then the parent with a blocking lock. The candidate `a0_tournament_clock_membership_gate` therefore sorts before it and obtains the per-event gate, publication row, existing launch receipt, and parent before returning into that old helper. All earlier row acquisitions are NOWAIT. PostgreSQL has already locked the child during UPDATE or DELETE; the candidate cannot wait for an earlier boundary while holding that child.

A per-event transaction advisory gate is acquired even when the publication row is absent or inactive. It is also acquired by a parent clock write before consulting activation. The candidate uses an audit-only hash namespace; the production namespace still needs allocation and a catalog preflight. Any future trigger inserted before the gate must fail a migration preflight unless its behavior is reviewed. Trigger position alone does not prove that later functions have no other wait edges.

The candidate proof reports 16 passing cases and seven observed lock waits, recorded in `docs/audits/2026-09-10-k01-clock-boundary-evidence.json`. Disabling the candidate member gate first reproduces the defect: a transaction reopens a closed table with stale blinds while another transaction activates the clock without seeing that uncommitted membership. The reopened table commits stale after activation. With the absent/inactive gate, activation waits for the member transaction and then includes its newly open table.

The proof also exercises launch-receipt, parent-first capacity, and child-first close inversions; whole-transaction rollback of predecessor writes; legacy anchor writes on either side of activation; exact operation replay versus current state; and a last-table failure rolling back the parent, all table writes, activation, and operation receipt. Its wallet and entry rows are explicit transaction sentinels, not actual paid-entry or accounting verification.

Existing production evidence guards reject physical deletion, tournament reassignment, cash-to-tournament reassignment, tournament-to-cash reassignment, and terminal reopen. The candidate preserves those refusals. It examines both OLD and NEW event IDs before an existing guard can refuse the mutation, but does not introduce any newly permitted membership transition.

The complete G/B/T settlement and atomic-table wait graph, actual paid capacity RPC rollback, exact lease expiry after waits, immutable publication/receipt ACLs, and concurrent maintenance composition remain required. Passing this design proof does not close K01.

## Concrete Pause Credit Boundary Still To Implement

Fresh production catalog inspection confirms that `engine_maintenance_thaw_targets` has exactly four columns: `freeze_started_at`, `step`, `target_id`, and `credited_seconds`. It has no clock epoch, captured level, or original level anchor. A target UUID is therefore insufficient evidence to attribute an old credit to a later clock level.

The five-argument thaw authority takes its initial elapsed seconds from the database clock after admission. It later sets `frozen_seconds` to `release_target_at - freeze_started_at`, advances exact targets by only the remaining suffix, and may extend that future release target in another generation. It clears the live break row before the future target; the certified thaw ledger keeps admission frozen until that target. A clock guard must use the existing complete persistent freeze predicate, including that future tail, rather than merely checking whether the break row exists.

The maintenance credit interval is consequently `[freeze_started_at, freeze_started_at + credited_seconds)`, provided a reviewed prospective clock-epoch binding proves that this exact `level_started_at` target belongs to the epoch. The epoch must remain stable through pauses, local resume credits, maintenance credits, and manager lease replacement; a genuine next level creates a new epoch. Publication revision alone is not an epoch because a thaw changes that revision.

A local pause owner records its immutable identity and actual interval independently of other owners. For a given epoch, let `L` be the union of that epoch's local pause-owner intervals, and `M` the union of its exact maintenance level-credit intervals. The total eligible local anchor credit is the duration of `L` outside `M`. A resume can apply only the difference between that total and the local credit already recorded for the same epoch. Overlap between synchronized and add-on owners is counted once. No caller-supplied remaining time may enter the calculation.

The current snapshot deliberately excludes `on_break` tournaments from maintenance level targets. Thus a synchronized pause with no such target receives its full eligible local credit. Add-on pauses do not necessarily set `on_break`, so their actual overlap with maintenance level credit must be subtracted. Absence of a target must be proved from the completed snapshot under the same maintenance boundary, rather than guessed while snapshotting is in flight.

The remaining implementation must attach the epoch at the actual snapshot/credit ownership boundary, cover both the broad checkpoint and incremental suffix, and preserve add-on planned versus already-started pauses when maintenance shifts the offer deadline. Adoption of a tournament with an existing pause needs a deterministic original owner and start, including a restart after a deadline elapsed. The manager's local pause boolean is insufficient for this reconstruction. Required cases include future release-target rebasing, two freezes in one level, add-on plus synchronized overlap, retry after partial credit, and a delayed old maintenance invocation after local resume. No atomic clock activation or migration is included until these facts are represented and verified with actual helper execution.

## Epoch And Pause Execution Proof

`scripts/dev/probe-clock-boundary-pg17.py --pause-epochs` now loads the exact captured snapshot, broad checkpoint, incremental credit, and reconnect helper definitions into disposable PG17. Their body hashes are checked before behavior cases run. The extra tables provide the columns those helpers reference and contain no production records. The five-argument ownership and release authority is captured for review but is not installed or executed in this fixture.

The candidate extension records an exact epoch when a level target is snapshotted. Both broad and suffix test wrappers verify that the target's binding still matches the current epoch before invoking the actual helper. It treats each completed maintenance window as immutable: the same endpoint resolves its prior outcome, while a delayed request to extend that closed window refuses. These wrappers use explicit test timestamps and transaction witnesses, so they are not production APIs or an authorization design.

The 17 cases include actual snapshot exclusion of synchronized pauses; broad and incrementally extended maintenance credits; two maintenance windows during one epoch; overlapping local owners; exact local-resume replay after another owner received later credit; old-epoch refusal; preserving an already durable pause through first activation; and an injected broad-helper failure that rolls back its snapshot, target binding, clock write, and thaw receipt. Concurrent exact and conflicting close retries reach observed advisory lock waits and reread the owner afterward.

Evidence is `docs/audits/2026-09-10-k01-clock-pause-epoch-evidence.json`. The pause interval formula passes these cases, but the wrapper marks finalization explicitly. This does not prove the real four-second checkpoint interruption, certified future admission tail, outer maintenance ownership, SQL function grants, all table and settlement triggers, or manager lifecycle composition.

The next production design must make epoch binding a private, durable extension of the actual maintenance snapshot and both credit writers. A delayed operation can only resolve a closed window's original receipt; it cannot extend that window after local resume. Any replay response must distinguish that original receipt from current clock state. Existing durable synchronized and add-on pause facts must be imported under the activation barrier before the manager is admitted. Cases that cannot supply a trustworthy owner/start cannot manufacture a new anchor or reset from caller remaining time. The full production-composition review and native tests are still prerequisites to creating an activation migration.
