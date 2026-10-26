# The paired-board fold is signed by the policy graph

## What went wrong

The PLO4/PLO5/PLO6 paired-board fold (#8088, widened in #8104) was applied in
`HorseLogic.decide` after the brain had already sealed its policy graph. The
graph's final action was the brain's call, the decision's action was the fold,
and the engine's receipt check (`horseDecisionReceiptIsValid`) refused the
whole decision: 149 "horse decision worker returned invalid policy receipt"
refusals in the first 45 minutes after the 03:33 UTC activation, read from
`/health.liveHorseDecision`. Each refused decision fell back to the engine's
safety default instead of the brain's own decision record.

## The fix

- The fold is now the last rule of the graph's `wager_rules` node, after the
  tournament shove rule, the river-nuts raise and the full-pot sizing rule. The
  graph records the change, the timing node then prices the fold's think time,
  and every owner receipt is still checked against the action the owner chose
  (the validator already reads owners' selections from `wager_rules.before`).
- The boundary validator admits exactly one non-aggressive wager-rule change: a
  call, raise or jam turned into a fold, and only for PLO4, PLO5 and PLO6.
  Hold'em and every other game still refuse it.
- The outer call in `decide` only covers a decision that never entered the
  graph.

## Pinned

`HorsePloPairedBoardFold.law.test.ts` replays PLO5 turn, PLO4 flop and PLO6
river spots, asserts the graph's final action and `wager_rules` transition are
the fold, and asserts `horseDecisionReceiptIsValid` accepts it for that game
and refuses it for a game without an owner fold rule. On the shipped code the same test fails: the graph
reports `call 190.52` while the decision is `fold`.

## The hold'em premium rule had the same defect, and is fixed with it

#8122 (Dan 2026-10-25: hold'em premiums are never passive, dominated offsuit
hands fold to a big 3-bet) merged while this was in review and used the same
after-`graph.finish` pattern. It was not yet serving. On main, its recorded
KQo spot produced a graph ending in `call` while the decision was `fold`, so
the next engine release would have had the engine refuse those decisions too
and fall back to the safety default. It now runs as the final wager rule,
after the paired-board fold, in the order it had before. The validator admits
its dominated-hand fold for no-limit hold'em; its raises and bets were already
admitted. `HorseHoldemPremiumAggression.law.test.ts` now asserts every rule
decision is signed by the graph and accepted by the receipt check.
