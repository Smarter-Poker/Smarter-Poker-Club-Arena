# Horse Brain Phase 11 audit fixes (2026-10-05)

A line-by-line audit of everything Phase 11 shipped (P11.1-P11.3, the sampler
and card-facts speed work, the completion reader and the evidence) found four
defects. All four are fixed at the root here.

## 1. Candidates were not in the legal form, so the matrix measured a mixed arm

`OmahaVariantLivePolicy` (and the PLO4 policy it shares a kernel with) sized
cash wagers to the cent and returned unrounded, stack-sized calls.
`HorseLogic.legalize` snaps cash wagers to whole dollars when the big blind is a
whole number, turns a bet of 92% or a raise of 95% of the stack into all-in, and
turns a call of the whole stack into all-in. The P10.3/P11.3 selection guard
correctly refuses any applied candidate the legalizer would rewrite
(`illegal_candidate`) and plays the reference instead. Measured on a development
shard (800 pairs, six-max 100 BB): PLO5 23 of 277, PLO6 45 of 323, PLO8 13 of
226 changed proposals were replaced by the reference. The P11.2 matrices of
October 5 therefore measured a candidate arm that was partly the reference, and
their shard results did not count it.

Fix: `evaluateOmahaVariantPolicy` and `evaluatePlo4LivePolicy` take the owner's
legalizer; HorseLogic passes its own. A changed proposal is recorded and
executed in exactly the form the owner gives it, inside the timed region. The
guard stays and is now expected never to fire for a form difference.
`server/src/benchmark/OmahaLegalFormCandidates.test.ts` runs 240 league pairs per
pack (and 60 PLO4 pairs) through the real HorseLogic and asserts zero
`illegal_candidate` refusals with changed proposals applied; with the fix
reverted all four cases fail.

Consequence: the Phase 11 matrices are re-run on the fixed source under the
same locked contract (the fix was found on a development seed, not chosen from
held-out outcomes). Phase 10's verdict was measured under the same defect; it is
recorded, not re-run here.

## 2. Governor-reduced samples counted as completed

The sampler requests `max(4, floor(32 x governor scale))` samples. The matrix
ran with the governor off (always 32). Completion definition v2 counted a
complete live sample of 16 as `completed`. Definition v3
(`horse-phase11-completion-definition-v3`) counts it as `governorReduced`;
tested with the real policy at governor scale 0.5 (16 of 16 requested and
completed: `governor_reduced`) and 1 (`completed`).

## 3. Policy digest missed BettingStructure.ts

`HorseEval.variantInfo` takes pot-limit/fixed-limit from `BettingStructure.ts`,
and the legal form and the guard depend on it. Digest v3
(`horse-phase11-policy-digest-v3`) hashes it (21 files).

## 4. A selection without its binding passed the worker boundary

`packSelectionIsValid` now refuses a receipt that carries `selection` but no
`inputs` field (every such receipt is newer than its phase's binding). A
pre-binding receipt (no selection either) stays readable. Review fixtures now
carry the real binding the policy recorded.

Also: the null-proof test no longer forbids the committed completion records
(main was red on it after #6134), and a code comment that overstated what the
journal reviewer recomputes was corrected.

Not changed (design limit, stated): the evidence directory is not in the engine
image (`server/Dockerfile` copies `server/src` only), so a future selection
needs its evidence shipped; every selection is null today.
