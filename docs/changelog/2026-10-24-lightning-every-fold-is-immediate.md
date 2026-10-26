# Every Lightning fold leaves for the next hand

Explicit Lightning folds now commit the actual controller fold immediately, including while no bet is owed and before the player's turn. The current actor keeps their decision context and original clock deadline, while any horse decision refreshes from the changed public opponents; only an actual terminal hand or completed betting round advances. A released player cannot remain live and accidentally win the old pot.

Selecting the explicit auto-fold pre-action uses the same immediate path. Older clients sending fold_watch also use fast-fold release. Authentication, rendered-hand identity, all-in and betting-stage restrictions, original idempotent reservation release, and live feature pauses remain enforced. Ordinary turn folds continue to release normally.

Chips remain under the existing committed-exposure and settlement delta accounting. An unmatched forced bet can still be returned by the original settlement, while its reserved chips cannot be dealt in another hand prematurely.

Regression evidence includes the original refusal and watch-retention failures, real HandController play through the hand host, current-turn preservation, stale/duplicate pre-actions, feature pauses, no folded winner, and chip conservation with the original unmatched-blind refund. This engine candidate also carries the server-only observer repair from 58c2135a54ef446f8f949aa12e6e9dcee41e9d39; its separately delivered client consumer must be published before this engine is activated. No database migration is added.
