# Prepare explicit online MTT redistribution planning

Add pure, opt-in planners for tournament balancing and table breaks. They require a complete roster, prior movement history, blind history and captured random draws. Incomplete or exhausted inputs return a pending result.

Table breaks sample uniformly from complete ordered chair assignments across up to 2,000 tables. Bounded balancing minimizes move count, then natural big-blind displacement and prior moves. Existing callers and the legacy redistribution methods keep their current behavior; this change does not activate a new tournament policy or authorize a seat move.

Validation covers heads-up history, reserved chairs, fair sampling, field limits and existing balancing/dealing behavior. Physical movement and live policy activation require their separate ownership and settlement contracts.
