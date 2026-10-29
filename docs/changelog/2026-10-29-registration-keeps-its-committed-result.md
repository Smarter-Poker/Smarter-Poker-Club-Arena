# Registration keeps its committed result

The shared tournament registration hook caught presentation failures in the same block as the registration RPC. A throwing page-refresh callback prevented seat navigation after a successful entry. A thrown seat lookup similarly reported a registration error even though entry had succeeded.

The refresh callback now reports synchronous and asynchronous failures independently. Seat lookup exceptions use the existing unknown-seat result, preserving bounded lookup attempts and the honest registered-but-unconfirmed destination. Neither path retries registration, changes payment authority, or guesses a seat.

Two rendered-hook cases fail before the repair; the refused-entry control remains a failure without navigation. Hosted checks, publication and live verification remain pending. No production entry or wallet was used for testing.
