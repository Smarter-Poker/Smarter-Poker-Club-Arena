# Insurance is offered only on a one-pot hand (2026-10-06)

## What was wrong

`InsuranceEngine.settle` decides an accepted contract on "is the insured
player among the hand's winners", and it is handed every winner of every pot.
With a side pot that is not the question the dialog asked:

- a short stack wins the main pot and the insured leader wins only the side
  pot: two winners, read as a chop, the leader is paid nothing for the pot he
  lost;
- a short-stacked leader wins everything he insured and someone else wins a
  side pot he was never in: two winners again, no fee is charged.

Both move real chips between a player and the insurance bank against the
contract shown. Table-level conservation held, so nothing flagged it.

## The fix, at the cause

`insuranceContractIsExact()` in `ServerTableEngineRunout.ts`: the offer is
enabled for a hand only when `computeLivePots()` holds exactly one pot at the
start of the runout (the uncalled bet has already gone back by then). On that
hand the pot's winners and the hand's winners are the same people, and the
existing settle is exact. A hand with a side pot is run out with no offer.
Nothing is corrected afterwards.

## What this deliberately does not change

Hi-lo insurance (PLO8, FLO8) is a written Phase 9 contract, "high-half price,
a split pushes", pinned by `Phase9OmahaInsurance.test.ts`. It is left as it
is. Whether a high-only price is the right product for a split game is a rule
for the owner, not a defect this change may decide.

## Proof

`server/src/engine/InsuranceContractIsExact.test.ts`, driving the real
HandController: heads-up all-in with unequal stacks is one pot (offered);
three-way with unequal stacks has a side pot (not offered); three-way with
equal stacks is one pot (offered). The existing insurance suites pass
unchanged.
