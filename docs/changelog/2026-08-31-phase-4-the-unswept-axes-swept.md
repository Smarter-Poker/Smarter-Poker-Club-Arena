# 2026-08-31 — Phase 4 of 7: the unswept axes, swept

Five axes flagged in the Phase 1 plan as never audited. The sweep's headline
is what it did NOT find: the two heavyweight bugs on these axes were already
dead — V28 killed the unreachable 'middle' bucket, V29 the heads-up SB/BB
inversion. What remained was correct behaviour pinned nowhere, one honest gap
with a measured incidence, and one latent misread with zero reachable tables.

## Axis verdicts, with evidence

**1. plo8 hi-lo scoop/quarter — HEALTHY, now pinned.** Probed through the full
decide() path on a made-low turn: a bare nut low with no high checked 40/40
(never pots itself into a quartering); a scoopy A2+top-two bet ~45%. The
mutation pass found the discipline is defended in DEPTH — it holds even with
the V8 overlay ablated — so the pin guards the outcome, not a layer.

**2. Straddle pots — single straddles handled, multi-straddles unreachable.**
v18_straddle fires ~12k/day. The recogniser reads a straddled pot only up to
`currentBet <= 2.2bb`, so a DOUBLE straddle (4bb) would be misread as an open
raise — but every straddle-enabled table on the platform is `max_straddles=1`
(measured: 3 tables, all 1x), so the gap is unreachable. Documented here
rather than coded around: a guard for a config nobody runs is a trap for the
agent who later changes it without a test.

**3. Push-fold short stacks — the chart owns the zone; the net has the right
shape.** `memory_charts_gold` carries full-range rows at 2-25bb, 1bb
granularity, all positions (240 rows; 629 open-jam fires today). The flat
~65% heuristic beneath it is reached ONLY when the chart store is empty.
Probed widths: 65% at 3bb, 60% at 12bb — flat where Nash widens toward 100%,
ACCEPTED because it is the failure net, not the strategy. Pinned three ways:
a charted 100% jam is jammed even with 72o (the chart outranks the
heuristic), an empty store folds the same hand (the net fails TIGHT, never
wide), and the fallback can never invert (3bb at least as wide as 12bb).

**4. 9-max position mapping — correct since V28, shape now contract-pinned.**
28 of the running tables are 9-max, the platform's dominant format. The
3-early / 2-middle / 2-late arithmetic is asserted standalone so a retune of
the private function cannot silently change the shape the charts and
3-bet thresholds were tuned against.

**5. `Math.min(oppCount, 4)` — sanctioned approximation, incidence measured.**
5+way postflop pots are 0.17% of hands (5 in 3,000 sampled). The cap samples
the first four live opponents' range bands in seat order. At that incidence,
widening the cap would buy variance reduction nobody can observe at the cost
of the MC latency budget everywhere. Accepted and recorded.

## Housekeeping

The dead local `DEPTH_BUCKETS` constant in GtoPostflopV31.ts (orphaned by
Phase 3's shared `depthCandidates`) is removed.

## Verification

- tsc clean both roots; engine **1,488 tests / 130 files**, services
  **548 / 51** green.
- 6 new pins. Mutation: unwiring the chart consult fails the 72o pin (1/6).
  The plo8 mutation attempt is recorded honestly: ablating V8 did NOT break
  the bare-low pin, because the discipline is multi-layer — the pin is an
  outcome pin, and that is the point of it.
