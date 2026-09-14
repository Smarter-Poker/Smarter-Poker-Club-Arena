# Horse Brain Phase 8, Round 1 acceptance manifest

Frozen before implementation on 2026-09-11. Base: `5a550b6343f613a7134011b41d69cdad613642f7`.

## Scope and contract

NLH tournament flop, turn and river; 2-10 players; MTT, SNG, HU SNG,
Spin, and complete-context satellite, PKO and mystery-bounty objectives.
Other variants, multiple boards, incomplete/stale context, recovery options
that Phase 7 cannot price, invalid numbers and exhausted work budgets retain
the existing legal decision with an explicit reason. Preflop and Phase 7
confident terminal overrides retain their ownership.

Inputs are the Phase 5 canonical public state, hero cards, Phase 6 tournament
context and Phase 7 legal candidate utilities. No opponent private cards,
network, database, filesystem or external inference belongs on the action clock.
Outputs are a versioned candidate decision and ledger, objective-separated
utilities, reasons, continuation uncertainty and bounded future-game features.
The canonical candidate list supplies every action and size. Final enforcement
must agree with the candidate receipt before a change can be accepted.

The initial delivery is shadow by default. Activation requires promotion
evidence described below; an unpromoted candidate never changes real play.
No schema or release-infrastructure changes are part of this manifest.

## Policy and future-game coverage

Exercise low-SPR value versus dominated commitment, covering versus covered,
multiway and players behind, legal blocker pressure and protected checks,
fold-equity-preserving sizing, bounty/seat utility, and river chip/prize
disagreement. Deep one-pair commitment is a separate critical bucket.
Reuse Phase 7 payout/bounty accounting without adding chip EV twice.

Future-game work must have a fixed shallow horizon and work limit, describe its
opponent-policy assumptions, conserve chips and expose uncertainty. Report
approaching blinds, next-level orbit cost, M velocity, short-stack collision,
retained reshove capacity and covering capacity. Missing table-break or future
timing facts stay unavailable. A forced-blind projection alone does not resolve
unmodeled future betting and must not clear continuation retention by itself.

## Baseline and regression evidence

Production review IDs 399521, 399839, 400340 and 400615 are the fixed real-hand
corpus. Read-only retrieval confirms AA/AA/AA/JJ losses of 600, 594.48, 487.43
and 470.66 big blinds. Replay only information available at each decision;
historical full tournament context is not fabricated. Distinguish an exact
captured replay from a reconstructed scenario using a declared test context.
The original T8 on 7-7-9-8 multiple-all-in control must remain safe.

Test minimum/maximum raise, reopening, stack cap, side-pot exclusion, nuts
versus one pair, incomplete context, unknown bounty, multiboard fallback,
serialization, restart-stable seed, private-card rejection and numerical errors.
Every named policy boundary needs tests on both sides.

## Measurement and promotion

Primary metric: paired difference in realized prize plus immediately paid bounty,
normalized by the initial funded prize/bounty pool. Satellite primary metric is
seat attainment. Report chip results separately. Compare equal deals, seat
rotation, blind schedule and payouts against the same fixed baseline population.
Report busts, finish distribution, action regret, legal failures, truncations,
chip-conservation errors, candidate hits, changed decisions and critical buckets.

Predeclared independent promotion seeds: 8101101, 8102203, 8103307.
Minimum: 1,024 complete paired tournaments per seed per supported objective.
Every seed must have a positive two-sided 99% confidence lower bound on the
primary paired metric; also report the pooled interval and all format buckets.
No reseeding or sample extension after seeing results. An unresolved or negative
run rejects promotion. No illegal actions, conservation errors, truncated hands,
private-card leaks or critical-bucket regressions are acceptable.

Policy overhead budget: 2 ms; shallow simulation budget: 5 ms, with explicit
work caps and fail-closed timeout. Record measured p50/p95/p99/max separately
from deterministic output. CI runs bounded fixtures, not a promotion-sized job.
Worker/process transport carries the same tournament result contract as local
evaluation; promotion never trusts a disconnected demonstration.

Automatic disable requires negative promotion evidence, illegal action,
catastrophe, latency breach or missing eligible/fired receipts. Disabled state
retains the existing decision and cannot self-promote after restart.

## Completion

One focused development gate and one final integrated server gate with existing
skips reported. Normal hooks, protected PR and protected merge; no self merge.
One owning engine release, only after the existing operator is finished.
Require successful workflow and exact live SHA, healthy worker/leadership,
and two increasing natural post-release telemetry samples for eligible, fired,
changed, retained/fallback, execution and supported objectives. Shadow delivery,
unresolved league evidence or missing live receipts means NOT COMPLETE.
