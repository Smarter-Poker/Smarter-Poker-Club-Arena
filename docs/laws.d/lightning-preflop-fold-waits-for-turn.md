# tests/lightning-preflop-fold-waits-for-turn.law.test.ts

Off-turn Lightning preflop Fold stays in its original hand until its own turn; button and keyboard preserve real price, free Check/Fold, stale-hand and one-shot semantics.

October 26: against older engines the guard covers every betting street; a priced fold may release immediately only when the serving snapshot advertises fold_on_turn. Free Check/Fold remains turn-bound.
