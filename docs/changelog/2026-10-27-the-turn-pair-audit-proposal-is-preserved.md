# Recover the turn one-pair measurement

The consolidated Horse Brain source audit found the October 19 proposal in open
PR #7447 had not reached current protected main. The current reviewer labels the
river counterpart but leaves the same showdown shape unnamed when the commitment
went in on the turn.

Record `one_pair_turn_stackoff` and its `_won` mirror through the existing atomic
review/rollup path. Keep the current 40bb threshold, quiet-board and own-pair tests,
weak-kicker ownership and showdown requirement. Exclude multiple boards. Register
it as measurement only in the data ledger and denominator law; no dial, betting
policy, cap, scheduler, retrospective rewrite or new production write path is added.

This tag describes the final single-board showdown shape and the existing
commitment-street classifier. It does not reconstruct the turn's information set,
measure the incremental EV of a call, or establish a strategic error. Original
public-input counterfactual and held-out qualification remain necessary before
changing strategy. Loss totals alone cannot authorize a tighter cap.

New regression cases fail before recovery and pass afterward for both outcomes,
with river, rag-kicker, no-showdown and multiboard exclusions. Existing pair and
denominator checks remain enforced by the ordinary server suite.
