# Money proof readers share a one MiB file envelope

PR 4883's trusted verifier rejected a 1,000,956-byte qualified migration even
though GitHub returned the full base64 file. The producer used a decimal
1,000,000-byte ceiling. The dispatch consumer had the same ceiling on Git reads.

Both readers now share an explicit 1,048,576-byte limit for each migration or
declaration record. This accepts that complete immutable input without changing
its financial contents or hashes. The encoded bundle, inflated aggregate,
file counts, exact-head binding, trusted reporter and financial checks remain.

The actual producer's boundary regression failed eight acceptance cases before
the repair, then passed. PR and dispatch paths cover the measured size, exact
limit, over-limit refusal, unsupported Contents responses and head movement.
The existing required repository-check entry imports the regressions so they
execute in CI. No production SQL is modified or executed by this repair.
