# Phase 12, P12-B first slice: the explicit net-action interface (FLH/FLO8 river)

Package: **P12-B, "finish per-variant economics on the canonical rule matrix"**,
from `docs/horse-brain-phases6-15-completion-plan-2026-09-17.md`. Its own
wording for what to build first:

> Smallest calculation slice follows P11-A: use one explicit net-action
> interface with game-specific scoring and canonical wager bounds, beginning
> with FLH/FLO8 river call/completion. Preserve the policy's current 2.5 ms
> sampling deadline inside 4 ms total and named unavailable result.

This is that slice and nothing beyond it. The Short Deck and Pineapple halves
of P12-B (36-card scoring, three-card occupancy, the flop-only opponent prior)
and the FLH/FLO8 cap/reopen and unit/deduction extensions to the EXISTING
completion/deep/reference suites are not in it. Phase 11 was not touched.

## What the live wrapper could not say before

`evaluateRemainingVariantPolicy` prices a call as `callCost / netPot` against a
sampled pot SHARE. A pot share cannot express:

- a side pot hero is not eligible for (hero can win one pot and not another);
- the uncalled-bet refund when a short seat cannot cover hero's wager;
- the BBJ fee, which the call-price path does not read at all (P11-A named this
  gap: "it does not explicitly price BBJ through the joint deduction owner");
- whole-unit and odd-cent allocation of a scaled award;
- an FLO8 quarter or sixth as chips rather than as a share.

## What was added

`server/src/engine/remainingVariants/RemainingVariantActionEconomics.ts`
(`remaining-variant-action-economics-v1`). For an FLH/FLO8 river node it prices
every legal candidate in NET CHIPS against taking no further part:

- `fold` is exactly `0`. Chips already in the middle are sunk and no line
  recovers them, so zero is the exact comparison point, not an approximation.
- `call` is priced as `terminal_showdown`: the current contesting roster
  reaches showdown with the chips the call puts in.
- the street's single canonical wager is priced TWICE, under two declared
  opponent response assumptions, `all_contesting_opponents_call` and
  `all_contesting_opponents_fold`. The real value lies between them and this
  module does not claim to know where.

It composes the platform's own settlement owners and copies none of their
arithmetic: `prepareJointPots` for refunds and individual pot eligibility,
`settleJointScores` for high and low (`splitLow` from the PACK, so FLO8 splits
and FLH does not), `applyJointDeductions` for rake AND the BBJ fee. It performs
no I/O, reads no private card, mutates no chip, and never throws: a malformed
input, an unreconcilable bound, a settlement an owner refuses, or an exhausted
budget each return a NAMED `unavailable` with no values.

It runs on the terminal showdowns the sampler ALREADY scored. `RemainingVariantSampler`
gained one optional retention callback; no extra sample, card, deck draw or
iteration is taken to supply it, and the aggregate evidence it returns is
unchanged whether or not retention is asked for.

**The controller owns legality.** The wager-to is derived from this street's
actual raise levels through `fixedLimitStreetBounds` (so a short level is
COMPLETED to the full street bet, WSOP 2026 rule 133) and is then compared with
the controller's own `minRaiseTo`/`maxRaiseTo`. An inexact match is a
disagreement about legality, and the node is refused `wager_bounds_unavailable`
rather than priced. No estimate in this module can legalize a forbidden raise,
and on a capped street no wager is priced at all.

## Diagnostic this round, and verified rather than carried

The proposal is still chosen by the existing structural pot-share path. The
economics are attached to the receipt as `actionEconomics`, and nothing reads
them to decide. That is demonstrated, not asserted in a comment: the BBJ
schedule is read ONLY by the economics, so turning it on moves the net chip
numbers and leaves the reason, the proposal, `callPrice` and the firing
identical.

P10.1 shipped a runtime policy digest that nothing ever compared with the code
it described, and it took PRs #5998 and #5999 to find. So this receipt is
re-checked by the running module at the worker response boundary:

- `remainingVariantActionEconomicsIsValid` pins the version string, the exact
  key sets, the unavailable/values exclusive-or, the `best` argmax, the fold
  identity, the per-line bounds, and the agreement between every priced wager
  and the canonical bound the receipt declares;
- `remainingVariantReceiptBindingIsValid` binds it to its receipt: same
  variant, same street, river only, eligible, and the `net_action_economics`
  feature present exactly when a result is available;
- `horseDecision/responseValidation.ts` calls it, so a wrong Phase 12 receipt
  now fails closed. **Until this slice, no Phase 12 receipt was shape-checked
  at that boundary at all** - Phase 10 and Phase 11 both were.
- `horseDecision/client.ts` drops a SHADOW-only Phase 12 receipt whose binding
  fails, with its ownership record and a named
  `phase12_shadow_receipt_binding_dropped` fire registered in
  `HorseDataLedger`, exactly as the P10 audit F8 rule already does for Phases
  10 and 11. A malformed diagnostic must not take the worker down; an applied
  receipt still fails closed.
