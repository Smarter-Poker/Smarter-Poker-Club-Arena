# Phase 8.1 Useful-Completion Diagnostic, October 1, 2026

Horse Brain only. Machine: this development Mac (Apple M3 Ultra, 28 logical CPUs, Node v26.3.0), shared with other agents running at the same time. These are local measurements, not fleet latency. Counts only.

## Files

| File                                          | Contents                                                                                                                                                             |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `phase8-useful-completion-population.json`    | Frozen population: 182 live-worker `DECIDE_FAST` requests, sha256 `a9732fd888b0d54a8012dda6a2fccb79e81085a33c1e0677e42c5c6df3e35ad4` over the canonical request list |
| `phase8-useful-completion-cold.json`          | Cold pass, repetition 1, every decision                                                                                                                              |
| `phase8-useful-completion-warm.json`          | Warm pass, repetition 1, every decision                                                                                                                              |
| `phase8-useful-completion-repetitions.json`   | All six final-source runs, the held experiment and the retained contended runs                                                                                       |
| `phase8-useful-completion-digest-before.json` | Per-decision equivalence digest on engine source `4948e0ff` (clock frozen at 0)                                                                                      |

## Exact Commands

Run from `server/` after `npx tsc -p tsconfig.json` (the diagnostic imports only the compiled `dist/` tree):

```text
node scripts/phase8-useful-completion.mjs build --out=population.json
node scripts/phase8-useful-completion.mjs run --population=../docs/evidence/phase8/phase8-useful-completion-population.json --pass=cold --revision=4948e0ffd527adee5d898426f7abd84be0be09ab --out=<file>
node scripts/phase8-useful-completion.mjs run --population=../docs/evidence/phase8/phase8-useful-completion-population.json --pass=warm --revision=4948e0ffd527adee5d898426f7abd84be0be09ab --out=<file>
node scripts/phase8-useful-completion.mjs digest --population=../docs/evidence/phase8/phase8-useful-completion-population.json --revision=4948e0ffd527adee5d898426f7abd84be0be09ab --out=<file>
```

Each run is a fresh process. Cold runs every decision once, in population order, right after worker readiness (the fixed card preparation, 4.79 ms in cold repetition 1, runs before readiness as in production). Warm runs the whole population once unrecorded, then records the same requests again in the same process. Three cold and three warm runs were interleaved (cold, warm, cold, warm, cold, warm) at 1-minute load averages between 12.21 and 13.25.

## Population

- Phase 8 test fixture: the four captured production public lines (reviews 399521, 399839, 400340, 400615) with their explicitly reconstructed field, now read through `HorsePhase8ReplayFixture.ts`, the same reconstruction the replay suite uses.
- Maintained league fixtures: the hero's own shadow-mode postflop decisions in `runTournamentLeague`, seed 8101101, 4 pairs per objective: MTT 19, SNG 51, Spin 71, satellite 7, PKO 15, mystery 15.
- Streets: flop 75, turn 60, river 47. Local seats 2 to 9; tournament field 2 to 18. Formats: Spin 71, MTT-format 60, SNG 51.
- Live contract: every request passed the compiled worker's own canonical snapshot and Phase 6 context validation (0 worker errors of 182). Declared normalizations, applied only where the source state lacked them: neutral descriptive Phase 6 fields, `toCall` as current bet minus hero street bet with `fold` offered (the four replay states), explicit null fixed-limit fields, and `anteType` derived from the hand and next-level ante as the worker requires (league states). Equity governor fixed at scale 1, `mind: false`, decision time fixed.
- The live Phase 8 safety latch is production's and stayed live; it never tripped in the final runs.

## Final-Source Results (engine source `4948e0ff`, unchanged by this change)

| Run    | Eligible | Fired | Completed | `continuation_operation_budget` | `continuation_sample_calibration` | Final-gate refusals after firing |
| ------ | -------- | ----- | --------- | ------------------------------- | --------------------------------- | -------------------------------- |
| cold 1 | 181      | 137   | 137       | 42                              | 2                                 | 0                                |
| cold 2 | 181      | 138   | 138       | 41                              | 2                                 | 0                                |
| cold 3 | 181      | 141   | 141       | 38                              | 2                                 | 0                                |
| warm 1 | 181      | 151   | 151       | 28                              | 2                                 | 0                                |
| warm 2 | 181      | 157   | 157       | 22                              | 2                                 | 0                                |
| warm 3 | 181      | 152   | 152       | 27                              | 2                                 | 0                                |

The one ineligible decision is `phase7_choice_retained` in every run. Every eligible decision reconciles: completed plus named refusals equals 181 in each run, with no unknown reason. No fired decision failed a final gate (`budget_exhausted`, `illegal_candidate`, `conservation_error`, `blocker_jam_unproven` all 0), so on this population, on a moderately loaded host, `fired` and `completed` coincide; every non-completion is a cooperative 4 ms work stop before firing. Work stops by stage in cold 1: future rollout 26, ICM 10, sample 6; warm 1: 17, 8, 3.

Cold 1 eligible Phase 8 latency: p50 2.880 ms, p95 4.042 ms, p99 4.144 ms, max 4.153 ms; policy overhead max 0.415 ms. Warm 1: p50 2.784 ms, p95 4.014 ms, p99 4.154 ms, max 4.226 ms; policy overhead max 0.075 ms. The 5 ms wall and 2 ms policy limits held in all six runs. Completion by source in cold 1 and warm 1: Spin 69 and 69 of 71, SNG 35 and 39 of 50, MTT 7 and 15 of 19, PKO 9 and 12 of 15, mystery 12 and 11 of 15, satellite 4 and 4 of 7, replay lines 1 and 1 of 4.

## Contended Runs Retained

An earlier interleaved set ran while other agents held the host at a 1-minute load average near 48 on 28 logical CPUs. There, wall-clock overruns above 5 ms appeared as the final-gate refusal `budget_exhausted` (16 to 22 per cold process), and in three fresh processes three consecutive overruns latched `repeated_budget_breach` after 5, 27 and 41 eligible decisions, refusing Phase 8 for the rest of those processes. The summaries are retained in `phase8-useful-completion-repetitions.json`. This is the existing latency-breach gate working as specified, not a computation failure.
