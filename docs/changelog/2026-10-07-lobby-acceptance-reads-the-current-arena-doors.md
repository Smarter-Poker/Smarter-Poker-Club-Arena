# Lobby acceptance reads the current arena doors

Post-deploy 37575691538 skipped both Diamond phone orientations because its September closed-arena test assumed both funded-play switches were off. The actual arena is enabled. Missing `Not Open Yet` was incorrectly described as missing cards.

The read-only browser case now observes the real `fn_poker_arena_context` response, validates its Diamond identity/entitlement and both boolean switches, requires the stake ladder to render, and checks controls against each actual door. Missing/error/malformed authority and missing cards fail; the existing 10-second context and 20-second card budgets remain. No switches, wallets, seats or registrations are changed. An empty tournament catalogue is recorded, not claimed as a live negative-registration proof.

Rendered real-card regressions cover all four independent closed/open combinations, disabled purchase controls, preserved review controls, and full-table queue callbacks without join/view side effects. The real ClubHomePage plus React Router now exercises tournament row navigation for REGISTERING, STARTING_SOON, LATE_REG, RUNNING and BAGGED on the MTT tab without a registration or purchase call.

The two original production lobby cases remain honestly conditional: the reserved certification cash club has neither a tournament nor a full cash table. Synthetic read results qualify isolated component wiring only; they are not production game, funding or waitlist acceptance. No production fixtures are seeded to force those states.
