# Horse Brain Phase 15.1: Durable Accepted Effects, Implementation Record (2026-10-07)

Scope: Phase 15 / P15-A steps 1 to 3 (durable accepted-effect receipt,
durable commit boundary and fresh-process recovery, journal wiring), built to
`docs/horse-brain-phase15-1-durable-effects-contract-2026-10-07.md`. Step 4
(exact historical replay) is the sibling P15-REPLAY lane. Nothing here
activates a strategy: every candidate selection stays `null`, and no wager,
money, retention or tournament rule changed.

## Deliveries

| PR    | Content                                                                                                                                                                                                                         | Merge        |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| #6437 | Contract (caller map, receipt, acknowledgement semantics, boundary, recovery, regressions)                                                                                                                                      | `23848a2ed4` |
| #6445 | Receipt module, accepted-wager commit, worker receipt at the first terminal transition, `plan_receipt` journal kind, durable-on-exact-ACK count, `recoverPlanReceipts`, contract amendment (`issuedAction`, coerced acceptance) | `d48eeeadb4` |
| #6452 | Reader: `reviewHorsePlanEffects` / `readHorsePlanEffects` and `horseJournalReview --plan-effects`                                                                                                                               | `a4dbbed177` |

## What Is Now True

- An accepted horse plan batch produces exactly one `horse-plan-receipt-v1`
  receipt at its first terminal transition (`applied` or `failed`), carrying
  the original issued batch digest, the batch binding (actor, seat, table and
  hand namespace, generation, fence), the effects, the issued action, the
  controller-accepted wager and its FAST witness, the policy generation, the
  source release and the worker epoch.
- The receipt is written through the private journal as `plan_receipt` under
  the original decision's hand and turn keys. It is counted durable
  (`phase15_plan_receipt_durable`) only on the journal writer's exact fsynced
  ACK; enqueue never counts.
- The worker COMMIT ACK still means volatile application in one worker epoch.
  Live application, the 128-entry bound, terminal-only reclamation,
  duplicate and conflict refusals, partial-application refusal, late-ACK
  no-replay and the dispatch-barrier ordering are unchanged.
- Recovery (`reconstructHorsePlanEffects`, `recoverPlanReceipts`) materializes
  only by keyed replacement into the same live hand, street and lease with
  usable policy, and refuses everything else by name. A fresh process has no
  live hand of an earlier lease (in-flight hands are abandoned by
  `checkCrashRecovery`; the maintenance break drains hands before a deploy),
  so its reconstruction of the previous process's receipts is the empty
  materialization, by contract and by test.
- The reader classifies issued, accepted, durable, applied, failed and
  unknown per retained hand; `applicationVerified` is true only from binding
  receipts and `replayVerified` stays `false`.

## Publication And Natural Proof

