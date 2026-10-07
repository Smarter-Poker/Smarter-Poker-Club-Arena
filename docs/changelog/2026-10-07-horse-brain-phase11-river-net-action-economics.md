# Phase 11, P11-A: the PLO5, PLO6 and PLO8 river priced in net chips

Found by the October 7 audit of Horse Brain Phases 11 and 12. The completion
plan's package **P11-A, "net action economics beyond entry/texture
thresholds"**, was never built, and the Phase 11 closure record did not say so.
Phase 12 built its half (P12-B, FLH/FLO8, #6151) and its changelog quotes P11-A
as the gap it followed. This is the P11-A slice the plan names first, on the
same interface.

## What the live wrapper could not say

`evaluateOmahaVariantPolicy` prices a call as `callCost / netPot` against a
sampled pot SHARE. A share cannot express a side pot hero is not eligible for,
the uncalled-bet refund, the BBJ fee (the call-price path never reads it),
whole-unit and odd-cent allocation, or a PLO8 quarter or sixth as chips.

## What was added

`server/src/engine/omaha/OmahaVariantActionEconomics.ts`
(`omaha-variant-action-economics-v1`). At a fired PLO5, PLO6 or PLO8 river node
it prices every legal candidate in NET CHIPS against taking no further part:
fold is exactly `0`; call is the terminal showdown; each priced wager (the
controller's minimum and the largest the pot-limit, stack and controller bounds
allow, in the owner's legal form) under two declared responses,
`all_contesting_opponents_call` and `all_contesting_opponents_fold`. It
composes the platform's own owners and copies none of their arithmetic:
`prepareJointPots` (refunds, pot eligibility), `settleJointScores` (`splitLow`
from the pack, so PLO8 splits and PLO5/PLO6 do not), `applyJointDeductions`
(rake and the BBJ fee). A size outside the controller's bounds or hero's stack
is refused by name, never priced.

It runs on the showdowns the sampler ALREADY scored: `sampleOmahaVariantEquity`
gained one optional retention callback, and its evidence is identical with or
without it (tested). The pass runs STRICTLY AFTER `finish`, on its own 1 ms
budget, so it cannot change the reason, the proposal, `latencyMs` or the
fallback; a refused node is not priced. The result is the receipt field
`netActionEconomics` with the feature `net_action_economics`; nothing reads it
to decide (the BBJ contrast test shows the decision, proposal, reason and call
price identical while the net chips move).

The receipt binding the worker boundary applies (`omahaVariantReceiptBindingIsValid`,
called by `responseValidation.ts`, and the shadow drop in `client.ts`) now
re-checks the field against `omahaVariantActionEconomicsIsValid`: version, exact
keys, the unavailable/values exclusive-or, the fold identity, the `best` argmax,
every priced wager inside the declared controller bounds, and the feature tag
present exactly when a result is available.

The Phase 11 policy digest moves to `horse-phase11-policy-digest-v4` and hashes
the new file. That invalidates nothing: no Phase 11 pack is qualified, and every
selection stays `null`.

## Verification

- `OmahaVariantActionEconomics.test.ts`: every number derived by hand in the
  test from the hand's chips. Scoop versus low-only of the same pot, a tied low,
  no qualifying low, a quarter, a short all-in winning the main pot while hero
  wins the side pot, hero's excess returned over a short caller, the odd cent
  of a split low, rake under and at the cap, and the BBJ fee contrasted with
  zero fees; every refusal named; the validator refuses eleven tamperings.
- `OmahaVariantNetAction.test.ts`: the live node for all three packs, nothing
  on preflop/flop/turn or a refused node, the BBJ no-decision contrast, the
  binding refusals, sampler retention identity, and a source pin on the
  ordering and the budget.
- Source mutations each turn the suites red: BBJ dropped from the deduction,
  the refund dropped from the net, PLO8 scored high-only, the controller's upper
  bound not compared, the budget pointed at the policy clock, the receipt
  binding check removed.

## Scope

River only. The plan sequences flop and turn after the river interface ("then
extend the same interface to ... flop/turn response branches"), and those
branches need an opponent response model that does not exist for heads-up
single-board Omaha; multiway flop and turn lines are priced in shadow by the
Phase 13 joint response tree. No strategy, selection or live decision changes.
