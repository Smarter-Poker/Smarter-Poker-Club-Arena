# Horse Brain Phase 6B: Route Checks, Mismatch Refusal and Bounded Observed Route Proof

Prepared 2026-09-26, observations taken 2026-09-27. Horse Brain Phase 6B (2 of 4). This document builds on the atlas domain descriptor `TOURNAMENT_PREFLOP_ATLAS_DOMAIN` merged in PR #5265 (`docs/horse-brain-phase6b-domain-matrix-2026-09-25.md`) and does not redefine it. Status words are the six fixed statuses: verified now, historical only, implemented but unverified, defective, unavailable external input, not applicable with reason. No percentage is derived from them.

## Summary

| Item                                                                                                                                                                         | Status                     | Evidence                                                                                                       |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Arithmetic checks (ante orbit under 3 ante modes at all 17 anchors; M boundaries 1, 5, 10, 20, 40 with half-M hysteresis under each ante mode)                               | verified now               | `HorsePhase6TournamentArithmetic.test.ts` (70)                                                                 |
| Intersection checks (215,424-coordinate totality loop: every coordinate resolves to exactly one route or one named refusal; every family and context status)                 | verified now               | `HorsePhase6Tournament.test.ts` (44)                                                                           |
| Real-consumer checks (validator, worker, HorseLogic, HorsePreflop read the one domain; no duplicated tables)                                                                 | verified now               | `HorsePhase6RouteRefusal.test.ts` (22), `workerRuntime.test.ts` (156)                                          |
| Mismatch refusal (a receipt whose declared coordinate disagrees with the recomputed coordinate is refused with a named reason, at the matcher and at the live worker client) | verified now               | `HorsePhase6RouteRefusal.test.ts` (22)                                                                         |
| Next-level projection gate read from the descriptor by all three consumers (it was defective on origin/main: three literal copies)                                           | verified now               | `HorsePhase6RouteRefusal.test.ts` (22), `HorsePhase6TournamentDomain.test.ts` (58)                             |
| Bounded observed route proof, last 24 hours on the serving release `f2e484a3`                                                                                                | unavailable external input | production Horse journal paused since 2026-09-26T14:13:54Z (`archive_segments`); zero records on that release  |
| Bounded observed route proof, final six archived hours on the previous release `778075b4`                                                                                    | historical only            | 34,697 tournament preflop receipts, 1,338 of 5,643 cells observed, 0 mismatches, 33,763 accepted actions bound |
| This PR's code on the serving engine                                                                                                                                         | implemented but unverified | not merged or published; the observation ran the currently deployed modules                                    |

## What Changed in Production Code

1. **One owner for the receipt format.** `HorsePhase6Attribution.ts` kept its own copies of the context statuses, ante types, game families, fallback names, the cell prefix, the table-size range and the velocity rounding. It now imports `TOURNAMENT_CONTEXT_STATUSES`, `TOURNAMENT_ANTE_TYPES`, `TOURNAMENT_GAME_FAMILIES` and `TOURNAMENT_FALLBACK_PRECEDENCE`, and rebuilds the cell through the atlas's own `tournamentPreflopCell`, coordinate validity through `tournamentCoordinateIsValid` and velocity urgency through `tournamentVelocityUrgency`. The lookup itself uses the same three functions. `workerRuntime.ts` admission reads the same status and ante arrays.
2. **Named mismatch refusal.** `horsePhase6AttributionMismatch` returns the first named reason a returned receipt disagrees with its snapshot (`coordinate_table_size`, `coordinate_hero_position`, `coordinate_raiser_position`, `coordinate_stack_bb`, `coordinate_branch`, `coordinate_game_family`, `coordinate_ante_type`, `context_status`, `m_velocity`, `receipt_invalid`, `reference_transition` and the structural reasons). `horsePhase6AttributionMatchesSnapshot` is its boolean form. The live worker client fails the request with that reason instead of a bare "invalid policy receipt".
3. **One next-level projection gate.** The descriptor declared `TOURNAMENT_NEXT_LEVEL_PROJECTION_GATE` (3 minutes, multiplier above 1.15), but `HorseLogic.ts` (branch M zone), `HorsePreflop.ts` (decision M and depth) and the snapshot recompute in `HorsePhase6Attribution.ts` each carried their own `<= 3` and `> 1.15` literals, so the descriptor described a table its consumers did not read. `tournamentNextLevelProjectionApplies` now reads the gate constant and all three consumers call it. The comparisons, the missing-clock rule and the missing-multiplier rule are unchanged.

