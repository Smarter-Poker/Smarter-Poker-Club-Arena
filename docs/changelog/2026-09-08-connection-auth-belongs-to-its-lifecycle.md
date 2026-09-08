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

The follow-up audit reproduced a second race in both clients: a session probe
started for a refused socket could finish after a new socket connected and
change its status back to reconnecting. The probe result now belongs to the
socket and lifecycle that requested it. Four additional regressions cover both
clients with and without an intervening disconnect. Existing tests still require
a current revoked session to stop retrying and an inconclusive current probe to
keep recovery running. The shared session prober's own sign-out effects remain
a separate audit item.

A detached table socket's late close also passed the old guard while the new
lifecycle had no socket yet. The table close handler now requires exact current
socket identity, matching the channel client and the other table callbacks.
A regression reproduces the false reconnect status during replacement auth.
