# Horse Brain Phase 6: current serving qualification, September 30, 2026

Horse Brain only. This record supersedes stale progress/status statements in the September 18 build plan and September 26 gate reconciliation; their dated evidence remains historical. It addresses the four agreed Phase 6 stages. It does not certify phases 7–15, every natural game situation, strategic strength or GTO optimality.

## Delivery and exact source

Serving engine `f92ef5798bbc968f19a33f8515a5025a62e840d5`, container started September 29 at 22:56:05.964865563 UTC, image `sha256:1e70e715f76a514c92a143a8a83ea8f6e4dcd34023bad267fe0e23cb4bd70a83`. The [sealed receiving workflow](https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/actions/runs/36637586608) succeeded. Protected ancestry includes the context, domain, replay, population and capture repairs, including #5541 (per-shard archive), #5563 (writer CPU/queue/all-shard readers), and #5588 (capture priority/observation deadline). The relevant Horse runtime and observation sources have no changes between the serving revision and the inspected current protected main `52addc2502a878012a9a6571078cbca60a12eb35`.

The existing [engine certificate](https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/actions/runs/36667498638/job/109735290423) passed at 04:23:15 UTC: four WebKit cases executed, zero skipped/failed/flaky. It exercised MTT (including natural blind-level change), Spin, SNG and cash/network-loss recovery. Fixture deletion and absence were verified. Its expected engine is the exact serving revision; subsequent public health reports the same release and continuous uptime. The final workflow provenance step checks the client separately (`c8dba952`); a separate client job failed and is not represented as passing. This successful engine job closes the original 6A gate 4 without another restart or duplicated certificate.

## Capture health

[Exact-release flush aggregates](evidence/phase6d/capture-health-2026-09-30-f92ef579.json), 08:00–11:15 UTC, cover 13 nonempty 15-minute bins and three telemetry workers. There are 1,912,722 enqueued and 1,912,712 recorded events, 18 capture-unavailable fires (0.000941%), and no queue-capacity or lock-retry fires. Eight bins exceed the prior comparable-load reference of 140,000 enqueues, with a maximum of 184,222. Capture is below the existing 0.5% line at the observed load; it is not lossless. Flush-boundary count differences are not individual-chain proof.

## Frozen population and actual use

The [declaration](evidence/phase6d/population-declaration-2026-09-30-f92ef579.json) was committed at 11:21:42 UTC (`a5a70d21457d39a54edf7b26a6c1999b38b00298`), before reading its records. Its exact byte digest is `8b5e54544cc5316db1268bd1cd41c62e8cd6ec35810375af2633a6f097cd4824`; preserve those bytes. The window is 10:00–11:00 UTC, including scheduled maintenance. Selection keeps the original 3,969 cells, target three per cell, first 400 hands per shard/hour, global 9,600-hand bound and 600-second deadline. The two physical archives are `archive` and `archive-shard-1`, corresponding to the declaration's two decision shards.

[Population](evidence/phase6d/population-2026-09-30-f92ef579.json) and [observation](evidence/phase6d/population-observation-2026-09-30-f92ef579.json): both shards walked 400 hands; no pending-custody or unreadable hands; stop reason strata exhausted. The observer used the serving image, read-only journal mount, no network, 512 MiB and 0.5 CPU. Identity was unchanged, exit was zero, no OOM occurred, and removal succeeded.

- 198 admitted preflop decisions, all on the serving release.
- 196 complete intended FAST chains: original request → computation → reference → controller-accepted action → completed hand.
- Two DEEP decisions (aggregate rows 30 and 192) explicitly retired as `not_executed/second_look_unchanged`. They have original request/computation/reference and reconciled retirement witnesses, no accepted action, and no review gaps. They are not relabeled complete accepted chains. `ServerTableEngineTurns` owns this retirement; the journal review and binder deliberately distinguish it from an execution.
- All 198 hand reviews reconcile with zero gaps. No admitted execution lacks a required captured link.
- 72 declared cells observed; 3,897 unobserved, explicitly listed. Ordinary SNG did not appear in this finite Horse population; the separate live certificate covers SNG transport, not SNG Horse strategy.
- The broad continuity scan has one sequence hole per shard: 10:48:24 UTC on shard 1 and 11:03:25 UTC in shard 0's post-window tail. Both are over 45 minutes after the admitted decisions and do not explain the two deliberate retirements. These limits remain visible; this report makes no zero-loss or universal coverage claim.

