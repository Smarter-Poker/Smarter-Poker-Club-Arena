# Satellite awards honor minutes-only late registration

The database admission function supports a running target with no positive level cap and an open started_at + late_reg_mins window. The engine helper rejected every such target, setting ticket value to zero and paying the satellite pool as cash before attempting the seat RPC.

The award query now selects both timing fields. Its helper follows the database's level-first, minutes-fallback rule, closing exactly at the deadline. Finalized pools and full targets remain closed; the seat RPC still makes the locked admission decision.

An actual-method regression test first demonstrated the incorrect cash payment. Its database fixture returns the timing fields only if the real query selects them. Boundary tests cover the deadline, level precedence, missing or invalid timing, capacity, and finalized pools.

This change does not settle historical awards, modify wallets, resolve the separate bounty split/escrow issues, or complete the full audit. Publication and engine cutover must be verified separately from tests and merge status.
