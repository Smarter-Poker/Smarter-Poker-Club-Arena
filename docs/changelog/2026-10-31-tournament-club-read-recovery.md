# Retry an unread tournament asset within its owning sweep

A transient club read during manager admission left the asset cache unknown for
the manager's lifetime. A mystery activation that already held the field kept
retrying with that same unknown cache and could never reach its seed transaction.
Provisional place and reprice consumers shared the stale cache.

The existing elimination sweep now rereads only an unknown club before invoking
those consumers. A failed read stays unknown and does not stop unrelated safe
sweep work. Cached rows and established absent joins are unchanged. The reader
checks the captured manager lifecycle and club identity before publishing either
a result or a failure into the cache; retired responses cannot seed or overwrite
a replacement lifecycle's asset. Start and resume pass the same lifecycle token.

Regression coverage executes the production scheduler wrapper, club reader and
mystery activation with controlled transport: a failed admission read recovers
on the next existing sweep with the exact chip or Diamond unit, another failed
read retains unknown, and delayed success/failure cannot mutate a stopped or
replaced lifecycle. No financial rule, seed authority, timer or watcher is added.
