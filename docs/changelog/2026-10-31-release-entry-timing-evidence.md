# Release entry timing evidence

The bounded pending-transaction reader now recognizes the existing Lightning hold completion and unknown logs and the legacy checkpoint entry phase logs. It exports only fixed categories and their exact owning journal timestamps, preserving the twelve-row limit, invocation binding and unknown-absence semantics. No raw transport errors or numeric entry details leave the host.

The release currently pauses Lightning synchronously after the durable countdown starts and before testing its initial 285-second reserve. That is a possible source of missed admission, not an established cause of the observed production attempt. This diagnostic change supplies evidence through the existing explicit read-only route; it neither changes the transaction nor initiates a release.

Validation covers actual native grep selection, the closed export schema, malformed phases and private-text suppression alongside the existing reader fixtures.
