# The forced-activation law supplies its postflop coverage

The exact engine qualification for 3cdfbc0c failed the NLH tournament Phase 8 candidate-count assertion after its invalid-receipt and authority-gate assertions passed. Six controller hands do not guarantee a postflop decision: the brain's sampling seed does not control the secure deck, and the original failure did not retain stage/mode counts to distinguish missing coverage from a withdrawn authority.

The first of those six NLH tournament hands now prepares an ordinary heads-up limped pot through two legal actions on the real controller. Its physical flop becomes the first production-worker request. That request must carry usable worker authority, pass the main gate and return a candidate ledger; the worker's action must still be accepted by the controller. The remaining five hands retain their worker-driven preflop actions. Every existing receipt, gate, candidate, shadow and controller-acceptance assertion remains. Failures now include stage, mode and Phase 8 reason counts.

This changes test setup only. It does not alter a live deck, strategy, phase admission, safety fallback, release window or production state.
