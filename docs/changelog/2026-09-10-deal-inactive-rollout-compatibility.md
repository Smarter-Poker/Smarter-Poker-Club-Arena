# Deal Review Rollout Compatibility

The proposal review client and engine preserve the existing final-table voting flow only when the database explicitly responds with `proposal_authority_not_active`. Transport errors, timeouts, invalid responses, stale proposals and changed revisions never select the legacy flow.

The legacy panel retains its tally and vote action. Each vote rechecks authoritative inactivity and the current account. The engine retains the existing unanimity check, physical hand-boundary park and receipt-only completion. Before every legacy terminal admission, it asks the authority again. If activation follows an attempted write, the serialized receipt resolver determines whether that attempt committed; a missing response never becomes a claimed payment or a proven rollback.

A context that has observed active proposal authority does not downgrade. Active reviews continue to require the exact proposal ID, revision and explicit consent. Ordinary place settlement keeps its existing route. The database activation guard remains responsible for rejecting a legacy writer admitted immediately before activation.

The existing one-argument legacy vote RPC derives its actor from `auth.uid()` and has no expected-actor parameter. Rechecking the account before sending reduces stale-account submissions but does not remove the remaining authentication-token race. This compatibility change does not claim the new proposal vote's server-side expected-actor guarantee applies to legacy voting.