- A receipt that carries no `actionEconomics` key claims no economics and is
  not refused, so every retained and legacy receipt stays valid.

## Budget, and the defect the first design had

**First design, and why it was wrong.** The pass was given a deadline at 3.4 ms
on the POLICY clock, between the unchanged `samplingDeadlineMs` 2.5 and the
unchanged `liveBudgetMs` 4, checked before every terminal settlement. The claim
was that it could therefore never be the reason `finish` falls back to the
baseline on `work_budget`.

That claim was false, and the test written to pin it is what proved it. On a
shared GitHub ubuntu runner the pass costs about 1.0 ms median with a 5.2 ms
p95, against the 0.9 ms residual the design left it. The guard bounds WORK
UNITS, not wall time: a check at 3.39 ms passes and then one settlement, plus
the hypothetical pot construction that had no check at all, runs long enough to
cross 4 ms. `reason` came back `work_budget` and the proposal was dropped. A
diagnostic had taken the decision down, which is exactly the trap 10.86 rule 4
describes - the fix that leaves the same trap one level up.

**Second design, which cannot do that.** The pass runs STRICTLY AFTER `finish`,
inside a `finishPriced` wrapper on the seven postflop decision returns, on a
budget of its own: `REMAINING_VARIANT_DOMAIN.netActionBudgetMs = 1`, measured
from its own start. By the time it runs, `finish` has already fixed `reason`,
`proposalAction`, `proposalAmount`, `changed`, `applied` and `latencyMs`, so no
cost incurred here can reach the decision at all. A node the policy REFUSED is
not priced, and the pass checks its own budget before building the hypothetical
pots and before every settlement, so its own overshoot is one settlement.

`latencyMs` therefore stays the policy's own work and does not carry this
pass's cost; the pass reports its own `analysisMs`, and both are on the
receipt. That separation is stated in the field's own comment, not left to be
discovered.

The ordering is the safety property, so it is pinned at the SOURCE rather than
inferred from a timing run a fast host would pass either way: a test reads
`RemainingVariantLivePolicy.ts` and refuses a call site that is not inside
`finishPriced` after `finish`, a budget pointed at the policy clock, more than
one call site, or a refused node being priced.

**Measured**, at the sampler's full 32 samples, warm, with an unconditional
budget so every run completes: Mac Studio median 0.142 ms, p95 0.233 ms; shared
GitHub ubuntu runner median 1.009 ms, p95 5.166 ms. On a host like the runner
the field will often be absent with `work_budget_unavailable`, which is the
designed named outcome and costs the decision nothing.

**Three named outcomes at a firing river node, not two.** Running the live pin
inside the FULL local suite, on a loaded machine, starved the SAMPLER rather
than the pass: fewer than `MIN_TERMINAL_SAMPLES` showdowns were retained, so
the pass reported `terminal_samples_unavailable`. Three showdowns is not a net
economic result and it says so by name rather than averaging them. The pin now
holds the closed set of refusals, which is the property that matters; its first
version asserted two outcomes and was wrong about the estate, not the code. Production runs a
dedicated engine box, and `EquityLoadGovernor` already cuts `requestedSamples`
when the loop saturates, which cuts this pass with it. If natural coverage of
the field proves thin, the next step is a DECLARED per-line sample cap, not a
wider budget.

## Verification

- `RemainingVariantActionEconomics.test.ts`, 76 cases. Every expected number is
  derived in the comment beside it from the hand's own chips, never from
  another call into the module and never from the pot-share estimator.
- `RemainingVariantNetAction.test.ts`, 27 cases: the live node, the absences,
  the named refusals, the boundary validation, the BBJ contrast that proves the
  economics changed no decision, the source pin on the ordering, a pin that the
  live outcome is always one of exactly two NAMED states, and an unconditional
  cost measurement that always measures something rather than passing when it
  measured nothing.
- Four source mutations of the calculation (BBJ dropped from the deduction
  call, the refund dropped from the net, the controller bound no longer
  compared, FLO8 scored high-only) and six of the wiring (the boundary check
  removed, the economics re-check removed, the feature binding loosened, the
  live call disabled, the pass moved back before `finish`, its budget pointed
  at the policy clock, a refused node priced) each turn the suite red. The
  assertions assert.
- `npx tsc --noEmit` clean in `server/`.

`src/engine/HorsePhase11Authority.test.ts` is red on `main` for an unrelated
reason (it asserts no Phase 11 completion record exists and three now do) and
is being fixed in PR #6138. It is not touched here.

## 10.5

Nothing in this slice reads `is_horse`, and nothing it adds is conditioned on
who is in the seat. It prices the chips a SEAT's action returns, under the same
rake, the same BBJ fee, the same pot eligibility and the same settlement owners
a human's seat is settled by, on the same turn clock and inside the same
decision budget.
