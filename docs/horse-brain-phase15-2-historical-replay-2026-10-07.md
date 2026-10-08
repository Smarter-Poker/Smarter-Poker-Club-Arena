# Horse Brain Phase 15 Step 4: Exact Historical Replay (2026-10-07)

Plan: [Phases 6 to 15 completion plan](horse-brain-phases6-15-completion-plan-2026-09-17.md), section "Phase 15 / P15-A", implementation step 4: "Add exact historical replay using the original source/artifact, read frame, decision input, RNG/sampling/governor budgets, prior plan state and optional-state ownership. Compare decision and effects before joining actual acceptance. Isolate it from live financial/action paths; missing inputs mean non-replayable, not permission to substitute current globals."

This builds on the [Phase 6C exact-input replay](horse-brain-phase6c-replay-protocol-2026-09-26.md) and does not duplicate it. Phase 6C replays the original inputs on whatever code runs it and reports both SHAs. The exact replay replays a record only on the exact source that made it, from the record alone, in a new process, with the clock frozen and the worker-owned state restored from the record, and it compares the whole decision and its plan effects before it looks at acceptance.

Deterministic replay is not strength. An exact replay proves that the published decision path repeats itself on its exact original inputs; it says nothing about whether the action was good, and it activates nothing.

## 1. Inputs And Where Each Is Recorded

| Input                                                                                                                                                                   | Recorded in the decision record                                                             | Before this change                                                              |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Original source                                                                                                                                                         | `sourceRelease` on the record envelope (bound by the record digest)                         | present                                                                         |
| Artifacts (chart store, open-node store, V31 dataset, external policy artifact)                                                                                         | `readiness.solverStoreIdentity`, `readiness.solverStores`, `readiness.solverPolicyArtifact` | present                                                                         |
| Decision input (actor, persona, profile, public history, field, tournament context)                                                                                     | `snapshot` (the FAST request), bound by `snapshot.decisionKey`                              | present                                                                         |
| Read frame and prior plan state of the hand (opponent stats, pair reads, plans, raise plans, outlooks, plan context)                                                    | `readFrame` (v2/v3 carries `planContext`), `planContext`, `planBinding`                     | present                                                                         |
| RNG                                                                                                                                                                     | seed derived from the decision key by the runtime; `rngBefore`, `rngAfter`                  | present                                                                         |
| Sampling and governor budget                                                                                                                                            | `governorScale` (the scale the Monte Carlo used, fixed in Phase 6C 11.4)                    | present                                                                         |
| Decision clock                                                                                                                                                          | `snapshot.decisionTimeMs`                                                                   | present                                                                         |
| Optional-state ownership: the optional policy owners the worker admitted (Phase 8 postflop, Phase 10 PLO4, Phase 11 Omaha, Phase 12 remaining variants, Phase 13 joint) | `replayState.admission`                                                                     | **missing**: read from the worker's authority state and wall clock at admission |
| The worker's Phase 8 safety sentinel, read by HorseLogic directly (it gates Phase 8 continuation capture)                                                               | `replayState.phase8SafetyDisabledReason`                                                    | **missing**: a process global that changes over the worker's lifetime           |
| Decision and effects produced                                                                                                                                           | `decision`, `effects`                                                                       | present                                                                         |

`replayState` (`server/src/engine/horseDecision/replayState.ts`, version `horse-decision-replay-state-v1`) is captured by its owner, `HorseDecisionWorkerRuntime.executeFast`, after the five admissions and before the decision, from the same values the decision reads. The record grows; the decision does not change. Records journaled before the release that carries it stay `non_replayable:replay_state`.

## 2. How A Record Is Replayed

`server/scripts/phase15-exact-replay.mjs` replays each record in its own child process: a new Node process with no module state from any other record and an environment holding only `PATH`, `HOME`, `TMPDIR`, `LANG`, `TZ=UTC` and a database address that resolves to nothing. The child refuses and counts every outbound network connection (`fetch` and TCP sockets) and reports the count. It loads the store snapshots through the production store modules and refuses any file whose computed identity differs from the identity it declares. The batch mode runs only from a clean checkout and takes the running source from `git rev-parse HEAD`; `--node` names the Node executable the children run on.

Inside the child, `server/src/engine/horseDecision/replay/exactReplay.ts`:

