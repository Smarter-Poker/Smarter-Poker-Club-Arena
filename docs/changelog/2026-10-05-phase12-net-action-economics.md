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

## Budget

`REMAINING_VARIANT_DOMAIN.netActionDeadlineMs = 3.4`, between the unchanged
`samplingDeadlineMs` 2.5 and the unchanged `liveBudgetMs` 4. The pass refuses
before inspecting anything when the budget is already gone, and re-checks
before every terminal settlement, so it can never be the reason `finish` falls
back to the baseline on `work_budget`. Measured on the Mac Studio at the
sampler's full 32 samples, warm: median 0.135 ms, max 0.30 ms, inside the
0.9 ms residual. A cold first call is slower than that and reports
`work_budget_unavailable`, which is the correct outcome and not a silent one.

## Verification

- `RemainingVariantActionEconomics.test.ts`, 76 cases. Every expected number is
  derived in the comment beside it from the hand's own chips, never from
  another call into the module and never from the pot-share estimator.
- `RemainingVariantNetAction.test.ts`, 25 cases: the live node, the absences,
  the named refusals, the boundary validation, and the BBJ contrast that proves
  the economics changed no decision.
- Four source mutations of the calculation (BBJ dropped from the deduction
  call, the refund dropped from the net, the controller bound no longer
  compared, FLO8 scored high-only) and four of the wiring (the boundary check
  removed, the economics re-check removed, the feature binding loosened, the
  live call disabled) each turn the suite red. The assertions assert.
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
