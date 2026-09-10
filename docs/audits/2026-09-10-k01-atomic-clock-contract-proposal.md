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
