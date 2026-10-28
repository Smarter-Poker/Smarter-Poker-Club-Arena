# Game Arrivals Retain The Rejoin Door Contract

PR #8468 adds the game-arrival snapshot after the existing rejoin and lifecycle
arguments to `claimOfferedSeats`. The older source contract incorrectly required
the lifecycle argument to close the call, failing Server Engine shard 1 despite
the retained bar and rejoin-floor guards.

The contract now requires every original argument in order, the new arrival
argument, and the arrival admission check. Existing assertions for barred horses
and rejoin floors remain intact. The original contract failed locally before
this correction; all 51 focused door, allocation and arrival tests passed after.
No runtime, financial rule, CI requirement or deployment gate changed.
