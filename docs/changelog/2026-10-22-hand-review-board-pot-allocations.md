# Recorded multi-board pot allocations

Bomb-pot and run-it-twice hands already settle exact awards by board, pot, player and high/low half. Cash-hand history omitted those pot awards, and its per-board winner records retained only totals. Future records now retain each main- and side-pot slice from the same post-fee, rounding-repaired awards used for settlement, without changing player credits or payout rules.

Hand Summary, Hand Detail and Replay's Rundown show the recorded amount for each pot within its board and high/low result. Shared hands preserve explicit main-pot slices too. Older records without an allocation remain unallocated; the client does not infer historical shares.

The additive data uses existing JSON fields and requires no schema migration. The client is compatible with older records and serving engines. New recording behavior requires the protected engine release through its existing daily maintenance route; client publication and engine activation are separate evidence boundaries.
