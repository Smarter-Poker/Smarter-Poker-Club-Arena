# Horse decision binding to accepted hands

The live Horse path now joins a captured betting decision and its actual controller execution to the permanent hand UUID and the action's position in the accepted transaction. This is a private, bounded memory component of the decision journal. It is not durable storage, complete capture, restart replay or a GTO verdict.

## The two histories are different

`ServerTableEngineTurns.scheduleHorseAction` captures the current unfiltered `currentHandActions` prefix. The permanent history includes blinds, antes, dead posts and returns which are absent from `HandController.actionHistory`. Using the controller's list length would point at a different action in the committed hand. The new context stores a version, count and SHA256 digest of the accepted-log prefix, with no private cards. Actor, seat, action, chips, street, controller timestamp, raise discriminator and dead-money flag enter that digest. Missing or malformed history stays unavailable.

The existing turn fence supplies the table UUID, hand number, seat, verified database lease generation and turn generation. All must agree with the original snapshot. Unverified leases and legacy fixtures cannot create canonical evidence. The full decision key validates the new audit context. Strategy sampling excludes it, preserving the same strategy seed for the same original poker inputs.

## Actual producer and consumer

The worker client creates execution witness v4 only after matching its returned request/fence. It retains the original accepted-log anchor. The scheduled executor copies the actual controller record's actor, timestamp and raise discriminator alongside action, amount, seat and street. These fields survive a later callback failure or a coerced wager.

`logHandHistory` already calls `observeCompletedHand` after its authoritative transaction accepts the hand. Its existing Horse observation carries the permanent UUID, lease fence and full action list. No settlement or financial producer code was changed. The client now consumes that observation through `HorseCommittedDecisionTracker` and compares the exact prefix, original executor record, Horse policy origin, public node and producer-bound observation identity. A matched coerced wager keeps its coerced execution status.

Exact replay does not duplicate outcome counters. Conflicting committed IDs or competing executed decisions for one accepted action remain terminal contradictions. Missing source, wrong actor/time/amount/raise flag, wrong lease or hand, absent lineage, pending/fallback execution and incomplete prefixes do not receive a bound receipt. Private UUIDs, actor identities and history digests remain out of public counters and table state. Only the finite `phase15_hand_binding_*` outcome family is counted.

The tracker retains at most 8,192 witnesses, expires them after one hour on a monotonic clock, and indexes by table/hand/lease. Capacity and expiry explicitly close still-pending bindings as unavailable. These limits can exclude decisions during heavy workloads or long hands; this component does not claim complete coverage. It performs no I/O and does not await the worker's observation acknowledgement.

## Verification and limits

The verification covers invalid leases, wrong hand/actor/action/prefix/lineage, duplicate and conflicting observations, duplicate executed decisions, multiple action ordinals, capacity/expiry, late settlement and diagnostic sampling invariance. Three actual scheduled HandController fixtures include real ante/blind events through the engine's existing event handler; the resulting accepted-history ordinal and exact executed call all bind. A real client FIFO fixture binds its returned, settled witness when the existing accepted observation arrives. The actual worker rejects changed audit context carrying the old key and retains the same sampling stream when valid context is added.

On local macOS arm64, a synthetic 128-action prefix measured capture p99 0.0713ms and reconciliation p99 0.0879ms. Tracking at the 8,192-entry capacity measured p99 0.0051ms across 3,000 samples. These are component measurements, not Phase 8 or fleet qualification. Exact logs, source hashes, full-suite results and the local commit are retained in the owning task's checkpoint.

The durable private decision/execution journal, complete runtime pack and work/clock capture, full restart replay, missing-decision reconciliation and fallback/discard lineage are still required. A successful binding cannot establish source completeness, learning authority or poker strength. Publication and natural execution of this source remain separate gates. The committed-over10BB audit remains GTO-unverified.
