# 2026-08-31 — Phase 3 of 7: depth fidelity — the 10bb fallback, the effective stack, and the counter that tells them apart

Phase 3 is coverage and hit rate, driven by the telemetry Phases 1-2
installed. The first measurement reframed the problem: when the gate passes,
the cells answer **94.4%** of the time (12,035 hits vs 710 misses today). Hit
RATE is not the leak. Hit QUALITY was — two ways nobody could see.

## 1. The fallback was the 10bb cell, for everybody

Every lookup's docstring promised "depth fallback: the neighbouring bucket".
The code built `[depth, ...DEPTH_BUCKETS].slice(0, 2)` — whose second element
is `DEPTH_BUCKETS[0] = 10` for every depth except 10 itself. A 150bb hero
whose 150 cell was missing was answered from the **10bb** cell: the
jam-happiest strategy in the warehouse, served at the one depth where jamming
is most wrong. Live since V29, in all four lookup sites (V29/V30 advice, V31
advice, and both V32 range getters, which copied the pattern).

`depthCandidates()` now serves `[snapDepthBucket(stack), log-nearest other]`.
The primary DELIBERATELY stays `snapDepthBucket` even where log-nearest
disagrees with its hand-tuned boundaries (snap(30) is 20; 40 is log-nearer):
the cells were built against the snap boundaries, and re-homing the primary
would silently move live hits. That invariant is pinned for ten depths.

## 2. The consult keyed on hero's stack; the cells are keyed on the effective

`gto_postflop_*` cells are keyed by `eff_stack_bb` — the SHORTER stack, the
money that can actually go in — but the consult passed hero's stack alone. A
100bb hero against a 25bb villain consulted the 80 cell for a pot that only
25bb can ever enter. This was Phase 1's one known deferred gap; closed at
both consults (open and V32) with `min(hero, villain-total)`.

## 3. gto_depth_fallback — degraded answers now count themselves

A neighbour-cell answer is real but second-best, and it was previously
indistinguishable from a primary hit. It now fires `gto_depth_fallback`
(parsed from the advice cell's own key, so the store return shapes are
untouched), splitting the hit rate into "right cell" and "neighbour cell".
As the aggregations fill, this counter should decay toward zero — and if it
does not, Phase 6's scheduling question has its answer.

## Verification

- tsc clean both roots; engine **1,482 tests / 129 files**, services
  **538 / 50** — no existing test had pinned the old fallback order.
- 10 new tests, including the regression pin (a 150bb spot with only a 10
  cell now stays SILENT where the old code answered with 10bb strategy) and
  an end-to-end effective-stack proof through `decide()`.
- **Four mutations, each caught**: the shipped bug restored (4 fail), the
  primary re-homed to log-nearest (2), effective stack reverted to hero-only
  (2), the fallback counter silenced (1).

## Also verified this pass

The silent `v32_*` counters that prompted a scare: the Hetzner deploy for
V32 (`48e77819`) is still PENDING at the drain gate — the running build
predates V32, so silence is the correct reading, not a wiring failure. The
counters will move when the coalesced restart lands.