The first read returned but local report formatting could not import the missing root `prettier` dependency, so it retained no qualifying artifact. The exact locked dependencies were installed; the successful attempt repeated the same committed declaration without changing selection/window. No observer remained after either attempt. This was local evidence tooling, not a production change or a new sample chosen to pass.

## Exact same-population replay

All 198 declared decision IDs were exported, none missing; serving identity and observer removal were verified. Private original records stay outside Git on the archive SSD. The maintained offline replay used the journaled original inputs and existing snapshots whose recomputed identities match: 240 chart rows (`2c8a2d9f448e…`) and 7,747 postflop rows (`dff78313b437…`). Decision source difference from serving to replay checkout is empty; the checkout SHA differs only because it includes later protected work and this declaration.

All 196 supported decisions reproduce exactly: zero divergence, 196 independent qualifications agree, all 196 receipt digests and authority paths match. The two retired DEEP second looks remain named `replay_unsupported:DECIDE_DEEP` exclusions; they are not counted as reproduced. Previous unchanged-harness negative controls are reused, not rerun. Replay median/p95 compute are 4.79/18.74 ms on this Mac; recorded original compute is 9.75/42.28 ms. Different machines/workloads mean this is not a speedup claim.

## First-five blueprint reconciliation

The ten common gates are evaluated for each agreed Phase 6 stage; a stage does not become solver-certified merely by meeting the engineering gates. Source-specific prior test evidence is retained in the build/domain/route/replay records, including independent arithmetic, named mismatch refusals, original-input negative controls and capture regressions. [All 16 applicable protected merges are contained in the serving release](evidence/phase6d/source-release-proof-2026-09-30.json); the compared implementation files are unchanged, so those passing tests were not needlessly repeated.

| Gate                           | Phase 6 evidence                                                                                                                                                                                                         |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| G1 Declared domain             | 6B domain descriptor and independent boundary matrix; 6D 3,969-cell declaration with observed/unobserved cells named.                                                                                                    |
| G2 Original inputs             | Immutable cache publication, original request/read frame and actual dealt-hand projection; all 198 request links present.                                                                                                |
| G3 Calculations                | Existing independent arithmetic/consumer checks; all 198 calculation links present; 196 same-input independent replay qualifications agree.                                                                              |
| G4 Immutable authority         | Source/domain/store identities retained, frozen declaration committed before observation and unchanged afterward.                                                                                                        |
| G5 Reachability                | 196 intended decisions reach all five actual-use links; two second looks have explicit terminal retirement; wider 6B route evidence pending.                                                                             |
| G6 Truthful outcomes           | Every admitted review reconciles; executed and retired outcomes remain distinct; wider 6B route evidence pending.                                                                                                        |
| G7 Independent correctness     | Source-bound arithmetic, cache/blind, mismatch, replay and capture regressions retained; independent replay agrees on every supported admitted decision.                                                                 |
| G8 Bounded work and replay     | 800-hand declared observation, original-input replay with measured latency/work and two named DEEP exclusions; all observer resource/cleanup gates pass.                                                                 |
| G9 Learning/promotion          | Not applicable with reason: Phase 6 introduces no learned candidate or live promotion. Existing authority is unchanged.                                                                                                  |
| G10 Publication and actual use | Protected containing engine is serving, sealed receiver succeeded, four-case engine certificate passed, and fresh natural accepted-use evidence is retained. This documentation's protected publication remains pending. |

## Remaining closure step

The bounded whole-window 6B route proof is running against the same release and exact window. Until it is read back, reconciled and this evidence is protected-merged, overall Phase 6 delivery remains pending. No new engine rollout is needed for this evidence-only change.
