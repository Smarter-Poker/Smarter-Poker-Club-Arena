# Run the explicit private-record proof after qualified cleanup

Production proof run 41171355620 passed cleanup qualification but skipped its
actual browser job. The explicit event intentionally skips publication-gate;
GitHub's implicit success condition propagated that skipped ancestor through
the cleanup dependency. Use the same explicit status condition as the existing
Stats proof: evaluate after dependencies, refuse cancellation, require successful
cleanup, and accept only the fixed private-record proof event. The regression
fails against the old condition. All fixture, provenance, delivery and cleanup
requirements remain unchanged. No client or engine runtime change.

Required accounting CI also exposed a calendar-dependent fixture collision:
on October 31, the Today fixture's next-midnight row lands on the fixed
November 1 DST case for the same user. Give fixed-date DST cases their own
fixture user. Preserve every boundary, expected amount, and production reader.
The native PostgreSQL suite reproduced the failure before this isolation.
The same isolation landed concurrently in #8850. Integration preserves that
protected-main fixture byte-for-byte; this PR's final diff changes only proof
admission and its regression, plus this record.