- Engine `71ab03dfe3` (contains #6445) went live in the 22:55 UTC break on
  2026-10-07: `/health` `releaseSha` `71ab03dfe3c668b235e150cdb99806591171e3ef`;
  engine release run `37697966313` succeeded through "Prove The Exact Engine
  Has Every Production Door", "Publish Through Hetzner Club Arena" and
  "Dispatch Exact Cross-Artifact Production Certification". Its
  `Post-Deploy E2E` run (`37699351969`) was cancelled by the workflow's
  concurrency when a newer client publish started; that is recorded, not
  claimed as a pass.
- Engine `30ef59adc0` (contains #6445 and #6452) went live in the 23:55 UTC
  break: `/health` `releaseSha` `30ef59adc08a67d0bf1dae0bacc1e63b287b197e`.
  That deploy is the natural restart observed below.

### Counts Over The Whole `71ab03dfe3` Process (22:55 To 23:55 UTC)

From `horse_brain_telemetry` (read-only), last flushes 23:54:32 (worker) and
23:54:54 (main thread), after the break drained every hand:

| Class        | Source                                                                            | Count  |
| ------------ | --------------------------------------------------------------------------------- | ------ |
| issued       | `phase15_plan_issue_issued` delta                                                 | 13,661 |
| accepted     | `phase15_plan_commit_posted`                                                      | 13,659 |
| durable      | `phase15_plan_receipt_durable` (exact fsynced ACK)                                | 13,659 |
| applied      | `phase15_plan_receipt_applied` (and `phase15_plan_applied_volatile` delta 13,659) | 13,659 |
| failed       | `phase15_plan_receipt_failed`, `phase15_plan_apply_failed`                        | 0      |
| unknown      | accepted minus durable                                                            | 0      |
| not accepted | `phase15_plan_retirement_retired` delta                                           | 2      |

`phase15_plan_receipt_unavailable` did not fire. Issued 13,661 equals
accepted 13,659 plus 2 retired: every accepted batch of that process had a
durable receipt before it shut down.

### Across The Natural Restart

After the 23:55 restart, the new process's reader
(`readHorsePlanEffects`, read-only, inside the engine container) classified
80 Horse cash hands dealt by the previous process between 23:00 and 23:55
(60 sampled across the hour plus the last 20 before the break), whose keys
were derived from `cash_hand_participant_manifests`:

| Measure                                                   | Result                            |
| --------------------------------------------------------- | --------------------------------- |
| hands with retained records                               | 80 of 80                          |
| issued / accepted / durable / applied                     | 68 / 68 / 68 / 68                 |
| failed / unknown                                          | 0 / 0                             |
| hands with issued batches and `applicationVerified: true` | 36 of 36                          |
| ledger gaps                                               | none                              |
| existing turn join (`reconcileHorseJournalHand`)          | 80 reconciled, no `turn_conflict` |

The receipts written by the previous process were read back from the
durable archive by the next one; nothing was cleared. By contract the
reconstruction of live plan state from them is empty (each hand ended in the
drain and the new process holds a new lease); the durable record is what
survives and it reconciles exactly.

## G1 To G10

| Gate               | Status                     | Evidence                                                                                                                                                                                                               |
| ------------------ | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1 Domain          | not applicable with reason | The boundary has no strategy domain: every variant and format reaches it through the one engine commit gate (and the Lightning commit).                                                                                |
| G2 Inputs          | verified now               | The receipt binds the original FAST binding, issued digest, issued action, accepted wager and witness; natural reads bind 68 of 68 receipts to their retained decisions and executions.                                |
| G3 Calculation     | not applicable with reason | No calculation or distribution changes.                                                                                                                                                                                |
| G4 Authority       | implemented but unverified | Candidate authority generations are recorded and withdrawal refuses recovery (tests); no candidate is selected in production, so the recorded list is empty.                                                           |
| G5 Actual use      | verified now               | Turns / Lightning to client to worker to journal to reader, observed in production (13,659 durable receipts, reader 68 of 68 applied).                                                                                 |
| G6 Outcomes        | verified now               | issued 13,661 = accepted 13,659 + 2 retired; durable = applied = 13,659; failed 0; unknown 0.                                                                                                                          |
| G7 Correctness     | verified now               | New receipt, worker (real HorseMind), client, journal and reader regressions; existing plan, controller and equivalence suites unchanged; pre-push 648 server files and protected CI green.                            |
| G8 Work and replay | verified now               | Restart behaviour at the actual worker boundary: the natural 23:55 restart kept every receipt readable and reconciled, and live application work is unchanged. Exact historical replay is the P15-REPLAY lane (#6442). |
| G9 Promotion       | not applicable with reason | No strategy promotion; every selection stays `null`.                                                                                                                                                                   |
| G10 Publication    | verified now               | #6437 `23848a2ed4`, #6445 `d48eeeadb4`, #6452 `a4dbbed177`; served by `71ab03dfe3` then `30ef59adc0`; natural coverage above is a scoped sample, not a full population.                                                |

## Defects Found

- `LightningHandHost.ts` commits plan effects for the wager as shaped for its
  controller without the engine's exact accepted-wager gate. Live behaviour
  is left unchanged (outside this lane); the receipt records the coerced
  acceptance beside `issuedAction`, and recovery refuses it as
  `acceptance_mismatch`.

## Limits

- Live in-hand plan materialization from receipts after a restart is not
  applicable with reason: a fresh process never resumes an in-flight hand
  and holds a new lease, so `recoverPlanReceipts` is not called at boot. If
  in-flight hand resume is ever built, it must call it with that hand's
  receipts.
- A journal paused at a quota or failed yields no durable receipt; the batch
  is then `unknown`, never authority. It did not occur in the window.
- Telemetry counts are per process and day; the per-hand reader sample (80
  hands) is not a full population.
- `Post-Deploy E2E` for `71ab03dfe3` was cancelled by concurrency, not
  passed.

## Lightning Exact Acceptance (2026-10-07)

Closes the defect recorded above under Defects Found. Delivery: #6459
(`a29a591da2`), branch
`agent/claude-horse-brain/p15-lightning-exact-acceptance-20261007`.

### What Is Now True

- The exact accepted-wager check has one owner,
  `horsePlanWagerAcceptedExactly` in `server/src/engine/HorsePlanEffectReceipt.ts`.
  `ServerTableEngineTurns` and `LightningHandHost` both call it. A witnessed
  decision needs exactly one intended controller record whose action and
  amount equal the submission, the issued decision and the FAST witness's
  selection.
- `LightningHandHost.executeHorseDecision` observes the controller's accepted
  record through its action door, commits a plan batch only on an exact match
  (inside the lane dispatch barrier, as Turns does) and then settles the
  execution witness. A non-exact action posts no commit; the client's witness
  finalizer retires the batch (`RETIRE_DECISION_EFFECTS`, worker disposition
  `retired`), the physical engine's own path, and no durable receipt is
  written for it.
- Turn ownership matches Turns: an answer for a turn that moved on is retired
  `response_fence`, a turn cancelled before acting `turn_abandoned`. Before
  this change Lightning never settled a witness, so an issued batch it did
  not commit was never retired.
- Chips, pots and actions are unchanged: the executed action is still
  `shapeLightningHorseAction` plus the action door. Only whether the horse's
  plan state takes the decision's effects changed.

### Reshape Cases

| Case                                                 | Lightning before                   | Physical engine          | Lightning now     |
| ---------------------------------------------------- | ---------------------------------- | ------------------------ | ----------------- |
| Bet/raise alias                                      | commit                             | retire                   | retire            |
| Size under the minimum, lifted                       | commit                             | retire                   | retire            |
| Fixed-limit size snapped to the street size          | commit                             | retire                   | retire            |
| Sized whole-stack wager promoted to all-in           | no commit, never retired           | retire                   | retire            |
| Capped fixed-limit street, raise substituted by call | no commit, never retired           | retire                   | retire            |
| All-in-or-fold menu substitution                     | no commit, never retired           | retire                   | retire            |
| Controller refusal and check/fold degradation        | no commit, never retired           | retire (fallback)        | retire (fallback) |
| Table commitment cap                                 | not applicable: Lightning has none | clamp, retire if changed | not applicable    |
| Exact accepted bet or raise                          | commit                             | commit                   | commit            |

### Tests

- `server/src/lightning/LightningHorsePlanExactAcceptance.test.ts` (11, new):
  real host, HandController and execution witness. 8 of the 11 fail on the
  previous host; the 3 money comparisons pass on both, as they must.
- `server/src/testing/horseRegression/plan/client-controller.test.ts` (+3):
  actual client and worker runtime with the Lightning shaper. Exact writes one
  `applied` receipt whose `issuedAction` equals `acceptance`; lifted and
  aliased wagers are retired by the worker, with no commit and no receipt.
- Targeted run 26 files, 908 tests; pre-push full server suite 569 files,
  10,417 tests; protected CI green on every required check (TypeScript Check, Client Unit Tests, Money trigger
  declaration authority, Server Engine and accounting shards); the non-required
  `Installed and merged migrations agree` failed on an unrecorded production
  migration (`20261006154000`) that is unrelated to this change.

### Publication And Natural Observation

Engine `/health` `releaseSha` is `a29a591da2efa8acb1a67cbb93f5e67af11cfc1f`
from the 01:55 UTC maintenance window (status `ok` from 01:56 UTC). Bounded
read-only observation, 01:55 to 02:07 UTC:

- Lightning: `lightning_hand` has 0 rows (all time and since the release),
  `lightning_instance` 0, `lightning_pool_session` 0. The two Lightning
  counters this change adds, `lightning_phase15_plan_accepted_exact` and
  `lightning_phase15_plan_retired_inexact`, have 0 fires. No Lightning horse
  decision exists to observe.
- Lightning decisions also carry a four-part fence, so the worker derives no
  plan hand identity for them and issues no batch (`no_effects`). The
  defective path was latent in production; it is closed before Lightning
  plays a hand.
- Physical engine, through the shared predicate, telemetry deltas for the new
  process (01:57:54 to 02:06:50 UTC reads; worker counters flushed 02:06:22,
  client counters 02:06:46): `phase15_plan_issue_issued` +1,663,
  `phase15_plan_commit_posted` +1,748, `phase15_plan_applied_volatile` +1,639,
  `phase15_plan_receipt_durable` +1,638, `phase15_execution_coerced` +2,
  `phase15_plan_retirement_retired` +0. Exact wagers keep committing and
  every applied batch has its durable receipt (one still in flight at the
  read); issued and posted are read 24 s apart from different flushes.

| Item                                   | Status                     | Evidence                                                                                                                              |
| -------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Exact gate and retirement in Lightning | implemented but unverified | Served by `a29a591da2` since 01:55 UTC and pinned by the tests above; no natural Lightning horse decision has occurred to observe it. |
| Same disposition and receipt as Turns  | verified now               | Actual client and worker composition tests above.                                                                                     |
| No money or action change              | verified now               | Identical action records and contributions with and without a plan (tests); the gate runs after the action is accepted.               |
| Natural Lightning horse decisions      | unavailable external input | 0 Lightning hands, instances or pool sessions in production; 0 fires of either Lightning counter.                                     |
