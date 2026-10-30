# Stats pagination proof executes after its qualified cleanup gate

The focused `run-stats-pagination-proof` event intentionally skips the publication gate. In run 41145667479 the cleanup safety check passed, but GitHub skipped the Stats job because its condition inherited the default success requirement from the skipped publication ancestor.

The Stats job now explicitly evaluates after that ancestor while requiring a successful cleanup safety check, an uncancelled run and the exact existing event. Its fixed case, release pins, permissions, timeouts, zero retries and isolated-account cleanup are unchanged. No other proof profile or publisher changes.

The focused regression evaluates the actual workflow condition for the skipped ancestor and rejects failed, skipped, cancelled or unknown cleanup results, cancelled runs and other events. Before the workflow repair, two checks failed and thirteen passed; after the repair all fifteen checks passed.
