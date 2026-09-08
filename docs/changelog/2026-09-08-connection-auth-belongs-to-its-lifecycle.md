# Pending connection auth belongs to its lifecycle

A table or shared channel client could disconnect while its token lookup was
pending and then reconnect on the same instance. The old single-flight boolean
blocked the new lookup. Reconnect cleared the intentional-close flag, so the
old result could then open a socket for an obsolete session.

Both clients now identify each disconnect boundary with a generation. A new
lifecycle can start its own lookup immediately. An old resolution or rejection
cannot open a socket, schedule a retry, or release the new lookup's guard.
Concurrent callers inside one lifecycle still share one opening attempt.

Four behavioral regressions reproduced the problem in both clients before the
fix. They verify fresh credentials, no obsolete socket, preservation of the new
single-flight guard, and no reconnect status after a stale rejection.

This closes the pending-token race. It does not establish that every auth,
logout, server restart, or table recovery path has been audited.
