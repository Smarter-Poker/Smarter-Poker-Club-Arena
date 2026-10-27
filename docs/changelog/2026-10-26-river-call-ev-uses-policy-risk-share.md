# River call EV reports the risk its action policy prices

`riverCallVerdict` selected calls using the established square-root share-of-stack risk premium, but its returned `evCall` charged the full stack-off premium. A partial-stack call clearly above its policy-adjusted price could therefore return negative EV. The production decision caller reads only `call`; no production consumer of this returned diagnostic was found.

Use the same existing risk-share expression for the returned EV and the unchanged action threshold. Preserve pot odds, deductions, risk cap, indifference band, randomness and action selection. Regression cases compare both sides of the price with and without exact deductions; they fail before this correction while their existing call/threshold checks pass.

This repairs a contradictory diagnostic value. It does not change strategy or establish a strength improvement.
