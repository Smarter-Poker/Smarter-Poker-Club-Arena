# Diamond must-move transaction fixture

`tests/sql/run-diamond-must-move.py` creates an isolated PostgreSQL 17 cluster
with only a private Unix socket and removes it in `finally`. It accepts a
PostgreSQL binary directory, never a database URL, password or live identity.

The bootstrap retains read-only production catalog columns and function
preimages in the adjacent captures. The runner verifies captured body hashes
before applying the candidate migration. Scene rows are synthetic. Actual
seat occupancy, game-scope cascade and deferred Diamond custody constraints
run in the fixture; authorization/session/maintenance predicates model the
transport boundary. This is transaction qualification, not full production
RLS, foreign-key topology, live gameplay or publication certification.

The original affordability bug admits an unfunded Diamond join and the
original move cannot commit through the deferred custody guard. The repaired
writers must preserve custody identity, entry provenance, lots and wallet
balances across moves/swaps; reject stale, unauthorized and cross-arena
operations; roll back a late custody failure; retain exact duplicate receipts;
project feeder rules; apply staff edits/closures to the whole game; adopt
same-key legacy tables together; and refuse migration replay.

Deployment has two distinct migrations. Install compatible writers first,
activate and verify the new engine through its existing maintenance release,
then adopt the legacy ladder. Adoption before engine activation would make
the old engine refuse clustered Diamond tables. No runner installs production
migrations or advances a release.
