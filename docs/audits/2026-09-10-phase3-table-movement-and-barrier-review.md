# Phase 3 Table Movement And Hand-For-Hand Review

Source baseline: `40886c94ab69fd37a47957b3ea3b23b5a0c0e375`. Production catalog observations: 2026-09-10 03:17-03:23 UTC. No production mutation was performed in this review.

| Control | Result  | Remaining Requirement                                                                                                                                                                  |
| ------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| K08     | Blocked | Install the accepted canonical move authority, then prove seat-selection, one stack transfer, and the hand boundary.                                                                   |
| K09     | Blocked | Prove table break/final-table seating against the installed authority alongside elimination and reconnect.                                                                             |
| K10     | Partial | The in-memory table barrier exists; a shared synchronized-hand epoch and versioned simultaneous-bust ranking contract are not established.                                             |
| BX11    | Partial | Existing behavior tests cover duplicate barrier edges and a late retirement. Durable closure, missing/replacement dealer generations, and delayed completion need combined acceptance. |
| BX12    | Open    | Reverse-delivery rank equivalence has not been proved against a versioned synchronized-hand rule.                                                                                      |
| BX14    | Blocked | The canonical move/receipt authority must exist before the move, blind-posting, and disconnect race can be certified.                                                                  |

## Canonical Move Dependency

`TournamentManager.executePlayerMovesOwned` reaches `requestTournamentSeatMoveAtBoundary`, then `tournamentSeatMoveRpc.ts`, which invokes `fn_move_tournament_player`; ambiguous outcomes require `fn_resolve_committed_tournament_seat_move`. Both functions were absent at 03:17 UTC. At 03:22:27 UTC, `tournament_seat_move_receipts` and `tournament_seat_exit_authority_cutover` were also absent. The installed assignment and acquisition helpers were present, with body MD5s `16a587f7567336fe4379135f22e3fb41` and `24e6b8e732c77b831c16d321b1d6fa61` respectively. Their presence does not implement immutable move receipts.

The obsolete incident functions `fn_ca_move_tournament_seat`, `fn_ca_return_stranded_to_the_felt`, and `fn_ca_restore_tournament_felt` were absent. Migration `20260909230135_tournament_capacity_has_one_runtime_door` is recorded as applied. These retired functions are not an alternate runtime solution.

The pending writer is `20260909014545_tournament_seat_exits_stay_inside_tournament_authority.sql`; receipt resolution follows in `20260909182952_a_committed_tournament_move_receipt_survives_lease_loss.sql`. The current writer is over 5,500 lines and includes historical paid-candidate, positive-orphan, zero-seat, roster, terminal, and legacy-writer cutovers. Extracting just its mover or inventing its cutover marker would bypass its acceptance conditions.

The earlier stale freeze-pin finding is superseded: PR #4066 merged as `8265a38c8e7538a6e14afb72db652b6a5ac2d84a` at 00:54:12 UTC and the current writer pins `a29498531e4b7d3889532e80fafc8d57`. The live entry-freeze function matched that MD5 at 03:18:30 UTC; its serializer matched `084ed24f99e9d08765bd86ff8b920284`. All twelve sampled legacy/wrapped prerequisite signatures existed at 03:23:28 UTC. A stale pin or a missing sampled signature is not the current blocker.

The twelve-argument accepted-hand settlement function exists with MD5 `6685f27ebb50bc05afc04b106353714c`; the former missing-function claim must not be repeated. Full cutover acceptance remains distinct from that prerequisite.

The next move release must follow `docs/audits/2026-09-09-tournament-stage-one-replay-manifest.md` from a supported current schema, validate the current historical cohorts and forward prerequisites, preserve the freeze and exact postconditions, apply the complete accepted boundary, and then execute the actual move/replay/settlement/reconnect races. This review did not establish a full current-schema rehearsal or authorize historical repairs.

## Hand-For-Hand And Rank Evidence

`TournamentManagerBase.advanceHandForHandBarrier` tests the current engine for every ID in `handForHandTableIds`, refuses any missing/unparked engine, and releases current engines once. Durable retirement removes an ID and rechecks the barrier. Recovery attempts remain members when hand-for-hand starts. The existing nine cases in `server/src/tournament/HandForHandBreakOwnership.test.ts` were previously executed by the primary audit; this lane reviewed and reused that evidence instead of rerunning unchanged tests. In particular, the duplicate-edge/late-retirement case is useful partial BX11 evidence, but it does not execute the durable table-close transaction.

The barrier stores table IDs and a delayed re-pause timer, not a synchronized-hand epoch persisted into accepted-hand/knockout records. The actual elimination sweep orders candidates by `hand_number`, then `stack_before`, then refusal streak and user UUID. That is not proof of a shared versioned cross-table hand identity. At 03:19:29 UTC, ordinary `fn_eliminate_tournament_player_atomic(uuid,uuid,integer,numeric,numeric)` had MD5 `04a2e93dd8afe35fbc0cdd2829daf0f8`; its owner-only core had MD5 `f596d731cacf8d7e62a4549204ce73fc` at 03:19:52 UTC. The wrapper authenticates accepted knockout evidence and the core records the supplied `p_position`; neither read establishes synchronized-epoch ranking.

`AGENT_SKILLS/POKER_TOURNAMENTS.md` sections 9-10 publish the seat rule: largest table to smallest, next big blind moved, no in-hand movement, balanced break distribution, final-table formation at capacity, and all tables completing before any next deal. That reference, `AGENT_SKILLS/TOURNAMENT_ARCHITECTURE.md`, and `POKER_GAMEPLAY_SPEC.md` do not specify a versioned cross-table simultaneous-bust tie policy. No new ranking policy was invented or financial position changed during this review.

No listed control is newly certified complete by this document. Phase 3 remains open, and this evidence does not start Phase 4.
