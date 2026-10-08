# Seed arrival waits for the purchased roster

The representative isolated load fixture previously rejected a legitimate initial waiting snapshot with no dealer players even though its original seed purchases were already durable. Initial seed observers now accept only an inactive empty or partial waiting roster of the purchased seed identities and exact planned chairs. Such frames remain pending, do not authorize actions, and do not clear the original 20-second startup deadline. Both seed seats must be positively adopted before readiness. After adoption, empty or partial roster loss retains the existing refusal.

SNAPSHOT and DELTA share the same validation. Original arrival clocks, 240-second actor lifetime, 180-second measurement and remaining-lifetime reserve are unchanged. No engine, database or financial transaction implementation changes.

The connected transport regression reproduced FIXTURE_ACTOR_ROSTER before the fix. It covers pending empty/singleton arrival, positive adoption, post-adoption roster loss, active empty hands, nonzero pots/clocks, board content, wrong capacity, wrong chairs and zero stacks. Existing setup/measurement, in-flight reconnect and no-clock-replay cases remain exercised by the directly triggered representative fixture checks. These boundary tests are not a capacity certificate; funded acceptance remains separately required.
