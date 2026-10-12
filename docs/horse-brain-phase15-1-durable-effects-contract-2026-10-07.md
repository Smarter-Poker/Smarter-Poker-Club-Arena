# Horse Brain Phase 15.1: Durable Accepted-Effect Contract (2026-10-07)

Scope: Phase 15 / P15-A implementation steps 1 to 3 of
`docs/horse-brain-phases6-15-completion-plan-2026-09-17.md` (durable
accepted-effect identity and receipt, durable commit boundary and recovery,
journal wiring). Step 4 (exact historical replay) belongs to the sibling
P15-REPLAY lane and is not specified here. This document is the design that
the implementation PRs follow; it activates nothing. Every candidate selection
stays `null` and no strategy, wager, money or tournament rule changes.

Source revision read: `origin/main` at `761aeb8bbf`. Line references below are
to that revision.

## Current Caller Map

| Step               | Owner                                      | Exact location                                                                                                                          | What it does today                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------ | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Capture            | `HorseMind.ts`                             | 259-280 (`HorseMindDecisionEffect`), 1030-1042 (`captureDecisionEffects`)                                                               | `notePlan` (1569), `noteOutlook` (1594) and `noteRaisePlan` (1646) push into the capture sink instead of writing while a FAST decision is computed.                                                                                                                                                                                                                                                   |
| Issue              | `horseDecision/workerRuntime.ts`           | 1884-2052 (`executeFast`)                                                                                                               | Captures effects, keeps them only when `horseReferenceWagerWasRetained` (`HorseDecisionEffects.ts` 11-27) holds and `horseDecisionEffectsMatchRequest` (`HorseDecisionEffects.ts` 99-122) binds them to actor, hand key and street; journals the decision (2011-2027); then `issuePlanBatch` (452-489) reserves the batch under key `[generation, fence]` before `FAST_RESULT` is posted (2016-2049). |
| Issue state        | `horseDecision/workerRuntime.ts`           | 435-450                                                                                                                                 | `issuedPlanBatches`: `issued / ambiguous / applied / failed / retired / no_effects`, bound 128 (`MAX_ISSUED_PLAN_BATCHES`), terminal TTL 60 s; only terminal entries are reclaimed (457-479).                                                                                                                                                                                                         |
| Identity           | `HorsePlanHandIdentity.ts`                 | 8-35 (dispositions, refusals), 38-89 (plan context, `plan-hand-v1:<table>:<hand>` key at 75-78), 93-190 (`horse-plan-batch-v1` binding) | Canonical original FAST binding: fast request id, generation, fence, decision key, actor, seat, street, plan context.                                                                                                                                                                                                                                                                                 |
| Ownership          | `horseDecision/client.ts`                  | 437-444 (`planOwners`), 1265-1270 (FAST result validation), 1468-1497 (owner and witness finalizer)                                     | The delivered FAST object owns an `available / committing / retired` record; the witness finalizer retires it.                                                                                                                                                                                                                                                                                        |
| Accept             | `ServerTableEngineTurns.ts`                | 4103-4172                                                                                                                               | Inside `worker.runWithDispatchBarrier` (4127), `HandController.performAction` records acceptance through `acceptanceObserver` (4093-4095). The commit is posted only for the exact intended bet/raise that equals the execution witness selection (4137-4152).                                                                                                                                        |
| Accept (Lightning) | `lightning/LightningHandHost.ts`           | 1335-1352                                                                                                                               | After a successful shaped `bet` / `raise` of an issued nonempty batch, commits through the lane (`horseDecision/lane.ts` 382-386).                                                                                                                                                                                                                                                                    |
| Apply              | `horseDecision/client.ts`                  | 657-756 (`commitDecisionEffects`)                                                                                                       | Rechecks Phase 8 / 10 / 11 / 12 / 13 authority for an applied candidate (withdrawn: retire, 669-734), then posts `COMMIT_DECISION_EFFECTS` with the detached binding and effects. A lost ACK retires as `commit_unconfirmed` (750-755).                                                                                                                                                               |
| Apply              | `horseDecision/workerRuntime.ts`           | 2230-2279 (`executeEffectCommit`)                                                                                                       | Refuses absent / mismatched / ambiguous / failed / retired / no-effects batches; applies the detached issued effects through `HorseMind.applyDecisionEffects` (`HorseMind.ts` 1044-1069); a throw marks the batch `failed` (partial application is never ACKed as success).                                                                                                                           |
| Retire             | `horseDecision/client.ts`                  | 758-785; `horseDecision/workerRuntime.ts` 2297-2327                                                                                     | `RETIRE_DECISION_EFFECTS` ends ownership; an applied batch stays applied.                                                                                                                                                                                                                                                                                                                             |
| Shutdown           | `horseDecision/workerRuntime.ts`           | 2427-2437                                                                                                                               | `issuedPlanBatches.clear()`.                                                                                                                                                                                                                                                                                                                                                                          |
| Journal            | `services/HorseDecisionJournal.ts`         | 356-359, 731-769 (`record`), 868-911 (exact ACK), 1258-1285                                                                             | Decision, execution, lifecycle, accepted-hand and discard records. Enqueue is not durability; the writer's exact fsynced ACK retires a record.                                                                                                                                                                                                                                                        |
| Journal record     | `services/horseDecisionJournal/record.ts`  | 4-10, 95-131                                                                                                                            | Six kinds; envelope digest and canonical JSON validation.                                                                                                                                                                                                                                                                                                                                             |
| Journal store      | `services/horseDecisionJournal/store.ts`   | 103 and 670 (`synchronous=EXTRA`, `fullfsync`), 143-150 and 904-921 (`BEGIN IMMEDIATE` batch); `worker.ts` 51-65                        | The writer thread commits a batch of at most 16 records in one SQLite transaction and only then posts `ACK` with per-record receipts.                                                                                                                                                                                                                                                                 |
| Journal effects    | `services/horseDecisionJournal/effects.ts` | 17-40                                                                                                                                   | Qualifies retained FAST effects as speculative intent; `applicationVerified: false`.                                                                                                                                                                                                                                                                                                                  |
| Journal reader     | `services/horseDecisionJournal/review.ts`  | 81-125, 313-367                                                                                                                         | Joins decisions, executions, lifecycle and accepted hands; `replayVerified: false`. Every kind other than the five named ones is routed as an execution (365).                                                                                                                                                                                                                                        |

