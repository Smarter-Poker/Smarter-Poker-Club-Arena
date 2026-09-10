# Mystery CI uses the available PostgreSQL client

The accounting CI runtime provides PostgreSQL server binaries and the pinned Node `pg` client, but no `psql`. The mystery rehearsal failed loading its fixture before any scenario ran.

The rehearsal now uses the existing `registration-query.mjs` transport when `PGNODE` is set, retaining `psql` otherwise. Fixture loading and concurrent requests use the same transport. A SQL readiness marker replaces psql meta-commands, and both real sessions keep the observed lock-wait barrier. Each connection explicitly uses the isolated socket, database and `mystery_test` identity and clears inherited `PGHOSTADDR`.

Verification: all 13 groups pass through each client. The Node run uses a binary directory with no psql. Both runs inherit deliberately invalid external connection variables and still use their own cluster. An unavailable Node client propagates failure without reaching a following shell command. The shared helper and all financial assertions remain unchanged. Python compile and `git diff --check` pass. Re-read: yes. No runtime, dependency, policy or production database change.
