# Run the explicit private-record proof after qualified cleanup

Production proof run 41171355620 passed cleanup qualification but skipped its
actual browser job. The explicit event intentionally skips publication-gate;
GitHub's implicit success condition propagated that skipped ancestor through
the cleanup dependency. Use the same explicit status condition as the existing
Stats proof: evaluate after dependencies, refuse cancellation, require successful
cleanup, and accept only the fixed private-record proof event. The regression
fails against the old condition. All fixture, provenance, delivery and cleanup
requirements remain unchanged. No client or engine runtime change.