1. validates the record digest and refuses, by name, a record that names no source (`source_release`) or a source other than the one running (`original_source`);
2. rebuilds every input from the record alone through the Phase 6C reconstruction (digest and decision-key bound), requires `replayState` (v2), `effects` and `planBinding`, and refuses a record made on another JavaScript runtime as `original_runtime` (a v1 state, which names none, as `runtime_identity`);
3. checks every artifact the decision could have consulted by content identity (Phase 6C references; `artifact:<ref>` when this process does not hold it);
4. runs the request through the production `HorseDecisionWorkerRuntime` and `HorseLogic` with `Date.now` frozen at the recorded decision time and the monotonic clock frozen, the governor pinned to the recorded scale, the Phase 8 sentinel set to the recorded value, the opponent reads and prior plans decoded from the recorded frame into a HorseMind sandbox with observation off, no journal and no plan application;
5. refuses as `admission:<owner>` when the runtime admits an optional owner differently from the record (authority this process cannot hold is a missing input, never a default);
6. compares, in this order: `rng_before`, `governor_scale`, `decision` (the whole receipt with wall-clock fields and shadow-mode receipts removed, as in Phase 6C, the action and amount first), `rng_after`, `effects`, `plan_binding`;
7. only then joins acceptance.

Outcomes:

- `replayed_exact`: every compared field is equal. Only this sets `replayVerified: true`.
- `replayed_mismatch`: the replay ran on the exact source and inputs; `firstDifference` names the first unequal field path.
- `non_replayable:<input>`: the named input is missing or not available to this process. Nothing is substituted. `non_replayable:wall_clock_budget` is used only when the original receipt shows a wall-clock work budget bound a non-shadow owner and the replay, with its clock frozen, differs: how much work fitted is not recorded. `non_replayable:retained_fast_read_view` names a `DECIDE_DEEP` second look, which the runtime accepts only against the FAST read view it retained in memory.

## 3. Acceptance Join

After the comparison, the replay joins two kinds of acceptance evidence the journal holds for the same turn (same journal `turnKey`):

- the `execution` witness (same decision key): its execution status, whether its selected action equals the decision, the executed action and the number of accepted actions. A missing witness is `not_joined:execution_record_absent`, never an acceptance;
- the durable accepted-effect receipt of P15-A steps 1 to 3 (`plan_receipt`, `HorsePlanEffectReceipt.ts`, merged in #6445 after this replay first merged; the replay joins it from #6442's follow-up on). `durableEffectReceipt` is `applied` or `failed` only for a valid receipt whose issued batch digest equals the digest of the decision's own recorded binding and effects (which an exact replay reproduces); otherwise `no_effects` (an empty batch, no receipt due), `absent`, `invalid`, `other_batch` or `no_receipt_source`. A receipt never makes a replay exact, and an absent receipt is never an application.

Releases before the follow-up report `durableEffectReceipt: unavailable`.

## 4. Defect Found And Fixed: The Replay Re-Encoded The Read Frame From Its Own Mind

The runtime encodes the read frame after the decision from `HorseMind.snapshotDecisionReads`, outside the decision callback. In a replay that read the replay process's own HorseMind, not the sandbox the replay decided in. Tournament receipts carry the frame digest (`tournamentUtility.readFrameSha256`), so in a fresh process every tournament decision differed there. The runtime now takes the view to encode from an injectable dependency (`snapshotDecisionReads`; absent, the worker's own HorseMind, so live behaviour is unchanged), and the replay passes the sandbox. `exactReplay.test.ts` "replays a tournament original exactly in a fresh process whose own mind holds nothing" fails without the fix with `decision.tournamentUtility.readFrameSha256`. The runtime replay also now restores the Phase 8 sentinel after every replay, so one replayed decision can no longer change the sentinel a later replay in the same process reads.

## 5. Pre-Merge Diagnostic (Not Replay Evidence)

Before merge, 1,109 natural decision records made by the serving release `6b1af5c5fb11b158c3c8871b93360df566ad7a49` (read-only copy of the newest 400 archive segments of each shard, 2026-10-07 about 21:25Z) were replayed in process on this branch, whose decision code equals `6b1af5c5` apart from this change, with a `replayState` injected (unselected authority, so each owner `shadow` unless the request turns it off). The records carry store identities equal to the 2026-09-27 snapshots.

| Injected Phase 8 sentinel                                              | replayed_exact | replayed_mismatch                                                                          | non_replayable:retained_fast_read_view |
| ---------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------ | -------------------------------------- |
| null, before the frame fix                                             | 436            | 648 (`tournamentUtility.readFrameSha256` 563, `tournamentUtility.evidence.inputSha256` 85) | 25                                     |
| null, after the frame fix                                              | 999            | 85 (`tournamentUtility.evidence.inputSha256`, tournament nlh postflop)                     | 25                                     |
| `eligible_but_silent` or `repeated_budget_breach`, after the frame fix | 1084           | 0                                                                                          | 25                                     |

The 85 tournament postflop decisions reproduce only when the sentinel the worker held is restored: the serving workers' sentinel had disabled Phase 8 continuation capture, a process global the record did not carry. That is the input `replayState` now records. Because the state was injected, none of these rows counts as `replayVerified`; the evidence is section 6.

## 6. Natural Production Replay

