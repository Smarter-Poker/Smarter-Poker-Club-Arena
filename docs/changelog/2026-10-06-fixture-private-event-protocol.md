# Fixture actors accept the server's private event envelope

The isolated acceptance actor treated USER_EVENT like public EVENT and required
payload.type. TableStateHub actually sends private payload.kind, so genuine hole
cards and pre-action updates stopped the actor with FIXTURE_ACTOR_EVENT.

USER_EVENT now validates the three existing producer kinds (hole_cards,
pre_action, add_on_adjusted), then returns without replacing authoritative state
or entering the public financial-event route. Unknown kinds, malformed payloads,
wrong-table frames and invalid public envelopes still fail closed.

Native loopback regressions reproduce the prior private-card refusal and a
private envelope incorrectly reaching insurance HTTP actions. The corrected
actor suite passes 34 cases, including malformed/private-kind refusal, unchanged
public insurance acceptance and existing lifecycle/sequence checks. These are
transport-boundary tests, not a full engine, funded-lifecycle or launch certificate.
The existing component-fixture-native-smoke workflow runs this maintained suite.