## Facts That Decide The Boundary

1. **Worker loss is process exit.** `client.ts` 1539-1577: failure is terminal,
   never constructs a replacement worker, and calls `onFatal`, which
   `GameServer.ts` 3820-3823 rethrows so the process shuts down. "Worker loss"
   and "shutdown" are both a fresh process.
2. **A fresh process never resumes an in-flight hand.**
   `ServerTableEngineBase.ts` 10607-10676 (`checkCrashRecovery`) marks the
   active snapshot complete and deals a fresh hand; players keep last-known
   stacks. `resumeRetainedHandSubmission` (10614) only finishes the commit of a
   hand that already ended. Deploys happen in the maintenance break with no hand
   in flight.
3. **Plan state is hand-scoped and lease-scoped.** Effects are keyed by
   `plan-hand-v1:<table>:<handNumber>` and read only on later streets of the same
   hand. The fence (`table:hand:seat:lease:turn`) carries the lease generation
   (`HorseMindHandIdentity.ts` 54-76); a fresh process acquires a new lease.
4. **Acceptance is not a database transaction.** The controller accepts the
   wager in memory (`ServerTableEngineTurns.ts` 4103-4126). Money is committed
   later by the hand-completion transaction. There is no per-action durable
   acceptance transaction to extend, and the plan forbids reopening or retrying
   a wager for an effect acknowledgement. Accounting is therefore not consulted
   and no wager path changes.
5. **The private journal store is a real durable transaction.** SQLite with
   `synchronous=EXTRA` and `fullfsync=ON`, one `BEGIN IMMEDIATE` per batch, ACK
   only after commit, exact identity-checked receipts in the publisher.
6. **Volume.** `horse_brain_telemetry` for 2026-10-06: 326,037
   `phase15_plan_issue_issued`, 325,966 `phase15_plan_applied_volatile`, 71
   `phase15_plan_retirement_retired`, 627,051 `phase15_plan_accepted_no_effects`,
   19,181,514 journal records. One receipt per applied batch is about 1.7% more
   journal records.

## Decision: What An Acknowledgement Means

- **The worker COMMIT ACK (`applied_volatile` / `already_applied_volatile`)
  means materialized application in the current worker epoch's volatile
  HorseMind.** Unchanged. It is never durable and never names a receipt.
- **The durable receipt means durable accepted intent, with the application
  outcome observed in the same synchronous worker step.** The worker creates it
  at the moment it materializes (or fails to materialize) the exact issued batch
  for an exact accepted wager. It is durable only when the journal writer's
  fsynced commit ACK names that record; the publisher then counts
  `phase15_plan_receipt_durable`. Publisher enqueue is neither intent nor
  application, and a decision or execution record is never a receipt.
