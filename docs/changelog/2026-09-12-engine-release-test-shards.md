# Run the complete release preflight in four CI shards

Consecutive engine releases spent about 15 minutes repeating the full server
suite before staging. Several became stale during that delay. The release
preflight now partitions the same suite across four CI jobs, each checking out
and compiling the requested immutable source. All four must succeed before the
production database check or deployment can start.

The change reduces the test portion of the publication delay. It keeps source
freshness checks, production database checks, the single durable publisher,
maintenance cutover and recovery intact. It does not reuse a prior commit's
test verdict or dispatch a replacement release.

Validation covers the real Vitest shard file partition and the workflow's
complete matrix/dependency chain. Actual CI timings and publication remain to
be measured on a protected release using this workflow.
