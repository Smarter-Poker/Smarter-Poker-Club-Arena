# Run the complete release preflight in four CI shards

Consecutive engine releases spent about 15 minutes repeating the full server
suite before staging. Several became stale during that delay. The release
preflight now partitions the same suite across four CI jobs, each checking out
and compiling the requested immutable source. All four must succeed before the
production database check or deployment can start.

Protected PR CI uses the same four-way partition after a full server job hit its
15-minute ceiling. Its aggregate retains the required `Server Engine (typecheck

- tests)` name. It fails on any failed or cancelled shard and accepts a skipped
  suite only when successful change detection explicitly found no server changes
  on a pull request. PostgreSQL accounting remains a prerequisite of every shard.

The change reduces the test portion of the publication delay. It keeps source
freshness checks, production database checks, the single durable publisher,
maintenance cutover and recovery intact. It does not reuse a prior commit's
test verdict or dispatch a replacement release.

Validation covers all 735 real Vitest suite files in disjoint groups of
184/184/184/183, existing release safety checks, the complete matrix/dependency
chain, and execution of the CI aggregate's success/failure/skip verdicts. Actual
CI timings and publication remain to be measured on a protected release using
this workflow.