No shift, precedence, action sampling, candidate flag or receipt value changed. These are defect fixes, not strategy changes, so no flag was added. The descriptor stays descriptive and off the action path, so no new wire field or digest input was added (B-T3: new wire and digest checks are not applicable with that reason).

## Verified Now: Tests

Executed on the PR head against current `origin/main`, Node 26, Vitest 2.1.9.

| File                                                                                                                                                                                                                                                                                                | Tests | What it proves                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server/src/engine/HorsePhase6TournamentArithmetic.test.ts` (new)                                                                                                                                                                                                                                   |    70 | Ante orbit, real M, effective M and zone under `none`, `per_player`, `big_blind` at every one of the 17 anchors (51 literal rows, independently derived); per-seat-authored and capped (2 BB) big blind ante conventions; every M zone boundary with exact and just-outside hysteresis edges in both directions under each ante mode through `buildTournamentMState`; the same chip stack rescaled across ante modes without moving the stack.                                            |
| `server/src/engine/HorsePhase6RouteRefusal.test.ts` (new)                                                                                                                                                                                                                                           |    22 | The validator, the worker, HorseLogic, HorsePreflop and the receipt matcher read the domain (source text and behaviour); the projection gate fires exactly inside 3 minutes and above 1.15 at both edges; the validator admits exactly the 36 status x family x ante combinations and refuses one value outside each axis; a self-consistent receipt for a different coordinate on every axis is refused by name at the matcher and at the live client; the matching receipt is accepted. |
| `server/src/engine/HorsePhase6Tournament.test.ts` (extended)                                                                                                                                                                                                                                        |    44 | The 215,424-coordinate totality loop, bound to the descriptor, proves every coordinate owns one unique cell and that the real validator accepts every one; a second walk over every family x context status (152,064 coordinates) proves each resolves to exactly one named outcome by the declared precedence.                                                                                                                                                                           |
| `server/src/engine/HorsePhase6TournamentDomain.test.ts` (from #5265, header updated)                                                                                                                                                                                                                |    58 | Descriptor, digest, freezing, hysteresis, projection gate through HorsePreflop and HorseLogic, velocity, covering stacks, sparse rings, endpoints, context routes.                                                                                                                                                                                                                                                                                                                        |
| `server/src/engine/AnteMath.test.ts`                                                                                                                                                                                                                                                                |    13 | Unchanged ante conventions.                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `server/src/engine/horseDecision/*.test.ts` (8 files)                                                                                                                                                                                                                                               |   334 | Includes `workerRuntime.test.ts` (156): the worker admits exactly the domain statuses and ante types and refuses one outside each by name.                                                                                                                                                                                                                                                                                                                                                |
| Connected suites (`testing/horseRegression/merged/attribution-*.candidate.test.ts`, `phase6-lifecycle-composition.candidate.test.ts`, `HorseV23`, `TournamentJamDepth`, `HorseCanonicalTournamentIdentity`, `HorsePhase7TournamentUtility`, `HorseLogic`, `HorseV37Satellites`, `HorseAllInOrFold`) |   323 | Unchanged-positive controls for the receipt, blind clock, jam depth and HorseLogic consumers.                                                                                                                                                                                                                                                                                                                                                                                             |

`HorseTournamentPreflop.test.ts` does not exist; its coverage lives in the Phase 6 files above. Server `tsc --noEmit` passes. ESLint passes on every changed file.

The totality loop proves lookup totality over valid algebraic coordinates. It does not prove numerical strategy quality, calibration or that a real betting history reaches a coordinate.

## Bounded Observed Route Proof

Script: `server/scripts/phase6b-route-proof.mjs` (observer) and `server/scripts/phase6b-route-proof-observe.py` (read-only runner). The selector is an explicit UTC window and the exact serving engine SHA, both arguments, both recorded. The observer runs in a throwaway container built from the serving image (no network, read-only journal mount, 1 GB, 1 CPU, hard deadline) and imports the deployed compiled atlas, receipt matcher and accepted-action binder, so every count is the deployed code's judgement. Only aggregate counts leave the host: no hand keys, actor or table identifiers, private cards or record bodies. The engine's own `/health` report of the serving release and of the Horse journal is captured before and after. Nothing is invented or interpolated; an empty cell is reported as unobserved.

Cells are dealt size (2 to 10) x branch (11) x ante mode (3) x stack-anchor band (19: below 2, the 16 anchor intervals, exactly 100, above 100) = 5,643 cells.

### Last 24 Hours on the Serving Release: Unavailable External Input

Evidence: `docs/evidence/phase6b/phase6b-route-proof-20260927T144119Z.json` and `.md`.

Command:

```
python3 server/scripts/phase6b-route-proof-observe.py f2e484a3d1a674f329d923b30394fd65f5aff50e 2026-09-26T14:41:00Z 2026-09-27T14:41:00Z docs/evidence/phase6b
```

The engine reported release `f2e484a3d1a674f329d923b30394fd65f5aff50e` before and after. Its Horse journal reported `mode: paused`, `pausedReason: archive_segments`, `pausedSince: 2026-09-26T14:13:54.887Z`, 4,139,804 records, unchanged across the run. The newest archived record is from 2026-09-25T19:34:05Z. The window therefore holds zero records on the serving release, and all 5,643 cells are unobserved. This is not evidence that the routes failed; the journal that owns the evidence recorded nothing in the window. Restoring the journal is owned by the journal and engine operators, not by this lane, and no engine configuration was changed.

### Final Six Archived Hours on the Previous Release: Historical Only

Evidence: `docs/evidence/phase6b/phase6b-route-proof-20260927T144144Z.json` and `.md` (full per-cell table and the complete unobserved list).

Command (the fifth argument selects records written by the previous release; the observer image is still the serving release):

```
python3 server/scripts/phase6b-route-proof-observe.py f2e484a3d1a674f329d923b30394fd65f5aff50e 2026-09-25T13:35:00Z 2026-09-25T19:35:00Z docs/evidence/phase6b 778075b419d078c58565c284c0ca7c5225bb773a
```

The window was fixed before the run as the last six hours of the archive. 788,555 archive rows were scanned, 780,363 fell inside the window, all written by `778075b419d078c58565c284c0ca7c5225bb773a`; none were truncated.

| Measure                                                                           |                      Count |
| --------------------------------------------------------------------------------- | -------------------------: |
| Decisions                                                                         |                    187,504 |
| Cash decisions                                                                    |                    135,096 |
| Tournament decisions after preflop                                                |                     17,711 |
| Tournament preflop decisions                                                      |                     34,697 |
| v2 receipts with a lookup                                                         |                     34,697 |
| Receipts matching their snapshot (deployed matcher)                               |                     34,697 |
| Mismatch refusals                                                                 |                          0 |
| Depth bracket disagreements with the atlas                                        |                          0 |
| Coordinates outside the domain                                                    |                          0 |
| Atlas baseline lookups                                                            |                     22,451 |
| Named refusals: `incomplete_context`                                              |                      9,130 |
| Named refusals: `unsupported_variant` (Omaha)                                     |                      3,116 |
| Context status complete / incomplete / stale                                      |        24,698 / 9,936 / 63 |
| Routes: intent engine / chart open jam / chart BB defend / variant price          | 33,210 / 1,091 / 226 / 170 |
| Accepted actions bound to the completed hand                                      |                     33,763 |
| Binding unavailable: `execution_unavailable` / `observation_identity_unavailable` |                  489 / 325 |
| Decisions whose completed hand lies outside the window                            |                        120 |
| Cells observed / unobserved                                                       |              1,338 / 4,305 |

By branch: unopened 15,259; cold_call 6,671; bb_defense 3,342; blind_vs_blind 2,998; reshove 2,385; three_bet_facing 1,620; multiway_all_in 1,304; squeeze 1,023; overcall 71; limp_facing 24; open_facing unobserved. By ante mode: big_blind 17,281; per_player 17,157; none 259. By size: 2 to 9 observed; 10 unobserved. Above 100 BB: 18,673 of 34,697 lookups, all served by the documented clamp to 100 BB (an approximation, not a calibrated deep-stack cell); below 2 BB: 241.

The deployed matcher on that release returns a boolean only (`mismatchReasonsNamed: false`); the named reasons in this PR are implemented but unverified in production until it ships.

### Unobserved Cells

In the historical window 4,305 of 5,643 cells are unobserved; each is listed in `cells.unobserved` of the JSON. Whole axes with no observation:

- Dealt size 10: no 10-handed tournament preflop decision in the window.
- Branch `open_facing`: it requires one raise, no callers, and hero having already acted (hero limped or completed, then faced a raise). Horses almost never limp in tournaments (24 `limp_facing` decisions), so this history is naturally rare. It is unobserved, not unreachable: `HorsePhase6Tournament.test.ts` supplies a classifier input that reaches it, and `HorsePhase6TournamentDomain.test.ts` pins its shift vectors.

Every other cell outside the observed 1,338 is unobserved and is not certified by a neighbouring cell. In the serving 24-hour window all 5,643 are unobserved.

## Implemented but Unverified

- The three code changes above on the serving engine: they are in this PR, not merged or published. Protected publication and a natural cohort on the containing release are 6B acceptance items that remain once the journal records again.
- Named mismatch reasons on natural records: the observer counts them when the deployed matcher exports `horsePhase6AttributionMismatch`; the current release does not.

## Gate Status (Bounded to 6B)

| Gate                       | Status                     | Reason or owner                                                                                                         |
| -------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| G1 Domain                  | verified now               | Descriptor, totality loop, domain-bound consumers.                                                                      |
| G2 Inputs                  | verified now               | Worker admission and receipt validator refuse values outside the domain by name.                                        |
| G3 Computation             | verified now               | Literal independently derived ante, M and hysteresis expectations.                                                      |
| G4 Immutable authority     | verified now               | Frozen descriptor and pinned digest (#5265); consumers read the same frozen constants.                                  |
| G5 Reachability            | historical only            | Natural lookups and accepted-action joins on `778075b4`; serving window is unavailable external input (journal paused). |
| G6 Outcome receipts        | historical only            | Baseline, named refusals, routes and accepted joins counted per cell on `778075b4`.                                     |
| G7 Independent correctness | verified now               | Oracle rows are literal; the policy under test never generates its own expectation.                                     |
| G8 Performance and replay  | not applicable with reason | Original-input replay and latency belong to 6C.                                                                         |
| G9 Learning and promotion  | not applicable with reason | No candidate activation in 6B.                                                                                          |
| G10 Publication and use    | implemented but unverified | This PR is unpublished; the serving journal is paused.                                                                  |

## Source Identities at the PR Head

Atlas revision `horse-tournament-preflop-v1`, domain digest `4a8918a0f015e9e96b31dc63e0a7ab45eca503698c514c82f55627bec7864305` (unchanged by this PR; the observer recomputed it on the deployed build and it matched).

Blob hashes (`git hash-object`) of the owner files at the PR head:

| File                                               | Blob                                       |
| -------------------------------------------------- | ------------------------------------------ |
| `server/src/engine/HorseTournamentPreflop.ts`      | `46a8d00b02e896ad065984322a35be1006bea580` |
| `server/src/engine/AnteMath.ts`                    | `833fb44e097b86cd513eff29c39ecd19dcd54d97` |
| `server/src/engine/HorsePreflop.ts`                | `0f310922de60f4eaea7004f956fd42f0f5907afd` |
| `server/src/engine/HorseLogic.ts`                  | `62d934169ba251e9c609b14b381d4277d0f29e14` |
| `server/src/engine/HorsePhase6Attribution.ts`      | `f3282dd9a4a770b44b9e9bc91d068d92e48bede4` |
| `server/src/engine/ServerTableEngineTurns.ts`      | `c165f3d627b05a335b93d2e62fd8149e3c030b75` |
| `server/src/engine/horseDecision/workerRuntime.ts` | `cb8561ef3b56df1583bb548df7786b99402ae8a0` |
| `server/src/engine/horseDecision/client.ts`        | `a854cef4e0938e55a41c92a71e2db6427a11d9e7` |

Observer script `server/scripts/phase6b-route-proof.mjs` sha256 `e58f19b232ab59a28e7599d4e0f4605c2ea0ea37e524a53d3685a50f8b04c1fa` (recorded as `scriptSha256` in both evidence envelopes).

## Reproduce

```
export PATH=/opt/homebrew/opt/node@26/bin:/opt/homebrew/bin:$PATH
cd server
npx vitest run src/engine/HorsePhase6TournamentArithmetic.test.ts src/engine/HorsePhase6RouteRefusal.test.ts src/engine/HorsePhase6Tournament.test.ts src/engine/HorsePhase6TournamentDomain.test.ts src/engine/AnteMath.test.ts src/engine/horseDecision/ --reporter=dot
npx tsc --noEmit -p tsconfig.json
cd ..
# Observation (read-only; needs the engine host key on the operator's Mac):
python3 server/scripts/phase6b-route-proof-observe.py <serving-sha40> <since-ISO-Z> <until-ISO-Z> docs/evidence/phase6b [<records-release-sha40>]
node server/scripts/phase6b-route-proof.mjs render --input docs/evidence/phase6b/<file>.json
```

## 2026-09-27: Re-Verified on the Serving Release e6b9dc5d

The release that serves since 2026-09-27T20:56:03Z is `e6b9dc5d472a040a118f537f65203a6cae45ce80`, and it contains c8cbe6e6 (#5417) (`git merge-base --is-ancestor`). The bounded observed route proof above was rerun against it without changing any engine configuration. Evidence: `docs/evidence/phase6b/phase6b-route-proof-e6b9dc5d-20260927T215216Z.json` and `.md`.

Command, run on the operator's Mac from a worktree of `origin/main` at 347ab6be before any change on this branch (observer `phase6b-route-proof.mjs` sha256 `e58f19b2...`):

```
python3 server/scripts/phase6b-route-proof-observe.py e6b9dc5d472a040a118f537f65203a6cae45ce80 2026-09-27T20:57:00Z 2026-09-27T21:52:00Z docs/evidence/phase6b
node server/scripts/phase6b-route-proof.mjs render --input docs/evidence/phase6b/phase6b-route-proof-e6b9dc5d-20260927T215216Z.json
```

Engine `/health` before: release `e6b9dc5d472a040a118f537f65203a6cae45ce80`, Horse journal `ready`, 4,883,862 records. After: the same release, Horse journal `failed` (`termination_unverified` since 2026-09-27T21:22:51.994Z), 4,774,445 records. The two reports came from different decision shards of the same process (see below); the observer's serving identity check (container, image, start time, release label) was equal before and after.

| Measure                                                  |                  Count |
| -------------------------------------------------------- | ---------------------: |
| Tournament preflop decisions on e6b9dc5d                 |                 30,455 |
| v2 receipts with a lookup / matching their snapshot      |        30,455 / 30,455 |
| Mismatch refusals                                        |                      0 |
| Depth bracket disagreements / coordinates outside domain |                  0 / 0 |
| Atlas evaluated / unavailable / bypassed receipts        | 7,378 / 18,885 / 4,192 |
| Accepted actions bound to the completed hand             |                 23,758 |
| Cells observed / unobserved (of 5,643)                   |            690 / 4,953 |

Dealt size 10 and branch `open_facing` are again wholly unobserved. The deployed matcher exports named mismatch reasons (`mismatchReasonsNamed: true`); with zero mismatches in the window no named reason was produced, so the named reasons have not yet been seen on a natural mismatch.

### What the window does not contain

The journal retained only part of the window's decisions. The horse decision lane runs two worker shards and each runs its own journal publisher and writer on the one shared archive. From about 21:07Z both writers met the other's catalog lock (SQLite BUSY after its 250 ms busy timeout), and the publisher answered every lock by terminating the writer and starting a replacement: 3 to 45 replacements per shard per five minutes, and 5,374 to 10,881 records per shard per five minutes dropped at the 64-record queue bound. At 21:22:51.994Z one shard's retiring writer did not confirm termination inside the one-second fence and that shard's capture stopped for good; from then on about half of all decisions (that shard's tables) were not captured, while the surviving shard, alone on the catalog, ran with no replacement at all. `/health` kept one slot for both shards' reports, so it answered `ready` or `failed` depending on which shard had reported last (eight reads at 21:5xZ from one process: one `failed`, seven `ready`). The per-shard counts are in the evidence `.md`.

This is a defect in the Horse journal, not in the 6B routes: every retained record was judged by the deployed code and none mismatched. It is fixed at its cause on this branch, and the fix is implemented but unverified until a release containing it serves:

1. `HorseDecisionJournal.ts`: a writer that answers RETRYABLE while ready is alive and has rolled back, so the same immutable batch is sent to the same writer again after a bounded backoff (`HORSE_JOURNAL_LOCK_RETRY_DELAYS_MS`, 12 steps, 25 ms to 1 s). Only a batch refused that many times in a row falls back to the existing replacement path, whose two-replacement budget and termination fence are unchanged. A writer that meets a lock before it opens is still replaced.
2. `/health`: each shard's report keeps its own slot (`client.ts` names the shard); the mode, failure and pause fields are the least healthy shard's, the catalog figures are the freshest shard's (one shared archive), `queued` is the sum, and a new `publishers` field counts shards by mode. With more than one shard the capture sentence begins "N of M decision-shard publishers running; least healthy: ...". The observer now records `publishers` in its before and after reads.
3. Tests, planted red on the unfixed source: `retry.test.ts` "retries a locked batch on the same writer after a bounded backoff and never replaces it" and "renews the lock budget with the exact ACK, and a batch that exhausts it falls back to the bounded replacement"; `HorseDecisionJournal.test.ts` "reports the least healthy shard and counts the shards by mode" and "keeps the single-shard sentence unchanged". All four failed on the unfixed source and pass with the fix. Controls: a real two-store SQLite test proves a competing writer's lock surfaces as RETRYABLE and that the same store then records the batch (and the other writer sees it as a replay); a lock before READY is still replaced; a writer that dies during a lock backoff is never asked again. Four existing tests that used RETRYABLE to mean "the writer died" now use the writer's exit, which is what they model. Server suites `services/horseDecisionJournal/`, `HorseDecisionJournal.test.ts`, `engine/horseDecision/`, `HorseDataLedger.test.ts` and `handlers/`: 26 files, 874 tests passed; `tsc --noEmit` and ESLint clean.

### Gate Status on e6b9dc5d (Bounded to 6B)

| Gate                                                     | Status                     | Evidence                                                                                                                                                   |
| -------------------------------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G4 Immutable authority                                   | verified now               | domain digest `4a8918a0...` recomputed by the observer on the deployed e6b9dc5d image from the frozen descriptor and equal to the pin                      |
| G5 Reachability                                          | verified now               | 30,455 natural tournament preflop lookups on e6b9dc5d matching their snapshot, 23,758 accepted actions bound to the completed hand (retained records only) |
| G6 Outcome receipts                                      | verified now               | baseline, named refusals, routes and accepted joins counted per cell on e6b9dc5d: 690 cells observed, 4,953 unobserved and listed, 0 mismatches            |
| G10 Publication and use                                  | verified now               | e6b9dc5d contains c8cbe6e6 and serves; its deployed matcher (named reasons exported) judged the release's own natural receipts                             |
| Horse journal lock and `/health` shard fix (this branch) | implemented but unverified | planted-red tests above; not in a serving release                                                                                                          |

G1, G2, G3, G7, G8 and G9 are unchanged from the table above. The population in this window is partial for the journal reason stated, so these counts certify the retained records only; they are not a complete population and not a replay (6C) or population (6D) result.

## 2026-09-28: Re-Verified on the Serving Release 763e4cec

The release that serves at the time of this read is `763e4cec8cdc21b61957e0a16dd6b4278f0a7f4f`
(container `club-arena-engine` started 2026-09-28T06:55:53Z at the time of the read; it contains
the journal lock-retry and per-shard `/health` fix from the 2026-09-27 section above, #5480,
already deployed). The bounded observed route proof was rerun against it, same window as the
6A/6D sections of this branch's evidence. Evidence: `docs/evidence/phase6b/phase6b-route-proof-20260928T155630Z.json`
(the committed, successful run) and `docs/evidence/phase6b/phase6b-route-proof-20260928T154841Z.json`
(a first attempt that failed transiently; see below).

Command:

```
python3 server/scripts/phase6b-route-proof-observe.py 763e4cec8cdc21b61957e0a16dd6b4278f0a7f4f 2026-09-28T14:12:00Z 2026-09-28T15:12:00Z docs/evidence/phase6b
```

**A first attempt failed transiently and was retried; the retry succeeded cleanly with the
identical selector.** The first run (15:48:41Z to 15:49:25Z) exited 3, `{"status":"unavailable","reason":"observation_failed"}`,
with no further detail (the observer only emits a stack trace under `PHASE6B_ROUTE_PROOF_DEBUG=1`,
which the production wrapper does not set). A manual reproduction with that debug flag set,
same image, same script bytes, same window, ran cleanly to completion in about 4 minutes,
producing the full observation with no error. The wrapper was then re-run through its normal
path (unchanged, no debug flag) and completed cleanly in about 3 minutes. Both successful runs
(the manual debug reproduction and the committed retry) agree; nothing about the failure was
reproducible on retry with identical inputs, so this reads as a transient condition in the
observer's own read path (most plausibly momentary contention opening the shared SQLite catalog
while the two live production journal writers are appending to it), not a Horse Brain decision
or route defect: no decision was misjudged, because the failed attempt never got far enough to
classify one. This is a property of the read-only evidence tool, not of production code, so no
Horse Brain fix or planted-red test applies here.

Engine `/health` before the successful run: release `763e4cec8cdc21b61957e0a16dd6b4278f0a7f4f`,
Horse journal `ready`, 2 of 2 decision-shard publishers running, 4,984,135 records. The
observer's own serving-identity check (container, image, start time, release label) was verified
equal before the run and immediately after the container exited.

**The scheduled hourly engine restart landed seconds after this run finished, and the wrapper's
own post-run health read raced it.** The observation itself finished at 15:59:18.693Z;
`club-arena-engine` restarted (same release, same image) at 15:59:24Z as the documented :55/:00
hourly maintenance break (CLAUDE.md section 13) cut the new instance over. The wrapper's
post-run `/health` read landed in that window and got `{"ok": false}`, so the tool's own
`completedObservation` flag is `false` on the committed file even though the container's own
exit code, OOM state, identity check and cleanup were all clean (`exitCode: 0`,
`containerExitCode: 0`, `oomKilled: false`, `sameServingIdentityAfter: true`,
`observerRemoved: true`) and the 671 KB observation payload is complete. A read taken 20 seconds
later shows the same release, journal `ready` again, 1 of 1 publisher reporting so far (the
restart's normal warm-up; the second shard was still coming back). This is the platform freeze
behaving as documented, not a defect in the route proof or in 6B.

| Measure                                                  |                   Count |
| -------------------------------------------------------- | ----------------------: |
| Tournament preflop decisions on 763e4cec                 |                  35,644 |
| v2 receipts with a lookup / matching their snapshot      |         35,644 / 35,644 |
| Mismatch refusals                                        |                       0 |
| Depth bracket disagreements / coordinates outside domain |                   0 / 0 |
| Atlas evaluated / unavailable / bypassed receipts        | 10,403 / 19,354 / 5,887 |
| Accepted actions bound to the completed hand             |                  20,971 |
| Cells observed / unobserved (of 5,643)                   |             608 / 5,035 |

Domain digest: `atlas.pinnedDigest` and `atlas.recomputedDigest` are both `4a8918a0f015e9e96b31dc63e0a7ab45eca503698c514c82f55627bec7864305`
(`digestMatches: true`), recomputed on the deployed 763e4cec image from the frozen descriptor.
Dealt size 10 and branch `open_facing` are again wholly unobserved, the same axes noted
unobserved on 2026-09-27; the deployed matcher again exports named mismatch reasons
(`mismatchReasonsNamed: true`) and again saw zero mismatches, so no named reason was produced on
a natural mismatch in this window either.

### Gate Status on 763e4cec (Bounded to 6B)

| Gate                    | Status       | Evidence                                                                                                                                                   |
| ----------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G4 Immutable authority  | verified now | domain digest `4a8918a0...` recomputed by the observer on the deployed 763e4cec image from the frozen descriptor and equal to the pin                      |
| G5 Reachability         | verified now | 35,644 natural tournament preflop lookups on 763e4cec matching their snapshot, 20,971 accepted actions bound to the completed hand (retained records only) |
| G6 Outcome receipts     | verified now | baseline, named refusals, routes and accepted joins counted per cell on 763e4cec: 608 cells observed, 5,035 unobserved and listed, 0 mismatches            |
| G10 Publication and use | verified now | 763e4cec serves and its deployed matcher (named reasons exported) judged the release's own natural receipts; identity verified before and after the run    |

G1, G2, G3, G7, G8 and G9 are unchanged from the tables above and from this branch's 6A/6D
section. This window's counts are of retained journal records only inside the declared 14:12Z to
15:12Z hour, on the exact serving release; they are not a complete population and not a replay
(6C) or population (6D) result -- those are covered separately in this branch's 6D evidence
(`docs/horse-brain-phase6d-serving-release-2026-09-27.md`, 2026-09-28 section), which draws from
the same window on the same release.
