# Historical review signals and live policy

Historical leak reports changed five live policy adjustments even after the
nightly study was converted to observational audits. They also changed the full
decision digest that seeded the worker's mixed strategy. The regression fixture
reproduced both channels: a Hold'em top-pair spot folded on all 80 tagged trials
and none of the clean trials; diagnostic-only modifiers changed the worker seed
from 1277139691 to 3489219849.

The live policy now excludes observational additions to Omaha pressure heat and
caps, Hold'em pressure heat and caps, limped-pot caps, river re-raise/call gates
and respect, and tournament survival premiums. Structural V20/V40 pressure,
made-hand classification, opponent lines, nut/redraw protection, raise plans,
variant rules and Phase 6/7 tournament calculations remain. The legacy review
rates and premium proposal can still be calculated for diagnostics. Historical
profiles and authored modifiers/personas are preserved; this change does not
reset accounts or determine which older dial values were causally justified.

The full canonical request key still binds all raw modifiers and options.
Changing a report without recomputing that key is rejected before computation.
After validation, the worker derives a separate sampling key that excludes only
the eight historical review-count/denominator fields and the now diagnostic-only
`v41Leaks` switch. Empty modifier/option objects normalize to absent so adding
only diagnostics cannot select another stream. This intentionally changes the
old seed representation for empty bags and diagnostic-only profiles. Nonempty
authored inputs without excluded fields reuse the existing digest. Authored
aggression, tightness, bluff frequency, sizing, persona, all other options, the
hand state, fence and decision hour remain bound. Discard seeding is unchanged;
deep computation replays the captured fast seed and restores canonical RNG.

Telemetry records `phase14_review_signal_ignored` once when historical report
fields are present and diagnostic reporting is enabled. The retired receipts
that claimed a report altered policy are removed from the live source and ledger.
`v41Leaks` cannot reactivate adjustments. A positive report, large sample or
unknown profile field cannot grant causal permission.

Verification includes the two retained failing regressions, compilation, 11,751
server tests across 793 files (145 existing skips and one skipped file; 66.02s),
and exact paired decisions in the original Hold'em, limped-pot, river-war and
tournament fixtures. Existing structural Omaha/nut/pressure tests remain. Worker
checks cover every excluded field, empty bags, the diagnostic switch, authored
inputs, non-finite rejection, full-key tamper rejection, deep replay and restart.

The compiled offline native probe uses real HorseLogic, actual worker threads,
the production canonical validator, RNG and effect capture. It covers nine
variants, four streets, one/two/three boards and both cash and tournament formats:
216 cases, two worker lifetimes, 1,296 decisions and 1,080 paired/restart
comparisons. Actions, amounts, think times, RNG before/after and deferred effects
match; elapsed-time diagnostics are excluded from equality and measured with the
real clock. Two child terminations are confirmed after stop receipts; zero child
fetch attempts occur. Digest:
`32d86ef7b345561750ea2501890bde438c94b273c54a8777beb4f526bf10298e`.
Observed compute p50 3.934ms, p99 15.744ms and maximum 34.419ms are fixture
measurements, not production throughput or satisfaction of the Phase 8 4ms gate.

The first native run correctly rejected incomplete tournament context from a
policy-only fixture. The probe now supplies explicit tournament lifecycle,
blind, payout, player and M facts. An initial stop wait exposed imported store
timers; the probe now confirms termination after the stop receipt, matching the
live owner's cleanup approach, and exits its parent after verified child cleanup.
Earlier failed/incomplete logs remain in task evidence.

Run after compiling the server:

```
node scripts/ci/probes/horse-review-signal-native.mjs /path/to/evidence.json
```

The probe deliberately omits persistence hydration/flush and uses no production
data. No schema change is required. Source merge, served identity and natural
telemetry must be verified separately. This boundary is a prerequisite to the
unfinished causal proposal/holdout/shadow/activation/rollback pipeline, not its
implementation or approval. Automatic observation discovery, complete-window
authority, measured capacity, the scoped model consumer, Phase 8 qualification
and Phase 15 remain separate work.