- **Materialized plan state is derived only from durable accepted intent**, by
  deterministic keyed replacement (below). An `applied` disposition inside a
  receipt is an observation of the volatile step, never by itself permission
  to materialize.

Rejected alternatives:

- _Durable-before-apply outbox._ The dispatch barrier orders the commit before
  the next decision of the same horse (`client.ts` 584-598). Gating application
  on an fsync would let that next decision overtake it, which changes live play.
  By facts 1 to 3 it would also buy no recoverable state.
- _A Supabase receipt table._ No per-action acceptance transaction exists to
  join (fact 4); a new write per accepted wager adds database load and touches
  the money path. Excluded.

## Durable Accepted-Effect Identity And Receipt

Own module `server/src/engine/HorsePlanEffectReceipt.ts`, importable by the
replay lane. Version `horse-plan-receipt-v1`. Fields:

| Field               | Source                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `issuedBatchDigest` | SHA-256 over `['horse-plan-issued-batch-v1', horsePlanBatchBindingKey(binding), horseDecisionEffectsKey(effects)]`, computed by the worker at issue. The original issued batch, not a caller copy.                                                                                                                                                                                                                                                                                                                                                                                                |
| `binding`           | The original `horse-plan-batch-v1` binding: actor, seat, generation, fence, decision key, fast request id, street, plan context (table / hand namespace).                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `effects`           | The detached issued effects (at most 16).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `issuedAction`      | The issued decision's final action and amount, captured by the worker at issue (never from a caller).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `acceptance`        | `horse-plan-acceptance-v1`: the controller-accepted `action` (`bet` / `raise`) and `amount`, plus the execution witness identity (`requestId`, `decisionKey`) bound to the original FAST, or `null` when no witness exists. Recorded as observed: the engine gate (`ServerTableEngineTurns.ts` 4137-4152) makes it equal `issuedAction`; `LightningHandHost.ts` (1335-1352) commits the wager as shaped for its controller without that exact gate, a pre-existing difference outside this lane whose live behaviour is left unchanged. A differing acceptance is never materialized by recovery. |
| `policy`            | Policy graph version and every applied candidate authority (`phase8` / `phase10` / `phase11` / `phase12` / `phase13`: epoch, generation) at issue. Empty while every selection is `null`.                                                                                                                                                                                                                                                                                                                                                                                                         |
| `source`            | Release SHA of the running engine (`resolveReleaseIdentity`), or `null`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `workerEpoch`       | A random UUID per worker runtime: a new process is a new epoch.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `disposition`       | `applied` or `failed` (the first terminal transition only; a duplicate COMMIT writes no second receipt).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

The batch identity is `[generation, fence]`. Two receipts for one identity
with different digests, acceptance or disposition are a conflict.

## Where The Durable Boundary Lives And Why

The receipt is a new private journal record kind, `plan_receipt`, written by
the same worker publisher as the original decision record, with the same
producer, anchored hand key and turn key, so the reader joins it exactly. The
writer's existing fsynced batch transaction is the commit boundary and the
publisher's exact ACK is the durable acknowledgement. No new store, thread,
timer or cron. When the journal is disabled, paused at a quota or failed, no
durable receipt exists and every affected batch is classified `unknown`;
absence, corruption or a forged record never grants strategy authority, since
recovery materializes only into a live hand of the same lease (below).

## Recovery Algorithm

`reconstructHorsePlanEffects(receipts, live)` is pure and deterministic:

1. Validate every receipt (shape, digest recomputed from binding and effects,
   effects bound to the binding's actor, hand key and street, acceptance
   bound to the binding). Invalid: `invalid`.
2. Group by `[generation, fence]`. Identical duplicates collapse; differing
   receipts are all `conflict`.
3. `failed`: `failed_not_replayed`. A partial application stays failed or
   unknown and is never retried as success. An acceptance that differs from
   `issuedAction`: `acceptance_mismatch`.
4. Against the live context supplied by the caller (table, hand number, lease,
   street, turn generation of the hand currently in play, if any):
   no live hand for the table: `hand_not_live`; different table:
   `table_mismatch`; newer hand: `hand_superseded`; different lease:
   `lease_superseded`; street advanced: `street_superseded`; live turn
   generation older than the receipt: `generation_expired`.
5. Any recorded candidate authority not currently usable: `policy_withdrawn`.
6. Otherwise `replaced`: effects are applied in ascending turn generation
   through `HorseMind.applyDecisionEffects`, which is keyed replacement
   (`plans`, `outlooks`, `raisePlans` set by key), so reapplication is
   idempotent.

