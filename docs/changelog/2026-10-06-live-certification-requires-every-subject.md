# Live certification requires every subject

The production live-table job could certify a stable release after three cases
passed and the required MTT case skipped for lack of a natural eligible subject.
Run 37418196160 demonstrated this on October 6: three passed, one skipped, with
account cleanup verified. The existing per-file execution guard correctly saw
that the shared spec executed, but was insufficient for complete certification.

The owning workflow now requires the exact MTT, SPIN, SNG and cash network-loss
cases to pass once in mobile WebKit before setting certified=true. Missing,
skipped, failed, interrupted, malformed, duplicate, wrong-project and retried
coverage cannot produce that output. Partial coverage remains a named non-verdict
and its report is retained; real Playwright failures and the existing execution
guard still fail normally. Both-lane seal admission keeps its existing guards.

Regression protection executes the maintained release shell and report reader.
The stable-release/partial-coverage shell failed before the change by emitting
certified=true. No production subject, timer, retry policy or financial state
was modified to obtain coverage.
