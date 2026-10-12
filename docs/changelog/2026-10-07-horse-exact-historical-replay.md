# A journaled Horse decision replays exactly in a fresh process on the source that made it

## What was missing

Phase 15 step 4 asks for exact historical replay: the original source and artifacts, read frame, decision input, RNG and budgets, prior plan state and optional-state ownership, compared before acceptance, isolated from live paths. The Phase 6C replay rebuilt most inputs, but ran on any source, in a shared process, with a live clock, and two worker-owned values the decision reads were never journaled: which optional policy owners the worker admitted, and the worker's Phase 8 safety sentinel. Measured on 1,109 natural decisions of the serving release, 85 tournament postflop decisions could not be reproduced without the sentinel.

## What changed

- `server/src/engine/horseDecision/replayState.ts` and `workerRuntime.ts`: every FAST decision record now carries `replayState` (the five admitted owner modes and the Phase 8 sentinel), captured from the values the decision reads. Capture only; the decision is unchanged.
- `server/src/engine/horseDecision/replay/exactReplay.ts`: replays one record on the exact running source with the clock frozen and the recorded state restored, compares RNG, governor, the whole decision, effects and plan binding in a fixed order, then joins the journal's execution witness. Outcomes are `replayed_exact`, `replayed_mismatch` with the first differing field, or `non_replayable:<input>`.
- `server/scripts/phase15-exact-replay.mjs`: one fresh child process per record, scrubbed environment, outbound connections refused and counted, store snapshots verified by identity, aggregate-only evidence.
- Defect fixed: a replay re-encoded the read frame from its own process's HorseMind instead of the sandbox it decided in, so every tournament receipt's frame digest differed. The runtime now takes that view from an injectable dependency; live behaviour is unchanged.

Protocol and evidence: `docs/horse-brain-phase15-2-historical-replay-2026-10-07.md`.

## Tests

`server/src/engine/horseDecision/replay/exactReplay.test.ts` (originals made by the production runtime from natural requests): exact in a fresh process (cash and tournament), a different running source refused, single perturbed inputs named (`rng_after`, `plan_binding.generation`, governor scale), every missing input named, admission authority refused, an artifact the process lacks refused, and live paths untouched (no plan application, no network, mind, clocks and sentinel restored).
