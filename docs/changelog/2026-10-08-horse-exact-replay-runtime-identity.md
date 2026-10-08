# A Horse decision replays only on the JavaScript runtime that computed it

## What was wrong

The exact historical replay (P15-A step 4) matched a record to the exact source and artifacts that made it, but not to the JavaScript runtime. On natural records of release `30ef59ad`, one mtt preflop decision replayed with seven `winProbability` values one bit away from the recorded ones. Under the engine's own runtime (Node v22.23.2, V8 12.4, x64) it reproduces exactly; the replay had run on Node v26.3.0, V8 14.6, arm64. Math library results can differ in the last bit between V8 versions and architectures, and the receipt carries floating-point values. Nothing recorded the runtime and nothing refused a different one.

## What changed

- `server/src/engine/horseDecision/replayState.ts`: `replayState` v2 carries `runtime` (Node version, V8 version, architecture), captured by the worker beside each FAST decision. Capture only.
- `server/src/engine/horseDecision/replay/exactReplay.ts`: a record made on another runtime is `non_replayable:original_runtime`; a v1 state, which names no runtime, is `non_replayable:runtime_identity`. Verdicts name both runtimes. A second look reports `durableEffectReceipt: no_effects`.
- `server/scripts/phase15-exact-replay.mjs`: `--node` runs the children on a named Node executable, `--esbuild-binary` gives its TypeScript loader the matching esbuild build; the evidence names the child runtime and the recorded runtimes.

Evidence and gate status: `docs/horse-brain-phase15-2-historical-replay-2026-10-07.md` sections 6 and 7.

## Tests

`exactReplay.test.ts`: the runtime identity is journaled; a different Node/V8 version and a different architecture are each refused as `original_runtime`; a v1 state is `runtime_identity`; a second look reports `no_effects`.
