# Midway PLO5 Madness Approved Launch

The explicit Midway union launch reviews the selected twenty-player lineup, six-seat 2/5 PLO5 Madness, four initial arrivals, and at most one new arrival every ten minutes. Humans retain ordinary admission and all bankroll, roster, capacity, minimum-player, and maintenance safeguards remain authoritative.

The existing union table-management console accepts `?launch=midway-plo5-20261028`. The scoped review requires an operator action, uses one durable creation request, and calls the authenticated arrival creator. Ordinary game creation is unchanged. Unknown launch intents, changed accounts, missing contracts, older engines, and invalid persisted game or table policy markers refuse without falling back to unrestricted creation. Repeated requests read the same game and active anchor, including responses without a table identifier.

The serving engine advertises arrival protocol version one through its existing health response. The launch refuses until that contract is actually serving. Successful ordinary seat admission owns each arrival receipt; a failed buy-in rolls it back, rejoining does not consume another identity, and delayed or restarted cycles cannot release a burst. Main and feeder share the same policy.

Qualification covers the scoped authenticated request, exact lineup, unknown acknowledgment and replay, stale account, unavailable engine, policy readback, and existing creation/wake and union-authority behavior. Source, installed migration, published client, activated engine, and actual game behavior remain separate delivery evidence.
