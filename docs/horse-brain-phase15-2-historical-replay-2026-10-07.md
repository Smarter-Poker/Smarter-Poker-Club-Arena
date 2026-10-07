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

`server/scripts/phase15-exact-replay.mjs` replays each record in its own child process: a new Node process with no module state from any other record and an environment holding only `PATH`, `HOME`, `TMPDIR`, `LANG`, `TZ=UTC` and a database address that resolves to nothing. The child refuses and counts every outbound network connection (`fetch` and TCP sockets) and reports the count. It loads the store snapshots through the production store modules and refuses any file whose computed identity differs from the identity it declares. The batch mode runs only from a clean checkout and takes the running source from `git rev-parse HEAD`.

Inside the child, `server/src/engine/horseDecision/replay/exactReplay.ts`:

1. validates the record digest and refuses, by name, a record that names no source (`source_release`) or a source other than the one running (`original_source`);
2. rebuilds every input from the record alone through the Phase 6C reconstruction (digest and decision-key bound), and requires `replayState`, `effects` and `planBinding`;
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

The durable accepted-effect receipt of P15-A steps 1 to 3 is built by a sibling lane and is not on `main` as this is written. Until it lands, the replay joins the acceptance evidence the journal already holds: the `execution` record of the same turn (same journal `turnKey`, same decision key), reporting its execution status, whether its selected action equals the decision, the executed action and the number of accepted actions. Every verdict says `durableEffectReceipt: unavailable`. A missing execution record is `not_joined:execution_record_absent`, never an acceptance.

## 4. Defect Found And Fixed: The Replay Re-Encoded The Read Frame From Its Own Mind

The runtime encodes the read frame after the decision from `HorseMind.snapshotDecisionReads`, outside the decision callback. In a replay that read the replay process's own HorseMind, not the sandbox the replay decided in. Tournament receipts carry the frame digest (`tournamentUtility.readFrameSha256`), so in a fresh process every tournament decision differed there. The runtime now takes the view to encode from an injectable dependency (`snapshotDecisionReads`; absent, the worker's own HorseMind, so live behaviour is unchanged), and the replay passes the sandbox. `exactReplay.test.ts` "replays a tournament original exactly in a fresh process whose own mind holds nothing" fails without the fix with `decision.tournamentUtility.readFrameSha256`. The runtime replay also now restores the Phase 8 sentinel after every replay, so one replayed decision can no longer change the sentinel a later replay in the same process reads.

## 5. Pre-Merge Diagnostic (Not Replay Evidence)

Before merge, 1,109 natural decision records made by the serving release `6b1af5c5fb11b158c3c8871b93360df566ad7a49` (read-only copy of the newest 400 archive segments of each shard, 2026-10-07 about 16:24Z) were replayed in process on this branch, whose decision code equals `6b1af5c5` apart from this change, with a `replayState` injected (unselected authority, so each owner `shadow` unless the request turns it off). The records carry store identities equal to the 2026-09-27 snapshots.

| Injected Phase 8 sentinel                                              | replayed_exact | replayed_mismatch                                                                          | non_replayable:retained_fast_read_view |
| ---------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------ | -------------------------------------- |
| null, before the frame fix                                             | 436            | 648 (`tournamentUtility.readFrameSha256` 563, `tournamentUtility.evidence.inputSha256` 85) | 25                                     |
| null, after the frame fix                                              | 999            | 85 (`tournamentUtility.evidence.inputSha256`, tournament nlh postflop)                     | 25                                     |
| `eligible_but_silent` or `repeated_budget_breach`, after the frame fix | 1084           | 0                                                                                          | 25                                     |

The 85 tournament postflop decisions reproduce only when the sentinel the worker held is restored: the serving workers' sentinel had disabled Phase 8 continuation capture, a process global the record did not carry. That is the input `replayState` now records. Because the state was injected, none of these rows counts as `replayVerified`; the evidence is section 6.

## 6. Natural Production Replay

Recorded after the release containing this change serves and journals natural decisions.
