# Original adaptive membership validates every tuple as one set

The mandatory legacy membership prerequisite spent one SQL insert per observation and computed a sanitized batch even when no member had retired. The existing private helper now parses the bounded batch once, extracts and validates every original hand reference before deduplication, and records the same exact SHA256 memberships in one set insert. It calls the original sanitizer only after that exact batch joins an actually retired certificate.

The original row lock, missing/ready no-op, null-canonical behavior,16MiB and20,000-tuple limits, error refusal, original batch digest and protected tuple strings remain. Human and unknown hands still receive membership; membership is not retirement authority. No qualifier, raw-retirement fence, activation gate, job or timer changes.

Focused native PostgreSQL proof observes4096 original insert statements becoming one, with64 exact original hand digests and all original raw/batch contents preserved. It verifies future append and legacy phases, real original retirement and exact/changed replay, malformed human/unknown/duplicate references, transaction rollback, null canonical receipt, original row-lock concurrency and private grants. Timings apply only to the retained native inputs, not universal production throughput.

The existing mandatory adaptive CLI runs its original34 checks, qualifies this helper and returns the unseeded qualified template, then runs the existing27 capacity checks against that actual helper. Installed source, protected delivery and live backlog reduction remain separate delivery evidence.