`HorseDecisionWorkerRuntime.recoverPlanReceipts(receipts, live)` runs that
reconstruction, applies the `replaced` effects, and seeds the batch as
`applied` so a late duplicate COMMIT answers `already_applied_volatile` and a
conflicting one is refused. It never writes a second receipt.

Production consequence, stated plainly: by facts 1 to 3 a fresh process has no
live hand of any earlier lease, so the reconstruction of the previous process's
receipts is the empty materialization. The engine therefore does not scan the
archive at boot (synchronous archive IO on the decision thread for a known
empty result). The previous process's pending state is not cleared silently:
the reader reconstructs its ledger and classifies every issued batch. Should
in-flight hand resume ever be built, it must call `recoverPlanReceipts` with
that hand's durable receipts, and the lease gate still applies.

## Journal Wiring And Reader

The reader counts each nonempty FAST batch in a retained hand: `issued`
(every such batch); `accepted` (its execution witness holds exactly one
intended accepted wager equal to the decision); `durable` (a valid receipt
bound to the decision record's binding and effects and to that accepted
wager); `applied` and `failed` (the durable receipt's disposition); `unknown`
(accepted with no binding receipt once the accepted hand is retained, or a
receipt that does not bind). A batch still waiting for its accepted hand is
`accepted` only. `applicationVerified` becomes `true` only for `applied`;
`replayVerified` stays `false`. A receipt without its decision and execution,
or with a forged digest, is `unknown` and adds a gap; it is never applied.

## Bounded Retention

The worker's `issuedPlanBatches` keeps its 128-entry bound and terminal-only
reclamation. Receipts live in the existing private archive ring and its
quotas (segments, catalog bytes, compressed bytes, record count, evidence
hold). The 8-day Horse-only hand retention in the database is untouched.

## Preserved Boundary

Unchanged: exact client ownership, explicit unused-plan retirement,
terminal-only reclamation, the 128-entry bound, finite issue / refusal /
application dispositions, separate counting of `no_effects`,
`capacity_unavailable` and `reissue_unavailable`, late-ACK no-replay, an
applied batch staying applied on retirement, the detached-batch and
dispatch-barrier ordering, partial-application refusal, duplicate / conflict
handling, private archive custody and archive-aware review. The preserved
regression baseline listed in the plan is retained, not rebuilt.

## New Regressions (Exact List)

- `server/src/engine/HorsePlanEffectReceipt.test.ts` (new): digest is
  canonical and order-independent of object keys; forged digest, unbound
  effects and unbound acceptance are `invalid`; conflicting receipts;
  reconstruction refusals for old hand, table, street, lease, generation and
  policy withdrawal; failed receipts are never replaced; deterministic order;
  a fresh lease reconstructs to the empty materialization.
- `server/src/testing/horseRegression/plan/worker.test.ts` (the existing
  plan worker suite, real `HorseMind` and real worker runtime): crash before
  durable acceptance (issued, never committed: a fresh runtime has nothing to
  apply and no receipt exists); crash after durable acceptance (receipt
  written once with the exact digest, acceptance and epoch); lost durable ACK
  and fresh-process reconstruction (a new runtime recovers the receipt into the
  same live lease, and a duplicate COMMIT answers `already_applied_volatile`
  without a second receipt); conflicting receipt; partial materialization (an
  apply that throws mid-batch writes a `failed` receipt and recovery refuses
  it); old hand / table / street / lease / turn; policy withdrawal; coerced
  acceptance recorded and never reconstructed; journal-only forged
  application; no journal.
- `server/src/engine/horseDecision/client.test.ts`: the commit carries the
  exact acceptance; a missing or unbound acceptance is rejected before post.
- `server/src/services/HorseDecisionJournal.test.ts`: `plan_receipt` records
  validate; `phase15_plan_receipt_durable` counts only on the exact ACK, never
  on enqueue.
- `server/src/services/horseDecisionJournal/review.test.ts`: the six
  counts; journal-only forged application (a receipt with no execution, or
  with a forged digest) is not applied; `applicationVerified` only from a
  valid receipt.
- Unchanged live behaviour when nothing crashes: the existing
  `HorseDecisionEffectCommit.test.ts`, `HorseSchedulerCanonicalCommit.test.ts`,
  `LiveHorseDecisionWorkerWiring.guard.test.ts` and
  `testing/horseRegression/plan/*.test.ts` controller and equivalence suites
  pass with only the commit call carrying its acceptance.

## Status Vocabulary For This Slice

Until the implementation merges and is observed in production: receipt,
boundary, recovery and reader are `implemented but unverified`; durable
cross-process plan materialization is `not applicable with reason` (facts 1 to
3); exact historical replay is the sibling lane's.
