# Mixed admission continues its original operation

An interrupted mixed-custody recovery retained its exact owner and reservations, but GameServer treated the existing manager as a completed admission. A subsequent admission request therefore could not resume the original operation. Durable manager wakes also ignored that recovery-only manager.

Retain the original continuation with its exact manager, transfer and reservation. Concurrent admission requests join the same in-flight operation; a durable manager wake invokes that continuation before it can request or acknowledge ordinary work. Failed recovery preserves custody and the pending wake. Successful recovery consumes its canonical receipt before normal play. Shutdown or replacement cannot resume the old owner. No new timer, scan, recovery loop or lease identity is introduced.

Eight connected regressions failed on the original source, then passed after the repair. They use real GameServer and TournamentManager components and modeled transport, with the original move IDs and lost-response scenario. Existing native PostgreSQL qualification covers transactional receipt replay separately; these tests do not claim production recovery.

The mixed-custody classifier change also invalidated two full-weekly fixture bindings. Their exact reviewed hashes are refreshed and the directly triggered classifier and accounting verification paths run against the final candidate. No financial assertion is weakened.