All batches below replay natural decision records read-only from the engine host's private archive (`/var/lib/club-arena/horse-decisions/archive*/segments`, the newest 1,500 segments of each shard copied with `tar` over the read-only SSH route) to the private evidence scratch. Only these aggregates are in the repository. Each record is replayed in its own fresh child process from a detached clean checkout of the exact release that made it, with the chart and open-node store snapshots whose content identity equals the identity every record journals (`2c8a2d9f448e` charts, `dff78313b437` open-node). No record was written anywhere and no child attempted an outbound connection.

### 6.1 Release `71ab03dfe3c6`, first minutes after activation

Release `71ab03dfe3c668b235e150cdb99806591171e3ef` (contains #6442; engine `/health` `releaseSha` read 22:55:55Z) activated at the 22:55Z maintenance cutover. Copy taken 23:02:53Z to 23:03:02Z: 2,590 decision, 2,592 execution and 194 plan receipt records, all by `71ab03df`. Every FAST record carries `replayState`; on all 2,489 of them the admission was `shadow` for all five optional owners and the Phase 8 sentinel was `null` (fresh workers).

Predeclared batch A: the newest 600 decision records at or after 23:02:15Z and before 23:02:45Z (they span 23:02:36.273Z to 23:02:44.996Z).

| Outcome                                                      | Count |
| ------------------------------------------------------------ | ----- |
| `replayed_exact`                                             | 575   |
| `replayed_mismatch`                                          | 0     |
| `non_replayable:retained_fast_read_view` (DEEP second looks) | 25    |

`replayVerified` is true for exactly the 575. 38 of them issued a nonempty plan batch (33 with one effect, 5 with three) and reproduced it exactly. Acceptance join (execution witness): 572 `intended` and 25 `not_executed`, every one with the selected action equal to the decision; 3 had no execution record in the copy yet. The 71ab03df replayer predates the receipt join and reports `durableEffectReceipt: unavailable`. 600 fresh processes, 0 child failures, 0 outbound connection attempts.

### 6.2 Release `71ab03dfe3c6`, sentinel tripped

By 23:16Z every serving worker's Phase 8 sentinel read `eligible_but_silent` (all 2,902 FAST records in the second copy, 23:15:53Z to 23:16:50Z, taken at 23:16:43Z: 3,010 decision, 3,025 execution, 242 plan receipt records).

Predeclared batch B: the newest 600 decision records at or after 23:16:00Z and before 23:16:35Z.

| Outcome                                  | Count |
| ---------------------------------------- | ----- |
| `replayed_exact`                         | 585   |
| `replayed_mismatch`                      | 0     |
| `non_replayable:retained_fast_read_view` | 15    |

37 of the 585 issued a nonempty batch and reproduced it. Acceptance join: 579 `intended`, 15 `not_executed`, all with selected equal to the decision; 6 without an execution record yet. 600 fresh processes, 0 child failures, 0 outbound connection attempts.

Negative control on batch B's own records: the recorded sentinel replaced by `null` and the record re-signed, replayed in process on the same source: 544 `replayed_exact` and 41 `replayed_mismatch`, every mismatch a tournament hold'em postflop decision (mtt flop 19, turn 12, river 4; hu_sng flop, turn and river 2 each) at `decision.tournamentUtility.evidence.inputSha256`. The captured sentinel is load-bearing, and replaying with the current process's value instead of the recorded one would be wrong.

### 6.3 Release `30ef59adc08a`, receipt join, and a defect: the runtime was not part of the identity

Release `30ef59adc08a67d0bf1dae0bacc1e63b287b197e` (contains #6455, the durable receipt join; `/health` `releaseSha` read 23:56:36Z) activated at the 23:55Z cutover. Copy taken 00:02:06Z (October 8): 2,954 decision, 2,949 execution and 214 plan receipt records, all by `30ef59ad`; all 2,862 FAST records with the sentinel `null` (fresh workers).

Predeclared batch C: the newest 600 decision records at or after 00:01:16Z and before 00:01:58Z.

| Outcome                                                                          | Durable receipt                                      | Count |
| -------------------------------------------------------------------------------- | ---------------------------------------------------- | ----- |
| `replayed_exact`                                                                 | `no_effects`                                         | 536   |
| `replayed_exact`                                                                 | `applied` (37 one-effect and 8 three-effect batches) | 45    |
| `replayed_exact`                                                                 | `absent` (one-effect batch, no receipt in the copy)  | 1     |
| `replayed_mismatch` at `decision.tournamentUtility.candidates[1].winProbability` | `no_effects`                                         | 1     |
| `non_replayable:retained_fast_read_view`                                         | `absent` (reported `no_effects` from this change on) | 17    |

Every `applied` receipt bound exactly the batch the replay reproduced; none was `failed`, `invalid` or `other_batch`. Execution witnesses: 577 `intended`, 17 `not_executed`, all with selected equal to the decision; 6 not yet in the copy. 600 fresh processes, 0 child failures, 0 outbound connection attempts.

**Defect found.** The one mismatch is an mtt hold'em preflop fold: same action, same RNG state after, and every receipt field equal except `winProbability` of seven of its nine candidates, which differ in the last bit (`0.04843749999999999` recorded, `0.048437499999999994` replayed). Replayed four times in one process it gives the same replayed bits every time, so the replay is deterministic. Replayed under the engine's own runtime (Node `v22.23.2`, V8 `12.4.254.21-node.56`, `x64`; the official Node release run through Rosetta, with the x64 esbuild for the TypeScript loader) it reproduces the recorded bits exactly. The replays above ran on Node `v26.3.0`, V8 `14.6.202.34-node.20`, `arm64`. The JavaScript runtime is part of the artifact that computed the decision: Math library results can differ in the last bit between V8 versions and between architectures, and the receipt carries floating-point values. Nothing recorded it, and nothing refused a different one.

**Fixed in this change.** `replayState` v2 adds `runtime` (`process.version`, `process.versions.v8`, `process.arch`), captured by the worker beside each FAST decision. The exact replay refuses a record made on another runtime as `non_replayable:original_runtime`, and a v1 state, which names none, as `non_replayable:runtime_identity`; the script runs its children on `--node <executable>`. Records journaled by `71ab03df` and `30ef59ad` therefore stay non-replayable. Batches A, B and C are kept as what they were: output equality on a different runtime, measured with the replayer of those releases. They are not `replayVerified` evidence under the corrected identity.

## 7. Gate Status (G1 To G10)

| Gate               | Status                     | Basis                                                                                                                                                                                                                                                                               |
| ------------------ | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1 Domain          | historical only            | Batches A to C (sections 6.1 to 6.3) covered 62 and 57 observed (format, variant, street) cells, every one with exact replays and every DEEP second look named; they ran on a runtime other than the engine's. Recorded again on matching-runtime records after this change serves. |
| G2 Inputs          | implemented but unverified | The runtime identity was a missing input (6.3, defective at `71ab03df` and `30ef59ad`); captured from this change on. Every other input rebuilt from the record alone and bound by its digests, and `replayState` v1 was present on every sampled FAST record.                      |
| G3 Calculation     | historical only            | The whole receipt reproduced field for field in batches A to C apart from the one runtime-dependent last bit; the negative control shows a contrasting recorded input changes the computed evidence.                                                                                |
| G4 Authority       | implemented but unverified | Source, store and optional-owner identity verified in batches A to C; the runtime identity check is new in this change.                                                                                                                                                             |
| G5 Actual use      | verified now               | The production worker runtime and HorseLogic of the exact release replayed natural records that release produced, each in its own process (batches A to C).                                                                                                                         |
| G6 Outcomes        | verified now               | Every record ended with a finite outcome; execution witnesses and durable receipts joined, with `not_joined` and `absent` kept visible (6.1 to 6.3).                                                                                                                                |
| G7 Correctness     | verified now               | `exactReplay.test.ts` pins exactness in a fresh process, named perturbations, every missing input, source, runtime, admission and artifact refusal, the receipt join and live-path isolation; the read-frame defect test fails without its fix.                                     |
| G8 Work and replay | implemented but unverified | Frozen clock, recorded seed and governor, fresh process per record; matching-runtime replay of natural records follows after this change serves.                                                                                                                                    |
| G9 Promotion       | not applicable with reason | The replay learns nothing and selects nothing; every optional owner stays `shadow` with selection `null`.                                                                                                                                                                           |
| G10 Publication    | implemented but unverified | #6442 (`4ad5b676`, served by `71ab03df`) and #6455 (`30ef59ad`, served from 23:55Z) are published; this change is not yet.                                                                                                                                                          |

## 8. Remaining Limits

- `DECIDE_DEEP` second looks stay `non_replayable:retained_fast_read_view`: the runtime accepts one only against the FAST read view it retained in memory, and the replay does not fabricate that retention.
- Records journaled before `71ab03df` carry no `replayState` (`non_replayable:replay_state`); records by `71ab03df` and `30ef59ad` carry v1 without a runtime (`non_replayable:runtime_identity`). Nothing is backfilled.
- The batches are short natural windows: they show the published path replays exactly where it was observed, not a full population.
- `non_replayable:wall_clock_budget` exists for an original whose non-shadow receipt shows a wall-clock budget bound; no sampled record reached it.
- The journal reader (`services/horseDecisionJournal/review.ts`, owned by P15-A steps 1 to 3) still reports `replayVerified: false` for every hand; the per-record `replayVerified` lives in the private replay verdicts, not in reader state.
