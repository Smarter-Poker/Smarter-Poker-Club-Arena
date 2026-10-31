# Start the retained decision clock only when its input is ready

A control-only continuation checkpoint can temporarily withhold the action context during TURN_CHANGE's animation settle beat without changing the poker decision. Comparing that withheld token to the original token skipped the only turn-clock handler. Retention later restored the input token but did not restore the skipped timer. Arming immediately instead was also unsafe: a delayed checkpoint could consume the clock while the player could not act.

Keep one activation owned by the original event, bound to its controller, hand and decision. The existing continuation-ready callback consumes it only after retention, without awaiting its own queue or repeating the animation settle beat. Start the full clock at that boundary. Preserve stopped, superseded and changed-decision guards and durability-gated action publication.

The actual continuation queue regression reproduced both the missing timer and forced fold during delayed retention. It verifies no timer or forced action through a 60-second storage delay, exactly one real timer after readiness, legal Fold/Call/Raise over HTTP, and refusal of stale activation when the decision changes or engine stops. These are isolated behavioral proofs, not attribution or live verification of a particular player's report.
