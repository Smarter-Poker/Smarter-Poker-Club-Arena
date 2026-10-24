# The horse commitment review grades decisions against the solver charts (2026-10-24)

## What was wrong

For 2026-10-23, every row in `public.horse_commitment_reviews` (one hour: NLH 9,928,
PLO4 2,110, PLO5 427, PLO6 395) had `gto_verdict = 'unverified'` and the reasons
`{decision_replay_not_matched, reference_not_matched}`. The daily review graded nothing.

Nothing failed to match, because nothing ever tried. `fn_horse_commitment_audit_step` wrote

```sql
reasons:=ARRAY['decision_replay_not_matched','reference_not_matched'];
```

as a constant for every horse row (20260914161209, carried forward unchanged through
20260917051350, 20261007075304 and 20261008041707 line 524). The column also carried
`CHECK (gto_verdict='unverified')`, so no other value could ever be stored. No code anywhere
replays a horse decision or looks up a reference for these rows.

## Why a replay was not the answer

A live horse decision draws on the worker's `fastRandom` stream, the in-memory opponent memory
(HorseMind and its maniac reads), the per-horse `gtoAdherence` roll and the continuation layers'
process state. None of that reaches the database. Phase 15's exact replay needs the private
journal and the exact runtime. Rebuilding the decision from `hand_history` and calling the
result a match would be a fake verdict.

## What the review grades now

Migration `20261024225914_horse_commitment_review_grades_against_the_solver_charts.sql`
grades what the stored data can honestly grade:

- **What it grades:** the horse's own accepted decision, taken from `hand_history.actions`.
  Only actions with origin `horse_policy` count, and each carries the public action node
  captured before the action was applied.
- **What it grades against:** the stored solver reference, `memory_charts_gold`. These are the
  240 PioSolver push/fold charts the live brain consults through `GtoCharts.ts`.
- **Where the hole cards come from:** the digest-verified accepted payload
  (`accepted_hand_facts.stats_facts`).

The reference answers exactly the two spots `GtoCharts.ts` is authoritative for:

- **open_jam:** no-limit hold'em preflop, folded to the horse, not the big blind, at most 15 BB.
- **bb_defend:** the big blind facing a heads-up small-blind all-in, at most 25 BB effective.

The horse's position comes from the same rule as `HorseLogic.classifyPosition`. Its depth snaps
to the nearest charted depth, and a hand missing from the chart counts as a fold.

The verdicts are:

- **`reference_deviation`:** the action the horse chose has a chart frequency of 0.10 or less.
  This is the same "pure miss" that `HorseSolverAgreement` uses. One deviation in the hand is
  enough.
- **`reference_agreed`:** every chip-committing horse decision in the hand was graded and agreed
  with the chart.
- **`unverified`:** anything else. One reason is recorded per ungraded decision, for example:
  - `reference_domain_variant:plo4`
  - `reference_domain_street:flop`
  - `reference_domain_depth:open_jam`
  - `reference_domain_spot:facing_raise`
  - `reference_domain_straddle`
  - `reference_chart_unavailable:<key>`
  - `decision_public_node_unavailable`
  - `decision_fallback_not_graded`
  - `decision_hole_cards_unavailable`
  - `decision_not_found`

The column now admits `reference_agreed` and `reference_deviation`, on eligible rows only. The
constraint is added `NOT VALID`, because every existing row is `unverified`. The step's batch
receipt and every guard, cursor, counter, prune and timeout are unchanged. Rows already written
keep their first-write content, so this is not a backfill.

The offline daily corrective review (`dailyRowScreen`) treats the new `reference_*` /
`decision_*` reasons as decision evidence, not source gaps.

## Expected coverage

Most NLH cash commitments are deep-stacked, and PLO has no reference, so most rows stay
`unverified`. They are now named precisely. Short-stack tournament and spin push/fold
commitments get a real verdict. The coverage will widen when a qualified postflop or PLO
reference exists. Inventing one here would not be honest.

## Proof

- **PG17 harness:** `scripts/ci/test-horse-commitment-audit.py` job `reference_grade24`
  installs the migration over the real job-7 chain. It refuses a drifted step header, step body
  and verdict constraint, and refuses a repeat install. The retained 40 roster-basis checks hold
  on the new step, and 24 new checks pass.
- **Fixture provenance:** the fixture's base hands were played through the real
  `HandController`. `server/src/services/horseCommitmentReferenceGrade.fixture.test.ts` requires
  them to equal what the engine produces.
- **Install:** pending. The migration has to go through Apply Merged Migration after merge.
