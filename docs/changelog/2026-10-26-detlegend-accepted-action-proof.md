# Detlegend continuation: accepted actions across cash and tournaments

The original six-step plan in the archived "Detlegend's all-in call" chat
is separate from the fifteen brain phases:

1. Inventory activation and fix owner wager rules being applied after the
   decision graph was sealed. The maintained repair is #8138; retain it.
2. Activate brain phases 8 and 10 through 14 under the owner's explicit order.
   Source #8182 and the bounded activation window #8204 are merged. The
   original deployment operation remains responsible for actual cutover.
3. Review hold'em two-pair stack-offs at the original decision coordinates.
4. Review Omaha cold-call stack-offs, including winning counterpart hands.
5. Check folds to large bets against the public opponent line and the call
   price, preserving the owner's paired-board exception and maniac rules.
6. Verify remaining variants and tournaments through the decision worker,
   authority gates and the controller's accepted action.

## A rejected action can no longer pass the activation law

The original cash-hand test silently substituted a call/check when the
controller rejected a worker action, and could stop a hand when the worker
returned no result. Its NLH case checked the absence of shadow decisions
without requiring a candidate decision. Those paths could leave a green
"every decision is accepted" assertion without proving that claim.

The existing law now fails immediately on either missing output or controller
rejection and requires a positive NLH joint candidate count. It also drives
complete tournament snapshots through production admission in NLH, PLO4,
PLO5, PLO6, PLO8, Short Deck, Pineapple, FLH and FLO8. Each action must pass
receipt validation and the real HandController. Applied Phase 8 receipts are
rechecked at the main authority gate. No authority is injected into these
tests. Tournament data and hands are synthetic; no production funds move.

This is regression protection, not a new strategy, release authority or
profitability certificate. Unsupported phase domains and declared work bounds
remain in force. The separate Phase 14 controller/withdrawal and tournament
tests remain part of connected verification.

## Review boundaries

The production review tag `board_paired_two_pair_stackoff` describes the final
showdown board, not necessarily the board when chips were committed. A sampled
NLH hand committed with AQ on A-5-3 before the final board paired. Another
sample called a river bet with A7 on 8-A-3-K-8 after a turn raise. They require
different reviews; the final tag alone cannot authorize a blanket fold rule.
Likewise, a folded hand's negative result alone cannot establish an overfold,
and cold-call losses must be paired with the existing `_won` population.

The operational checkpoint retains bounded read-only samples, exact test
results, the original release operation, related independently owned repairs
and open live verification. This record does not declare all six steps done.
